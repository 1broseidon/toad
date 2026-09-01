import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type { NodeIdentity, WebModeStatus } from "../../shared/types";
import { deviceViewing, forgetDeviceViewing } from "../push/notify";
import { handleFleetPair, handleFleetRpc, listFleetPeers } from "../fleet/fleet";
import { isNodeIdentity, verifyNodePayload } from "../node/identity";
import {
	admitMobileMember,
	memberGrant,
	mobileMember,
	onMembersChanged,
	type MobileMember,
} from "../node/members";
import { ensureRoom } from "../node/room";
import { localNodeId } from "../store/records";
import {
	claimPairing,
	consumePairing,
	deviceByToken,
	deviceForMember,
	instanceIdentity,
	setDevicePushProblem,
	touchDevice,
} from "./devices";
import { registerPushDevice, unpairPushDevice } from "../store/push";
import {
	handleAuthorizePage,
	handleAuthorizeSubmit,
	handleClientRegistration,
	handleClientToken,
	seatMetadataResponse,
	seatRouteFor,
	sweepRevokedClients,
	type SeatRoute,
} from "../mcp/seat";
import { handleSeatMcpRequest } from "../mcp/seat-server";
import { memberGate, memberPush, memberResult } from "./member-view";
import { ensureTls, remintWebTls, webTlsTrust } from "./tls";
import { onCredentialsChanged } from "../store/credentials";
import { meshCount } from "../fleet/metrics";

/**
 * Calls that only the desktop's own window may make, each with the refusal a
 * phone should read.
 *
 * The rule is not "this is sensitive" but "this seat is not the one that owns
 * it": entering a provider key, or deciding that it may be copied to other
 * machines, is an act performed at the desk that holds the key. A phone can see
 * the room's credential list — it is names and booleans — and can change none of
 * it.
 */
const DESKTOP_ONLY = new Map<string, string>([
	["authorizeMcpServer", "MCP credentials can only be changed on the owning desktop"],
	["disconnectMcpServer", "MCP credentials can only be changed on the owning desktop"],
	["setMcpStaticHeaders", "MCP credentials can only be changed on the owning desktop"],
	["setMcpOAuthClientSecret", "MCP credentials can only be changed on the owning desktop"],
	["credentialCreate", "A provider key is entered on the desk that will hold it"],
	["credentialSetReplication", "Replicating a provider key is decided at the desk that owns it"],
	["credentialRevoke", "A provider key is revoked at the desk that owns it"],
	["credentialDelete", "A provider key is deleted at the desk that owns it"],
]);

/**
 * Web mode: the same app, served to a phone on the LAN.
 *
 * The mainview is already a web app talking RPC over a wire; this serves
 * that bundle over plain HTTP and carries the same contract over a
 * WebSocket. Scoped to LAN/VPN reachability — but not to LAN trust: the
 * wire authenticates a *linked device* from the first byte, because "on my
 * network" is not an identity (any browser tab on the LAN can reach this
 * port, and DNS rebinding means not even that is required).
 *
 * Linking happens once, through a one-time code the desktop shows as a QR
 * (`/?pair=<code>`); the device trades it at /pair for its own token and
 * appears in a revocable list. Revocation closes the device's sockets in
 * the same breath — a revoked phone goes dark now, not at next reconnect.
 */

const DEFAULT_PORT = 4680;
const HTTPS_PORT = Number(process.env.TOAD_WEB_HTTPS_PORT) || 4443;
/**
 * The loopback door: the client seat, in the clear, to 127.0.0.1 alone.
 *
 * 4682 because a desk already answers on 4443 (TLS), 4680 (the plain LAN web
 * door) and 4681 (the node plane), and a fourth listener on a port one of them
 * already holds would come up as an unexplained absence on the desk that had
 * both features on. Overridable exactly the way the HTTPS port is, and for the
 * same two reasons — a box with something else there, and a harness that needs
 * its own.
 */
const LOOPBACK_PORT = Number(process.env.TOAD_WEB_LOOPBACK_PORT) || 4682;

function tokenEqual(a: string, b: string): boolean {
	const ab = Buffer.from(a);
	const bb = Buffer.from(b);
	return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** The built mainview, wherever this process finds itself running. */
function viewsDir(): string | null {
	const candidates = [
		// Packaged/dev bundle: Resources/app/bun/index.js → ../views/mainview
		join(dirname(fileURLToPath(import.meta.url)), "..", "views", "mainview"),
		// Running from source (verify scripts): the repo's dist.
		join(process.cwd(), "dist"),
	];
	for (const dir of candidates) {
		if (existsSync(join(dir, "index.html"))) return dir;
	}
	return null;
}

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript",
	".css": "text/css",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".woff2": "font/woff2",
	".json": "application/json",
	".webmanifest": "application/manifest+json",
};

/** The address a phone can actually type: the first routable IPv4. */
export function lanAddress(): string | null {
	for (const entries of Object.values(networkInterfaces())) {
		for (const entry of entries ?? []) {
			if (entry.family === "IPv4" && !entry.internal) return entry.address;
		}
	}
	return null;
}

type Resolver = (method: string) => ((params: unknown) => Promise<unknown>) | undefined;

/** A linked desktop holds a device credential too; `fleetPeerId` says which.
 * A mobile plane member carries its node id; its reads and pushes are trimmed
 * to the member record's grant. */
type WsData = { deviceId: string; fleetPeerId: string | null; memberNode: string | null };

let server: Bun.Server<WsData> | null = null;
let secureServer: Bun.Server<WsData> | null = null;
let loopbackServer: Bun.Server<WsData> | null = null;
const clients = new Set<Bun.ServerWebSocket<WsData>>();

/** The origin phones should live on: HTTPS when the cert exists, so the
 * link screen gets a live camera and the PWA a secure context. */
function preferredOrigin(): string | null {
	const host = lanAddress() ?? "127.0.0.1";
	if (secureServer) return `https://${host}:${secureServer.port}`;
	if (server) return `http://${host}:${server.port}`;
	return null;
}

