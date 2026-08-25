import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Persona, WebSearchKeys, WebSearchSettings } from "../../shared/types";
import { fenceUntrustedQuotedContent } from "../mcp/tools";

export const WEB_SEARCH_TOOL_NAME = "web_search";
export const PROVIDER_TIMEOUT_MS = 10_000;
export const PROVIDER_COOLDOWN_MS = 5 * 60_000;
export const CACHE_TTL_MS = 30 * 60_000;
export const CACHE_CAPACITY = 200;

export type WebSearchResult = {
	title: string;
	url: string;
	snippet: string;
	source: string;
};

export interface WebSearchProvider {
	readonly id: "parallel" | "exa" | "firecrawl" | "keenable";
	search(query: string, limit: number, signal?: AbortSignal): Promise<WebSearchResult[]>;
}

export type WebSearchStrategy = (
	providers: readonly WebSearchProvider[],
	query: string,
	limit: number,
	signal?: AbortSignal,
) => Promise<WebSearchResult[]>;

export type WebSearchFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type Fetch = WebSearchFetch;
type Json = Record<string, unknown>;

export class WebSearchRateLimitError extends Error {
	constructor() {
		super("rate limited");
		this.name = "WebSearchRateLimitError";
	}
}

function object(value: unknown): Json | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Json)
		: undefined;
}

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function normalize(items: Array<Partial<WebSearchResult>>, source: string, limit: number): WebSearchResult[] {
	const output: WebSearchResult[] = [];
	for (const item of items) {
		const title = typeof item.title === "string" ? item.title.trim() : "";
		const url = typeof item.url === "string" ? item.url.trim() : "";
		if (!title || !url) continue;
		const raw = typeof item.snippet === "string" ? item.snippet.trim().replace(/\s+/g, " ") : "";
		const snippet = raw.length > 300 ? `${raw.slice(0, 299)}…` : raw;
		output.push({ title, url, snippet, source });
		if (output.length >= limit) break;
	}
	return output;
}

function sseJson(text: string): unknown[] {
	const values: unknown[] = [];
	for (const event of text.split(/\r?\n\r?\n/)) {
		const data = event
			.split(/\r?\n/)
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trimStart())
			.join("\n");
		if (!data || data === "[DONE]") continue;
		try {
			values.push(JSON.parse(data));
		} catch {
			throw new Error("malformed event stream");
		}
	}
	return values;
}

function rpcPayloads(responseText: string, contentType: string | null): Json[] {
	let values: unknown[];
	if (contentType?.includes("text/event-stream") || /^\s*(?:event:|data:)/m.test(responseText)) {
		values = sseJson(responseText);
	} else {
		try {
			values = [JSON.parse(responseText)];
		} catch {
			throw new Error("malformed response");
		}
	}
	const payloads = values.map(object).filter((item): item is Json => Boolean(item));
	if (payloads.length === 0) throw new Error("malformed response");
	for (const payload of payloads) {
		if (payload.error !== undefined) throw new Error("provider returned an RPC error");
	}
	return payloads;
}

function rpcTexts(payloads: readonly Json[]): string[] {
	const output: string[] = [];
	for (const payload of payloads) {
		const result = object(payload.result);
		const content = result?.content;
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			const item = object(part);
			if (item?.type === "text" && typeof item.text === "string") output.push(item.text);
		}
	}
	if (output.length === 0) throw new Error("malformed response");
	return output;
}

async function post(
	fetcher: Fetch,
	name: string,
	url: string,
	init: RequestInit,
	signal?: AbortSignal,
): Promise<Response> {
	const timeout = AbortSignal.timeout(PROVIDER_TIMEOUT_MS);
	const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
	let response: Response;
	try {
		response = await fetcher(url, { ...init, signal: combined });
	} catch {
		throw new Error(`${name} request failed`);
	}
	if (response.status === 429) throw new WebSearchRateLimitError();
	if (!response.ok) throw new Error(`${name} request failed (${response.status})`);
	return response;
}

function rpcBody(name: string, args: Json): string {
	return JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
}

