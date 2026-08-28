import type { Attachment, Persona, SessionInfo, SessionState } from "../../shared/types";
import { DEFAULT_BACKEND_ID } from "../acp/registry";
import { normalizePolicy } from "../mcp/servers";
import {
	isBannedFromRoom,
	listMembershipFacts,
	mergeMembershipFacts,
	selfExiled,
} from "../node/facts";
import { NodeLink, type NodeLinkServerHooks } from "../node/link";
import { admittedNode } from "../node/membership";
import { listRecords, type ResourceRecord } from "../store/records";
import {
	createFleetInvite,
	handleFleetNodeRpc,
	joinFleet,
	listFleetPeers,
	markFleetPeerSeen,
	parseRemoteTarget,
	peerWireAccess,
	remoteTargetId,
	teardownFleetPeer,
} from "./fleet";
import { meshCount } from "./metrics";
import { initSync, receiveEnvelope, syncLinkDown, syncLinkUp } from "./sync";

/**
 * The team in one app: each linked desktop's teammates appear here as
 * first-class personas with node-qualified ids, and everything about them —
 * chat, settings, session state — rides a standing connection to the desktop
 * they live on. Admitted nodes share one deterministic, mutually authenticated
 * NodeLink. Legacy fleet peers retain the older phone-shaped WebSocket until
 * they are re-admitted.
 *
 * Facts only travel first-hand. A peer's push about one of its own teammates
 * is rebroadcast here with the id qualified; anything already qualified is
 * someone else's rebroadcast and is dropped, which is what keeps two desktops
 * that are each other's clients from echoing forever.
 */

const CALL_TIMEOUT_MS = 20_000;
const RECONNECT_FLOOR_MS = 2_000;
const RECONNECT_CEIL_MS = 30_000;

type Pending = {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
};

type PeerConnection = {
	up: boolean;
	readonly nodeId: string;
	readonly nodeName: string;
	call(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
	close(): void;
};

class LegacyPeerWire implements PeerConnection {
	up = false;
	private ws: WebSocket | null = null;
	private pending = new Map<number, Pending>();
	private nextId = 1;
	private closed = false;
	private backoff = RECONNECT_FLOOR_MS;

	constructor(
		readonly nodeId: string,
		readonly nodeName: string,
		private readonly origin: string,
		private readonly token: string,
		private readonly onPush: (name: string, payload: unknown) => void,
		private readonly onUp: () => void,
		private readonly onDown: () => void,
	) {
		this.connect();
	}

	private connect(): void {
		if (this.closed) return;
		let ws: WebSocket;
		try {
			ws = new WebSocket(`${this.origin.replace(/^http/, "ws")}/ws?token=${this.token}`);
		} catch {
			this.scheduleReconnect();
			return;
		}
		this.ws = ws;
		ws.onopen = () => {
			this.up = true;
			this.backoff = RECONNECT_FLOOR_MS;
			this.onUp();
		};
		ws.onmessage = (event) => {
			let frame: { id?: number; ok?: boolean; result?: unknown; error?: string; push?: string; payload?: unknown };
			try {
				frame = JSON.parse(String(event.data));
			} catch {
				return;
			}
			if (typeof frame.id === "number") {
				const waiting = this.pending.get(frame.id);
				if (!waiting) return;
				this.pending.delete(frame.id);
				clearTimeout(waiting.timer);
				if (frame.ok) waiting.resolve(frame.result);
				else waiting.reject(new Error(frame.error ?? "peer call failed"));
				return;
			}
			if (typeof frame.push === "string") this.onPush(frame.push, frame.payload);
		};
		const drop = () => {
			if (this.ws !== ws) return;
			const wasUp = this.up;
			this.up = false;
			this.ws = null;
			for (const waiting of this.pending.values()) {
				clearTimeout(waiting.timer);
				waiting.reject(new Error("peer wire closed"));
			}
			this.pending.clear();
			if (wasUp) this.onDown();
			this.scheduleReconnect();
		};
		ws.onclose = drop;
		ws.onerror = drop;
	}

	private scheduleReconnect(): void {
		if (this.closed) return;
		setTimeout(() => this.connect(), this.backoff);
		this.backoff = Math.min(this.backoff * 1.6, RECONNECT_CEIL_MS);
	}

	call(method: string, params: unknown, timeoutMs = CALL_TIMEOUT_MS): Promise<unknown> {
		if (!this.up || !this.ws) {
			return Promise.reject(new Error(`${this.nodeName} is not reachable right now`));
		}
		const id = this.nextId++;
		const frame = JSON.stringify({ id, method, params });
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`${this.nodeName} did not answer`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			try {
				this.ws!.send(frame);
			} catch (error) {
				this.pending.delete(id);
				clearTimeout(timer);
				reject(error instanceof Error ? error : new Error("peer send failed"));
			}
		});
	}

	close(): void {
		this.closed = true;
		this.ws?.close();
	}
}