/** The plain-HTTP LAN origin — what desktop-to-desktop traffic rides. */
export function httpOrigin(): string | null {
	if (!server) return null;
	const host = lanAddress() ?? "127.0.0.1";
	return `http://${host}:${server.port}`;
}

/**
 * The TLS origin, and only ever that.
 *
 * `preferredOrigin` falls back to the plain door when there is no cert, which
 * is right for a phone's link screen and wrong for anything that must not be
 * spoken in the clear. The client seat's OAuth surface asks here instead: no
 * cert means no authorization server, rather than a client secret in the open.
 */
export function secureOrigin(): string | null {
	if (!secureServer) return null;
	return `https://${lanAddress() ?? "127.0.0.1"}:${secureServer.port}`;
}

/**
 * The loopback origin, which is the whole point of the loopback door.
 *
 * Named as `127.0.0.1` and never as a hostname, because the address is the
 * security argument: a client that dialled the loopback address is a client on
 * this machine, and everything this door hands it must point back at the same
 * literal. A metadata document served here that named `secureOrigin()` would
 * bounce a client that needs no certificate onto one it cannot verify — which
 * is exactly the wall this door exists to remove.
 */
export function loopbackOrigin(): string | null {
	if (!loopbackServer) return null;
	return `http://127.0.0.1:${loopbackServer.port}`;
}

export function webModeStatus(): WebModeStatus {
	const origin = preferredOrigin();
	return origin ? { enabled: true, url: `${origin}/` } : { enabled: false, url: null };
}

/**
 * Pairing CORS: native Capacitor claims from `capacitor://localhost`,
 * not from this origin. The code is the credential; origin never was.
 */
const PAIR_CORS = {
	"access-control-allow-origin": "*",
	"access-control-allow-methods": "POST, OPTIONS",
	"access-control-allow-headers": "content-type",
};

function pairJson(body: unknown, status = 200): Response {
	return Response.json(body, { status, headers: PAIR_CORS });
}

/** The URL a fresh pairing QR should encode. */
export function pairingUrl(code: string): string | null {
	const origin = preferredOrigin();
	if (!origin) return null;
	// Native clients ignore the https origin for the wire and use this
	// port on the same host — the plain door, no self-signed cert.
	const httpPort = server?.port ?? DEFAULT_PORT;
	return `${origin}/?pair=${code}&http=${httpPort}`;
}

/* ------------------------------------------------------------ mobile members
 * The phone as a plane member. `/node/join` trades the same one-time pairing
 * code the QR already carries for a *membership* — a replicated member record
 * — instead of a standing bearer token. `/node/session` then authenticates
 * any later connection by Ed25519 challenge against that record and mints a
 * short-lived session for the `/ws` upgrade. Every desk in the grant can run
 * this exchange once the record has synced to it; that is what lets one
 * identity walk between desks.
 */

const CHALLENGE_TTL_MS = 60_000;
const SESSION_TTL_MS = 10 * 60_000;
/** How stale a signed join may be before it is a replay, not a request. */
const JOIN_SKEW_MS = 2 * 60_000;

const challenges = new Map<string, { nonce: string; expiresAt: number }>();
const sessions = new Map<string, { nodeId: string; deviceId: string; expiresAt: number }>();

function sweepMobileAuth(): void {
	const now = Date.now();
	for (const [id, challenge] of challenges) {
		if (challenge.expiresAt <= now) challenges.delete(id);
	}
	for (const [token, session] of sessions) {
		if (session.expiresAt <= now) sessions.delete(token);
	}
}

/** The member record, wearing the identity shape the verifier expects. */
function identityOfMember(member: MobileMember): NodeIdentity {
	return {
		id: member.nodeId,
		name: member.name,
		publicKey: member.publicKey,
		fingerprint: member.fingerprint,
		protocol: 1,
		capabilities: member.capabilities,
	};
}

export type GrantedDesktop = { nodeId: string; name: string; origin: string | null; self: boolean };

/** A fleet peer's plain web door, from whichever address the row holds. */
function webDoorOf(peer: { origin: string; webOrigin?: string }): string | null {
	if (peer.webOrigin) return peer.webOrigin;
	try {
		const url = new URL(peer.origin);
		// The fleet row addresses the node listener; phones speak to the web
		// door on the same host. A desk on a custom web port keeps a webOrigin.
		return `http://${url.hostname}:${DEFAULT_PORT}`;
	} catch {
		return null;
	}
}

/** The grant as the phone should see it: names and doors, not bare ids. */
export function grantedDesktops(grant: string[]): GrantedDesktop[] {
	const desks: GrantedDesktop[] = [];
	if (grant.includes(localNodeId())) {
		desks.push({ nodeId: localNodeId(), name: hostname(), origin: httpOrigin(), self: true });
	}
	for (const peer of listFleetPeers()) {
		if (!grant.includes(peer.id)) continue;
		desks.push({ nodeId: peer.id, name: peer.name, origin: webDoorOf(peer), self: false });
	}
	return desks;
}

function memberAnswer(member: MobileMember): Record<string, unknown> {
	return {
		nodeId: member.nodeId,
		name: member.name,
		fingerprint: member.fingerprint,
		grant: member.grant,
	};
}

/** The room, as every membership answer names it. Founds "Toad Room" when a
 * phone arrives before anyone has named one — naming is a settings act. */
function roomAnswer(): { id: string; name: string } {
	const room = ensureRoom();
	return { id: room.id, name: room.name };
}

/**
 * The join: one pairing code buys one membership, ever.
 *
 * The proof signs `{ code, id, at }` in that key order — possession of the
 * key that will authenticate every later session, bound to the code being
 * spent. Checks run proof-first so a garbled request cannot burn a code the
 * person is still holding up on screen.
 */
