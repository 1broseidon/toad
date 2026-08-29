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
import type { NodeLinkServerHooks } from "./link";
import {
	ensureNodeTls,
	localCertFingerprint,
	localCertPem,
	rotateNodeCert,
	type NodeTlsMaterial,
} from "./tls";

const DEFAULT_PORT = Number(process.env.TOAD_NODE_PORT) || 4681;

type Resolver = (method: string) => ((params: unknown) => Promise<unknown>) | undefined;
type WsData = { peerId: string; nodeLink: boolean };

let server: Bun.Server<WsData> | null = null;
/** Whether the live listener is speaking TLS. Set once, at listen time. */
let secure = false;
let tlsFault: string | null = null;
/** What this listener was started with, so a rotation can start it again. */
let started: { resolve: Resolver; port: number; links?: NodeLinkServerHooks } | null = null;
const peers = new Set<Bun.ServerWebSocket<WsData>>();
const nodeLinks = new Set<Bun.ServerWebSocket<WsData>>();

function bearer(request: Request): string {
	const url = new URL(request.url);
	return (
		url.searchParams.get("token") ??
		request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
		""
	);
}

function peerIdForLegacyToken(token: string): string | null {
	const peer = authenticateFleetPeer(token);
	if (peer) return peer.id;
	// Compatibility for a pre-NodeLink desktop which claimed webAccess over
	// /fleet/rpc and then dialled this origin's /ws.
	const device = deviceByToken(token);
	const id = device?.fleetPeerId;
	return id && listFleetPeers().some((peer) => peer.id === id) ? id : null;
}

function options(resolve: Resolver, links?: NodeLinkServerHooks) {
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
			if (url.pathname === "/node/link") {
				const peer = authenticateFleetPeer(bearer(request));
				if (!peer || peer.transport !== "node" || !links) {
					return new Response("unauthorized", { status: 401 });
				}
				return srv.upgrade(request, { data: { peerId: peer.id, nodeLink: true } })
					? undefined
					: new Response("upgrade failed", { status: 500 });
			}
			if (url.pathname === "/ws") {
				const peerId = peerIdForLegacyToken(bearer(request));
				if (!peerId) return new Response("unauthorized", { status: 401 });
				return srv.upgrade(request, { data: { peerId, nodeLink: false } })
					? undefined
					: new Response("upgrade failed", { status: 500 });
			}
			return new Response("Toad node", { status: url.pathname === "/" ? 200 : 404 });
		},
		websocket: {
			open(ws: Bun.ServerWebSocket<WsData>) {
				if (ws.data.nodeLink) {
					if (links?.open(ws.data.peerId, ws)) nodeLinks.add(ws);
					else ws.close(1008, "node link unavailable");
					return;
				}
				peers.add(ws);
			},
			close(ws: Bun.ServerWebSocket<WsData>) {
				if (ws.data.nodeLink) {
					nodeLinks.delete(ws);
					links?.close(ws.data.peerId, ws);
					return;
				}
				peers.delete(ws);
			},
			async message(ws: Bun.ServerWebSocket<WsData>, raw: string | Buffer) {
				if (ws.data.nodeLink) {
					links?.message(ws.data.peerId, ws, raw);
					return;
				}
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

export function startNodeServer(
	resolve: Resolver,
	port = DEFAULT_PORT,
	links?: NodeLinkServerHooks,
): string {
	if (!server) {
		started = { resolve, port, links };
		/* TLS or plain is one decision, made once at listen time and then
		 * published in the origin: no caller anywhere has to guess which plane
		 * it is talking to, because the scheme travels through pairing into
		 * every peer's fleet.json and is dialed back verbatim. */
		const tls = ensureNodeTls();
		secure = Boolean(tls);
		server = listen(port, tls, resolve, links);
	}
	return nodeOrigin()!;
}

/**
 * Binds the node port, and refuses to lose the plane over a bad certificate.
 *
 * A desk whose certificate its own TLS library rejects used to throw here and
 * come up with no node listener at all — silently, because the throw was
 * swallowed upstream while the web port stayed healthy. Every peer then held a
 * plain, unpinned row for a desk that was simply not listening, and nothing
 * anywhere said so. (macOS LibreSSL writing explicit EC parameters that Bun's
 * BoringSSL refuses is how we met it; the shape is general.)
 *
 * So: regenerate once, because material this process cannot serve is material
 * no restart will fix, and a stale one survives reboots. If that still fails,
 * bind plain rather than dark — an unencrypted plane the room can see beats an
 * encrypted one it cannot — and leave the reason where a human can find it.
 */
function listen(
	port: number,
	tls: NodeTlsMaterial | null,
	resolve: Resolver,
	links?: NodeLinkServerHooks,
): Bun.Server<WsData> {
	const bind = (material: NodeTlsMaterial | null) =>
		Bun.serve<WsData>({
			hostname: "0.0.0.0",
			port,
			...(material ? { tls: { key: material.key, cert: material.cert } } : {}),
			...options(resolve, links),
		});
	if (!tls) return bind(null);
	try {
		return bind(tls);
	} catch (first) {
		tlsFault = `This desk's certificate could not be served (${reasonOf(first)}); regenerating.`;
		console.error(`[node] ${tlsFault}`);
		const fresh = rotateNodeCert();
		if (fresh) {
			try {
				const server = bind(fresh);
				tlsFault = null;
				console.error("[node] a regenerated certificate binds; the node plane is encrypted again.");
				return server;
			} catch (second) {
				tlsFault = `This desk cannot serve TLS (${reasonOf(second)}); the node plane is running plain.`;
			}
		} else {
			tlsFault = "This desk could not generate a certificate; the node plane is running plain.";
		}
		console.error(`[node] ${tlsFault}`);
		secure = false;
		return bind(null);
	}
}

function reasonOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Why this desk is not serving TLS, when it meant to. Null when all is well. */
export function nodeTlsFault(): string | null {
	return tlsFault;
}

export function nodeOrigin(): string | null {
	if (!server) return null;
	const host = lanAddress() ?? "127.0.0.1";
	return `${secure ? "https" : "http"}://${host}:${server.port}`;
}

/** The fingerprint peers must pin for this desk, or null while it is plain. */
export function nodeCertFingerprint(): string | null {
	return secure ? localCertFingerprint() : null;
}

/** The certificate itself, handed over at pairing so a peer can pin it. */
export function nodeCertPem(): string | null {
	return secure ? localCertPem() : null;
}

/**
 * Rebinds the listener so freshly rotated TLS material goes live.
 *
 * Bun's `server.reload` replaces handlers, not the certificate — measured, not
 * assumed — so the only way to serve a new key is a new listener. Every socket
 * on the old one dies, which is the correct outcome anyway: they are all
 * pinned to a certificate this desk no longer has, and both sides' dial loops
 * bring them back.
 */
export function restartNodeServer(): string | null {
	if (!started) return null;
	const { resolve, port, links } = started;
	stopNodeServer();
	return startNodeServer(resolve, port, links);
}

export function stopNodeServer(): void {
	for (const ws of peers) ws.close();
	for (const ws of nodeLinks) ws.close();
	peers.clear();
	nodeLinks.clear();
	server?.stop(true);
	server = null;
	secure = false;
}

export function closeNodePeer(id: string): void {
	for (const ws of peers) {
		if (ws.data.peerId === id) ws.close();
	}
	for (const ws of nodeLinks) {
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