/* ---------------------------------------------------------------- manager */

const wires = new Map<string, PeerConnection>();
/** The secret each wire was built with, so a sweep can spot credential drift. */
const wireKeys = new Map<string, string>();
/** Last known session truth per qualified id, kept so a dropped wire can
 * report the same shape the peer would, just with the state set to stopped. */
const lastSessions = new Map<string, SessionInfo>();

let emit: (name: string, payload: unknown) => void = () => {};
let publishRoster: () => void = () => {};
let resolveLocal: (method: string) => ((params: unknown) => Promise<unknown>) | undefined = () => undefined;

export function initPeerWires(input: {
	/** Re-emits a peer's event to every client of THIS desktop. */
	send(name: string, payload: unknown): void;
	/** Announces the merged roster after a peer's slice changed. */
	publishPersonas(): void;
	/** Local RPC surface served bidirectionally over a NodeLink. */
	resolve?(method: string): ((params: unknown) => Promise<unknown>) | undefined;
}): void {
	emit = input.send;
	publishRoster = input.publishPersonas;
	if (input.resolve) resolveLocal = input.resolve;
	initSync({ publishRoster: input.publishPersonas, markSeen: markFleetPeerSeen });
	void syncPeerWires();
	/* Peers appear (joins) and disappear (revokes) rarely; a slow sweep is
	 * enough to notice both without threading callbacks through every path. */
	setInterval(() => void syncPeerWires(), 60_000);
}

/** Brings the wire set in line with fleet.json: dial new peers, drop gone ones. */
export async function syncPeerWires(): Promise<void> {
	const peers = listFleetPeers();
	const known = new Set(peers.map((peer) => peer.id));
	for (const [nodeId, wire] of wires) {
		if (!known.has(nodeId)) {
			wire.close();
			wires.delete(nodeId);
			wireKeys.delete(nodeId);
			publishRoster();
		}
	}
	for (const peer of peers) {
		const access = await peerWireAccess(peer.id);
		if (!access) continue;
		/* A wire is only as current as the secrets it was built with. Re-pairing
		 * replaces the pair's tokens, and a standing link born under the old
		 * ones would dial with a dead token and fail inbound MACs forever —
		 * worse, a socket abandoned mid-handshake by the other side can wedge
		 * as phantom-up. Credential drift is detected on every sweep and the
		 * wire rebuilt, so the mesh self-heals instead of trusting call order. */
		if (wires.has(peer.id)) {
			if (wireKeys.get(peer.id) === (access.linkKey ?? access.token)) continue;
			wires.get(peer.id)?.close();
			wires.delete(peer.id);
			wireKeys.delete(peer.id);
		}
		const onDown = () => {
			/* An unreachable desktop's teammates stay listed — a teammate
			 * you cannot reach still exists — but their sessions read as
			 * stopped until the wire returns. */
			for (const record of remoteOwnedRecords(peer.id)) {
				const known = lastSessions.get(remoteTargetId(peer.id, record.id));
				if (known) emit("sessionInfoChanged", { ...known, state: "stopped" });
			}
		};
		let wire: PeerConnection;
		if (access.transport === "node") {
			const admission = admittedNode(peer.id);
			if (!admission || !access.linkKey) continue;
			const link = new NodeLink(
				admission.node,
				access.origin,
				access.token,
				access.linkKey,
				(method) => peerMethod(peer.id, method) ?? resolveLocal(method),
				(name, payload) => onPeerPush(peer.id, name, payload),
				() => {
					syncLinkUp(peer.id, link);
					void onWireUp(peer.id);
					void officiateMesh();
				},
				() => {
					onDown();
					syncLinkDown(peer.id);
				},
				(env) => receiveEnvelope(peer.id, env),
				() => markFleetPeerSeen(peer.id),
			);
			wire = link;
		} else {
			wire = new LegacyPeerWire(
				peer.id,
				peer.name,
				access.origin,
				access.token,
				(name, payload) => onPeerPush(peer.id, name, payload),
				() => void onWireUp(peer.id),
				onDown,
			);
		}
		wires.set(
			peer.id,
			wire,
		);
		wireKeys.set(peer.id, access.linkKey ?? access.token);
	}
	void officiateMesh();
}

