import {
	Client,
	StreamableHTTPClientTransport,
	UnauthorizedError,
} from "@modelcontextprotocol/client";
import packageInfo from "../../../package.json" with { type: "json" };
import type { McpAuthStatus, McpRuntimeServerConfig, McpServerConfig } from "../../shared/types";
import { getSettings } from "../store/settings";
import * as credentials from "./credentials";
import {
	ToadMcpOAuthProvider,
	oauthServer,
	stateMatches,
	type AuthorizationOpener,
} from "./oauth-provider";

const CALLBACK_PORT = Number(process.env.TOAD_MCP_OAUTH_CALLBACK_PORT ?? 53_682);
const CALLBACK_PATH = "/oauth/callback";
const AUTH_TIMEOUT_MS = 5 * 60_000;
const active = new Set<string>();
const errors = new Map<string, string>();

function redirectUrl(): URL {
	return new URL(`http://127.0.0.1:${CALLBACK_PORT}${CALLBACK_PATH}`);
}

export function oauthProviderFor(server: McpRuntimeServerConfig): ToadMcpOAuthProvider | undefined {
	if (server.type !== "http" || server.auth.mode !== "oauth") return undefined;
	return new ToadMcpOAuthProvider(oauthServer(server), redirectUrl());
}

export function mcpAuthStatuses(): McpAuthStatus[] {
	return getSettings().mcpServers.flatMap((server): McpAuthStatus[] => {
		if (server.type !== "http") return [];
		if (server.auth.mode === "none") return [{ serverId: server.id, state: "not_configured" }];
		if (server.auth.mode === "static") {
			const headers = credentials.staticHeaders(server.id);
			const ready =
				server.auth.headerNames.length > 0 &&
				server.auth.headerNames.every((name) => typeof headers?.[name] === "string" && headers[name].length > 0);
			return [{ serverId: server.id, state: ready ? "authorized" : "disconnected" }];
		}
		if (active.has(server.id)) return [{ serverId: server.id, state: "authorizing" }];
		const token = credentials.tokens(server.id);
		const error = errors.get(server.id);
		if (!token) {
			return [{ serverId: server.id, state: error ? "error" : "disconnected", ...(error ? { error } : {}) }];
		}
		const savedAt = credentials.tokenSavedAt(server.id, token.issuer);
		const expiresAt = savedAt && token.expires_in ? savedAt + token.expires_in * 1_000 : undefined;
		return [{
			serverId: server.id,
			state: "authorized",
			...(token.issuer ? { issuer: token.issuer } : {}),
			...(token.scope ? { grantedScopes: token.scope.split(/\s+/).filter(Boolean) } : {}),
			...(expiresAt ? { expiresAt } : {}),
		}];
	});
}

/** Explicit desktop provisioning. Runtime agent startup never opens a browser. */
export async function authorizeMcpServer(serverId: string, openUrl: AuthorizationOpener): Promise<void> {
	if (active.size > 0) throw new Error("Finish the current MCP authorization first");
	const configured = getSettings().mcpServers.find((server) => server.id === serverId);
	if (!configured) throw new Error("That MCP server no longer exists");
	const server = oauthServer(configured);
	active.add(serverId);
	errors.delete(serverId);
	let callback: Callback | undefined;
	let client: Client | undefined;
	try {
		credentials.newAuthorizationAttempt(serverId);
		callback = startLoopbackCallback();
		const provider = new ToadMcpOAuthProvider(server, redirectUrl(), openUrl);
		const transport = new StreamableHTTPClientTransport(new URL(server.url), { authProvider: provider });
		client = new Client(
			{ name: "Toad", version: packageInfo.version },
			{ versionNegotiation: { mode: "auto" } },
		);
		try {
			await client.connect(transport);
			// A still-valid token needs no browser. Treat the authenticated probe as success.
			await client.listTools();
			return;
		} catch (error) {
			if (!UnauthorizedError.isInstance(error) || !provider.authorizationRedirected) throw error;
		}

		const params = await callback.wait;
		const expected = credentials.authorizationState(serverId).state;
		if (!stateMatches(expected, params.get("state"))) throw new Error("The OAuth callback state did not match");
		if (params.has("error")) throw new Error("The authorization server declined the request");
		await transport.finishAuth(params);
		await client.close().catch(() => undefined);

		// Validate the saved registration/token against a real MCP initialization.
		const verifiedTransport = new StreamableHTTPClientTransport(new URL(server.url), {
			authProvider: new ToadMcpOAuthProvider(server, redirectUrl()),
		});
		const verifiedClient = new Client(
			{ name: "Toad", version: packageInfo.version },
			{ versionNegotiation: { mode: "auto" } },
		);
		try {
			await verifiedClient.connect(verifiedTransport);
			await verifiedClient.listTools();
		} finally {
			await verifiedClient.close().catch(() => undefined);
		}
		credentials.invalidateOAuth(serverId, "verifier");
	} catch (error) {
		credentials.invalidateOAuth(serverId, "verifier");
		// The SDK intentionally leaves discovery invalidation to the host. A
		// failed authenticated attempt must not pin a changed authorization server.
		credentials.invalidateOAuth(serverId, "discovery");
		const message = safeMessage(error);
		errors.set(serverId, message);
		throw new Error(message);
	} finally {
		callback?.close();
		active.delete(serverId);
		await client?.close().catch(() => undefined);
	}
}

