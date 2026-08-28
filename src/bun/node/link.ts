import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { NodeIdentity } from "../../shared/types";
import type { Envelope } from "./envelope";
import { nodeIdentity, signNodePayload, verifyNodePayload } from "./identity";

const CALL_TIMEOUT_MS = 20_000;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const RECONNECT_FLOOR_MS = 2_000;
const RECONNECT_CEIL_MS = 30_000;

export type NodeLinkSocket = {
	send(data: string): unknown;
	close(code?: number, reason?: string): unknown;
};

export type NodeLinkServerHooks = {
	open(peerId: string, socket: NodeLinkSocket): boolean;
	message(peerId: string, socket: NodeLinkSocket, raw: string | Buffer): void;
	close(peerId: string, socket: NodeLinkSocket): void;
};

type Resolver = (method: string) => ((params: unknown) => Promise<unknown>) | undefined;

type Pending = {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
};

type Frame = {
	link?: "challenge" | "hello";
	nodeId?: string;
	nonce?: string;
	proof?: string;
	secure?: true;
	seq?: number;
	session?: string;
	body?: Frame;
	mac?: string;
	id?: number;
	method?: string;
	params?: unknown;
	ok?: boolean;
	result?: unknown;
	error?: string;
	push?: string;
	payload?: unknown;
	// An envelope frame's body is `{ env }` and nothing else: never combined
	// with an RPC id/method or a push name.
	env?: Envelope;
};

/**
 * One bidirectional control-plane connection for a node pair.
 *
 * Either side may dial: direction is transport, not trust, and reachability
 * is not symmetric — a NAT'd desk can reach out but cannot be reached. The
 * first socket to finish the nonce handshake wins and both sides stop
 * dialing while a link is up. When both handshakes are in flight at once,
 * the connection dialed by the lexicographically smaller node id survives.
 * The bearer token gates the HTTP upgrade; then both sides answer a fresh
 * nonce with their Ed25519 node key before RPC or observations are accepted.
 */
export class NodeLink {
	up = false;
	/** True when this side's own outgoing socket wins a handshake collision —
	 *  the lexicographically smaller id. A preference, not a permission. */
	readonly dialer: boolean;
	readonly nodeId: string;
	readonly nodeName: string;

	private readonly local = nodeIdentity();
	private socket: NodeLinkSocket | null = null;
	private direction: "incoming" | "outgoing" | null = null;
	private connecting: WebSocket | null = null;
	private pending = new Map<number, Pending>();
	private nextId = 1;
	private closed = false;
	private backoff = RECONNECT_FLOOR_MS;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
	private localNonce = "";
	private remoteNonce = "";
	private sendSeq = 0;
	private receiveSeq = 0;

	constructor(
		private readonly peer: NodeIdentity,
		private readonly origin: string,
		private readonly token: string,
		private readonly linkKey: string,
		private readonly resolve: Resolver,
		private readonly onPush: (name: string, payload: unknown) => void,
		private readonly onUp: () => void,
		private readonly onDown: () => void,
		// Optional so a caller that has no sync plane yet constructs unchanged.
		private readonly onEnvelope?: (env: Envelope) => void,
		/** Authenticated traffic is durable presence, regardless of frame kind. */
		private readonly onActivity?: () => void,
	) {
		this.nodeId = peer.id;
		this.nodeName = peer.name;
		this.dialer = this.local.id < peer.id;
		this.connect();
	}

	private connect(): void {
		if (this.closed || this.socket || this.connecting) return;
		let ws: WebSocket;
		try {
			const url = `${this.origin.replace(/^http/, "ws")}/node/link?token=${encodeURIComponent(this.token)}`;
			ws = new WebSocket(url);
		} catch {
			this.scheduleReconnect();
			return;
		}
		this.connecting = ws;
		ws.onopen = () => {
			if (this.closed || this.connecting !== ws) {
				ws.close();
				return;
			}
			this.connecting = null;
			/* An inbound socket attached while this dial was in flight. A link
			 * that finished authenticating already won; mid-handshake, the
			 * smaller id's own dial is the survivor. */
			if (this.socket && (this.up || !this.dialer)) {
				ws.close(1000, "link collision");
				return;
			}
			this.attach(ws, "outgoing");
		};
		ws.onmessage = (event) => this.receive(ws, String(event.data));
		const drop = () => {
			if (this.connecting === ws) {
				this.connecting = null;
				this.scheduleReconnect();
			}
			this.detached(ws);
		};
		ws.onclose = drop;
		ws.onerror = drop;
	}

	accept(socket: NodeLinkSocket): boolean {
		if (this.closed) {
			socket.close(1008, "node link closed");
			return false;
		}
		if (this.socket && this.up) {
			socket.close(1008, "node link already authenticated");
			return false;
		}
		/* Two sockets mid-handshake at once: keep the one dialed by the
		 * smaller id. An in-flight dial that has not opened does NOT count —
		 * it may be a black hole (a stale origin, a NAT), and an arrived
		 * inbound socket must never lose to a connection that may never open. */
		if (this.socket && this.dialer) {
			socket.close(1008, "link collision");
			return false;
		}
		if (this.connecting) {
			this.connecting.close();
			this.connecting = null;
		}
		this.attach(socket, "incoming");
		return true;
	}