/* ------------------------------------------------------------ mesh closure
 * A room's roster is a promise: every member sees every teammate. v1 sync is
 * first-hand only and routing wants a direct wire to the owner, so the
 * promise holds only when membership is a full pairwise mesh. Any node
 * holding authenticated links to two peers who do not list each other
 * officiates — the same invite/claim dance the phone runs at pairing,
 * carried over the links it already trusts. Both directions are tried,
 * because reachability is not symmetric (a NAT'd desk dials out but cannot
 * be dialed); whichever claim lands first closes the pair. Nothing is
 * relayed: the introduced pair still proves identity to each other
 * end-to-end inside /fleet/pair, and sync stays first-hand.
 */

const OFFICIATE_COOLDOWN_MS = 5 * 60_000;
const OFFICIATE_RETRY_MS = 30_000;
const officiated = new Map<string, number>();

/** Peer-only RPC surface. Resolved before the app handler map and only for
 *  NodeLink callers, so a phone or web client can never reach it. */
const FLEET_METHODS = new Set([
	"deliver",
	"createTeammate",
	"readTranscript",
	"readThread",
	"notify",
	"webAccess",
]);

function peerMethod(
	peerId: string,
	method: string,
): ((params: unknown) => Promise<unknown>) | undefined {
	if (FLEET_METHODS.has(method)) {
		return (params) => handleFleetNodeRpc(peerId, method, params);
	}
	if (method === "meshPeers") {
		return async () => ({ peers: listFleetPeers().map(({ id, name }) => ({ id, name })) });
	}
	if (method === "meshInvite") {
		return async (params) => {
			const expected = (params as { expectedNodeId?: string } | null)?.expectedNodeId;
			if (typeof expected !== "string" || !expected) throw new Error("expectedNodeId required");
			return createFleetInvite(expected);
		};
	}
	if (method === "meshJoin") {
		return async (params) => {
			const input = params as { origin?: string; code?: string; nodeId?: string } | null;
			if (!input?.origin || !input.code) throw new Error("origin and code required");
			if (input.nodeId && isBannedFromRoom(input.nodeId)) {
				return { ok: false, error: "that node was removed from the room" };
			}
			/* "Already" means a live authenticated wire, not a stored row. A
			 * desk the room tore down while we were the one being revoked
			 * leaves us a stale row with dead tokens — trusting it would
			 * short-circuit the re-introduction that fixes exactly that. A
			 * fresh claim over an existing healthy pair is merely idempotent. */
			const held = input.nodeId ? wires.get(input.nodeId) : undefined;
			if (held instanceof NodeLink && held.up) {
				return { ok: true, already: true };
			}
			const result = await joinFleet({ origin: input.origin, code: input.code });
			if (result.ok) void syncPeerWires();
			return result;
		};
	}
	if (method === "membershipFacts") {
		return async () => ({ facts: listMembershipFacts() });
	}
	return undefined;
}

/* --------------------------------------------------------- room membership
 * Membership facts gossip: signed by their asserter over their full content,
 * they are self-certifying, which is the one principled exception to
 * first-hand-only sync — a relayed fact is not hearsay when its provenance
 * rides inside it. Full set on link-up, broadcast on change, rebroadcast only
 * when a merge changed something so the flood converges instead of looping.
 */

export function broadcastMembership(): void {
	broadcastNodeLinks("membershipFacts", { facts: listMembershipFacts() });
}

