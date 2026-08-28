import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
	FleetNodeRoster,
	FleetTeammate,
	NodeIdentity,
} from "../../shared/types";
import { ROOT, ensureLayout } from "../paths";
import { assertMembership, listMembershipFacts, mergeMembershipFacts } from "../node/facts";
import { isNodeIdentity, nodeIdentity, signNodePayload, verifyNodePayload } from "../node/identity";
import { admitNode, forgetAdmittedNode, listAdmittedNodes } from "../node/membership";
import { listRecords, purgeOwner } from "../store/records";
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
 * Trust is pairwise: admission exchanges signed node identities and secrets,
 * then one mutually authenticated NodeLink carries the narrow peer surface in
 * either direction. Bearer-authenticated HTTP remains only for desktops from
 * before node admission, and as a bootstrap fallback while no standing link
 * is available. A peer can never reach the phone's general RPC surface.
 *
 * v1 is same-LAN. Advertised origins locate a peer for pairing and reconnect;
 * they are not routing truth once an authenticated socket exists — especially
 * when the peer dialed out through NAT.
 */

const INVITE_MS = 2 * 60_000;
/** Delivery rides a session turn, which can legitimately take minutes. */
const DELIVER_TIMEOUT_MS = 10.5 * 60_000;
/** A hot authenticated link is presence, not a reason to rewrite JSON per frame. */
const configuredLastSeenWriteMs = Number(process.env.TOAD_LAST_SEEN_WRITE_MS);
const LAST_SEEN_WRITE_MS =
	Number.isFinite(configuredLastSeenWriteMs) && configuredLastSeenWriteMs > 0
		? configuredLastSeenWriteMs
		: 30_000;
const lastSeenWrites = new Map<string, number>();

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
	/* Fleets that predate membership facts seed the room from their pairwise
	 * admissions once — my own signed facts, minted from state I already
	 * trusted. Gossip then carries them to peers on the next link-up. */
	const known = new Set(listMembershipFacts().map((fact) => fact.subject.id));
	for (const admission of listAdmittedNodes()) {
		if (!known.has(admission.node.id)) {
			assertMembership(
				{ id: admission.node.id, name: admission.node.name },
				admission.origin,
				"admit",
			);
		}
	}
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

/**
 * Removes every local trace of a peer: row, admission, devices, records.
 * This is the room-wide *apply* step — it mints no fact, so a desk obeying a
 * gossiped revocation does not echo a second revocation of its own.
 */
export function teardownFleetPeer(id: string): boolean {
	const store = read();
	const next = store.peers.filter((peer) => peer.id !== id);
	const held = next.length !== store.peers.length;
	if (held) {
		store.peers = next;
		write(store);
	}
	lastSeenWrites.delete(id);
	forgetAdmittedNode(id);
	revokeDevicesForPeer(id);
	purgeOwner(id);
	return held;
}

/**
 * The human act: removing a node removes it from the whole room. The signed
 * revocation gossips to every member, each of which tears the node down
 * locally — and the mesh closure consults the same facts, so a revoked node
 * stays gone instead of being helpfully re-introduced.
 */
export function revokeFleetPeer(id: string): boolean {
	const row = read().peers.find((peer) => peer.id === id);
	const admission = listAdmittedNodes().find((entry) => entry.node.id === id);
	const name = row?.name ?? admission?.node.name ?? id;
	const origin = row?.origin ?? admission?.origin ?? "";
	assertMembership({ id, name }, origin, "revoke");
	const held = teardownFleetPeer(id);
	peerWire().membershipChanged([id]);
	return held;
}

/**
 * Stamps durable presence from authenticated transport activity.
 *
 * NodeLink calls this for every secure frame in either direction, while the
 * interval keeps an active conversation from rewriting fleet.json per token.
 */
export function markFleetPeerSeen(id: string): void {
	const now = Date.now();
	const lastWrite = lastSeenWrites.get(id);
	if (lastWrite && now - lastWrite < LAST_SEEN_WRITE_MS) return;
	const store = read();
	const row = store.peers.find((item) => item.id === id);
	if (!row) return;
	if (row.lastSeenAt && now - row.lastSeenAt < LAST_SEEN_WRITE_MS) {
		lastSeenWrites.set(id, row.lastSeenAt);
		return;
	}
	row.lastSeenAt = now;
	write(store);
	lastSeenWrites.set(id, now);
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
				/* Pairing is where the room's word must arrive, not where a
				 * gossip race begins: a desk rejoining after exile has to
				 * learn it was re-admitted before it acts on its own stale
				 * revocation, or it hangs up on the invitation. */
				facts: listMembershipFacts(),
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
		facts?: unknown[];
	};
	if (!body.node?.id || !body.token) return { ok: false, error: "Malformed pairing reply" };
	/* Before anything else: the reply carries the inviter's view of the room,
	 * including the fresh admission of this desk. Merging it first is what
	 * lets a returning exile stop being one. */
	if (Array.isArray(body.facts)) mergeMembershipFacts(body.facts);
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
	if (peerIdentity) {
		admitNode(peerIdentity, peerOrigin);
		assertMembership({ id: peerIdentity.id, name: peerIdentity.name }, peerOrigin, "admit");
		peerWire().membershipChanged([peerIdentity.id]);
	}
	/* The pair's secrets just changed; a wire born under the old ones must
	 * not survive them. */
	peerWire().refreshPeerWire(body.node.id);
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
		facts?: unknown[];
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
	/* The claimant's view of the room, merged now that its code and identity
	 * proof have been checked. Facts are self-certifying, so a bad one simply
	 * fails to verify rather than needing this endpoint to police it. */
	if (Array.isArray(input.facts)) mergeMembershipFacts(input.facts);
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
		assertMembership({ id: peerIdentity.id, name: peerIdentity.name }, peerOrigin, "admit");
		peerWire().membershipChanged([peerIdentity.id]);
		peerWire().refreshPeerWire(peerIdentity.id);
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
				facts: listMembershipFacts(),
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