	private attach(socket: NodeLinkSocket, direction: "incoming" | "outgoing"): void {
		if (this.socket && this.socket !== socket) this.socket.close(1000, "link replaced");
		this.rejectPending("node link replaced");
		this.socket = socket;
		this.direction = direction;
		this.up = false;
		this.localNonce = randomBytes(24).toString("base64url");
		this.remoteNonce = "";
		this.sendSeq = 0;
		this.receiveSeq = 0;
		this.sendPlain({
			link: "challenge",
			nodeId: this.local.id,
			nonce: this.localNonce,
		});
		if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
		this.handshakeTimer = setTimeout(() => {
			if (this.socket === socket && !this.up) socket.close(1008, "node authentication timed out");
		}, HANDSHAKE_TIMEOUT_MS);
	}

	receive(socket: NodeLinkSocket, raw: string | Buffer): void {
		if (socket !== this.socket) return;
		let frame: Frame;
		try {
			frame = JSON.parse(String(raw)) as Frame;
		} catch {
			socket.close(1003, "invalid node frame");
			return;
		}
		if (frame.link === "challenge") {
			this.answerChallenge(frame);
			return;
		}
		if (frame.link === "hello") {
			this.verifyHello(frame);
			return;
		}
		if (!this.up) {
			socket.close(1008, "node is not authenticated");
			return;
		}
		const body = this.openSecure(frame);
		if (!body) return;
		this.noteActivity();
		// Before the RPC branches: an envelope body is its own thing, and a
		// frame carrying one must never be read as a call, an answer, or a push.
		if (body.env) {
			this.onEnvelope?.(body.env);
			return;
		}
		if (typeof body.id === "number" && typeof body.method === "string") {
			void this.answerCall(body.id, body.method, body.params);
			return;
		}
		if (typeof body.id === "number" && typeof body.ok === "boolean") {
			const waiting = this.pending.get(body.id);
			if (!waiting) return;
			this.pending.delete(body.id);
			clearTimeout(waiting.timer);
			if (body.ok) waiting.resolve(body.result);
			else waiting.reject(new Error(body.error ?? "node call failed"));
			return;
		}
		if (typeof body.push === "string") this.onPush(body.push, body.payload);
	}

	private answerChallenge(frame: Frame): void {
		if (
			frame.nodeId !== this.peer.id ||
			typeof frame.nonce !== "string" ||
			frame.nonce.length < 16 ||
			frame.nonce.length > 128
		) {
			this.socket?.close(1008, "invalid node challenge");
			return;
		}
		this.remoteNonce = frame.nonce;
		const claim = { from: this.local.id, to: this.peer.id, nonce: frame.nonce };
		this.sendPlain({
			link: "hello",
			nodeId: this.local.id,
			nonce: frame.nonce,
			proof: signNodePayload("node-link", claim),
		});
	}

	private verifyHello(frame: Frame): void {
		if (
			frame.nodeId !== this.peer.id ||
			frame.nonce !== this.localNonce ||
			!this.remoteNonce ||
			typeof frame.proof !== "string"
		) {
			this.socket?.close(1008, "invalid node hello");
			return;
		}
		const claim = { from: this.peer.id, to: this.local.id, nonce: this.localNonce };
		if (!verifyNodePayload(this.peer, "node-link", claim, frame.proof)) {
			this.socket?.close(1008, "node identity did not verify");
			return;
		}
		if (this.up) return;
		this.up = true;
		this.backoff = RECONNECT_FLOOR_MS;
		if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
		this.handshakeTimer = null;
		if (this.connecting) {
			this.connecting.close();
			this.connecting = null;
		}
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		this.onUp();
	}

	private async answerCall(id: number, method: string, params: unknown): Promise<void> {
		const handler = this.resolve(method);
		if (!handler) {
			try {
				this.sendSecure({ id, ok: false, error: `unknown method ${method}` });
			} catch {}
			return;
		}
		let result: unknown;
		try {
			result = await handler(params ?? {});
		} catch (error) {
			try {
				this.sendSecure({
					id,
					ok: false,
					error: error instanceof Error ? error.message : "node request failed",
				});
			} catch {}
			return;
		}
		try {
			this.sendSecure({ id, ok: true, result });
		} catch {}
	}

