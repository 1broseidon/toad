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
	revokeDevice,
	setDevicePush,
	setDevicePushProblem,
	touchDevice,
} from "./devices";
import { memberGate, memberPush, memberResult } from "./member-view";
import { ensureTls } from "./tls";
import { meshCount } from "../fleet/metrics";

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
			return { result: { registered: setDevicePush(deviceId, token, environment) } };
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
		});
	}

	// HTTPS is what makes the phone whole: a secure context is what browsers
	// price the camera, service workers, and real PWA install at. The cert is
	// self-signed and accepted once per device; no openssl, no HTTPS door,
	// and the link screen falls back from viewfinder to photo capture.
	const tls = ensureTls();
	if (tls) {
		secureServer = Bun.serve<WsData>({
			hostname: "0.0.0.0",
			port: HTTPS_PORT,
			tls,
			...options,
		});
	}

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
		fetch: !secureServer
			? appFetch
			: async (request: Request, srv: Bun.Server<WsData>) => {
					const url = new URL(request.url);
					const pwaArrival = url.pathname === "/" && url.searchParams.get("shell") !== "native";
					if (!pwaArrival) return appFetch(request, srv);
					const origin = preferredOrigin();
					return Response.redirect(`${origin}${url.pathname}${url.search}`, 302);
				},
	});
	return webModeStatus();
}

export function stopWebMode(): void {
	for (const ws of clients) ws.close();
	clients.clear();
	server?.stop(true);
	server = null;
	secureServer?.stop(true);
	secureServer = null;
}

/** Revokes the credential and hangs up its sockets in the same breath. */
export function revokeWebDevice(id: string): boolean {
	const removed = revokeDevice(id);
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