function handleMobileJoin(body: unknown): { status: number; body: unknown } {
	sweepMobileAuth();
	const input = body as { code?: unknown; node?: unknown; at?: unknown; proof?: unknown };
	const node = input.node as NodeIdentity;
	if (
		typeof input.code !== "string" ||
		typeof input.at !== "number" ||
		typeof input.proof !== "string" ||
		!isNodeIdentity(node)
	) {
		return { status: 400, body: { ok: false, error: "bad request" } };
	}
	if (!node.capabilities.includes("endpoint") || node.capabilities.includes("store")) {
		return { status: 400, body: { ok: false, error: "not a mobile identity" } };
	}
	if (node.id === localNodeId() || listFleetPeers().some((peer) => peer.id === node.id)) {
		return { status: 409, body: { ok: false, error: "that id names a desktop" } };
	}
	if (Math.abs(Date.now() - input.at) > JOIN_SKEW_MS) {
		return { status: 403, body: { ok: false, error: "stale request" } };
	}
	if (!verifyNodePayload(node, "mobile-join", { code: input.code, id: node.id, at: input.at }, input.proof)) {
		return { status: 403, body: { ok: false, error: "bad identity proof" } };
	}

	// A phone that is already a member re-proves its key and gets its room
	// back without spending the code — scanning a second desk's QR must not
	// depend on that desk having a live pairing open.
	const known = mobileMember(node.id);
	if (known) {
		return {
			status: 200,
			body: {
				ok: true,
				existing: true,
				desk: { nodeId: localNodeId(), name: hostname() },
				room: roomAnswer(),
				member: memberAnswer(known),
				desktops: grantedDesktops(known.grant),
			},
		};
	}

	if (!consumePairing(input.code)) {
		return { status: 403, body: { ok: false, error: "that code is expired or spent" } };
	}
	const grant = [localNodeId(), ...listFleetPeers().map((peer) => peer.id)];
	const outcome = admitMobileMember(node, grant);
	if (!outcome.ok) {
		return {
			status: 403,
			body: {
				ok: false,
				error:
					outcome.reason === "revoked"
						? "This phone was removed; re-admit it on the desk that removed it"
						: "That identity was refused",
				reason: outcome.reason,
			},
		};
	}
	return {
		status: 200,
		body: {
			ok: true,
			existing: outcome.existing,
			desk: { nodeId: localNodeId(), name: hostname() },
			room: roomAnswer(),
			member: memberAnswer(outcome.member),
			desktops: grantedDesktops(outcome.member.grant),
		},
	};
}

/**
 * The session exchange, both halves.
 *
 * Without a proof it is the ask — a nonce comes back with this desk's id so
 * the phone can bind its answer to the desk it thinks it is talking to. With
 * one, the signature over `{ challenge, id, dst }` is checked against the
 * *replicated* member key, the grant is checked live, and what is minted is
 * ten minutes of upgrade rights, not a credential worth stealing.
 */
function handleMobileSession(body: unknown): { status: number; body: unknown } {
	sweepMobileAuth();
	const input = body as { nodeId?: unknown; challenge?: unknown; proof?: unknown };
	if (typeof input.nodeId !== "string" || input.nodeId.length === 0) {
		return { status: 400, body: { ok: false, error: "bad request" } };
	}
	const member = mobileMember(input.nodeId);
	if (!member) {
		return {
			status: 403,
			body: { ok: false, error: "not a member of this room", reason: "unknown" },
		};
	}
	if (!member.grant.includes(localNodeId())) {
		return {
			status: 403,
			body: { ok: false, error: "this desktop is not shared with that phone", reason: "not-granted" },
		};
	}

	if (input.challenge === undefined) {
		const nonce = randomBytes(32).toString("base64url");
		challenges.set(member.nodeId, { nonce, expiresAt: Date.now() + CHALLENGE_TTL_MS });
		return {
			status: 200,
			body: { ok: true, challenge: nonce, desk: { nodeId: localNodeId(), name: hostname() } },
		};
	}

	if (typeof input.challenge !== "string" || typeof input.proof !== "string") {
		return { status: 400, body: { ok: false, error: "bad request" } };
	}
	const pending = challenges.get(member.nodeId);
	if (!pending || pending.nonce !== input.challenge || pending.expiresAt <= Date.now()) {
		return { status: 403, body: { ok: false, error: "challenge expired", reason: "challenge" } };
	}
	challenges.delete(member.nodeId);
	const payload = { challenge: input.challenge, id: member.nodeId, dst: localNodeId() };
	if (!verifyNodePayload(identityOfMember(member), "mobile-session", payload, input.proof)) {
		return { status: 403, body: { ok: false, error: "bad proof", reason: "proof" } };
	}

	const device = deviceForMember(member.nodeId, member.name);
	const token = randomBytes(24).toString("hex");
	sessions.set(token, {
		nodeId: member.nodeId,
		deviceId: device.id,
		expiresAt: Date.now() + SESSION_TTL_MS,
	});
	return {
		status: 200,
		body: {
			ok: true,
			token,
			deviceId: device.id,
			desk: { nodeId: localNodeId(), name: hostname() },
			room: roomAnswer(),
			member: memberAnswer(member),
			desktops: grantedDesktops(member.grant),
		},
	};
}

/* ------------------------------------------------------------- client seat
 * An outside MCP agent's way in. `mcp/seat.ts` decides what a request means;
 * this decides where it is allowed to arrive — which door, the right method,
 * and the CORS posture the two discovery documents need to be readable by a
 * client that has not authenticated yet.
 *
 * TWO DOORS CARRY IT, AND EACH ONE NAMES ITSELF. The TLS door on 0.0.0.0, for
 * an agent on another machine; the loopback door on 127.0.0.1, for an agent on
 * this one. Which door took the connection is what decides the origin every
 * URL the seat publishes is built from — the issuer, the three endpoints, the
 * resource identifier and the audience a token is checked against. A client
 * that dialled loopback must never be handed an https address it would then
 * have to verify a certificate for; that bounce is the entire failure this
 * door removes. So the origin is threaded from here rather than read out of a
 * global, and `mcp/seat.ts` builds no URL of its own.
 *
 * The plain LAN door on 0.0.0.0 still carries none of it. That refusal is
 * older than this comment and is not relaxed: loopback is a different
 * boundary, the LAN is not.
 */