/**
 * The narrow peer-facing RPC. A peer must never reach the surface the phone
 * uses; HTTP and NodeLink authenticate differently but dispatch identically.
 */
export async function handleFleetRpc(
	bearer: string | null,
	body: unknown,
): Promise<{ status: number; body: unknown }> {
	const peer = authenticateFleetPeer(bearer);
	if (!peer) return { status: 401, body: { error: "unauthorized" } };
	markFleetPeerSeen(peer.id);
	return dispatchFleetRpc(peer, body);
}

/**
 * The same narrow peer surface over an already authenticated NodeLink.
 * Identity comes from the link, never from caller-controlled parameters.
 */
export async function handleFleetNodeRpc(
	peerId: string,
	method: string,
	params: unknown,
): Promise<unknown> {
	const peer = read().peers.find((item) => item.id === peerId);
	if (!peer || peer.transport !== "node") throw new Error("unauthorized node peer");
	const result = await dispatchFleetRpc(peer, { method, params });
	if (result.status >= 400) {
		const error = result.body as { error?: unknown };
		throw new Error(typeof error?.error === "string" ? error.error : `peer request failed (${result.status})`);
	}
	return result.body;
}

async function dispatchFleetRpc(
	peer: FleetPeer,
	body: unknown,
): Promise<{ status: number; body: unknown }> {
	const input = body as { method?: string; params?: Record<string, unknown> };
	switch (input.method) {
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

/* ------------------------------------------------------------- the room */

type WireFacade = typeof import("./wire");

function peerWire(): WireFacade {
	return require("./wire") as WireFacade;
}

/** Every peer's roster, answered from replicated records and the wire's up flag. */
export async function fleetRosters(): Promise<FleetNodeRoster[]> {
	const { peerOnline, remoteSessionState } = peerWire();
	return read().peers.map((peer) => ({
		node: { id: peer.id, name: peer.name },
		teammates: listRecords("persona")
			.filter((record) => record.ownerNode === peer.id)
			.map((record) => {
				const replicated = record.replicated;
				const name = typeof replicated.name === "string" ? replicated.name : "Untitled";
				const team = typeof replicated.team === "string" ? replicated.team.trim() : "";
				const goal = typeof replicated.goal === "string" ? replicated.goal : "";
				const backendId = typeof replicated.backendId === "string" ? replicated.backendId : "";
				return {
					personaId: record.id,
					name,
					...(team ? { team } : {}),
					...(goal ? { goal: goal.slice(0, 200) } : {}),
					backendId,
					state: remoteSessionState(remoteTargetId(peer.id, record.id)),
					...(replicated.face ? { face: replicated.face as FleetTeammate["face"] } : {}),
				};
			}),
		online: peerOnline(peer.id),
	}));
}

/** Sends one message to a teammate on a peer desktop; waits for the reply. */
export async function deliverToPeer(
	peerId: string,
	input: { targetPersonaId: string; fromPersona: { id: string; name: string }; message: string },
): Promise<{ ok: boolean; reply?: string; detail?: string; from?: string }> {
	const peer = read().peers.find((item) => item.id === peerId);
	if (!peer) return { ok: false, detail: "Unknown desktop" };
	const result = await peerCall<{ ok: boolean; reply?: string; detail?: string; from?: string }>(
		peerId,
		"deliver",
		input,
		DELIVER_TIMEOUT_MS,
	);
	return result ?? { ok: false, detail: "Could not reach that desktop" };
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

async function peerCall<T>(
	peerId: string,
	method: string,
	params: unknown,
	timeoutMs = 10_000,
): Promise<T | null> {
	const peer = read().peers.find((item) => item.id === peerId);
	if (!peer) return null;

	/* The socket that authenticated this node is the route. In particular, an
	 * inbound socket from behind NAT is usable even when its advertised origin
	 * is not. Once selected, a wire failure is final for this call: retrying the
	 * same mutation over HTTP would create an ambiguous duplicate. */
	if (peer.transport === "node") {
		const wire = peerWire().peerWireFor(peerId);
		if (wire) {
			try {
				return (await wire.call(method, params, timeoutMs)) as T;
			} catch {
				return null;
			}
		}
	}

	// Compatibility for legacy peers, and for a node whose standing wire has
	// not come up yet. This is the only path that dials an advertised origin.
	return peerHttpCall<T>(peer, method, params, timeoutMs);
}

async function peerHttpCall<T>(
	peer: FleetPeer,
	method: string,
	params: unknown,
	timeoutMs: number,
): Promise<T | null> {
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
