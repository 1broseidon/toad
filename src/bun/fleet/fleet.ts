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
import { isSecureOrigin, learnPeerCertificate, nodeFetch } from "../node/dial";
import {
	admitNode,
	admittedNode,
	forgetAdmittedNode,
	listAdmittedNodes,
	repinAdmittedNode,
} from "../node/membership";
import {
	certFingerprint,
	isCertFingerprint,
	localCertPem,
	peerCertPin,
	pinnedTlsOptions,
	storePeerCert,
} from "../node/tls";
import { listRecords, purgeOwner } from "../store/records";
import { deviceForPeer, instanceIdentity, revokeDevicesForPeer } from "../web/devices";
import * as wireModule from "./wire";

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
		/**
		 * What the caller is on the desk that sent it. Absent means a teammate,
		 * which is every delivery a desk older than client seats can make; the
		 * receiving teammate is told a different sentence about each, and the
		 * marker on its tape says which.
		 */
		fromSeat?: "client";
	}): Promise<{ ok: boolean; reply?: string; detail?: string; replyEventIds?: string[] }>;
	/**
	 * A remote caller says its own agent has now been handed the reply, so
	 * those bubbles are read here. The thread lives on this desk because
	 * delivery ran here; the caller only knows the ids it was answered with.
	 */
	threadRead(input: {
		localPersonaId: string;
		remoteNodeId: string;
		remotePersonaId: string;
		eventIds: string[];
	}): number;
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

/**
 * Rewrites one peer's origin — the TLS upgrade probe's commit step. Only the
 * probe calls this, and only upward: a plain origin becomes a pinned secure
 * one, never the reverse.
 */
