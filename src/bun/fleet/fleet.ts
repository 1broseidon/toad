import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
	FleetNodeRoster,
	FleetTeammate,
	NodeIdentity,
	SessionState,
} from "../../shared/types";
import { ROOT, ensureLayout } from "../paths";
import { isNodeIdentity, nodeIdentity, signNodePayload, verifyNodePayload } from "../node/identity";
import { admitNode, forgetAdmittedNode } from "../node/membership";
import { listPersonas } from "../store/personas";
import { deviceForPeer, instanceIdentity, revokeDevicesForPeer } from "../web/devices";

/**
 * The fleet: other Toad desktops on the same LAN, linked to this one.
 *
 * The design is deliberately smaller than it sounds. Desktops do not share a
 * runtime, migrate agents, or replicate transcripts. Each one stays fully
 * authoritative over its own teammates; the fleet layer only does two things:
 *
 *  1. **Presence.** A desktop answers a trusted peer's "who lives with you?"
 *     with a snapshot — names, teams, faces, states. That is what merges the
 *     rosters into one room and lets a local agent see the whole team.
	 *  2. **Delivery.** A trusted peer can hand one message to one local teammate
	 *     and wait for the single reply on the wire. The caller's
	 *     `message_teammate` tool does not wait — it is notified when that
	 *     reply lands.
 *
 * Trust is pairwise bearer tokens, minted during a pairing the *phone*
 * brokers: the phone is already trusted by both desktops, so it carries the
 * invitation code from one to the other and the desktops then talk directly.
 * Peers authenticate against a deny-by-default surface of exactly two
 * methods; a peer can never reach the general RPC the phone uses.
 *
 * v1 is same-LAN, plain HTTP to raw addresses — the transport pairing already
 * uses. Reachability beyond the LAN is the gateway's future job, not this
 * module's.
 */

const INVITE_MS = 2 * 60_000;
const SNAPSHOT_TTL_MS = 15_000;
/** Delivery rides a session turn, which can legitimately take minutes. */
const DELIVER_TIMEOUT_MS = 10.5 * 60_000;

export type FleetPeer = {
	id: string;
	name: string;
	origin: string;
	/** What we present when calling them. */
	callToken: string;
	/** What they must present when calling us. */
	acceptToken: string;
	addedAt: number;
	lastSeenAt?: number;
	/** Our standing credential to their wire, once minted via webAccess. */
	webToken?: string;
	webOrigin?: string;
	/** New peers use the node server directly; absent rows keep the web bridge. */
	transport?: "node";
};

type Store = { version: 1; peers: FleetPeer[] };

const FILE = () => join(ROOT, "fleet.json");

function read(): Store {
	try {
		if (existsSync(FILE())) return JSON.parse(readFileSync(FILE(), "utf8")) as Store;
	} catch {
		/* unreadable is empty */
	}
	return { version: 1, peers: [] };
}

function write(store: Store): void {
	ensureLayout();
	writeFileSync(FILE(), JSON.stringify(store, null, "\t"));
}

function tokensEqual(a: string, b: string): boolean {
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	return left.length === right.length && timingSafeEqual(left, right);
}

/* ------------------------------------------------------------- wiring in */

type FleetMessage = { from: "user" | "teammate"; text: string; at: number };

type Deps = {
	/** Live session state for one local teammate. */
	stateOf(personaId: string): SessionState;
	/** Creates a teammate here on a linked desktop's (user-initiated) behalf. */
	createTeammate(draft: {
		name: string;
		goal?: string;
		team?: string;
	}): { personaId: string; name: string };
	/** A teammate's recent conversation, messages only, for a trusted peer. */
	readTranscript(personaId: string, limit: number): {
		personaId: string;
		name: string;
		messages: FleetMessage[];
		truncated: boolean;
	} | null;
	/**
	 * The standing thread between a local teammate and a remote caller —
	 * the remote side's DMs, which live here because delivery ran here.
	 */
	readThread(input: {
		localPersonaId: string;
		remoteNodeId: string;
		remotePersonaId: string;
		limit: number;
	}): {
		name: string;
		messages: Array<{ from: "me" | "them"; text: string; at: number }>;
		truncated: boolean;
	} | null;
	/** Hands one message to one local teammate; resolves with the reply. */
	deliver(input: {
		fromNode: { id: string; name: string };
		fromPersona: { id: string; name: string };
		targetPersonaId: string;
		message: string;
	}): Promise<{ ok: boolean; reply?: string; detail?: string }>;
	/** This desktop's reachable plain-HTTP origin on the LAN. */
	httpOrigin(): string | null;
	/** The control-plane listener, independent of phone web access. */
	nodeOrigin?(): string | null;
};