	call(method: string, params: unknown, timeoutMs = CALL_TIMEOUT_MS): Promise<unknown> {
		if (!this.up || !this.socket) {
			return Promise.reject(new Error(`${this.nodeName} is not reachable right now`));
		}
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`${this.nodeName} did not answer`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			try {
				this.sendSecure({ id, method, params });
			} catch (error) {
				this.pending.delete(id);
				clearTimeout(timer);
				reject(error instanceof Error ? error : new Error("node send failed"));
			}
		});
	}

	push(name: string, payload: unknown): boolean {
		if (!this.up || !this.socket) return false;
		try {
			this.sendSecure({ push: name, payload });
			return true;
		} catch {
			return false;
		}
	}

	/** Sends one envelope on the authenticated link. False when not up. */
	envelope(env: Envelope): boolean {
		if (!this.up || !this.socket) return false;
		try {
			this.sendSecure({ env });
			return true;
		} catch {
			return false;
		}
	}

	private sendPlain(frame: Frame): void {
		if (!this.socket) throw new Error("node link is not connected");
		this.socket.send(JSON.stringify(frame));
	}

	private sessionId(): string {
		const localFirst = this.local.id < this.peer.id;
		const session = localFirst
			? {
					lowId: this.local.id,
					lowNonce: this.localNonce,
					highId: this.peer.id,
					highNonce: this.remoteNonce,
				}
			: {
					lowId: this.peer.id,
					lowNonce: this.remoteNonce,
					highId: this.local.id,
					highNonce: this.localNonce,
				};
		return createHash("sha256").update(JSON.stringify(session)).digest("base64url");
	}

	private authenticated(
		from: string,
		to: string,
		session: string,
		seq: number,
		body: Frame,
	): string {
		return JSON.stringify({ from, to, session, seq, body });
	}

	private sendSecure(body: Frame): void {
		if (!this.socket || !this.up) throw new Error("node link is not authenticated");
		const session = this.sessionId();
		const seq = this.sendSeq + 1;
		const mac = createHmac("sha256", Buffer.from(this.linkKey, "base64url"))
			.update(this.authenticated(this.local.id, this.peer.id, session, seq, body))
			.digest("base64url");
		this.socket.send(JSON.stringify({ secure: true, seq, session, body, mac }));
		this.sendSeq = seq;
		this.noteActivity();
	}

	private noteActivity(): void {
		try {
			this.onActivity?.();
		} catch {
			// Presence bookkeeping must never break an authenticated transport.
		}
	}

	private openSecure(frame: Frame): Frame | null {
		if (
			frame.secure !== true ||
			typeof frame.seq !== "number" ||
			frame.seq !== this.receiveSeq + 1 ||
			typeof frame.session !== "string" ||
			typeof frame.body !== "object" ||
			!frame.body ||
			typeof frame.mac !== "string"
		) {
			this.socket?.close(1008, "invalid authenticated frame");
			return null;
		}
		const session = this.sessionId();
		if (frame.session !== session) {
			this.socket?.close(1008, "node session mismatch");
			return null;
		}
		const expected = createHmac("sha256", Buffer.from(this.linkKey, "base64url"))
			.update(
				this.authenticated(
					this.peer.id,
					this.local.id,
					session,
					frame.seq,
					frame.body,
				),
			)
			.digest();
		let supplied: Buffer;
		try {
			supplied = Buffer.from(frame.mac, "base64url");
		} catch {
			this.socket?.close(1008, "invalid node frame MAC");
			return null;
		}
		if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
			this.socket?.close(1008, "node frame MAC did not verify");
			return null;
		}
		this.receiveSeq = frame.seq;
		return frame.body;
	}

	detached(socket: NodeLinkSocket): void {
		if (socket !== this.socket) return;
		const wasUp = this.up;
		this.socket = null;
		this.direction = null;
		this.up = false;
		this.localNonce = "";
		this.remoteNonce = "";
		this.sendSeq = 0;
		this.receiveSeq = 0;
		if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
		this.handshakeTimer = null;
		this.rejectPending("node link closed");
		if (wasUp) this.onDown();
		this.scheduleReconnect();
	}

	private rejectPending(reason: string): void {
		for (const waiting of this.pending.values()) {
			clearTimeout(waiting.timer);
			waiting.reject(new Error(reason));
		}
		this.pending.clear();
	}

	private scheduleReconnect(): void {
		if (this.closed || this.reconnectTimer) return;
		/* Both sides retry now, so jitter keeps them from colliding on every
		 * attempt for the life of the outage. */
		const wait = this.backoff * (0.75 + Math.random() * 0.5);
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.connect();
		}, wait);
		this.backoff = Math.min(this.backoff * 1.6, RECONNECT_CEIL_MS);
	}

	close(): void {
		this.closed = true;
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
		this.reconnectTimer = null;
		this.handshakeTimer = null;
		this.connecting?.close();
		this.connecting = null;
		this.socket?.close();
		this.socket = null;
		this.up = false;
		this.rejectPending("node link closed");
	}

	status(): {
		nodeId: string;
		dialer: boolean;
		up: boolean;
		direction: "incoming" | "outgoing" | null;
	} {
		return {
			nodeId: this.nodeId,
			dialer: this.dialer,
			up: this.up,
			direction: this.direction,
		};
	}
}