/**
 * Tears down and rebuilds the wire for one peer. Pairing replaces the pair's
 * secrets, and a standing NodeLink keeps the key it was born with — after a
 * re-admission the survivor's old wire object would dial with a dead token
 * and answer inbound handshakes with a stale MAC, poisoning both directions.
 * The wire that outlives its credentials is a bug wearing an optimization.
 */
export function refreshPeerWire(id: string): void {
	const wire = wires.get(id);
	if (wire) {
		wire.close();
		wires.delete(id);
		wireKeys.delete(id);
	}
	void syncPeerWires();
}

/** Merges gossip and applies it: a newly effective ban tears the node down
 *  on this desk — the local act driven by the replicated fact. */
export function applyMembershipFacts(incoming: unknown): void {
	const facts = (incoming as { facts?: unknown[] } | null)?.facts;
	if (!Array.isArray(facts)) return;
	const changed = mergeMembershipFacts(facts);
	/* Exile is decided here and only here — on facts that arrived from the
	 * room, never as a side effect of our own admitting. A desk re-pairing
	 * after a mutual revocation mints its half first and hears the other half
	 * moments later on the new wire; acting on the stale word in between
	 * would tear down the very invitation that was reinstating it. */
	if (selfExiled()) {
		leaveRoom();
		return;
	}
	membershipChanged(changed);
}

/**
 * The single sink for "the room's word on these nodes changed", whether the
 * change arrived by gossip or was minted on this desk — a locally asserted
 * re-admission must reset the officiate cooldown exactly like a received one,
 * or the hub sits out a stale five-minute timer while the room waits.
 */
export function membershipChanged(subjects: string[]): void {
	if (subjects.length === 0) return;
	for (const id of subjects) {
		/* Either direction of change re-opens introductions: a ban must stop
		 * being enforced-stale, a fresh admission must not wait out a cooldown
		 * recorded before the room knew the node. */
		for (const key of [...officiated.keys()]) {
			if (key.split("~").includes(id)) officiated.delete(key);
		}
		if (!isBannedFromRoom(id)) continue;
		const wire = wires.get(id);
		if (wire instanceof NodeLink && wire.up) {
			wire.push("membershipFacts", { facts: listMembershipFacts() });
		}
		teardownFleetPeer(id);
		if (wire) {
			wire.close();
			wires.delete(id);
			wireKeys.delete(id);
		}
		publishRoster();
	}
	broadcastMembership();
	void syncPeerWires();
}

/**
 * This desk was removed from the room. Drop every trace of the room — peers,
 * admissions, their replicated records, the wires — and keep everything that
 * is ours: our teammates, their transcripts, our own history. An exile is not
 * a wipe; it is a desk that is alone again, and can be invited back by the
 * ordinary pairing flow.
 */
function leaveRoom(): void {
	for (const peer of listFleetPeers()) {
		teardownFleetPeer(peer.id);
	}
	for (const [id, wire] of wires) {
		wire.close();
		wires.delete(id);
		wireKeys.delete(id);
	}
	officiated.clear();
	publishRoster();
}

async function officiateMesh(): Promise<void> {
	const links = [...wires.entries()].filter(
		(entry): entry is [string, NodeLink] => entry[1] instanceof NodeLink && entry[1].up,
	);
	if (links.length < 2) return;
	const now = Date.now();
	for (let i = 0; i < links.length; i++) {
		for (let j = i + 1; j < links.length; j++) {
			const [aId, aLink] = links[i]!;
			const [bId, bLink] = links[j]!;
			/* Membership outranks healing: a revoked node must not be
			 * helpfully re-introduced by a desk that has not torn it down yet. */
			if (isBannedFromRoom(aId) || isBannedFromRoom(bId)) continue;
			const key = [aId, bId].sort().join("~");
			if (now - (officiated.get(key) ?? 0) < OFFICIATE_COOLDOWN_MS) continue;
			officiated.set(key, now);
			void introducePair(aId, aLink, bId, bLink).then((settled) => {
				/* A failed introduction retries sooner than the cooldown — the
				 * usual cause is a leaf that was momentarily unreachable. */
				if (!settled) officiated.set(key, Date.now() - OFFICIATE_COOLDOWN_MS + OFFICIATE_RETRY_MS);
			});
		}
	}
}