let deps: Deps | undefined;

export function initFleet(next: Deps): void {
	deps = next;
}

export function fleetNode(): { id: string; name: string } {
	const node = nodeIdentity();
	return { id: node.id, name: node.name };
}

export function listFleetPeers(): Array<Pick<FleetPeer, "id" | "name" | "origin" | "addedAt" | "lastSeenAt">> {
	return read().peers.map(({ id, name, origin, addedAt, lastSeenAt }) => ({
		id,
		name,
		origin,
		addedAt,
		lastSeenAt,
	}));
}

export function revokeFleetPeer(id: string): boolean {
	const store = read();
	const next = store.peers.filter((peer) => peer.id !== id);
	if (next.length === store.peers.length) return false;
	store.peers = next;
	write(store);
	cache.delete(id);
	forgetAdmittedNode(id);
	revokeDevicesForPeer(id);
	return true;
}

/* --------------------------------------------------------------- pairing
 * The phone officiates. It asks desktop A for an invite (an origin and a
 * short-lived code), hands both to desktop B, and B claims directly from A:
 * one POST carrying B's identity and the token A should use to call B,
 * answered with A's identity and the token B should use to call A. Both
 * sides store a peer; the code dies on first use.
 */

const invites = new Map<string, { expiresAt: number; expectedNodeId?: string }>();

export function createFleetInvite(
	expectedNodeId?: string,
): { origin: string; code: string } | { error: string } {
	const origin = deps?.nodeOrigin?.() ?? deps?.httpOrigin();
	if (!origin) return { error: "This desktop has no reachable address yet" };
	const code = randomBytes(4).toString("hex");
	invites.set(code, { expiresAt: Date.now() + INVITE_MS, expectedNodeId });
	return { origin, code };
}

/** Runs on the invited side (B): claims A's invite, stores A as a peer. */
export async function joinFleet(input: {
	origin: string;
	code: string;
}): Promise<{ ok: true; peer: { id: string; name: string } } | { ok: false; error: string }> {
	const nodeOrigin = deps?.nodeOrigin?.() ?? null;
	const legacyOrigin = deps?.httpOrigin() ?? null;
	const myOrigin = nodeOrigin ?? legacyOrigin;
	if (!myOrigin) return { ok: false, error: "This desktop has no reachable address yet" };
	const identity = nodeIdentity();
	const me = { id: identity.id, name: identity.name };
	const accept = randomBytes(24).toString("hex");
	const claim = { code: input.code, identity, nodeOrigin: myOrigin, token: accept };
	let response: Response;
	try {
		response = await fetch(new URL("/fleet/pair", input.origin), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				code: input.code,
				node: me,
				origin: legacyOrigin ?? myOrigin,
				identity,
				nodeOrigin: myOrigin,
				token: accept,
				proof: signNodePayload("fleet-pair-claim", claim),
			}),
			signal: AbortSignal.timeout(10_000),
		});
	} catch {
		return { ok: false, error: "Could not reach that desktop" };
	}
	if (!response.ok) return { ok: false, error: "That desktop refused the code" };
	const body = (await response.json()) as {
		node?: { id: string; name: string };
		identity?: NodeIdentity;
		nodeOrigin?: string;
		token?: string;
		proof?: string;
	};
	if (!body.node?.id || !body.token) return { ok: false, error: "Malformed pairing reply" };
	let peerIdentity: NodeIdentity | null = null;
	let peerOrigin = input.origin;
	let transport: FleetPeer["transport"];
	if (body.identity || body.proof || body.nodeOrigin) {
		if (!isNodeIdentity(body.identity) || !body.proof || !body.nodeOrigin) {
			return { ok: false, error: "Malformed node identity in pairing reply" };
		}
		const reply = {
			requesterId: identity.id,
			identity: body.identity,
			nodeOrigin: body.nodeOrigin,
			token: body.token,
		};
		if (!verifyNodePayload(body.identity, "fleet-pair-reply", reply, body.proof)) {
			return { ok: false, error: "That desktop's identity proof did not verify" };
		}
		if (body.identity.id !== body.node.id || body.identity.name !== body.node.name) {
			return { ok: false, error: "That desktop returned mismatched node identities" };
		}
		peerIdentity = body.identity;
		peerOrigin = body.nodeOrigin;
		transport = "node";
	}
	const store = read();
	store.peers = store.peers.filter((peer) => peer.id !== body.node!.id);
	store.peers.push({
		id: body.node.id,
		name: body.node.name,
		origin: peerOrigin,
		callToken: body.token,
		acceptToken: accept,
		addedAt: Date.now(),
		...(transport ? { transport } : {}),
	});
	write(store);
	if (peerIdentity) admitNode(peerIdentity, peerOrigin);
	return { ok: true, peer: body.node };
}