const SEAT_CORS = {
	"access-control-allow-origin": "*",
	"access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
	"access-control-allow-headers":
		"authorization, content-type, mcp-protocol-version, mcp-session-id, last-event-id",
	/* A browser client reads the challenge to find where to enroll, and reads
	 * the session header the transport sets; neither is visible cross-origin
	 * unless it is named here. */
	"access-control-expose-headers": "www-authenticate, mcp-session-id",
};

function seatJson(answer: { status: number; body: unknown; headers?: Record<string, string> }): Response {
	return Response.json(answer.body, {
		status: answer.status,
		headers: { ...SEAT_CORS, ...(answer.headers ?? {}) },
	});
}

/**
 * A seat answer that may be a page or a redirect rather than JSON.
 *
 * The browser door speaks HTML and 302s; every other route speaks JSON. One
 * helper for both so CORS and status handling do not fork by content type.
 */
function seatAnswer(answer: { status: number; body: unknown; headers?: Record<string, string> }): Response {
	const headers = { ...SEAT_CORS, ...(answer.headers ?? {}) };
	if (typeof answer.body === "string") return new Response(answer.body, { status: answer.status, headers });
	if (answer.body === null) return new Response(null, { status: answer.status, headers });
	return Response.json(answer.body, { status: answer.status, headers });
}

async function serveClientSeat(
	route: SeatRoute,
	request: Request,
	origin: string | null,
): Promise<Response | null> {
	if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: SEAT_CORS });
	if (!origin) {
		/* The plain LAN door does not carry this. Said as an OAuth error rather
		 * than a 404 so a client that probed the wrong port is told which
		 * fact to fix, and never gets far enough to send a secret here. */
		return seatJson({
			status: 403,
			body: {
				error: "invalid_request",
				error_description:
					"The client seat is served over the room's https door, or over http://127.0.0.1 from this machine. This plain LAN door carries none of it.",
			},
		});
	}
	if (route.kind === "endpoint") {
		/* The MCP endpoint itself. Everything about who is asking rides the
		 * bearer token, so this layer only has to say which door the request
		 * came in on and let the seat's own gate answer. */
		const answer = await handleSeatMcpRequest(request, origin);
		for (const [name, value] of Object.entries(SEAT_CORS)) answer.headers.set(name, value);
		return answer;
	}
	if (route.kind === "authorize") {
		/* The browser door. A GET draws the consent page; a POST is the code
		 * being entered, which is the approval. The grant offered is the
		 * phone's — this desk and everything linked to it — and it is computed
		 * here for the same reason registration's is: this layer knows the
		 * room, the seat module knows the protocol. */
		const desks = [localNodeId(), ...listFleetPeers().map((peer) => peer.id)];
		if (request.method === "GET") {
			return seatAnswer(handleAuthorizePage(new URL(request.url).searchParams, desks));
		}
		if (request.method === "POST") {
			let form: URLSearchParams;
			try {
				form = new URLSearchParams(await request.text());
			} catch {
				return seatJson({ status: 400, body: { error: "invalid_request" } });
			}
			return seatAnswer(handleAuthorizeSubmit(form, desks));
		}
		return seatJson({ status: 405, body: { error: "method_not_allowed" }, headers: { allow: "GET, POST, OPTIONS" } });
	}
	if (route.kind === "metadata") {
		if (request.method !== "GET") {
			return seatJson({ status: 405, body: { error: "method_not_allowed" }, headers: { allow: "GET, OPTIONS" } });
		}
		return seatMetadataResponse(route.document, origin);
	}
	if (request.method !== "POST") {
		return seatJson({ status: 405, body: { error: "method_not_allowed" }, headers: { allow: "POST, OPTIONS" } });
	}
	const authorization = request.headers.get("authorization");
	if (route.kind === "register") {
		let body: unknown;
		try {
			body = await request.json();
		} catch {
			return seatJson({
				status: 400,
				body: { error: "invalid_client_metadata", error_description: "The registration body is not JSON." },
			});
		}
		/* The same grant a phone's join confers: this desk and every desk
		 * linked to it, narrowed afterwards in Settings. One default, so an
		 * agent and a phone joining the same room start in the same place. */
		const grant = [localNodeId(), ...listFleetPeers().map((peer) => peer.id)];
		return seatJson(handleClientRegistration(authorization, body, grant, origin));
	}
	let form: URLSearchParams;
	try {
		form = new URLSearchParams(await request.text());
	} catch {
		return seatJson({ status: 400, body: { error: "invalid_request" } });
	}
	return seatJson(handleClientToken(authorization, form, origin));
}

/**
 * The loopback door: the client seat, and nothing else in this process.
 *
 * A separate listener rather than a flag on the LAN one, because the boundary
 * is the bind address and nothing softer. Everything Toad serves that is *not*
 * the seat — the app bundle, `/ws`, `/pair`, `/fleet` — already has a door and
 * gains nothing from a second, so this one answers 404 to all of it. Adding a
 * surface here would be adding a way in that nobody asked for.
 *
 * What loopback buys is the certificate: a client on this machine reaches this
 * door without a trust store, an installed root, or `NODE_EXTRA_CA_CERTS`,
 * because the confidentiality TLS provides is confidentiality from the network
 * and there is no network between two processes on one box. What it does not
 * buy is isolation from the *other* processes and users on that box — see
 * `docs/client-seat.md`.
 */
function loopbackServe() {
	return {
		idleTimeout: 255,
		async fetch(request: Request): Promise<Response> {
			const route = seatRouteFor(new URL(request.url).pathname);
			if (!route) {
				return new Response("This door serves the client seat only.\n", {
					status: 404,
					headers: { "content-type": "text/plain; charset=utf-8" },
				});
			}
			const answer = await serveClientSeat(route, request, loopbackOrigin());
			return answer ?? new Response(null, { status: 404 });
		},
	};
}

