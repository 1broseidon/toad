import { randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import type { Persona, SessionInfo, TranscriptEvent } from "../../shared/types";
import { bridgeSocketPath, ensureLayout } from "../paths";
import { getPersona, listPersonas } from "../store/personas";
import * as transcript from "../store/transcript";
import {
	BRIDGE_VERSION,
	MAX_FRAME_BYTES,
	failure,
	isRequest,
	success,
	type BridgeErrorCode,
	type BridgeRequest,
	type BridgeResponse,
	type BridgeScope,
	type Chain,
} from "./protocol";

type SupervisorLike = {
	info(personaId: string): SessionInfo;
};

type DeliverResult =
	| { ok: true; from: string; reply: string; note?: string }
	| { ok: false; reason: BridgeErrorCode; detail: string };

type PeersLike = {
	deliver(input: {
		callerId: string;
		targetId: string;
		message: string;
		chain: Chain;
	}): Promise<DeliverResult>;
	activeDelivery(key: string): Chain | undefined;
};

type ConnectionState = {
	buffer: string;
	scope?: BridgeScope;
	inflight: number;
};

let activeBridge: Bridge | undefined;

export function registerBridgeScope(token: string, scope: BridgeScope): void {
	activeBridge?.register(token, scope);
}

export function revokeBridgeScope(token: string): void {
	activeBridge?.revoke(token);
}

/** Returns the socket path only while this process owns a live bridge. */
export function bridgeAttachmentEnabled(): string | undefined {
	return activeBridge?.socketPath;
}

function sameToken(left: string, right: string): boolean {
	const a = Buffer.from(left);
	const b = Buffer.from(right);
	return a.length === b.length && timingSafeEqual(a, b);
}

function text(value: unknown, max: number): string | undefined {
	return typeof value === "string" && value.length <= max ? value : undefined;
}

function integer(value: unknown, fallback: number, min: number, max: number): number | undefined {
	const resolved = value === undefined ? fallback : value;
	return Number.isInteger(resolved) && Number(resolved) >= min && Number(resolved) <= max
		? Number(resolved)
		: undefined;
}

function peerSessionKey(scope: Extract<BridgeScope, { kind: "peer" }>): string {
	return `${scope.threadKey}|${scope.callerId}->${scope.targetId}`;
}

export class Bridge {
	private tokens = new Map<string, BridgeScope>();
	private listener?: Bun.UnixSocketListener<ConnectionState>;
	readonly socketPath = bridgeSocketPath();

	constructor(
		private dependencies: {
			supervisor: SupervisorLike;
			peers: PeersLike;
		},
	) {}

	async start(): Promise<boolean> {
		ensureLayout();
		if (existsSync(this.socketPath)) {
			if (await this.probeLiveOwner()) return false;
			try {
				unlinkSync(this.socketPath);
			} catch {
				return false;
			}
		}
		try {
			this.listener = Bun.listen<ConnectionState>({
				unix: this.socketPath,
				data: { buffer: "", inflight: 0 },
				socket: {
					open(socket) {
						socket.data = { buffer: "", inflight: 0 };
					},
					data: (socket, bytes) => this.onData(socket, bytes),
					error: (socket) => socket.terminate(),
				},
			});
			activeBridge = this;
			return true;
		} catch {
			return false;
		}
	}

	register(token: string, scope: BridgeScope): void {
		if (activeBridge === this) this.tokens.set(token, scope);
	}

	revoke(token: string): void {
		this.tokens.delete(token);
	}

	stop(): void {
		this.tokens.clear();
		this.listener?.stop(true);
		this.listener = undefined;
		if (activeBridge === this) activeBridge = undefined;
		if (existsSync(this.socketPath)) {
			try {
				unlinkSync(this.socketPath);
			} catch {
				// Shutdown is best-effort; the next start probes before removing it.
			}
		}
	}

	private async probeLiveOwner(): Promise<boolean> {
		return new Promise<boolean>((resolve) => {
			let settled = false;
			const finish = (value: boolean) => {
				if (settled) return;
				settled = true;
				resolve(value);
			};
			const timer = setTimeout(() => finish(false), 300);
			void Bun.connect<{ buffer: string }>({
				unix: this.socketPath,
				data: { buffer: "" },
				socket: {
					open(socket) {
						socket.write(
							`${JSON.stringify({
								v: BRIDGE_VERSION,
								id: 1,
								method: "hello",
								params: { token: "probe" },
							})}\n`,
						);
					},
					data(socket, bytes) {
						socket.data.buffer += bytes.toString();
						const line = socket.data.buffer.split("\n")[0];
						if (!line) return;
						try {
							const frame = JSON.parse(line) as Partial<BridgeResponse>;
							finish(frame.v === BRIDGE_VERSION && frame.id === 1 && typeof frame.ok === "boolean");
						} catch {
							finish(false);
						}
						clearTimeout(timer);
						socket.end();
					},
					connectError() {
						clearTimeout(timer);
						finish(false);
					},
					error() {
						clearTimeout(timer);
						finish(false);
					},
				},
			}).catch(() => finish(false));
		});
	}

	private onData(socket: Bun.Socket<ConnectionState>, bytes: Buffer): void {
		socket.data.buffer += bytes.toString("utf8");
		if (!socket.data.buffer.includes("\n") && Buffer.byteLength(socket.data.buffer) > MAX_FRAME_BYTES) {
			socket.terminate();
			return;
		}
		for (;;) {
			const newline = socket.data.buffer.indexOf("\n");
			if (newline === -1) return;
			const line = socket.data.buffer.slice(0, newline);
			socket.data.buffer = socket.data.buffer.slice(newline + 1);
			if (Buffer.byteLength(line) > MAX_FRAME_BYTES) {
				socket.terminate();
				return;
			}
			let raw: unknown;
			try {
				raw = JSON.parse(line);
			} catch {
				socket.write(`${JSON.stringify(failure(0, "bad_params", "Invalid bridge frame"))}\n`);
				continue;
			}
			if (!isRequest(raw)) {
				socket.write(`${JSON.stringify(failure(0, "bad_params", "Invalid bridge frame"))}\n`);
				continue;
			}
			if (!socket.data.scope && raw.method !== "hello") {
				socket.end(`${JSON.stringify(failure(raw.id, "unauthenticated", "Authentication required"))}\n`);
				return;
			}
			if (socket.data.inflight >= 4) {
				socket.write(`${JSON.stringify(failure(raw.id, "busy", "Too many requests"))}\n`);
				continue;
			}
			socket.data.inflight++;
			void this.handle(raw, socket.data)
				.then((response) => {
					const encoded = `${JSON.stringify(response)}\n`;
					if (raw.method === "hello" && !response.ok) socket.end(encoded);
					else socket.write(encoded);
				})
				.finally(() => {
					socket.data.inflight--;
				});
		}
	}

	private async handle(request: BridgeRequest, connection: ConnectionState): Promise<BridgeResponse> {
		try {
			if (request.method === "hello") {
				if (connection.scope) return failure(request.id, "bad_params", "Already authenticated");
				const supplied = text(request.params.token, 128);
				const match = supplied
					? [...this.tokens.entries()].find(([token]) => sameToken(token, supplied))
					: undefined;
				if (!match) return failure(request.id, "unauthenticated", "Authentication failed");
				connection.scope = match[1];
				const persona = getPersona(match[1].personaId);
				return success(request.id, {
					personaId: match[1].personaId,
					name: persona?.name ?? "Unknown teammate",
					scope: match[1].kind,
				});
			}

			const scope = connection.scope;
			if (!scope) return failure(request.id, "unauthenticated", "Authentication required");
			switch (request.method) {
				case "get_context":
					return this.getContext(request.id, scope);
				case "list_teammates":
					return this.listTeammates(request.id, scope);
				case "message_teammate":
					return await this.messageTeammate(request.id, scope, request.params);
				case "read_transcript":
					return this.readTranscript(request.id, request.params);
				case "search_transcripts":
					return this.searchTranscripts(request.id, request.params);
				default:
					return failure(request.id, "unknown_method", "Unknown bridge method");
			}
		} catch {
			return failure(request.id, "internal", "The bridge could not complete the request");
		}
	}

	private getContext(id: number, scope: BridgeScope): BridgeResponse {
		const persona = getPersona(scope.personaId);
		if (!persona) return failure(id, "not_found", "Teammate not found");
		return success(id, {
			personaId: persona.id,
			name: persona.name,
			goal: persona.goal,
			cwd: persona.cwd,
			backendId: persona.backendId,
		});
	}

	private listTeammates(id: number, scope: BridgeScope): BridgeResponse {
		return success(id, {
			teammates: listPersonas().map((persona) => ({
				personaId: persona.id,
				name: persona.name,
				goal: persona.goal,
				backendId: persona.backendId,
				status: this.dependencies.supervisor.info(persona.id).state,
				isYou: persona.id === scope.personaId,
			})),
		});
	}

	private async messageTeammate(
		id: number,
		scope: BridgeScope,
		params: Record<string, unknown>,
	): Promise<BridgeResponse> {
		const targetId = text(params.target, 200);
		const message = text(params.message, 24_000);
		if (!targetId || message === undefined || message.length === 0) {
			return failure(id, "bad_params", "A target and non-empty message are required");
		}
		let chain: Chain;
		if (scope.kind === "human") {
			chain = { id: randomUUID(), depth: 0, path: [] };
		} else {
			const inherited = this.dependencies.peers.activeDelivery(peerSessionKey(scope));
			if (!inherited) return failure(id, "internal", "No active peer delivery");
			chain = { ...inherited, depth: inherited.depth + 1 };
		}
		const result = await this.dependencies.peers.deliver({
			callerId: scope.personaId,
			targetId,
			message,
			chain,
		});
		if (!result.ok) return failure(id, result.reason, result.detail);
		return success(id, {
			from: result.from,
			reply: result.reply,
			...(result.note ? { note: result.note } : {}),
		});
	}

	private readTranscript(id: number, params: Record<string, unknown>): BridgeResponse {
		const target = text(params.target, 200);
		const limit = integer(params.limit, 30, 1, 100);
		if (!target || limit === undefined) return failure(id, "bad_params", "Invalid transcript request");
		const persona = getPersona(target);
		if (!persona) return failure(id, "not_found", "Teammate not found");
		const all = transcript
			.load(target)
			.filter(
				(event): event is Extract<TranscriptEvent, { kind: "user" | "agent" }> =>
					event.kind === "user" || event.kind === "agent",
			);
		const selected = all.slice(-limit).map((event) => ({
			from: event.kind === "user" ? "user" : "teammate",
			text: event.text,
			at: event.ts,
		}));
		let truncated = selected.length < all.length;
		while (selected.length > 1 && JSON.stringify(selected).length > 20_000) {
			selected.shift();
			truncated = true;
		}
		if (selected[0] && JSON.stringify(selected).length > 20_000) {
			selected[0].text = selected[0].text.slice(-19_000);
			truncated = true;
		}
		return success(id, {
			personaId: persona.id,
			name: persona.name,
			messages: selected,
			truncated,
		});
	}

	private searchTranscripts(id: number, params: Record<string, unknown>): BridgeResponse {
		const query = text(params.query, 200);
		const limit = integer(params.limit, 20, 1, 40);
		if (!query || query.length < 2 || limit === undefined) {
			return failure(id, "bad_params", "Invalid transcript search");
		}
		const requested = params.targets;
		if (
			requested !== undefined &&
			(!Array.isArray(requested) || requested.some((item) => typeof item !== "string"))
		) {
			return failure(id, "bad_params", "Invalid transcript targets");
		}
		const allowed = new Map(listPersonas().map((persona) => [persona.id, persona]));
		const personas: Persona[] = requested
			? (requested as string[]).map((target) => allowed.get(target)).filter(Boolean) as Persona[]
			: [...allowed.values()];
		const needle = query.toLowerCase();
		const hits: Array<Record<string, unknown>> = [];
		let total = 0;
		for (const persona of personas) {
			for (const event of transcript.load(persona.id)) {
				if (event.kind !== "user" && event.kind !== "agent") continue;
				const index = event.text.toLowerCase().indexOf(needle);
				if (index === -1) continue;
				total++;
				if (hits.length >= limit) continue;
				const start = Math.max(0, index - 160);
				const end = Math.min(event.text.length, index + query.length + 160);
				hits.push({
					personaId: persona.id,
					name: persona.name,
					from: event.kind === "user" ? "user" : "teammate",
					at: event.ts,
					excerpt: event.text.slice(start, end),
				});
			}
		}
		return success(id, { hits, truncated: total > hits.length });
	}
}
