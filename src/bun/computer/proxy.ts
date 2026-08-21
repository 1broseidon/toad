import { timingSafeEqual } from "node:crypto";
import { captureObserved } from "./frames";
import { computerRecord, touchComputer } from "./store";
import { ensureComputer } from "./manager";

/**
 * The localhost door to every teammate's computer.
 *
 * Agents are handed a URL on this proxy rather than the container's own
 * port, because the container may not be running when the session starts —
 * or may not exist at all after hibernation. Each request ensures the
 * machine is awake, then forwards; that one choke point implements the
 * spec's "wake happens on the first tool call, from whichever state" and
 * feeds the idle timers, and it keeps working across stop/rm because the
 * container's random host port is rediscovered on every wake.
 *
 * Two doors, same wall: HTTP requests (the MCP surface) authenticate with
 * the computer's bearer token in the Authorization header; the VNC
 * WebSocket (`/computer/<id>/vnc`, for the in-app screen pane) carries the
 * same token as `?token=` because the browser WebSocket API cannot set
 * headers. Upgraded connections bridge to the container's own /vnc
 * websockify endpoint, with the proxy re-attaching the Authorization
 * header on the inside leg.
 *
 * Binds to 127.0.0.1 only.
 */

/** SSE streams and VNC sessions idle between events; don't reap them. */
const IDLE_TIMEOUT_S = 255;

/** File writes throttled: activity is minutes-granular, tool calls are not. */
const TOUCH_INTERVAL_MS = 30_000;
const lastTouch = new Map<string, number>();

function touch(personaId: string): void {
	const now = Date.now();
	if (now - (lastTouch.get(personaId) ?? 0) < TOUCH_INTERVAL_MS) return;
	lastTouch.set(personaId, now);
	touchComputer(personaId);
}

function tokenMatches(presented: string, token: string): boolean {
	const a = Buffer.from(presented);
	const b = Buffer.from(token);
	return a.length === b.length && timingSafeEqual(a, b);
}

function authorizedHeader(request: Request, token: string): boolean {
	const header = request.headers.get("authorization") ?? "";
	return tokenMatches(header.startsWith("Bearer ") ? header.slice(7) : "", token);
}

/** State of one browser↔container VNC bridge, hung on ws.data. */
type VncBridge = {
	personaId: string;
	target: string;
	auth: string;
	upstream?: WebSocket;
	/** Frames from the browser that arrived before the upstream leg opened. */
	pending: Array<string | ArrayBuffer | Uint8Array>;
};

async function resolvePersona(personaId: string) {
	// Imported lazily: personas → servers → the computer entry → this proxy is
	// otherwise a static cycle.
	const { getPersona } = await import("../store/personas");
	return getPersona(personaId);
}

async function handle(request: Request, server: Bun.Server<VncBridge>): Promise<Response | undefined> {
	const url = new URL(request.url);
	const match = url.pathname.match(/^\/computer\/([^/]+)(\/.*)$/);
	if (!match) return new Response("not found", { status: 404 });
	const [, personaId, rest] = match as unknown as [string, string, string];

	const persona = await resolvePersona(personaId);
	if (!persona?.computer?.enabled) return new Response("no computer", { status: 404 });

	const { token } = computerRecord(personaId);
	const isVnc = rest === "/vnc" && request.headers.get("upgrade")?.toLowerCase() === "websocket";

	if (isVnc) {
		if (!tokenMatches(url.searchParams.get("token") ?? "", token)) {
			return new Response("unauthorized", { status: 401 });
		}
	} else if (!authorizedHeader(request, token)) {
		return new Response("unauthorized", { status: 401 });
	}

	let endpoint;
	try {
		endpoint = await ensureComputer({
			personaId,
			cwd: persona.cwd,
			image: persona.computer.image,
		});
	} catch (error) {
		return new Response(`the computer could not wake: ${(error as Error).message}`, {
			status: 502,
		});
	}
	touch(personaId);

	if (isVnc) {
		const bridge: VncBridge = {
			personaId,
			target: `${endpoint.baseUrl.replace("http://", "ws://")}/vnc`,
			auth: `Bearer ${endpoint.token}`,
			pending: [],
		};
		return server.upgrade(request, { data: bridge })
			? undefined
			: new Response("upgrade failed", { status: 500 });
	}

	const headers = new Headers(request.headers);
	headers.delete("host");
	headers.delete("connection");

	// Tool calls are small JSON; buffering them lets the proxy notice a
	// `capture` going by and drop a frame of what the agent saw into the
	// transcript. Anything big or non-JSON streams through untouched.
	let body: BodyInit | null | undefined =
		request.method === "GET" || request.method === "HEAD" ? undefined : request.body;
	if (
		request.method === "POST" &&
		rest === "/mcp" &&
		(request.headers.get("content-type") ?? "").includes("json") &&
		Number(request.headers.get("content-length") ?? Infinity) < 65_536
	) {
		const text = await request.text();
		body = text;
		if (isCaptureCall(text)) {
			const seen = endpoint;
			// After the response settles, not before it: the frame should show
			// the screen the tool answered about.
			setTimeout(() => captureObserved(personaId, seen), 300);
		}
	}

	return fetch(`${endpoint.baseUrl}${rest}${url.search}`, {
		method: request.method,
		headers,
		body,
	});
}

function isCaptureCall(text: string): boolean {
	if (!text.includes('"tools/call"') || !text.includes('"capture"')) return false;
	try {
		const parsed = JSON.parse(text) as {
			method?: string;
			params?: { name?: string };
		};
		return parsed.method === "tools/call" && parsed.params?.name === "capture";
	} catch {
		return false;
	}
}

let server: Bun.Server<VncBridge> | null = null;

function ensureServer(): NonNullable<typeof server> {
	if (!server) {
		server = Bun.serve<VncBridge>({
			hostname: "127.0.0.1",
			port: 0,
			idleTimeout: IDLE_TIMEOUT_S,
			fetch: (request, srv) => handle(request, srv),
			websocket: {
				open(ws) {
					const bridge = ws.data;
					// Bun's WebSocket client can set headers, which is the whole
					// reason the token survives the hop the browser cannot make.
					const upstream = new WebSocket(bridge.target, {
						headers: { Authorization: bridge.auth },
					} as never);
					upstream.binaryType = "arraybuffer";
					bridge.upstream = upstream;
					upstream.onopen = () => {
						for (const frame of bridge.pending) upstream.send(frame as never);
						bridge.pending = [];
					};
					upstream.onmessage = (event) => {
						ws.send(event.data as never);
						touch(bridge.personaId);
					};
					upstream.onclose = () => ws.close();
					upstream.onerror = () => ws.close();
				},
				message(ws, message) {
					const { upstream, pending } = ws.data;
					if (upstream && upstream.readyState === WebSocket.OPEN) {
						upstream.send(message as never);
					} else {
						pending.push(message);
					}
					touch(ws.data.personaId);
				},
				close(ws) {
					ws.data.upstream?.close();
				},
			},
		});
	}
	return server;
}

/**
 * The MCP URL a teammate's session is opened with. Starting the listener is
 * synchronous, so this can run inside the (sync) server-list resolution.
 */
export function computerProxyUrl(personaId: string): string {
	return `http://127.0.0.1:${ensureServer().port}/computer/${personaId}/mcp`;
}

/** The VNC WebSocket URL for the in-app screen pane, token included. */
export function computerVncUrl(personaId: string): string {
	const { token } = computerRecord(personaId);
	return `ws://127.0.0.1:${ensureServer().port}/computer/${personaId}/vnc?token=${token}`;
}