export function parallelProvider(fetcher: Fetch = fetch): WebSearchProvider {
	return {
		id: "parallel",
		async search(query, limit, signal) {
			const response = await post(fetcher, "Parallel", "https://search.parallel.ai/mcp", {
				method: "POST",
				headers: { Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
				body: rpcBody("web_search", { objective: query, search_queries: [query] }),
			}, signal);
			const texts = rpcTexts(rpcPayloads(await response.text(), response.headers.get("content-type")));
			const found: Array<Partial<WebSearchResult>> = [];
			for (const text of texts) {
				let parsed: unknown;
				try { parsed = JSON.parse(text); } catch { throw new Error("malformed response"); }
				const root = object(parsed);
				const candidates = Array.isArray(parsed) ? parsed : Array.isArray(root?.results) ? root.results : [];
				for (const candidate of candidates) {
					const item = object(candidate);
					if (!item) continue;
					const excerpts = strings(item.excerpts);
					found.push({
						title: typeof item.title === "string" ? item.title : undefined,
						url: typeof item.url === "string" ? item.url : typeof item.URL === "string" ? item.URL : undefined,
						snippet: excerpts.join(" ") || (typeof item.excerpt === "string" ? item.excerpt : undefined),
					});
				}
			}
			return normalize(found, "Parallel", limit);
		},
	};
}

export function exaProvider(apiKey?: string, fetcher: Fetch = fetch): WebSearchProvider {
	return {
		id: "exa",
		async search(query, limit, signal) {
			const endpoint = apiKey
				? `https://mcp.exa.ai/mcp?exaApiKey=${encodeURIComponent(apiKey)}`
				: "https://mcp.exa.ai/mcp";
			const response = await post(fetcher, "Exa", endpoint, {
				method: "POST",
				headers: { Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
				body: rpcBody("web_search_exa", {
					query, numResults: limit, type: "auto", livecrawl: "fallback", contextMaxCharacters: 3000,
				}),
			}, signal);
			const texts = rpcTexts(rpcPayloads(await response.text(), response.headers.get("content-type")));
			const found: Array<Partial<WebSearchResult>> = [];
			for (const text of texts) {
				const starts = [...text.matchAll(/^Title:\s*(.+)$/gim)];
				for (let index = 0; index < starts.length; index++) {
					const start = starts[index]!;
					const block = text.slice(start.index, starts[index + 1]?.index ?? text.length);
					const url = block.match(/^URL:\s*(.+)$/im)?.[1]?.trim();
					const snippet = block
						.replace(/^Title:.*$/im, "")
						.replace(/^URL:.*$/im, "")
						.replace(/^Published Date:.*$/im, "")
						.trim();
					found.push({ title: start[1], url, snippet });
				}
			}
			return normalize(found, "Exa", limit);
		},
	};
}

export function firecrawlProvider(apiKey?: string, fetcher: Fetch = fetch): WebSearchProvider {
	return {
		id: "firecrawl",
		async search(query, limit, signal) {
			const headers: Record<string, string> = { "Content-Type": "application/json" };
			if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
			const response = await post(fetcher, "Firecrawl", "https://api.firecrawl.dev/v2/search", {
				method: "POST", headers, body: JSON.stringify({ query, limit }),
			}, signal);
			let parsed: unknown;
			try { parsed = await response.json(); } catch { throw new Error("malformed response"); }
			const root = object(parsed);
			const data = object(root?.data);
			if (root?.success !== true || !Array.isArray(data?.web)) throw new Error("malformed response");
			return normalize(data.web.map((value) => {
				const item = object(value);
				return { title: item?.title as string, url: item?.url as string, snippet: item?.description as string };
			}), "Firecrawl", limit);
		},
	};
}

export function keenableProvider(apiKey?: string, fetcher: Fetch = fetch): WebSearchProvider {
	return {
		id: "keenable",
		async search(query, limit, signal) {
			const headers: Record<string, string> = {
				"Content-Type": "application/json", "X-Keenable-Title": "Toad", "User-Agent": "Toad web search",
			};
			if (apiKey) headers["X-API-Key"] = apiKey;
			const path = apiKey ? "/v1/search" : "/v1/search/public";
			const response = await post(fetcher, "Keenable", `https://api.keenable.ai${path}`, {
				method: "POST", headers, body: JSON.stringify({ query, mode: "pro" }),
			}, signal);
			let parsed: unknown;
			try { parsed = await response.json(); } catch { throw new Error("malformed response"); }
			const root = object(parsed);
			if (!Array.isArray(root?.results)) throw new Error("malformed response");
			return normalize(root.results.map((value) => {
				const item = object(value);
				return {
					title: item?.title as string, url: item?.url as string,
					snippet: (typeof item?.description === "string" ? item.description : item?.snippet) as string,
				};
			}), "Keenable", limit);
		},
	};
}

let nextProviderStart = 0;
const cooldowns = new WeakMap<WebSearchProvider, number>();

export function createFallbackStrategy(now: () => number = Date.now): WebSearchStrategy {
	return async (providers, query, limit, signal) => {
		if (providers.length === 0) throw new Error("no web search providers are enabled");
		const start = nextProviderStart++ % providers.length;
		let reason = "all web search providers failed";
		for (let offset = 0; offset < providers.length; offset++) {
			const provider = providers[(start + offset) % providers.length]!;
			if ((cooldowns.get(provider) ?? 0) > now()) continue;
			try {
				const results = await provider.search(query, limit, signal);
				if (results.length > 0) return results;
				reason = "web search providers returned no results";
			} catch (error) {
				if (error instanceof WebSearchRateLimitError) cooldowns.set(provider, now() + PROVIDER_COOLDOWN_MS);
				if (signal?.aborted) throw new Error("web search was cancelled");
			}
		}
		throw new Error(reason);
	};
}

export function webSearchEnabled(settings: WebSearchSettings | undefined): boolean {
	return settings?.parallel !== false || settings?.exa !== false || settings?.firecrawl !== false || settings?.keenable !== false;
}

export function configuredProviders(
	settings: WebSearchSettings | undefined,
	keys: WebSearchKeys | undefined,
	fetcher: Fetch = fetch,
): WebSearchProvider[] {
	const output: WebSearchProvider[] = [];
	if (settings?.parallel !== false) output.push(parallelProvider(fetcher));
	if (settings?.exa !== false) output.push(exaProvider(keys?.exa, fetcher));
	if (settings?.firecrawl !== false) output.push(firecrawlProvider(keys?.firecrawl, fetcher));
	if (settings?.keenable !== false) output.push(keenableProvider(keys?.keenable, fetcher));
	return output;
}

type CacheEntry = { at: number; results: WebSearchResult[] };

export function createWebSearchTool(options: {
	settings?: WebSearchSettings;
	keys?: WebSearchKeys;
	providers?: WebSearchProvider[];
	strategy?: WebSearchStrategy;
	fetch?: Fetch;
	now?: () => number;
} = {}): ToolDefinition | undefined {
	if (!webSearchEnabled(options.settings)) return undefined;
	const providers = options.providers ?? configuredProviders(options.settings, options.keys, options.fetch);
	if (providers.length === 0) return undefined;
	const now = options.now ?? Date.now;
	const strategy = options.strategy ?? createFallbackStrategy(now);
	const cache = new Map<string, CacheEntry>();
	const providerKey = providers.map((provider) => provider.id).join(",");

	return defineTool({
		name: WEB_SEARCH_TOOL_NAME,
		label: "Search the web",
		description: "Search the public web for current information and return concise sourced results.",
		promptSnippet: "Search the web: titles, links, and snippets from public search indexes.",
		parameters: {
			type: "object",
			properties: {
				query: { type: "string", description: "What to search for." },
				count: { type: "integer", minimum: 1, maximum: 10, description: "Results to return (default 5, maximum 10)." },
			},
			required: ["query"], additionalProperties: false,
		} as never,
		execute: async (_toolCallId, params, signal) => {
			const args = (params ?? {}) as Record<string, unknown>;
			const query = typeof args.query === "string" ? args.query.trim() : "";
			const count = args.count === undefined ? 5 : Number(args.count);
			if (!query || !Number.isInteger(count) || count < 1 || count > 10) {
				return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, reason: "query and count (1–10) are required" }) }], details: {} };
			}
			const key = `${providerKey}|${query}|${count}`;
			const cached = cache.get(key);
			let results: WebSearchResult[];
			try {
				if (cached && now() - cached.at < CACHE_TTL_MS) {
					cache.delete(key); cache.set(key, cached); results = cached.results;
				} else {
					if (cached) cache.delete(key);
					results = await strategy(providers, query, count, signal);
					cache.set(key, { at: now(), results });
					while (cache.size > CACHE_CAPACITY) cache.delete(cache.keys().next().value!);
				}
				const compact = results.map((item, index) => `${index + 1}. ${item.title}\n${item.url}${item.snippet ? `\n${item.snippet}` : ""}\nSource: ${item.source}`).join("\n\n");
				return {
					content: [{
						type: "text" as const,
						text: fenceUntrustedQuotedContent(compact, {
							label: "public web search content",
							tag: "toad_web_search_results",
						}),
					}],
					details: {},
				};
			} catch (error) {
				const reason = error instanceof Error ? error.message : "web search failed";
				return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, reason }) }], details: {} };
			}
		},
	}) as ToolDefinition;
}

export function webSearchToolForPersona(
	persona: Pick<Persona, "webSearch">,
	keys?: WebSearchKeys,
): ToolDefinition | undefined {
	return createWebSearchTool({ settings: persona.webSearch, keys });
}