/**
 * Binds it, and never at the cost of the doors that were already up.
 *
 * A busy 4682 is the ordinary case of a second desk on one box — a worktree QA
 * instance beside the live app — and it must cost that desk its loopback door
 * and nothing more. So the failure is caught, named on the console, and left:
 * `loopbackOrigin()` answers null, the enrollment panel offers the TLS address
 * alone, and every other listener in this process is untouched.
 */
function bindLoopback(): Bun.Server<WsData> | null {
	try {
		return Bun.serve<WsData>({ hostname: "127.0.0.1", port: LOOPBACK_PORT, ...loopbackServe() });
	} catch (error) {
		console.error(
			`[web] this desk has no loopback client-seat door on ${LOOPBACK_PORT} (${reasonOf(error)}); agents on this machine use the https address.`,
		);
		return null;
	}
}

/** The one app, as Bun.serve options — served identically over both doors. */
/**
 * The calls that only mean something coming from a known device.
 *
 * Answered here rather than in the shared handler map because this is the
 * only layer that knows *which* device is asking: the socket authenticated
 * one, and the desktop process has no phone to speak for. Threading a device
 * through every handler to serve two of them would be the wrong trade.
 */
function deviceScoped(
	deviceId: string,
	method: string,
	params: unknown,
): { result: unknown } | null {
	const body = (params ?? {}) as Record<string, unknown>;
	switch (method) {
		case "registerPushDevice": {
			const token = String(body.token ?? "");
			const environment = body.environment === "production" ? "production" : "sandbox";
			if (!token) return { result: { registered: false } };
			/* The address goes to the room, not just to this desk. The phone
			 * rewrites it on every launch because APNs mints a fresh one whenever
			 * it likes, and this is the convergence point: the owning desk keeps
			 * the plaintext and publishes a box for every other desk, so any of
			 * them can reach the phone without routing through this one. */
			const registered = registerPushDevice({ deviceId, token, environment });
			return { result: { registered: registered !== null } };
		}
		case "reportPushProblem": {
			const reason = String(body.reason ?? "").trim();
			if (reason) setDevicePushProblem(deviceId, reason);
			return { result: undefined };
		}
		case "setActivePersona": {
			// The desktop's own copy of this is a single global driving the window
			// title. Push needs it per device — see the note in push/notify.ts —
			// so a phone's answer is recorded here and never clobbers the desktop's.
			const personaId = typeof body.personaId === "string" ? body.personaId : null;
			deviceViewing(deviceId, personaId);
			return { result: undefined };
		}
		default:
			return null;
	}
}

