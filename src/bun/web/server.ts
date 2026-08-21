import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type { WebModeStatus } from "../../shared/types";
import { claimPairing, deviceByToken, revokeDevice, touchDevice } from "./devices";

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
const clients = new Set<Bun.ServerWebSocket<WsData>>();

export function webModeStatus(): WebModeStatus {
	if (!server) return { enabled: false, url: null };
	const host = lanAddress() ?? "127.0.0.1";
	return { enabled: true, url: `http://${host}:${server.port}/` };
}

/** The URL a fresh pairing QR should encode. */
export function pairingUrl(code: string): string | null {
	if (!server) return null;
	const host = lanAddress() ?? "127.0.0.1";
	return `http://${host}:${server.port}/?pair=${code}`;
}

export function startWebMode(resolve: Resolver, port = DEFAULT_PORT): WebModeStatus {
	if (server) return webModeStatus();
	const dir = viewsDir();
	if (!dir) throw new Error("The web bundle was not found — build the app first.");

	server = Bun.serve<WsData>({
		hostname: "0.0.0.0",
		port,
		idleTimeout: 255,
		async fetch(request, srv) {
			const url = new URL(request.url);

			// Trades a one-time pairing code for this device's own token. The
			// code is the authentication; there is nothing else a stranger on
			// the LAN could present here.
			if (url.pathname === "/pair" && request.method === "POST") {
				let body: { code?: string; name?: string };
				try {
					body = (await request.json()) as typeof body;
				} catch {
					return Response.json({ ok: false }, { status: 400 });
				}
				const device = claimPairing(String(body.code ?? ""), String(body.name ?? ""));
				if (!device) return Response.json({ ok: false }, { status: 403 });
				return Response.json({ ok: true, deviceId: device.id, token: device.token });
			}

			if (url.pathname === "/ws") {
				const presented = url.searchParams.get("token") ?? "";
				const device = deviceByToken(presented);
				if (!device || !tokenEqual(presented, device.token)) {
					return new Response("unauthorized", { status: 401 });
				}
				touchDevice(device.id);
				return srv.upgrade(request, { data: { deviceId: device.id } })
					? undefined
					: new Response("upgrade failed", { status: 500 });
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
			open(ws) {
				clients.add(ws);
			},
			close(ws) {
				clients.delete(ws);
			},
			async message(ws, raw) {
				let frame: { id?: number; method?: string; params?: unknown };
				try {
					frame = JSON.parse(String(raw));
				} catch {
					return;
				}
				if (typeof frame.id !== "number" || typeof frame.method !== "string") return;
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
	});
	return webModeStatus();
}

export function stopWebMode(): void {
	for (const ws of clients) ws.close();
	clients.clear();
	server?.stop(true);
	server = null;
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