/** One introduction: skip when the pair already know each other, otherwise
 *  invite on one side and claim from the other, in both directions, until a
 *  claim lands. Idempotent — a re-introduced pair answers `already`.
 *  Resolves true when the pair is settled (linked or already linked). */
async function introducePair(
	aId: string,
	aLink: NodeLink,
	bId: string,
	bLink: NodeLink,
): Promise<boolean> {
	try {
		const known = (await aLink.call("meshPeers", {})) as { peers?: Array<{ id: string }> };
		if (known.peers?.some((peer) => peer.id === bId)) return true;
	} catch {
		return false;
	}
	const directions = [
		{ inviter: aLink, inviterId: aId, joiner: bLink, joinerId: bId },
		{ inviter: bLink, inviterId: bId, joiner: aLink, joinerId: aId },
	];
	for (const { inviter, inviterId, joiner, joinerId } of directions) {
		try {
			const invite = (await inviter.call("meshInvite", { expectedNodeId: joinerId })) as {
				origin?: string;
				code?: string;
			};
			if (!invite.origin || !invite.code) continue;
			const joined = (await joiner.call("meshJoin", {
				origin: invite.origin,
				code: invite.code,
				nodeId: inviterId,
			})) as { ok?: boolean };
			if (joined.ok) {
				meshCount("meshIntroduction", `${aId}~${bId}`);
				return true;
			}
		} catch {
			// Unreachable in this direction is expected; the reverse gets its turn.
		}
	}
	return false;
}

export const nodeLinkServerHooks: NodeLinkServerHooks = {
	open(peerId, socket) {
		const wire = wires.get(peerId);
		if (!(wire instanceof NodeLink)) {
			socket.close(1008, "node link is not configured");
			return false;
		}
		return wire.accept(socket);
	},
	message(peerId, socket, raw) {
		const wire = wires.get(peerId);
		if (wire instanceof NodeLink) wire.receive(socket, raw);
	},
	close(peerId, socket) {
		const wire = wires.get(peerId);
		if (wire instanceof NodeLink) wire.detached(socket);
	},
};

export function broadcastNodeLinks(name: string, payload: unknown): void {
	let sent = false;
	for (const wire of wires.values()) {
		if (wire instanceof NodeLink && wire.push(name, payload)) sent = true;
	}
	if (sent) {
		meshCount("nodeLinkBroadcast", name, {
			bytes: JSON.stringify({ push: name, payload }).length,
		});
	}
}

export function nodeLinkSnapshot(): Array<{
	nodeId: string;
	dialer: boolean;
	up: boolean;
	direction: "incoming" | "outgoing" | null;
}> {
	return [...wires.values()]
		.filter((wire): wire is NodeLink => wire instanceof NodeLink)
		.map((wire) => wire.status());
}

function onWireUp(nodeId: string): void {
	const wire = wires.get(nodeId);
	if (!wire) return;
	/* Membership converges on contact: exchange full fact sets so a desk that
	 * was dark during a revocation learns it the moment any wire returns. A
	 * pre-membership peer answers unknown-method; that is fine and ignored. */
	if (wire instanceof NodeLink) {
		void wire
			.call("membershipFacts", {})
			.then((facts) => applyMembershipFacts(facts))
			.catch(() => {});
	}
	/* Fresh session truth for each remote teammate, so the merged rail's
	 * vitals are right without waiting for the next state change. */
	for (const record of remoteOwnedRecords(nodeId)) {
		void wire
			.call("getSessionInfo", { personaId: record.id })
			.then((info) => {
				const qualified = qualifySession(nodeId, info as SessionInfo);
				lastSessions.set(qualified.personaId, qualified);
				emit("sessionInfoChanged", qualified);
			})
			.catch(() => {});
	}
}

function qualifySession(nodeId: string, info: SessionInfo): SessionInfo {
	return { ...info, personaId: remoteTargetId(nodeId, info.personaId) };
}