function appServe(dir: string, resolve: Resolver) {
	return {
		idleTimeout: 255,
		async fetch(request: Request, srv: Bun.Server<WsData>) {
			const url = new URL(request.url);

			/* The client seat: an outside MCP agent's OAuth surface. Answered
			 * before anything else because two of its paths are well-knowns at
			 * the origin root, which the SPA fallback below would otherwise
			 * swallow. Only on the TLS door — `srv === secureServer` rather
			 * than the URL's scheme, because the door is a fact about which
			 * listener took the connection and the scheme is a header away
			 * from being a claim. A client secret is not for the plain door.
			 * (The loopback door is its own listener and never lands here.) */
			const seatRoute = seatRouteFor(url.pathname);
			if (seatRoute) {
				const answer = await serveClientSeat(
					seatRoute,
					request,
					srv === secureServer ? secureOrigin() : null,
				);
				if (answer) return answer;
			}

			// Trades a one-time pairing code for this device's own token. The
			// code is the authentication; there is nothing else a stranger on
			// the LAN could present here.
			/* Desktop-to-desktop. Both routes speak only to the fleet layer:
			 * /fleet/pair is gated by a short-lived invite code the phone
			 * carried over; /fleet/rpc by the pairwise bearer that pairing
			 * minted. Neither can reach the device-token RPC surface. */
			if (url.pathname === "/fleet/pair" && request.method === "POST") {
				let body: unknown;
				try {
					body = await request.json();
				} catch {
					return Response.json({ error: "bad request" }, { status: 400 });
				}
				const result = handleFleetPair(body);
				return Response.json(result.body, { status: result.status });
			}
			if (url.pathname === "/fleet/rpc" && request.method === "POST") {
				let body: unknown;
				try {
					body = await request.json();
				} catch {
					return Response.json({ error: "bad request" }, { status: 400 });
				}
				const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
				const result = await handleFleetRpc(bearer, body);
				return Response.json(result.body, { status: result.status });
			}

			/* Mobile plane membership. Same CORS posture as /pair — the code and
			 * the signatures are the credentials; origin never was one. */
			if (url.pathname === "/node/join" || url.pathname === "/node/session") {
				if (request.method === "OPTIONS") {
					return new Response(null, { status: 204, headers: PAIR_CORS });
				}
				if (request.method === "POST") {
					let body: unknown;
					try {
						body = await request.json();
					} catch {
						return pairJson({ ok: false, error: "bad request" }, 400);
					}
					const result =
						url.pathname === "/node/join" ? handleMobileJoin(body) : handleMobileSession(body);
					return pairJson(result.body, result.status);
				}
			}

			if (url.pathname === "/pair") {
				if (request.method === "OPTIONS") {
					return new Response(null, { status: 204, headers: PAIR_CORS });
				}
				if (request.method === "POST") {
					let body: { code?: string; name?: string };
					try {
						body = (await request.json()) as typeof body;
					} catch {
						return pairJson({ ok: false }, 400);
					}
					const device = claimPairing(String(body.code ?? ""), String(body.name ?? ""));
					if (!device) return pairJson({ ok: false }, 403);
					const { instanceId, hostName } = instanceIdentity();
					return pairJson({
						ok: true,
						deviceId: device.id,
						token: device.token,
						instanceId,
						hostName,
					});
				}
			}

			if (url.pathname === "/ws") {
				/* The native shell tells a revoked token from a dead desktop by
				 * fetching this path cross-origin and reading the status. Without
				 * the CORS header that read is forbidden, the 401 looks like a
				 * network blip, and a revoked phone knocks forever instead of
				 * landing back on its instance list. The header only opens the
				 * status; the socket itself still authenticates per token. */
				const cors = { "access-control-allow-origin": "*" };

				/* A member session: minted minutes ago by the challenge exchange,
				 * single-use in spirit — the socket it upgrades outlives it, and a
				 * reconnect runs the exchange again. The membership is re-checked
				 * here because a session can outlive a revocation by its TTL. */
				const presentedSession = url.searchParams.get("session") ?? "";
				if (presentedSession) {
					sweepMobileAuth();
					const session = sessions.get(presentedSession);
					if (!session) return new Response("unauthorized", { status: 401, headers: cors });
					sessions.delete(presentedSession);
					const grant = memberGrant(session.nodeId);
					if (!grant || !grant.includes(localNodeId())) {
						return new Response("unauthorized", { status: 401, headers: cors });
					}
					touchDevice(session.deviceId);
					return srv.upgrade(request, {
						data: { deviceId: session.deviceId, fleetPeerId: null, memberNode: session.nodeId },
					})
						? undefined
						: new Response("upgrade failed", { status: 500, headers: cors });
				}

				const presented = url.searchParams.get("token") ?? "";
				const device = deviceByToken(presented);
				if (!device || !tokenEqual(presented, device.token)) {
					return new Response("unauthorized", { status: 401, headers: cors });
				}
				touchDevice(device.id);
				return srv.upgrade(request, {
					data: { deviceId: device.id, fleetPeerId: device.fleetPeerId ?? null, memberNode: null },
				})
					? undefined
					: new Response("upgrade failed", { status: 500, headers: cors });
			}

			// Static bundle. Path-traversal is refused by normalizing before join.
			const clean = normalize(url.pathname).replace(/^([/\\])+/, "");
			const path = clean === "" || clean === "." ? "index.html" : clean;
			const file = join(dir, path);
			const type = MIME[extname(file)];
			if (type && existsSync(file)) {
				return new Response(Bun.file(file), { headers: { "content-type": type } });
			}
			// Anything unknown is the SPA itself.
			return new Response(Bun.file(join(dir, "index.html")), {
				headers: { "content-type": MIME[".html"]! },
			});
		},
		websocket: {
			open(ws: Bun.ServerWebSocket<WsData>) {
				clients.add(ws);
			},
			close(ws: Bun.ServerWebSocket<WsData>) {
				clients.delete(ws);
				// A device that is gone is not looking at anything, so it stops
				// suppressing its own notifications.
				forgetDeviceViewing(ws.data.deviceId);
			},
			async message(ws: Bun.ServerWebSocket<WsData>, raw: string | Buffer) {
				let frame: { id?: number; method?: string; params?: unknown };
				try {
					frame = JSON.parse(String(raw));
				} catch {
					return;
				}
				if (typeof frame.id !== "number" || typeof frame.method !== "string") return;
				const deskOnly = DESKTOP_ONLY.get(frame.method);
				if (deskOnly) {
					ws.send(JSON.stringify({ id: frame.id, ok: false, error: deskOnly }));
					return;
				}
				const scoped = deviceScoped(ws.data.deviceId, frame.method, frame.params);
				if (scoped) {
					touchDevice(ws.data.deviceId);
					ws.send(JSON.stringify({ id: frame.id, ok: true, result: scoped.result }));
					return;
				}
				if (ws.data.memberNode) {
					// Only this layer knows which member is asking, so the
					// member-only surface and the allow-list gate both live here.
					if (frame.method === "myDesktops") {
						const grant = memberGrant(ws.data.memberNode) ?? [];
						ws.send(
							JSON.stringify({
								id: frame.id,
								ok: true,
								result: { room: roomAnswer(), desktops: grantedDesktops(grant) },
							}),
						);
						return;
					}
					const refusal = memberGate(ws.data.memberNode, frame.method, frame.params);
					if (refusal) {
						ws.send(JSON.stringify({ id: frame.id, ok: false, error: refusal }));
						return;
					}
				}
				const handler = resolve(frame.method);
				if (!handler) {
					ws.send(JSON.stringify({ id: frame.id, ok: false, error: `unknown method ${frame.method}` }));
					return;
				}
				try {
					const raw = await handler(frame.params ?? {});
					const result = ws.data.memberNode
						? memberResult(ws.data.memberNode, frame.method, raw)
						: raw;
					touchDevice(ws.data.deviceId);
					ws.send(JSON.stringify({ id: frame.id, ok: true, result }));
				} catch (error) {
					ws.send(
						JSON.stringify({
							id: frame.id,
							ok: false,
							error: error instanceof Error ? error.message : "request failed",
						}),
					);
				}
			},
		},
	};
}

let membersHooked = false;
let caHooked = false;
let adopting = false;
/** A bell rang while a pass was in flight, and that pass has to be run again. */
let adoptAgain = false;
/** The serve options the secure door was built from, for a rebind after cutover. */
let secureOptions: ReturnType<typeof appServe> | null = null;
let tlsFault: string | null = null;
/** The last bind failed on the port rather than the material — the one worth waiting out. */
let tlsPortInUse = false;

