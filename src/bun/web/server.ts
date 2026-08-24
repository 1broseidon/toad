import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type { WebModeStatus } from "../../shared/types";
import { deviceViewing, forgetDeviceViewing } from "../push/notify";
import {
	claimPairing,
	deviceByToken,
	instanceIdentity,
	revokeDevice,
	setDevicePush,
	touchDevice,
} from "./devices";
import { ensureTls } from "./tls";

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

type WsData = { deviceId: string };

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
				const presented = url.searchParams.get("token") ?? "";
				const device = deviceByToken(presented);
				if (!device || !tokenEqual(presented, device.token)) {
					return new Response("unauthorized", { status: 401, headers: cors });
				}
				touchDevice(device.id);
				return srv.upgrade(request, { data: { deviceId: device.id } })
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
				const handler = resolve(frame.method);
				if (!handler) {
					ws.send(JSON.stringify({ id: frame.id, ok: false, error: `unknown method ${frame.method}` }));
					return;
				}
				try {
					const result = await handler(frame.params ?? {});
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

export function startWebMode(resolve: Resolver, port = DEFAULT_PORT): WebModeStatus {
	if (server) return webModeStatus();
	const dir = viewsDir();
	if (!dir) throw new Error("The web bundle was not found — build the app first.");
	const options = appServe(dir, resolve);

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
		// The plain door: pages bounce to HTTPS when it exists, while /ws and
		// /pair keep answering for devices linked before the cert did.
		fetch: !secureServer
			? appFetch
			: async (request: Request, srv: Bun.Server<WsData>) => {
					const url = new URL(request.url);
					if (url.pathname === "/ws" || url.pathname === "/pair") {
						return appFetch(request, srv);
					}
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

/** Every push the desktop webview gets, the phones get too. */
export function webBroadcast(name: string, payload: unknown): void {
	if (clients.size === 0) return;
	const frame = JSON.stringify({ push: name, payload });
	for (const ws of clients) {
		try {
			ws.send(frame);
		} catch {}
	}
}