/** Runs on the inviting side (A), under `/fleet/pair`. */
export function handleFleetPair(
	body: unknown,
	transport: "legacy" | "node" = "legacy",
): { status: number; body: unknown } {
	const input = body as {
		code?: string;
		node?: { id?: string; name?: string };
		origin?: string;
		identity?: NodeIdentity;
		nodeOrigin?: string;
		token?: string;
		proof?: string;
	};
	const invite = input.code ? invites.get(input.code) : undefined;
	if (!invite || invite.expiresAt < Date.now()) return { status: 403, body: { error: "bad code" } };
	if (!input.node?.id || !input.node.name || !input.origin || !input.token) {
		return { status: 400, body: { error: "bad request" } };
	}
	if (invite.expectedNodeId && invite.expectedNodeId !== input.node.id) {
		return { status: 403, body: { error: "invite belongs to another node" } };
	}
	let peerIdentity: NodeIdentity | null = null;
	if (transport === "node") {
		if (!isNodeIdentity(input.identity) || !input.nodeOrigin || !input.proof) {
			return { status: 400, body: { error: "node identity required" } };
		}
		if (input.identity.id !== input.node.id || input.identity.name !== input.node.name) {
			return { status: 400, body: { error: "node identity mismatch" } };
		}
		const claim = {
			code: input.code,
			identity: input.identity,
			nodeOrigin: input.nodeOrigin,
			token: input.token,
		};
		if (!verifyNodePayload(input.identity, "fleet-pair-claim", claim, input.proof)) {
			return { status: 403, body: { error: "bad identity proof" } };
		}
		peerIdentity = input.identity;
	}
	invites.delete(input.code!);
	const accept = randomBytes(24).toString("hex");
	const peerOrigin = peerIdentity ? input.nodeOrigin! : input.origin;
	const store = read();
	store.peers = store.peers.filter((peer) => peer.id !== input.node!.id);
	store.peers.push({
		id: input.node.id,
		name: input.node.name,
		origin: peerOrigin,
		callToken: input.token,
		acceptToken: accept,
		addedAt: Date.now(),
		...(peerIdentity ? { transport: "node" as const } : {}),
	});
	write(store);
	if (peerIdentity) {
		admitNode(peerIdentity, peerOrigin);
		const identity = nodeIdentity();
		const nodeOrigin = deps?.nodeOrigin?.() ?? deps?.httpOrigin();
		if (!nodeOrigin) return { status: 500, body: { error: "node origin unavailable" } };
		const reply = {
			requesterId: peerIdentity.id,
			identity,
			nodeOrigin,
			token: accept,
		};
		return {
			status: 200,
			body: {
				node: { id: identity.id, name: identity.name },
				identity,
				nodeOrigin,
				token: accept,
				proof: signNodePayload("fleet-pair-reply", reply),
			},
		};
	}
	return { status: 200, body: { node: fleetNode(), token: accept } };
}

/* -------------------------------------------------------------- endpoint */

export function authenticateFleetPeer(bearer: string | null): FleetPeer | null {
	if (!bearer) return null;
	for (const peer of read().peers) {
		if (tokensEqual(peer.acceptToken, bearer)) return peer;
	}
	return null;
}

