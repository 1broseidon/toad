/**
 * Last-known-good MCP handshake from the container. The proxy answers
 * server/discover, initialize, and tools/list from this blob so a session
 * can attach before the machine is awake. Nothing here is authored by
 * toad.team — it is whatever the container last returned.
 *
 * Keyed by image tag. SEP-2549 `cacheScope` on the blob itself is the
 * container's `public`/`private` hint, not the key.
 */

export type HandshakeCache = {
	image: string;
	fetchedAt: number;
	ttlMs: number;
	results: Partial<Record<string, unknown>>;
};

const HANDSHAKE = new Set([
	"initialize",
	"notifications/initialized",
	"tools/list",
	"ping",
	"server/discover",
]);

export function isHandshakeMethod(method: string): boolean {
	return HANDSHAKE.has(method);
}

export type JsonRpc = {
	jsonrpc?: string;
	id?: unknown;
	method?: string;
	result?: unknown;
};

export function parseJsonRpc(text: string): JsonRpc | null {
	try {
		const parsed = JSON.parse(text) as JsonRpc;
		return parsed && typeof parsed === "object" ? parsed : null;
	} catch {
		return null;
	}
}

export function jsonRpcResult(id: unknown, result: unknown): Response {
	return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
		headers: { "content-type": "application/json" },
	});
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export function cacheFresh(cache: HandshakeCache | undefined, image: string): cache is HandshakeCache {
	if (!cache || cache.image !== image) return false;
	return Date.now() - cache.fetchedAt < cache.ttlMs;
}

/** Answer a handshake from cache. Null means wake the container. */
export function cachedHandshake(cache: HandshakeCache | undefined, image: string, message: JsonRpc): Response | null {
	const method = message.method;
	if (!method || !isHandshakeMethod(method)) return null;
	if (method === "notifications/initialized") return new Response(null, { status: 202 });
	if (method === "ping") return jsonRpcResult(message.id, {});
	if (!cacheFresh(cache, image)) return null;
	const result = cache.results[method];
	if (result === undefined) return null;
	return jsonRpcResult(message.id, result);
}

export function cacheFromContainer(image: string, method: string, result: unknown): HandshakeCache {
	const listed = result && typeof result === "object" ? (result as { ttlMs?: number }) : {};
	return {
		image,
		fetchedAt: Date.now(),
		ttlMs: typeof listed.ttlMs === "number" && listed.ttlMs > 0 ? listed.ttlMs : DEFAULT_TTL_MS,
		results: { [method]: result },
	};
}