function onPeerPush(nodeId: string, name: string, payload: unknown): void {
	const wire = wires.get(nodeId);
	if (!wire) return;
	meshCount("onPeerPush", name, { nodeId });
	switch (name) {
		case "membershipFacts": {
			/* Room policy, not a persona event: facts carry their own
			 * provenance (asserter-signed), so no first-hand qualification. */
			applyMembershipFacts(payload);
			return;
		}
		case "transcriptAppended":
		case "transcriptUpdated":
		case "streamDelta":
		case "sessionInfoChanged":
		case "faceProgress": {
			const body = payload as { personaId?: string };
			if (typeof body?.personaId !== "string" || body.personaId.includes("/")) {
				meshCount("onPeerPushDrop", name, { nodeId });
				return;
			}
			const qualified = { ...body, personaId: remoteTargetId(nodeId, body.personaId) };
			if (name === "sessionInfoChanged") {
				lastSessions.set(qualified.personaId, qualified as SessionInfo);
			}
			emit(name, qualified);
			return;
		}
		case "peerActivityChanged": {
			const record = payload as Record<string, unknown>;
			const qualified: Record<string, unknown> = {};
			for (const [id, activity] of Object.entries(record ?? {})) {
				if (id.includes("/")) continue;
				qualified[remoteTargetId(nodeId, id)] = activity;
			}
			/* Nothing of the peer's own survived the filter, so there is nothing
			 * first-hand to say. Emitting the empty shell anyway is how a push
			 * about somebody else's teammates becomes a push about nobody that
			 * still costs a round trip on every wire it touches. */
			if (Object.keys(qualified).length === 0) {
				meshCount("onPeerPushDrop", name, { nodeId });
				return;
			}
			emit(name, qualified);
			return;
		}
		case "schedulesChanged": {
			const jobs = (payload as Array<{ personaId?: string }>) ?? [];
			const qualified = jobs
				.filter((job) => typeof job.personaId === "string" && !job.personaId.includes("/"))
				.map((job) => ({ ...job, personaId: remoteTargetId(nodeId, job.personaId!) }));
			if (qualified.length === 0) {
				meshCount("onPeerPushDrop", name, { nodeId });
				return;
			}
			emit(name, qualified);
			return;
		}
		default:
			/* menuAction, windowStateChanged, peer threads: the peer's own
			 * window furniture, or surfaces v1 does not mirror. */
			meshCount("onPeerPushDrop", name, { nodeId });
			return;
	}
}

/** The pushes a peer's wire reads — the switch above, from the other end. */
const PEER_PUSHES = new Set([
	"transcriptAppended",
	"transcriptUpdated",
	"streamDelta",
	"sessionInfoChanged",
	"faceProgress",
	"peerActivityChanged",
	"schedulesChanged",
]);

/**
 * What of one local push belongs on the peer wires, or null for nothing.
 *
 * "Facts only travel first-hand" read from the sending end. A peer's event is
 * re-emitted here with its id qualified, so a fan-out that included the peers
 * would hand every desktop its own fact back to qualify and send again. Only
 * bare ids — this desk's own teammates — leave, and only for the handful of
 * pushes a wire is listening for; the rest is this window's own furniture.
 */
export function firstHandForPeers(name: string, payload: unknown): unknown | null {
	if (wires.size === 0 || !PEER_PUSHES.has(name)) return null;
	switch (name) {
		case "peerActivityChanged": {
			const record = (payload as Record<string, unknown>) ?? {};
			const mine = Object.fromEntries(
				Object.entries(record).filter(([id]) => !id.includes("/")),
			);
			return Object.keys(mine).length > 0 ? mine : null;
		}
		case "schedulesChanged": {
			const jobs = (payload as Array<{ personaId?: string }>) ?? [];
			const mine = jobs.filter(
				(job) => typeof job.personaId === "string" && !job.personaId.includes("/"),
			);
			return mine.length > 0 ? mine : null;
		}
		default: {
			const body = payload as { personaId?: string };
			if (typeof body?.personaId !== "string" || body.personaId.includes("/")) return null;
			return payload;
		}
	}
}

/** The last session state the wire heard for one remote teammate. */
export function remoteSessionState(qualifiedId: string): SessionState {
	return lastSessions.get(qualifiedId)?.state ?? "stopped";
}

/** Whether the standing wire to one peer is up. */
export function peerOnline(id: string): boolean {
	return wires.get(id)?.up === true;
}

function remoteOwnedRecords(peerId: string): ResourceRecord[] {
	return listRecords("persona").filter((record) => record.ownerNode === peerId);
}