export function localSnapshot(): { node: { id: string; name: string }; teammates: FleetTeammate[] } {
	return {
		node: fleetNode(),
		teammates: listPersonas().map((persona) => ({
			personaId: persona.id,
			name: persona.name,
			...(persona.team?.trim() ? { team: persona.team.trim() } : {}),
			...(persona.goal ? { goal: persona.goal.slice(0, 200) } : {}),
			backendId: persona.backendId,
			state: deps?.stateOf(persona.id) ?? "idle",
			...(persona.face ? { face: persona.face } : {}),
		})),
	};
}

/**
 * The peer-facing RPC. Two methods, nothing else — a peer must never reach
 * the surface the phone uses.
 */
export async function handleFleetRpc(
	bearer: string | null,
	body: unknown,
): Promise<{ status: number; body: unknown }> {
	const peer = authenticateFleetPeer(bearer);
	if (!peer) return { status: 401, body: { error: "unauthorized" } };
	const store = read();
	const row = store.peers.find((item) => item.id === peer.id);
	if (row) {
		row.lastSeenAt = Date.now();
		write(store);
	}
	const input = body as { method?: string; params?: Record<string, unknown> };
	switch (input.method) {
		case "status":
			return { status: 200, body: localSnapshot() };
		case "deliver": {
			if (!deps) return { status: 500, body: { error: "fleet not ready" } };
			const params = input.params ?? {};
			const targetPersonaId = typeof params.targetPersonaId === "string" ? params.targetPersonaId : "";
			const message = typeof params.message === "string" ? params.message : "";
			const fromPersona = params.fromPersona as { id?: string; name?: string } | undefined;
			if (!targetPersonaId || !message || !fromPersona?.id || !fromPersona.name) {
				return { status: 400, body: { error: "bad request" } };
			}
			const result = await deps.deliver({
				fromNode: { id: peer.id, name: peer.name },
				fromPersona: { id: fromPersona.id, name: fromPersona.name },
				targetPersonaId,
				message,
			});
			return { status: 200, body: result };
		}
		case "createTeammate": {
			if (!deps) return { status: 500, body: { error: "fleet not ready" } };
			const params = input.params ?? {};
			const name = typeof params.name === "string" ? params.name.trim().slice(0, 80) : "";
			if (!name) return { status: 400, body: { error: "bad request" } };
			const created = deps.createTeammate({
				name,
				goal: typeof params.goal === "string" ? params.goal.slice(0, 4000) : undefined,
				team: typeof params.team === "string" ? params.team.slice(0, 60) : undefined,
			});
			return { status: 200, body: { ok: true, ...created } };
		}
		case "readTranscript": {
			if (!deps) return { status: 500, body: { error: "fleet not ready" } };
			const params = input.params ?? {};
			const personaId = typeof params.personaId === "string" ? params.personaId : "";
			const limit = Math.min(Math.max(Number(params.limit) || 30, 1), 100);
			if (!personaId) return { status: 400, body: { error: "bad request" } };
			const result = deps.readTranscript(personaId, limit);
			if (!result) return { status: 404, body: { error: "not found" } };
			return { status: 200, body: result };
		}
		case "readThread": {
			if (!deps) return { status: 500, body: { error: "fleet not ready" } };
			const params = input.params ?? {};
			const localPersonaId = typeof params.localPersonaId === "string" ? params.localPersonaId : "";
			const remotePersonaId =
				typeof params.remotePersonaId === "string" ? params.remotePersonaId : "";
			const limit = Math.min(Math.max(Number(params.limit) || 30, 1), 100);
			if (!localPersonaId || !remotePersonaId) return { status: 400, body: { error: "bad request" } };
			const result = deps.readThread({
				localPersonaId,
				remoteNodeId: peer.id,
				remotePersonaId,
				limit,
			});
			if (!result) return { status: 404, body: { error: "not found" } };
			return { status: 200, body: result };
		}
		case "notify": {
			/* A peer's teammate needs a pocket. This desk sends if it can; an
			 * incapable desk answers quietly and the authority loses nothing. */
			const params = input.params ?? {};
			const kind = String(params.kind ?? "");
			const personaId = typeof params.personaId === "string" ? params.personaId : "";
			const title = typeof params.title === "string" ? params.title.slice(0, 120) : "";
			const body = typeof params.body === "string" ? params.body.slice(0, 300) : "";
			if (!personaId || !title || !["turn-ended", "permission", "blocked"].includes(kind)) {
				return { status: 400, body: { error: "bad request" } };
			}
			const { dispatchFromPeer } = await import("../push/notify");
			const result = await dispatchFromPeer(
				{ id: peer.id, name: peer.name },
				{ kind: kind as "turn-ended" | "permission" | "blocked", personaId, title, body },
			);
			return { status: 200, body: { ok: true, ...result } };
		}
		case "webAccess": {
			/* The calling desktop wants to show one of our teammates for real —
			 * chat, settings, tools — which is the wire, not this RPC surface.
			 * Grant it the same standing credential a paired phone holds. */
			const origin = deps?.httpOrigin();
			if (!origin) {
				return { status: 200, body: { ok: false, error: "Web access is not enabled" } };
			}
			const device = deviceForPeer(peer.id, peer.name);
			const { instanceId, hostName } = instanceIdentity();
			return {
				status: 200,
				body: { ok: true, origin, deviceId: device.id, token: device.token, instanceId, hostName },
			};
		}
		default:
			return { status: 400, body: { error: "unknown method" } };
	}
}