export async function disconnectMcpServer(serverId: string): Promise<void> {
	if (active.has(serverId)) throw new Error("Finish or cancel the current MCP authorization first");
	const configured = getSettings().mcpServers.find((server) => server.id === serverId);
	if (!configured || configured.type !== "http") throw new Error("That MCP server no longer exists");
	if (configured.auth.mode === "oauth") await revokeBestEffort(configured);
	credentials.removeServerCredentials(serverId);
	errors.delete(serverId);
}

async function revokeBestEffort(server: Extract<McpServerConfig, { type: "http" }>): Promise<void> {
	const discovery = credentials.discovery(server.id);
	const token = credentials.tokens(server.id);
	const metadata = discovery?.authorizationServerMetadata as
		| ({ revocation_endpoint?: string } & Record<string, unknown>)
		| undefined;
	const endpoint = metadata?.revocation_endpoint;
	if (!endpoint || !token) return;
	const registered = credentials.clientInformation(server.id, token.issuer);
	const client =
		server.auth.mode === "oauth" && server.auth.client
			? {
					client_id: server.auth.client.clientId,
					...(credentials.preRegisteredClientSecret(server.id)
						? { client_secret: credentials.preRegisteredClientSecret(server.id) }
						: {}),
				}
			: registered;
	for (const [value, hint] of [
		[token.refresh_token, "refresh_token"],
		[token.access_token, "access_token"],
	] as const) {
		if (!value) continue;
		const body = new URLSearchParams({ token: value, token_type_hint: hint });
		const headers = new Headers({ "content-type": "application/x-www-form-urlencoded" });
		const registeredMethod = (client as { token_endpoint_auth_method?: string } | undefined)
			?.token_endpoint_auth_method;
		const method =
			server.auth.mode === "oauth"
				? (server.auth.client?.tokenEndpointAuthMethod ?? registeredMethod ?? "none")
				: "none";
		if (client?.client_id && method === "client_secret_basic" && client.client_secret) {
			headers.set(
				"authorization",
				`Basic ${Buffer.from(`${encodeURIComponent(client.client_id)}:${encodeURIComponent(client.client_secret)}`).toString("base64")}`,
			);
		} else {
			if (client?.client_id) body.set("client_id", client.client_id);
			if (client?.client_secret && method === "client_secret_post") body.set("client_secret", client.client_secret);
		}
		try {
			await fetch(endpoint, { method: "POST", headers, body, signal: AbortSignal.timeout(10_000) });
		} catch {
			// Disconnect is a local security boundary. A remote revocation outage
			// must not retain credentials on this device.
		}
	}
}

type Callback = { wait: Promise<URLSearchParams>; close(): void };

function startLoopbackCallback(): Callback {
	let settle: ((params: URLSearchParams) => void) | undefined;
	let fail: ((error: Error) => void) | undefined;
	let done = false;
	const wait = new Promise<URLSearchParams>((resolve, reject) => {
		settle = resolve;
		fail = reject;
	});
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: CALLBACK_PORT,
		fetch(request) {
			const url = new URL(request.url);
			if (url.pathname !== CALLBACK_PATH || done) return new Response("Not found", { status: 404 });
			done = true;
			settle?.(new URLSearchParams(url.searchParams));
			return new Response(
				"<!doctype html><meta charset=utf-8><title>Toad authorized</title><p>Authorization received. You can close this window and return to Toad.</p>",
				{ headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
			);
		},
	});
	const timer = setTimeout(() => {
		if (!done) fail?.(new Error("MCP authorization timed out"));
		server.stop(true);
	}, AUTH_TIMEOUT_MS);
	return {
		wait,
		close() {
			clearTimeout(timer);
			server.stop(true);
		},
	};
}

function safeMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : "";
	// OAuth error descriptions are controlled by a remote server. Classify them
	// rather than reflecting them into RPC/UI, where they could contain a token
	// or impersonate local guidance.
	if (message === "The OAuth callback state did not match") return message;
	if (message === "The authorization server declined the request") return message;
	if (message === "MCP authorization timed out") return message;
	if (/issuer/i.test(message)) return "Authorization server issuer validation failed";
	if (/https|endpoint/i.test(message)) return "Authorization server endpoint validation failed";
	if (/register|client/i.test(message)) return "OAuth client registration failed";
	if (/scope|resource/i.test(message)) return "OAuth scope or resource validation failed";
	return "MCP authorization failed";
}