export function startWebMode(resolve: Resolver, port = DEFAULT_PORT): WebModeStatus {
	if (server) return webModeStatus();
	const dir = viewsDir();
	if (!dir) throw new Error("The web bundle was not found — build the app first.");
	const options = appServe(dir, resolve);

	// Membership changes land here from local edits and from sync alike. A
	// revoked phone — or one whose grant no longer names this desk — goes dark
	// now, not at its next reconnect; pending auth state dies with it.
	if (!membersHooked) {
		membersHooked = true;
		onMembersChanged(() => {
			for (const ws of clients) {
				const node = ws.data.memberNode;
				if (!node) continue;
				const grant = memberGrant(node);
				if (!grant || !grant.includes(localNodeId())) ws.close();
			}
			for (const [id] of challenges) {
				const grant = memberGrant(id);
				if (!grant || !grant.includes(localNodeId())) challenges.delete(id);
			}
			for (const [token, session] of sessions) {
				const grant = memberGrant(session.nodeId);
				if (!grant || !grant.includes(localNodeId())) sessions.delete(token);
			}
			/* The client seat's half of the same promise: a removed agent's
			 * access tokens die with the tombstone, not at their own expiry. */
			sweepRevokedClients();
		});
	}

	// A desk that joined the room before the CA existed — or before its owner
	// swept and sealed a copy to it — comes up on a bare self-signed leaf, which
	// is the honest fallback and not the intended state. The box arrives as an
	// ordinary credential op, and the bell that already rings for one is the
	// moment the door can stop asking clients to trust this desk alone. A
	// listener cannot be handed new TLS material in place, so it is rebound —
	// once, guarded by the fingerprint, because every provider key in the room
	// rings this same bell.
	if (!caHooked) {
		caHooked = true;
		onCredentialsChanged(() => {
			// Adopting the room's root revokes the one this desk minted before it
			// heard about the room's, and revoking rings this same bell. Re-entrant
			// by flag rather than by lock, the way `fleet/credentials.ts` is — and
			// with its `again` too, because a pass here spans an await: the bell
			// that finally carries this desk's sealed copy of the root can ring
			// while one is in flight, and a bell dropped is a desk that never
			// adopts. So the pass runs once more instead.
			if (!secureOptions) return;
			if (adopting) {
				adoptAgain = true;
				return;
			}
			const options = secureOptions;
			adopting = true;
			void (async () => {
				try {
					do {
						adoptAgain = false;
						await adoptTls(options);
					} while (adoptAgain);
				} finally {
					adopting = false;
				}
			})();
		});
	}

	// HTTPS is what makes the phone whole: a secure context is what browsers
	// price the camera, service workers, and real PWA install at. The leaf is
	// signed by the room's CA when this desk holds a copy of it and self-signed
	// when it does not; no openssl, no HTTPS door, and the link screen falls
	// back from viewfinder to photo capture.
	const tls = ensureTls();
	secureServer = tls ? bindSecure(tls, options) : null;

	/* The loopback door, which needs no certificate and therefore does not wait
	 * for one. A desk with no openssl still admits an agent running beside it. */
	loopbackServer = bindLoopback();
	// Armed only now. Minting the room's root publishes a credential, which
	// rings the bell above, and a hook that could bind the port while this line
	// was still deciding to would race the door against itself.
	secureOptions = options;

	const appFetch = options.fetch;
	server = Bun.serve<WsData>({
		hostname: "0.0.0.0",
		port,
		...options,
		// The plain door. Only a bare "/" navigation bounces to HTTPS — that is
		// a phone's browser arriving to install the PWA, which needs the secure
		// context. Everything else answers here: /ws and /pair for devices
		// linked before the cert did, /fleet for peers, and the app itself for
		// a fleet window (`?shell=native`), whose webview would refuse the
		// self-signed cert that the bounce lands on. Its asset requests carry
		// no marker, so the exemption is by inversion, not by list.
		//
		// Asked per request rather than captured at bind time: the secure door
		// can arrive after this one, when the room's CA reaches this desk.
		fetch: async (request: Request, srv: Bun.Server<WsData>) => {
			if (!secureServer) return appFetch(request, srv);
			const url = new URL(request.url);
			const pwaArrival = url.pathname === "/" && url.searchParams.get("shell") !== "native";
			if (!pwaArrival) return appFetch(request, srv);
			const origin = preferredOrigin();
			return Response.redirect(`${origin}${url.pathname}${url.search}`, 302);
		},
	});
	return webModeStatus();
}

/**
 * Puts a freshly signed leaf on the door, waiting for the port if it has to.
 *
 * A listener cannot be handed TLS material in place, so the old one is stopped
 * and a new one takes the same port — and a port is not always free in the tick
 * that released it. Nothing about the certificate is wrong when that happens, so
 * the replacement waits it out instead: a desk that read "address already in
 * use" as "this certificate cannot be served" would answer the room's own root
 * arriving by dropping to a plain door, which is the opposite of what just
 * happened to it. Two seconds is far longer than a socket takes to close and far
 * shorter than a person notices.
 */
async function adoptTls(options: ReturnType<typeof appServe>): Promise<void> {
	const before = webTlsTrust().fingerprint;
	const fresh = ensureTls();
	if (!fresh || webTlsTrust().fingerprint === before) return;
	secureServer?.stop(true);
	secureServer = null;
	for (let attempt = 0; attempt < 40; attempt += 1) {
		secureServer = bindSecure(fresh, options);
		// Bound, or failed for a reason waiting will not mend.
		if (secureServer || !tlsPortInUse) return;
		await new Promise((settle) => setTimeout(settle, 50));
	}
}

/**
 * Binds the HTTPS door, and refuses to lose it over bad TLS material.
 *
 * `Bun.serve` throws when its TLS library will not take the key it is handed,
 * and an unguarded throw here took the whole of web mode with it — the plain
 * door, the pairing surface, the client seat, all of it — for a leaf. (macOS
 * LibreSSL writing explicit EC parameters that Bun's BoringSSL refuses is how
 * the node plane met this shape; `web/tls.ts` now names the curve, and this is
 * the belt to that pair of braces.)
 *
 * So: remint once, because material this process cannot serve is material no
 * restart will fix and it survives reboots. If that still fails, serve plain
 * rather than dark, and leave the reason where a human can find it.
 *
 * A bind that failed on the *port* is neither case — no certificate ever fixed a
 * busy socket — so it is named rather than treated, and `adoptTls` is the caller
 * that can do something about it.
 */