/* ------------------------------------------------------------- the cache */

const cache = new Map<string, FleetNodeRoster>();

async function fetchRoster(peer: FleetPeer): Promise<FleetNodeRoster> {
	try {
		const response = await fetch(new URL("/fleet/rpc", peer.origin), {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${peer.callToken}`,
			},
			body: JSON.stringify({ method: "status" }),
			signal: AbortSignal.timeout(6_000),
		});
		if (!response.ok) throw new Error(String(response.status));
		const body = (await response.json()) as ReturnType<typeof localSnapshot>;
		const roster: FleetNodeRoster = {
			node: { id: peer.id, name: body.node?.name ?? peer.name },
			teammates: Array.isArray(body.teammates) ? body.teammates : [],
			online: true,
			fetchedAt: Date.now(),
		};
		const store = read();
		const row = store.peers.find((item) => item.id === peer.id);
		if (row) {
			row.lastSeenAt = Date.now();
			write(store);
		}
		return roster;
	} catch {
		const previous = cache.get(peer.id);
		return {
			node: { id: peer.id, name: peer.name },
			teammates: previous?.teammates ?? [],
			online: false,
			fetchedAt: Date.now(),
		};
	}
}

/** Every peer's roster, at most TTL stale, offline peers marked as such. */
export async function fleetRosters(): Promise<FleetNodeRoster[]> {
	const peers = read().peers;
	const results = await Promise.all(
		peers.map(async (peer) => {
			const cached = cache.get(peer.id);
			if (cached && Date.now() - cached.fetchedAt < SNAPSHOT_TTL_MS) return cached;
			const fresh = await fetchRoster(peer);
			cache.set(peer.id, fresh);
			return fresh;
		}),
	);
	return results;
}

/** Sends one message to a teammate on a peer desktop; waits for the reply. */
export async function deliverToPeer(
	peerId: string,
	input: { targetPersonaId: string; fromPersona: { id: string; name: string }; message: string },
): Promise<{ ok: boolean; reply?: string; detail?: string; from?: string }> {
	const peer = read().peers.find((item) => item.id === peerId);
	if (!peer) return { ok: false, detail: "Unknown desktop" };
	try {
		const response = await fetch(new URL("/fleet/rpc", peer.origin), {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${peer.callToken}`,
			},
			body: JSON.stringify({ method: "deliver", params: input }),
			signal: AbortSignal.timeout(DELIVER_TIMEOUT_MS),
		});
		if (!response.ok) return { ok: false, detail: `That desktop answered ${response.status}` };
		return (await response.json()) as { ok: boolean; reply?: string; detail?: string; from?: string };
	} catch {
		return { ok: false, detail: "Could not reach that desktop" };
	}
}