function text(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/** A store-backed remote teammate: replicated fields only, machine-bound placeholders. */
function assembleRemotePersona(
	peer: { id: string; name: string },
	record: ResourceRecord,
): Persona {
	const replicated = record.replicated as Partial<Persona>;
	const team = text(replicated.team);
	const modelId = text(replicated.modelId);
	return {
		id: remoteTargetId(record.ownerNode, record.id),
		node: { id: record.ownerNode, name: peer.name },
		name: text(replicated.name) ?? "Untitled",
		goal: text(replicated.goal) ?? "",
		...(replicated.face ? { face: replicated.face } : {}),
		...(team !== undefined ? { team } : {}),
		backendId: text(replicated.backendId) || DEFAULT_BACKEND_ID,
		cwd: "",
		...(modelId !== undefined ? { modelId } : {}),
		mcpPolicy: normalizePolicy(undefined),
		sessionCheckpoints: [],
		createdAt:
			typeof replicated.createdAt === "number" ? replicated.createdAt : record.updatedAt,
		updatedAt: record.updatedAt,
	};
}

/** Every linked desktop's teammates, qualified, for the merged roster. */
export function remotePersonas(): Persona[] {
	const merged: Persona[] = [];
	for (const peer of listFleetPeers()) {
		for (const record of remoteOwnedRecords(peer.id)) {
			merged.push(assembleRemotePersona(peer, record));
		}
	}
	return merged;
}

/* ---------------------------------------------------------------- routing */

/** Which request methods follow a persona to its desktop, and by which key. */
const ROUTED: Record<string, { key: "personaId" | "id"; result?: "session" | "persona" }> = {
	loadTranscript: { key: "personaId" },
	toggleReaction: { key: "personaId" },
	searchThread: { key: "personaId" },
	listChapters: { key: "personaId" },
	startFreshChapter: { key: "personaId" },
	listPeerThreads: { key: "personaId" },
	listSchedules: { key: "personaId" },
	sendPrompt: { key: "personaId" },
	steerPrompt: { key: "personaId" },
	cancelTurn: { key: "personaId" },
	answerPermission: { key: "personaId" },
	startSession: { key: "personaId", result: "session" },
	stopSession: { key: "personaId" },
	getSessionInfo: { key: "personaId", result: "session" },
	setModel: { key: "personaId", result: "session" },
	setMode: { key: "personaId", result: "session" },
	setConfig: { key: "personaId", result: "session" },
	composeFace: { key: "personaId" },
	updatePersona: { key: "id", result: "persona" },
};

/** A prompt is worth carrying whole; a file bigger than this is not. */
const ATTACHMENT_SHIP_MAX = 32 * 1024 * 1024;

/**
 * An attachment's path names a file on THIS machine; the teammate about to
 * read it lives on another. Ship the bytes ahead over the same wire —
 * `saveAttachment` already exists for a webview's pasted images, and the
 * owner hands back a path on its own disk — then send the prompt pointing
 * at where the file now lives. A file that cannot ship (gone, oversized)
 * passes through untouched and the owner's own fencing says so.
 */
async function shipAttachments(
	wire: PeerConnection,
	barePersonaId: string,
	params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const list = params.attachments as Attachment[] | undefined;
	if (!list?.length) return params;
	const shipped = await Promise.all(
		list.map(async (attachment) => {
			try {
				const file = Bun.file(attachment.path);
				if (!(await file.exists()) || file.size > ATTACHMENT_SHIP_MAX) return attachment;
				const data = Buffer.from(await file.arrayBuffer()).toString("base64");
				return (await wire.call(
					"saveAttachment",
					{
						personaId: barePersonaId,
						name: attachment.name,
						mimeType: attachment.mimeType ?? "application/octet-stream",
						data,
					},
					60_000,
				)) as Attachment;
			} catch {
				return attachment;
			}
		}),
	);
	return { ...params, attachments: shipped };
}

/**
 * Wraps the app's one request map so calls about a node-qualified persona ride
 * the wire to the desktop that owns it. Both the desktop webview and every
 * web client resolve from this map, so one wrap covers every surface.
 */
export function routeRemotePersonas(
	handlers: Record<string, (params: never) => Promise<unknown>>,
): void {
	for (const [method, route] of Object.entries(ROUTED)) {
		const local = handlers[method] as ((params: unknown) => Promise<unknown>) | undefined;
		if (!local) continue;
		handlers[method] = (async (params: Record<string, unknown>) => {
			const target = typeof params?.[route.key] === "string" ? (params[route.key] as string) : "";
			const remote = parseRemoteTarget(target);
			if (!remote) return local(params);
			const wire = wires.get(remote.nodeId);
			if (!wire) throw new Error("That desktop is not linked");
			let forward: Record<string, unknown> = { ...params, [route.key]: remote.personaId };
			if (method === "sendPrompt" || method === "steerPrompt") {
				forward = await shipAttachments(wire, remote.personaId, forward);
			}
			const result = await wire.call(method, forward);
			if (route.result === "session") return qualifySession(remote.nodeId, result as SessionInfo);
			if (route.result === "persona") {
				const persona = result as Persona;
				return {
					...persona,
					id: remoteTargetId(remote.nodeId, persona.id),
					node: { id: remote.nodeId, name: wire.nodeName },
				};
			}
			return result;
		}) as (params: never) => Promise<unknown>;
	}
}

/**
 * Merges a keyed-by-persona record (previews, peer activity) from every
 * reachable peer into the local one. Peers that fail to answer contribute
 * nothing rather than delaying the roster.
 *
 * `localMethod` must name a handler that answers with one desk's own records
 * and nothing else — never the merging handler that called this. Asking a
 * peer to merge is asking it to ask us, and two desks each waiting on the
 * other's answer is how a roster refresh becomes a standing conversation.
 */
export async function mergePeerRecords<T>(
	localMethod: string,
	local: Record<string, T>,
): Promise<Record<string, T>> {
	meshCount("mergePeerRecords", localMethod);
	const merged = { ...local };
	await Promise.all(
		[...wires.values()]
			.filter((wire) => wire.up)
			.map(async (wire) => {
				try {
					/* Garnish, not structure: a peer that is up but not answering —
					 * its own modal open, say — must not hold the roster hostage. */
					meshCount("wireCallLocal", localMethod, { nodeId: wire.nodeId });
					const theirs = (await wire.call(localMethod, {}, 4_000)) as Record<string, T>;
					for (const [id, value] of Object.entries(theirs ?? {})) {
						if (id.includes("/")) continue;
						merged[remoteTargetId(wire.nodeId, id)] = value;
					}
				} catch {
					/* Unreachable: their rows simply show without this garnish. */
				}
			}),
	);
	return merged;
}

/**
 * A drag's new order, delivered to every desk it names: each peer receives
 * only its own teammates' relative order, in bare ids — a complete reorder
 * of that desk's roster, since the merged rail shows all of it.
 */
export function routePersonaOrder(ids: string[]): void {
	const byNode = new Map<string, string[]>();
	for (const id of ids) {
		const remote = parseRemoteTarget(id);
		if (!remote) continue;
		const list = byNode.get(remote.nodeId) ?? [];
		list.push(remote.personaId);
		byNode.set(remote.nodeId, list);
	}
	for (const [nodeId, bare] of byNode) {
		const wire = wires.get(nodeId);
		if (!wire?.up) continue;
		void wire.call("setPersonaOrder", { ids: bare }).catch(() => {});
	}
}

/**
 * Which linked desktop a peer-thread key lives on. A thread file sits where
 * delivery ran: the side written as a bare persona id names that desk; the
 * `remote:`-prefixed side is the visitor. A key whose bare side is one of a
 * peer's teammates belongs to that peer.
 */
export function peerOwningThreadKey(threadKey: string): string | null {
	for (const side of threadKey.split("~")) {
		if (side.startsWith("remote:")) continue;
		for (const peer of listFleetPeers()) {
			if (remoteOwnedRecords(peer.id).some((record) => record.id === side)) {
				return peer.id;
			}
		}
	}
	return null;
}

/** The wire for one node, for paths that need bespoke handling (delete). */
export function peerWireFor(nodeId: string): {
	call(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
	nodeName: string;
} | null {
	const wire = wires.get(nodeId);
	return wire?.up ? wire : null;
}
