import type { Persona, SessionInfo, SessionState } from "../../shared/types";
import { listFleetPeers, parseRemoteTarget, peerWireAccess, remoteTargetId } from "./fleet";

/**
 * The team in one app: each linked desktop's teammates appear here as
 * first-class personas with node-qualified ids, and everything about them —
 * chat, settings, session state — rides a standing WebSocket to the desktop
 * they live on. This bun is simply a device on the peer's wire, speaking the
 * exact protocol a phone speaks; the peer neither knows nor cares that the
 * client is another desktop.
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

class PeerWire {
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

const wires = new Map<string, PeerWire>();
/** Each peer's roster, ids already qualified, in fleet.json peer order. */
const rosters = new Map<string, Persona[]>();
/** Last known session truth per qualified id, kept so a dropped wire can
 * report the same shape the peer would, just with the state set to stopped. */
const lastSessions = new Map<string, SessionInfo>();

let emit: (name: string, payload: unknown) => void = () => {};
let publishRoster: () => void = () => {};

export function initPeerWires(input: {
	/** Re-emits a peer's event to every client of THIS desktop. */
	send(name: string, payload: unknown): void;
	/** Announces the merged roster after a peer's slice changed. */
	publishPersonas(): void;
}): void {
	emit = input.send;
	publishRoster = input.publishPersonas;
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
			rosters.delete(nodeId);
			publishRoster();
		}
	}
	for (const peer of peers) {
		if (wires.has(peer.id)) continue;
		const access = await peerWireAccess(peer.id);
		if (!access) continue;
		wires.set(
			peer.id,
			new PeerWire(
				peer.id,
				peer.name,
				access.origin,
				access.token,
				(name, payload) => onPeerPush(peer.id, name, payload),
				() => void onWireUp(peer.id),
				() => {
					/* An unreachable desktop's teammates stay listed — a teammate
					 * you cannot reach still exists — but their sessions read as
					 * stopped until the wire returns. */
					for (const persona of rosters.get(peer.id) ?? []) {
						const known = lastSessions.get(persona.id);
						if (known) emit("sessionInfoChanged", { ...known, state: "stopped" });
					}
				},
			),
		);
	}
}

async function onWireUp(nodeId: string): Promise<void> {
	const wire = wires.get(nodeId);
	if (!wire) return;
	try {
		const listed = (await wire.call("listPersonas", {})) as Persona[];
		rosters.set(nodeId, qualifyRoster(nodeId, wire.nodeName, listed));
		publishRoster();
		/* Fresh session truth for each remote teammate, so the merged rail's
		 * vitals are right without waiting for the next state change. */
		for (const persona of rosters.get(nodeId) ?? []) {
			const bare = parseRemoteTarget(persona.id);
			if (!bare) continue;
			void wire
				.call("getSessionInfo", { personaId: bare.personaId })
				.then((info) => {
					const qualified = qualifySession(nodeId, info as SessionInfo);
					lastSessions.set(qualified.personaId, qualified);
					emit("sessionInfoChanged", qualified);
				})
				.catch(() => {});
		}
	} catch {
		/* The roster will arrive with the peer's next personasChanged. */
	}
}

function qualifyRoster(nodeId: string, nodeName: string, listed: Persona[]): Persona[] {
	return listed
		.filter((persona) => !persona.id.includes("/"))
		.map((persona) => ({
			...persona,
			id: remoteTargetId(nodeId, persona.id),
			node: { id: nodeId, name: nodeName },
		}));
}

function qualifySession(nodeId: string, info: SessionInfo): SessionInfo {
	return { ...info, personaId: remoteTargetId(nodeId, info.personaId) };
}

function onPeerPush(nodeId: string, name: string, payload: unknown): void {
	const wire = wires.get(nodeId);
	if (!wire) return;
	switch (name) {
		case "personasChanged": {
			rosters.set(nodeId, qualifyRoster(nodeId, wire.nodeName, payload as Persona[]));
			publishRoster();
			return;
		}
		case "transcriptAppended":
		case "transcriptUpdated":
		case "streamDelta":
		case "sessionInfoChanged":
		case "faceProgress": {
			const body = payload as { personaId?: string };
			if (typeof body?.personaId !== "string" || body.personaId.includes("/")) return;
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
			emit(name, qualified);
			return;
		}
		case "schedulesChanged": {
			const jobs = (payload as Array<{ personaId?: string }>) ?? [];
			emit(
				name,
				jobs
					.filter((job) => typeof job.personaId === "string" && !job.personaId.includes("/"))
					.map((job) => ({ ...job, personaId: remoteTargetId(nodeId, job.personaId!) })),
			);
			return;
		}
		default:
			/* menuAction, windowStateChanged, peer threads: the peer's own
			 * window furniture, or surfaces v1 does not mirror. */
			return;
	}
}

/** The last session state the wire heard for one remote teammate. */
export function remoteSessionState(qualifiedId: string): SessionState {
	return lastSessions.get(qualifiedId)?.state ?? "stopped";
}

/** Every linked desktop's teammates, qualified, for the merged roster. */
export function remotePersonas(): Persona[] {
	const merged: Persona[] = [];
	for (const peer of listFleetPeers()) merged.push(...(rosters.get(peer.id) ?? []));
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
			const result = await wire.call(method, { ...params, [route.key]: remote.personaId });
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
 */
export async function mergePeerRecords<T>(
	method: string,
	local: Record<string, T>,
): Promise<Record<string, T>> {
	const merged = { ...local };
	await Promise.all(
		[...wires.values()]
			.filter((wire) => wire.up)
			.map(async (wire) => {
				try {
					/* Garnish, not structure: a peer that is up but not answering —
					 * its own modal open, say — must not hold the roster hostage. */
					const theirs = (await wire.call(method, {}, 4_000)) as Record<string, T>;
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

/** The wire for one node, for paths that need bespoke handling (delete). */
export function peerWireFor(nodeId: string): { call(method: string, params: unknown): Promise<unknown>; nodeName: string } | null {
	const wire = wires.get(nodeId);
	return wire?.up ? wire : null;
}