/**
 * A notification envelope, offered to every linked desktop. Fire-and-forget:
 * the authority's buzz must never wait on a peer, and a peer with no key or
 * no phones simply declines.
 */
export function forwardNotify(payload: {
	kind: string;
	personaId: string;
	title: string;
	body: string;
}): void {
	for (const peer of read().peers) {
		void peerCall(peer.id, "notify", payload, 5_000).catch(() => {});
	}
}

async function peerCall<T>(peerId: string, method: string, params: unknown, timeoutMs = 10_000): Promise<T | null> {
	const peer = read().peers.find((item) => item.id === peerId);
	if (!peer) return null;
	try {
		const response = await fetch(new URL("/fleet/rpc", peer.origin), {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${peer.callToken}`,
			},
			body: JSON.stringify({ method, params }),
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!response.ok) return null;
		return (await response.json()) as T;
	} catch {
		return null;
	}
}

/**
 * Connection material for one peer. Admitted nodes use their pairwise fleet
 * token on the dedicated NodeLink. Legacy rows still mint the phone-shaped
 * web credential they used before node admission existed.
 */
export async function peerWireAccess(
	peerId: string,
): Promise<{
	origin: string;
	token: string;
	transport: "legacy" | "node";
	linkKey?: string;
} | null> {
	const store = read();
	const peer = store.peers.find((item) => item.id === peerId);
	if (!peer) return null;
	if (peer.transport === "node") {
		const secrets = [peer.callToken, peer.acceptToken].sort();
		const linkKey = createHash("sha256")
			.update(`toad-node-link:v1\n${secrets[0]}\n${secrets[1]}`)
			.digest("base64url");
		return { origin: peer.origin, token: peer.callToken, transport: "node", linkKey };
	}
	if (peer.webToken) {
		return { origin: peer.webOrigin ?? peer.origin, token: peer.webToken, transport: "legacy" };
	}
	const access = await webAccessFromPeer(peerId);
	if (!access?.ok || !access.token) return null;
	peer.webToken = access.token;
	peer.webOrigin = access.origin;
	write(store);
	return { origin: access.origin ?? peer.origin, token: access.token, transport: "legacy" };
}

export async function createTeammateOnPeer(
	peerId: string,
	draft: { name: string; goal?: string; team?: string },
): Promise<{ ok: boolean; personaId?: string; name?: string } | null> {
	const result = await peerCall<{ ok: boolean; personaId?: string; name?: string }>(
		peerId,
		"createTeammate",
		draft,
	);
	/* The next roster read should show the new seat, not a snapshot taken
	 * before it existed. */
	if (result?.ok) cache.delete(peerId);
	return result;
}

export function readPeerTranscript(
	peerId: string,
	personaId: string,
	limit = 30,
): Promise<{
	personaId: string;
	name: string;
	messages: Array<{ from: string; text: string; at: number }>;
	truncated: boolean;
} | null> {
	return peerCall(peerId, "readTranscript", { personaId, limit });
}

export function readPeerThread(
	peerId: string,
	input: { localPersonaId: string; remotePersonaId: string; limit?: number },
): Promise<{
	name: string;
	messages: Array<{ from: string; text: string; at: number }>;
	truncated: boolean;
} | null> {
	/* Sides flip at the boundary: OUR persona is remote to THEM. */
	return peerCall(peerId, "readThread", {
		localPersonaId: input.localPersonaId,
		remotePersonaId: input.remotePersonaId,
		limit: input.limit ?? 30,
	});
}

export function webAccessFromPeer(peerId: string): Promise<{
	ok: boolean;
	error?: string;
	origin?: string;
	deviceId?: string;
	token?: string;
	instanceId?: string;
	hostName?: string;
} | null> {
	return peerCall(peerId, "webAccess", {});
}

/** A remote teammate id an agent can address; parsed back on send. */
export function remoteTargetId(nodeId: string, personaId: string): string {
	return `${nodeId}/${personaId}`;
}

export function parseRemoteTarget(target: string): { nodeId: string; personaId: string } | null {
	const slash = target.indexOf("/");
	if (slash <= 0 || slash === target.length - 1) return null;
	return { nodeId: target.slice(0, slash), personaId: target.slice(slash + 1) };
}
