import {
	authenticateFleetPeer,
	handleFleetPair,
	handleFleetRpc,
	listFleetPeers,
} from "../fleet/fleet";
import { meshCount } from "../fleet/metrics";
import { deviceByToken } from "../web/devices";
import { lanAddress } from "../web/server";
import {
	handleIncomingNodeRequest,
	nodeRequestStatus,
} from "./admission";
import { nodeIdentity } from "./identity";

const DEFAULT_PORT = Number(process.env.TOAD_NODE_PORT) || 4681;

type Resolver = (method: string) => ((params: unknown) => Promise<unknown>) | undefined;
type WsData = { peerId: string };

let server: Bun.Server<WsData> | null = null;
const peers = new Set<Bun.ServerWebSocket<WsData>>();

function bearer(request: Request): string {
	const url = new URL(request.url);
	return (
		url.searchParams.get("token") ??
		request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
		""
	);
}

function peerIdForToken(token: string): string | null {
	const peer = authenticateFleetPeer(token);
	if (peer) return peer.id;
	// Compatibility for a pre-NodeLink desktop which claimed webAccess over
	// /fleet/rpc and then dialled this origin's /ws.
	const device = deviceByToken(token);
	const id = device?.fleetPeerId;
	return id && listFleetPeers().some((peer) => peer.id === id) ? id : null;
}

function options(resolve: Resolver) {
	return {
		idleTimeout: 255,
		async fetch(request: Request, srv: Bun.Server<WsData>) {
			const url = new URL(request.url);

			if (url.pathname === "/node/info" && request.method === "GET") {
				return Response.json(nodeIdentity());
			}
			if (url.pathname === "/node/request" && request.method === "POST") {
				let body: unknown;
				try {
					body = await request.json();
				} catch {
					return Response.json({ error: "bad request" }, { status: 400 });
				}
				const result = handleIncomingNodeRequest(body);
				return Response.json(result.body, { status: result.status });
			}
			const requestStatus = /^\/node\/request\/([^/]+)$/.exec(url.pathname);
			if (requestStatus && request.method === "GET") {
				const result = nodeRequestStatus(decodeURIComponent(requestStatus[1]!));
				return Response.json(result.body, { status: result.status });
			}
			if (url.pathname === "/fleet/pair" && request.method === "POST") {
				let body: unknown;
				try {
					body = await request.json();
				} catch {
					return Response.json({ error: "bad request" }, { status: 400 });
				}
				const result = handleFleetPair(body, "node");
				if (result.status === 200) {
					void import("../fleet/wire").then(({ syncPeerWires }) => syncPeerWires());
				}
				return Response.json(result.body, { status: result.status });
			}
			if (url.pathname === "/fleet/rpc" && request.method === "POST") {
				let body: unknown;
				try {
					body = await request.json();
				} catch {
					return Response.json({ error: "bad request" }, { status: 400 });
				}
				const result = await handleFleetRpc(bearer(request), body);
				return Response.json(result.body, { status: result.status });
			}
			if (url.pathname === "/ws") {
				const peerId = peerIdForToken(bearer(request));
				if (!peerId) return new Response("unauthorized", { status: 401 });
				return srv.upgrade(request, { data: { peerId } })
					? undefined
					: new Response("upgrade failed", { status: 500 });
			}
			return new Response("Toad node", { status: url.pathname === "/" ? 200 : 404 });
		},
		websocket: {
			open(ws: Bun.ServerWebSocket<WsData>) {
				peers.add(ws);
			},
			close(ws: Bun.ServerWebSocket<WsData>) {
				peers.delete(ws);
			},
			async message(ws: Bun.ServerWebSocket<WsData>, raw: string | Buffer) {
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
	};
}

export function startNodeServer(resolve: Resolver, port = DEFAULT_PORT): string {
	if (!server) {
		server = Bun.serve<WsData>({
			hostname: "0.0.0.0",
			port,
			...options(resolve),
		});
	}
	return nodeOrigin()!;
}

export function nodeOrigin(): string | null {
	if (!server) return null;
	const host = lanAddress() ?? "127.0.0.1";
	return `http://${host}:${server.port}`;
}

export function stopNodeServer(): void {
	for (const ws of peers) ws.close();
	peers.clear();
	server?.stop(true);
	server = null;
}

export function closeNodePeer(id: string): void {
	for (const ws of peers) {
		if (ws.data.peerId === id) ws.close();
	}
}

export function nodePeerBroadcast(name: string, payload: unknown): void {
	if (peers.size === 0) return;
	const frame = JSON.stringify({ push: name, payload });
	for (const ws of peers) {
		try {
			ws.send(frame);
		} catch {}
	}
	meshCount("nodePeerBroadcast", name, { bytes: frame.length });
}