function bindSecure(
	tls: { key: string; cert: string },
	options: ReturnType<typeof appServe>,
): Bun.Server<WsData> | null {
	const bind = (material: { key: string; cert: string }) =>
		Bun.serve<WsData>({ hostname: "0.0.0.0", port: HTTPS_PORT, tls: material, ...options });
	tlsPortInUse = false;
	try {
		const bound = bind(tls);
		tlsFault = null;
		return bound;
	} catch (first) {
		/* A port is not a certificate. Reminting because the socket is busy would
		 * be answering a full port with a new key, and the desk would end up plain
		 * with perfectly good material on disk — so this failure is named and
		 * handed back to whoever can wait for it. */
		if (/address already in use|EADDRINUSE/i.test(reasonOf(first))) {
			tlsPortInUse = true;
			tlsFault = `This desk's HTTPS port is still in use (${reasonOf(first)}).`;
			return null;
		}
		tlsFault = `This desk's web certificate could not be served (${reasonOf(first)}); reminting.`;
		console.error(`[web] ${tlsFault}`);
		/* Reminting is safe to call bare only because every step it reaches — the
		 * room's CA record, the vault, openssl in its scratch directory — swallows
		 * its own failures. That is an invariant held by inspection, and the price
		 * of it lapsing is paid right here: a throw escaping this handler escapes
		 * `startWebMode` too, and the *plain* door is bound after this call. Losing
		 * the whole of web mode to one bad certificate is exactly the regression
		 * this function exists to prevent, so the recovery gets the same braces the
		 * bind does. */
		let fresh: { key: string; cert: string } | null = null;
		try {
			fresh = remintWebTls();
		} catch (error) {
			tlsFault = `This desk could not mint a web certificate (${reasonOf(error)}); web mode is running plain.`;
			console.error(`[web] ${tlsFault}`);
			return null;
		}
		if (fresh) {
			try {
				const bound = bind(fresh);
				tlsFault = null;
				console.error("[web] a reminted certificate binds; the web door is encrypted again.");
				return bound;
			} catch (second) {
				tlsFault = `This desk cannot serve TLS (${reasonOf(second)}); web mode is running plain.`;
			}
		} else {
			tlsFault = "This desk could not mint a web certificate; web mode is running plain.";
		}
		console.error(`[web] ${tlsFault}`);
		return null;
	}
}

function reasonOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Why this desk has no HTTPS door, when it meant to. Null when all is well. */
export function webTlsFault(): string | null {
	return tlsFault;
}

export function stopWebMode(): void {
	for (const ws of clients) ws.close();
	clients.clear();
	server?.stop(true);
	server = null;
	secureServer?.stop(true);
	secureServer = null;
	loopbackServer?.stop(true);
	loopbackServer = null;
	// The adoption hook binds from these. Web mode that was turned off must not
	// come back up because a credential elsewhere in the room changed.
	secureOptions = null;
	tlsFault = null;
	tlsPortInUse = false;
}

/**
 * Revokes the credential and hangs up its sockets in the same breath.
 *
 * Through `unpairPushDevice` rather than `revokeDevice`, because the phone's
 * address is no longer only here: dropping the row alone would delete this
 * desk's plaintext and leave every other desk holding a sealed copy of an
 * address nobody answers to. The withdrawal travels first, and a desk that is
 * dark reads as pending until it comes back.
 */
export function revokeWebDevice(id: string): boolean {
	const removed = unpairPushDevice(id);
	if (removed) {
		for (const ws of clients) {
			if (ws.data.deviceId === id) ws.close();
		}
	}
	return removed;
}

export function closeFleetPeerSockets(peerId: string): void {
	for (const ws of clients) {
		if (ws.data.fleetPeerId === peerId) ws.close();
	}
}

/** Hangs up one member's sockets — the revocation path's other half. */
export function closeMemberSockets(nodeId: string): void {
	for (const ws of clients) {
		if (ws.data.memberNode === nodeId) ws.close();
	}
}

/**
 * Every push the desktop webview gets, the phones get too.
 *
 * A linked desktop speaks this same wire holding a device credential of its
 * own, but it is not a client of this one: hand it its own facts back and it
 * qualifies them, emits them, and sends them here again — one event
 * circulating between two desks forever. Peers hear only what
 * `peerBroadcast` deliberately gives them.
 */
export function webBroadcast(name: string, payload: unknown): void {
	fanOut("webBroadcast", name, payload, (ws) => ws.data.fleetPeerId === null);
}

/**
 * A push aimed at the linked desktops rather than the people. Separate from
 * the fan-out above on purpose: what a peer's wire reads is a short list, and
 * only fleet/wire.ts is in a position to say what belongs on it.
 */
export function peerBroadcast(name: string, payload: unknown): void {
	fanOut("peerBroadcast", name, payload, (ws) => ws.data.fleetPeerId !== null);
}

/**
 * Serializes once, and only if that audience has anyone in it.
 *
 * Member sockets are the exception: their copy is trimmed to the grant, so
 * each distinct member serializes its own frame — cached per member, because
 * one phone reconnecting twice should not pay the filter twice per push.
 */
function fanOut(
	kind: "webBroadcast" | "peerBroadcast",
	name: string,
	payload: unknown,
	wanted: (ws: Bun.ServerWebSocket<WsData>) => boolean,
): void {
	let frame: string | null = null;
	let sentBytes = 0;
	const memberFrames = new Map<string, string | null>();
	for (const ws of clients) {
		if (!wanted(ws)) continue;
		const node = ws.data.memberNode;
		if (node) {
			let trimmed = memberFrames.get(node);
			if (trimmed === undefined) {
				const shaped = memberPush(node, name, payload);
				trimmed = shaped.drop ? null : JSON.stringify({ push: name, payload: shaped.payload });
				memberFrames.set(node, trimmed);
			}
			if (trimmed) {
				try {
					ws.send(trimmed);
					sentBytes += trimmed.length;
				} catch {}
			}
			continue;
		}
		frame ??= JSON.stringify({ push: name, payload });
		try {
			ws.send(frame);
			sentBytes += frame.length;
		} catch {}
	}
	if (sentBytes > 0) meshCount(kind, name, { bytes: frame?.length ?? sentBytes });
}
