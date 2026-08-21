import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type { WebModeStatus } from "../../shared/types";
import { ROOT, ensureLayout } from "../paths";

/**
 * Web mode: the same app, served to a browser on the LAN.
 *
 * The mainview is already a web app talking RPC over a wire; this serves
 * that bundle over plain HTTP and carries the same contract over a
 * WebSocket, so a phone on the network gets the conversation the desktop
 * gets. A spike deliberately scoped to LAN/VPN reachability — but not to
 * LAN trust: the wire requires a bearer token from the first byte, because
 * "on my network" is not an identity (any browser tab on the LAN can reach
 * this port, and DNS rebinding means not even that is required).
 *
 * The RPC surface this exposes is operator-grade — schedules run prompts,
 * personas can be rewritten — so the token gates the WebSocket entirely,
 * and the static bundle (which contains no secrets) is all an
 * unauthenticated visitor can fetch.
 */

const WEB_FILE = join(ROOT, "web.json");
const DEFAULT_PORT = 4680;

type WebConfig = { token: string };

function webConfig(): WebConfig {
	ensureLayout();
	try {
		if (existsSync(WEB_FILE)) {
			const parsed = JSON.parse(readFileSync(WEB_FILE, "utf8")) as Partial<WebConfig>;
			if (typeof parsed.token === "string" && parsed.token.length >= 32) {
				return { token: parsed.token };
			}
		}
	} catch {}
	const fresh: WebConfig = { token: randomBytes(24).toString("hex") };
	writeFileSync(WEB_FILE, `${JSON.stringify(fresh, null, 2)}\n`, "utf8");
	return fresh;
}

function tokenMatches(presented: string, token: string): boolean {
	const a = Buffer.from(presented);
	const b = Buffer.from(token);
	return a.length === b.length && timingSafeEqual(a, b);
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

type WsData = { authed: true };

let server: Bun.Server<WsData> | null = null;
const clients = new Set<Bun.ServerWebSocket<WsData>>();

export function webModeStatus(): WebModeStatus {
	if (!server) return { enabled: false, url: null };
	const host = lanAddress() ?? "127.0.0.1";
	return {
		enabled: true,
		url: `http://${host}:${server.port}/?token=${webConfig().token}`,
	};
}

export function startWebMode(resolve: Resolver, port = DEFAULT_PORT): WebModeStatus {
	if (server) return webModeStatus();
	const dir = viewsDir();
	if (!dir) throw new Error("The web bundle was not found — build the app first.");
	const { token } = webConfig();

	server = Bun.serve<WsData>({
		hostname: "0.0.0.0",
		port,
		idleTimeout: 255,
		fetch(request, srv) {
			const url = new URL(request.url);

			if (url.pathname === "/ws") {
				if (!tokenMatches(url.searchParams.get("token") ?? "", token)) {
					return new Response("unauthorized", { status: 401 });
				}
				return srv.upgrade(request, { data: { authed: true as const } })
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