export function setPeerOrigin(id: string, origin: string): boolean {
	const store = read();
	const row = store.peers.find((peer) => peer.id === id);
	if (!row || row.origin === origin) return false;
	row.origin = origin;
	write(store);
	return true;
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

/**
 * What this desk asks a peer to pin, derived from the origin it is about to
 * advertise rather than from a callback a caller could forget to pass.
 *
 * The scheme is the single source of truth for which plane is live: an https
 * origin means the listener came up on the TLS material `localCertPem`
 * returns, so the two can never disagree. A plain origin pins nothing, which
 * is exactly what an un-upgraded desk looks like from the outside.
 */
function localPin(origin: string | null): { fingerprint: string; pem: string } | null {
	if (!origin || !isSecureOrigin(origin)) return null;
	const pem = localCertPem();
	if (!pem) return null;
	try {
		return { fingerprint: certFingerprint(pem), pem };
	} catch {
		return null;
	}
}

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
	const mine = localPin(myOrigin);
	const myFingerprint = mine?.fingerprint;
	const claim = {
		code: input.code,
		identity,
		nodeOrigin: myOrigin,
		token: accept,
		...(myFingerprint ? { certFingerprint: myFingerprint } : {}),
	};
	/* The pairing moment is where trust in a certificate is born, so this is
	 * the one dial with no pin to enforce yet: handshake once, keep what was
	 * presented, and use it as the trust root for this exchange only. It
	 * becomes trust further down, where the reply's Ed25519 signature must
	 * cover the fingerprint of the very certificate learned here — a machine
	 * in the middle can offer its own key but cannot make the peer sign it. */
	const learned = await learnPeerCertificate(input.origin);
	if (isSecureOrigin(input.origin) && !learned) {
		return { ok: false, error: "Could not reach that desktop" };
	}
	let response: Response;
	try {
		response = await nodeFetch(new URL("/fleet/pair", input.origin), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				code: input.code,
				node: me,
				origin: legacyOrigin ?? myOrigin,
				identity,
				nodeOrigin: myOrigin,
				token: accept,
				...(mine ? { certFingerprint: mine.fingerprint, certPem: mine.pem } : {}),
				proof: signNodePayload("fleet-pair-claim", claim),
				/* Pairing is where the room's word must arrive, not where a
				 * gossip race begins: a desk rejoining after exile has to
				 * learn it was re-admitted before it acts on its own stale
				 * revocation, or it hangs up on the invitation. */
				facts: listMembershipFacts(),
			}),
			signal: AbortSignal.timeout(10_000),
		}, learned);
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
		certFingerprint?: string;
		certPem?: string;
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
	let peerPin: string | undefined;
	if (body.identity || body.proof || body.nodeOrigin) {
		if (!isNodeIdentity(body.identity) || !body.proof || !body.nodeOrigin) {
			return { ok: false, error: "Malformed node identity in pairing reply" };
		}
		const reply = {
			requesterId: identity.id,
			identity: body.identity,
			nodeOrigin: body.nodeOrigin,
			token: body.token,
			...(body.certFingerprint ? { certFingerprint: body.certFingerprint } : {}),
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
		/* The teeth of the whole design. The fingerprint above is inside a
		 * signature only this node's key could make, and it must name the
		 * certificate this exchange actually ran over. Anything else — a
		 * relay's own key, a certificate for a different desk, an origin that
		 * promises TLS and then offers none — ends the pairing here rather
		 * than becoming a pin that is wrong forever. */
		if (isSecureOrigin(peerOrigin)) {
			if (!isCertFingerprint(body.certFingerprint) || !body.certPem) {
				return { ok: false, error: "That desktop offered TLS without a certificate to pin" };
			}
			if (learned && learned.fingerprint !== body.certFingerprint) {
				return { ok: false, error: "That desktop's certificate did not match its signed fingerprint" };
			}
			if (!storePeerCert(body.node.id, body.certFingerprint, body.certPem)) {
				return { ok: false, error: "That desktop's certificate did not match its signed fingerprint" };
			}
			peerPin = body.certFingerprint;
		} else if (body.certFingerprint) {
			return { ok: false, error: "That desktop pinned a certificate on a plain address" };
		}
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
		admitNode(peerIdentity, peerOrigin, peerPin);
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
		certFingerprint?: string;
		certPem?: string;
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
	let peerPin: string | undefined;
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
			...(input.certFingerprint ? { certFingerprint: input.certFingerprint } : {}),
		};
		if (!verifyNodePayload(input.identity, "fleet-pair-claim", claim, input.proof)) {
			return { status: 403, body: { error: "bad identity proof" } };
		}
		/* The claimant's pin arrives inside the same signature as its identity
		 * and its origin, so the three cannot be separated: an https origin
		 * must come with a certificate that hashes to the fingerprint it
		 * signed, and a plain origin must come with no pin at all. */
		if (isSecureOrigin(input.nodeOrigin)) {
			if (!isCertFingerprint(input.certFingerprint) || typeof input.certPem !== "string") {
				return { status: 400, body: { error: "certificate required for a TLS origin" } };
			}
			if (!storePeerCert(input.node.id, input.certFingerprint, input.certPem)) {
				return { status: 400, body: { error: "certificate did not match its signed fingerprint" } };
			}
			peerPin = input.certFingerprint;
		} else if (input.certFingerprint) {
			return { status: 400, body: { error: "a plain origin cannot pin a certificate" } };
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
		admitNode(peerIdentity, peerOrigin, peerPin);
		assertMembership({ id: peerIdentity.id, name: peerIdentity.name }, peerOrigin, "admit");
		peerWire().membershipChanged([peerIdentity.id]);
		peerWire().refreshPeerWire(peerIdentity.id);
		const identity = nodeIdentity();
		const nodeOrigin = deps?.nodeOrigin?.() ?? deps?.httpOrigin();
		if (!nodeOrigin) return { status: 500, body: { error: "node origin unavailable" } };
		const replyPin = localPin(nodeOrigin);
		const fingerprint = replyPin?.fingerprint;
		const reply = {
			requesterId: peerIdentity.id,
			identity,
			nodeOrigin,
			token: accept,
			...(fingerprint ? { certFingerprint: fingerprint } : {}),
		};
		return {
			status: 200,
			body: {
				node: { id: identity.id, name: identity.name },
				identity,
				nodeOrigin,
				token: accept,
				...(replyPin ? { certFingerprint: replyPin.fingerprint, certPem: replyPin.pem } : {}),
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
				...(params.fromSeat === "client" ? { fromSeat: "client" as const } : {}),
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
		/* The reply's second tick, coming home. Fire-and-forget by design: the
		 * caller's desk never waits on it, and a receipt that names nothing (a
		 * thread since deleted, an id already read, a duplicate) moves zero
		 * bubbles and answers ok all the same. Who sent it is the authenticated
		 * link's id, never a parameter — the same rule the record plane has. */
		case "threadRead": {
			if (!deps) return { status: 500, body: { error: "fleet not ready" } };
			const params = input.params ?? {};
			const localPersonaId = typeof params.localPersonaId === "string" ? params.localPersonaId : "";
			const remotePersonaId =
				typeof params.remotePersonaId === "string" ? params.remotePersonaId : "";
			const eventIds = Array.isArray(params.eventIds)
				? params.eventIds.filter((id): id is string => typeof id === "string").slice(0, 100)
				: [];
			if (!localPersonaId || !remotePersonaId) return { status: 400, body: { error: "bad request" } };
			const moved = deps.threadRead({
				localPersonaId,
				remoteNodeId: peer.id,
				remotePersonaId,
				eventIds,
			});
			return { status: 200, body: { ok: true, moved } };
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
			/* The authority already elected who posts to which phone; absent, this
			 * is a desk from before election and the old every-desk-sends rule
			 * applies. Believed only in shape — it names records and desks, and
			 * naming this desk is the whole of the authority it confers. */
			const { readPushSenderPlan } = await import("./push");
			const plan = readPushSenderPlan(params.plan);
			const { dispatchFromPeer } = await import("../push/notify");
			const result = await dispatchFromPeer(
				{ id: peer.id, name: peer.name },
				{ kind: kind as "turn-ended" | "permission" | "blocked", personaId, title, body, plan },
			);
			return { status: 200, body: { ok: true, ...result } };
		}
		case "hopTeammate": {
			/* This desk is the destination; the caller may be any member. The
			 * whole move runs here and the refusal, if any, is the result. */
			const personaId = String(input.params?.personaId ?? "");
			if (!personaId) return { status: 400, body: { error: "bad request" } };
			const hop = await import("./hop");
			return {
				status: 200,
				body: await hop.performHop(personaId, { self: input.params?.self === true }),
			};
		}
		case "hopPrepare": {
			/* This desk is the owner; the caller is the destination driving. */
			const hop = await import("./hop");
			return { status: 200, body: await hop.handleHopPrepare(peer.id, input.params) };
		}
		case "hopDemote": {
			const hop = await import("./hop");
			return { status: 200, body: await hop.handleHopDemote(peer.id, input.params) };
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

/* ---------------------------------------------------------- rotation
 * A key does not last forever, and replacing one must not cost a human a
 * re-pairing. The new fingerprint is re-announced over the link that is
 * already mutually authenticated, signed by the same node key that signed the
 * admission — so the announcement proves the same thing the pairing proved,
 * and this desk simply re-signs its own admission around the new pin.
 *
 * The peer rotates, announces, and keeps serving the old certificate until
 * the announcement is out; the link then drops on its own (a listener cannot
 * swap certificates mid-flight) and the sweep dials again, now against the
 * pin it just stored. Nothing here trusts the socket the news arrived on
 * beyond delivering it: the signature is what is believed.
 */

export type CertRotation = {
	nodeId: string;
	nodeOrigin: string;
	certFingerprint: string;
	certPem: string;
	rotatedAt: number;
	proof: string;
};

/** The rotation this desk announces after replacing its own certificate. */
export function localCertRotation(): CertRotation | null {
	const identity = nodeIdentity();
	const nodeOrigin = deps?.nodeOrigin?.() ?? null;
	const pin = localPin(nodeOrigin);
	if (!nodeOrigin || !pin) return null;
	const claim = {
		nodeId: identity.id,
		nodeOrigin,
		certFingerprint: pin.fingerprint,
		rotatedAt: Date.now(),
	};
	return {
		...claim,
		certPem: pin.pem,
		proof: signNodePayload("node-cert-rotation", claim),
	};
}

/**
 * Believes one peer's rotation, or refuses it. True when the pin moved.
 *
 * `peerId` comes from the authenticated link, never from the payload: a peer
 * may only ever rotate its own certificate. `rotatedAt` must beat the
 * admission it replaces, which is what stops a captured old announcement from
 * pinning a retired key back into place.
 */
export function applyPeerCertRotation(peerId: string, payload: unknown): boolean {
	const input = payload as Partial<CertRotation> | null;
	if (
		!input ||
		input.nodeId !== peerId ||
		typeof input.nodeOrigin !== "string" ||
		!isCertFingerprint(input.certFingerprint) ||
		typeof input.certPem !== "string" ||
		typeof input.rotatedAt !== "number" ||
		typeof input.proof !== "string"
	) {
		return false;
	}
	if (!isSecureOrigin(input.nodeOrigin)) return false;
	const admission = admittedNode(peerId);
	if (!admission || input.rotatedAt <= admission.admittedAt) return false;
	const claim = {
		nodeId: input.nodeId,
		nodeOrigin: input.nodeOrigin,
		certFingerprint: input.certFingerprint,
		rotatedAt: input.rotatedAt,
	};
	if (!verifyNodePayload(admission.node, "node-cert-rotation", claim, input.proof)) return false;
	if (admission.certFingerprint === input.certFingerprint && admission.origin === input.nodeOrigin) {
		return false;
	}
	if (!storePeerCert(peerId, input.certFingerprint, input.certPem)) return false;
	if (!repinAdmittedNode(peerId, input.certFingerprint, input.nodeOrigin)) return false;
	const store = read();
	const row = store.peers.find((item) => item.id === peerId);
	if (row) {
		row.origin = input.nodeOrigin;
		write(store);
	}
	return true;
}

/* ------------------------------------------------------------- the room */

/**
 * The wire, which imports this file back.
 *
 * A plain `import` even though the pair is a cycle, and deliberately not
 * `require()`: neither side touches the other while its module body runs — the
 * calls are all inside functions — so ESM links the cycle without a hazard,
 * while a `require()` of a relative module makes a SECOND copy of it and of
 * everything it imports under Cottontail's loader, and module-scoped state
 * (the replication registry, the credential listeners, the roster caches) then
 * exists twice in one process. See `docs/development.md`.
 */
function peerWire(): typeof wireModule {
	return wireModule;
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
	input: {
		targetPersonaId: string;
		fromPersona: { id: string; name: string };
		message: string;
		/** Says the caller is an outside client seat, not a teammate here. */
		fromSeat?: "client";
	},
): Promise<{
	ok: boolean;
	reply?: string;
	detail?: string;
	from?: string;
	replyEventIds?: string[];
}> {
	const peer = read().peers.find((item) => item.id === peerId);
	if (!peer) return { ok: false, detail: "Unknown desktop" };
	const result = await peerCall<{
		ok: boolean;
		reply?: string;
		detail?: string;
		from?: string;
		replyEventIds?: string[];
	}>(peerId, "deliver", input, DELIVER_TIMEOUT_MS);
	return result ?? { ok: false, detail: "Could not reach that desktop" };
}

/**
 * Tells the desk a reply came from that our own agent has now been handed it.
 *
 * The thread is over there, so the second tick has to travel; this is the only
 * receipt in Toad that needs a wire at all. Fire-and-forget, and a peer too old
 * to know the method answers unknown-method, which is fine and ignored: a
 * missing tick is a tick that has not arrived, which is exactly what it means.
 */
export function reportThreadRead(
	peerId: string,
	input: { localPersonaId: string; remotePersonaId: string; eventIds: string[] },
): void {
	if (input.eventIds.length === 0) return;
	void peerCall(peerId, "threadRead", input, 5_000).catch(() => {});
}

/**
 * A notification envelope, offered to every linked desktop. Fire-and-forget:
 * the authority's buzz must never wait on a peer, and a peer with no key or
 * no phones simply declines.
 *
 * Every desk gets it because every desk may want to *toast* it. The `plan`
 * inside names the single desk that is to put it in a pocket — the authority
 * decided that once, and a desk the plan does not name does not push. See
 * `electPushSenders` in `fleet/push.ts`.
 */
export function forwardNotify(payload: {
	kind: string;
	personaId: string;
	title: string;
	body: string;
	plan?: Record<string, string>;
}): void {
	for (const peer of read().peers) {
		void peerCall(peer.id, "notify", payload, 5_000).catch(() => {});
	}
}

/**
 * One peer-surface call for callers outside this module — the hop's routing
 * and handshakes ride the same wire selection `deliver` does. Null means the
 * peer could not be reached or refused transport, never a refusal-with-reason:
 * those come back as the method's own result body.
 */
export function callFleetPeer<T>(
	peerId: string,
	method: string,
	params: unknown,
	timeoutMs?: number,
): Promise<T | null> {
	return peerCall<T>(peerId, method, params, timeoutMs);
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
		/* The bootstrap path carries a bearer token, so it is exactly the
		 * traffic a pin exists to protect. An https peer with no usable pin
		 * gets no request at all — `nodeFetch` rejects rather than falling
		 * back, because falling back is how a downgrade gets its foothold. */
		const response = await nodeFetch(
			new URL("/fleet/rpc", peer.origin),
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${peer.callToken}`,
				},
				body: JSON.stringify({ method, params }),
				signal: AbortSignal.timeout(timeoutMs),
			},
			pinFor(peer.id),
		);
		if (!response.ok) return null;
		return (await response.json()) as T;
	} catch {
		return null;
	}
}

/**
 * The certificate this desk will accept from one peer, straight from the
 * admission it signed. Null means "nothing pinned" — fine for a plain peer,
 * fatal for an https one, and that judgement belongs to the caller.
 */
export function pinFor(peerId: string): ReturnType<typeof peerCertPin> {
	return peerCertPin(peerId, admittedNode(peerId)?.certFingerprint);
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
	tls?: { ca: string; servername: string };
	/** Part of the wire's identity, so a rotated pin rebuilds the link. */
	certFingerprint?: string;
} | null> {
	const store = read();
	const peer = store.peers.find((item) => item.id === peerId);
	if (!peer) return null;
	if (peer.transport === "node") {
		const secrets = [peer.callToken, peer.acceptToken].sort();
		const linkKey = createHash("sha256")
			.update(`toad-node-link:v1\n${secrets[0]}\n${secrets[1]}`)
			.digest("base64url");
		const pin = pinFor(peerId);
		/* A secure origin without a pin is not a peer to retry later at a
		 * lower standard — it is a peer this desk cannot recognise, so it
		 * offers no wire material at all and the sweep leaves the link down. */
		if (isSecureOrigin(peer.origin) && !pin) return null;
		return {
			origin: peer.origin,
			token: peer.callToken,
			transport: "node",
			linkKey,
			...(pin ? { tls: pinnedTlsOptions(pin), certFingerprint: pin.fingerprint } : {}),
		};
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
