import { timingSafeEqual } from "node:crypto";
import {
	checkResourceAllowed,
	type OAuthClientInformationContext,
	OAuthClientMetadata,
	OAuthClientProvider,
	OAuthDiscoveryState,
	StoredOAuthClientInformation,
	StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import packageInfo from "../../../package.json" with { type: "json" };
import type { McpServerConfig } from "../../shared/types";
import * as credentials from "./credentials";

type OAuthServer = Extract<McpServerConfig, { type: "http" }> & {
	auth: Extract<Extract<McpServerConfig, { type: "http" }>["auth"], { mode: "oauth" }>;
};

export type AuthorizationOpener = (url: string) => void | Promise<void>;

/** Persistent MCP SDK provider, one logical authorization session per server ID. */
export class ToadMcpOAuthProvider implements OAuthClientProvider {
	readonly clientMetadata: OAuthClientMetadata;
	private redirected = false;

	constructor(
		private readonly server: OAuthServer,
		readonly redirectUrl: URL,
		private readonly openAuthorization?: AuthorizationOpener,
	) {
		this.clientMetadata = {
			redirect_uris: [redirectUrl.toString()],
			token_endpoint_auth_method: server.auth.client?.tokenEndpointAuthMethod ?? "none",
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			application_type: "native",
			client_name: "Toad",
			client_uri: "https://toad.run",
			software_id: "dev.toad.desktop",
			software_version: packageInfo.version,
			...(server.auth.scopes.length > 0 ? { scope: server.auth.scopes.join(" ") } : {}),
		};
	}

	state(): string {
		const state = credentials.authorizationState(this.server.id).state;
		if (!state) throw new Error("The MCP authorization attempt has no state");
		return state;
	}

	clientInformation(ctx?: OAuthClientInformationContext): StoredOAuthClientInformation | undefined {
		const configured = this.server.auth.client;
		if (configured) {
			return {
				client_id: configured.clientId,
				...(credentials.preRegisteredClientSecret(this.server.id)
					? { client_secret: credentials.preRegisteredClientSecret(this.server.id) }
					: {}),
				...(ctx?.issuer ? { issuer: ctx.issuer } : {}),
			};
		}
		const stored = credentials.clientInformation(this.server.id, ctx?.issuer);
		if (
			stored?.client_secret_expires_at &&
			stored.client_secret_expires_at <= Math.floor(Date.now() / 1_000)
		) {
			return undefined;
		}
		return stored;
	}

	saveClientInformation(
		client: StoredOAuthClientInformation,
		ctx?: OAuthClientInformationContext,
	): void {
		const issuer = ctx?.issuer ?? client.issuer;
		if (!issuer) throw new Error("The authorization server did not bind its client registration to an issuer");
		credentials.saveClientInformation(this.server.id, issuer, client);
	}

	tokens(ctx?: OAuthClientInformationContext): StoredOAuthTokens | undefined {
		return credentials.tokens(this.server.id, ctx?.issuer);
	}

	saveTokens(tokens: StoredOAuthTokens, ctx?: OAuthClientInformationContext): void {
		const issuer = ctx?.issuer ?? tokens.issuer;
		if (!issuer) throw new Error("The authorization server did not bind its tokens to an issuer");
		credentials.saveTokens(this.server.id, issuer, tokens);
	}

	get authorizationRedirected(): boolean {
		return this.redirected;
	}

	async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
		if (!this.openAuthorization) {
			throw new Error("This MCP server needs authorization from Desktop Settings");
		}
		if (authorizationUrl.protocol !== "https:" && authorizationUrl.protocol !== "http:") {
			throw new Error("The authorization endpoint is not HTTP(S)");
		}
		const nonce = credentials.authorizationState(this.server.id).nonce;
		if (nonce) authorizationUrl.searchParams.set("nonce", nonce);
		this.redirected = true;
		await this.openAuthorization(authorizationUrl.toString());
	}

	saveCodeVerifier(verifier: string): void {
		credentials.saveCodeVerifier(this.server.id, verifier);
	}

	codeVerifier(): string {
		return credentials.codeVerifier(this.server.id);
	}

	addClientAuthentication = (headers: Headers, params: URLSearchParams): void => {
		const client = this.clientInformation();
		if (!client) throw new Error("The OAuth client is not registered");
		const registeredMethod = (client as { token_endpoint_auth_method?: string }).token_endpoint_auth_method;
		const method = this.server.auth.client?.tokenEndpointAuthMethod ?? registeredMethod ?? "none";
		if (method === "client_secret_basic") {
			if (!client.client_secret) throw new Error("The pre-registered OAuth client secret is missing");
			headers.set(
				"authorization",
				`Basic ${Buffer.from(`${encodeURIComponent(client.client_id)}:${encodeURIComponent(client.client_secret)}`).toString("base64")}`,
			);
			return;
		}
		params.set("client_id", client.client_id);
		if (method === "client_secret_post") {
			if (!client.client_secret) throw new Error("The pre-registered OAuth client secret is missing");
			params.set("client_secret", client.client_secret);
		}
	};

	async validateResourceURL(serverUrl: string | URL, discovered?: string): Promise<URL | undefined> {
		const selected = this.server.auth.resource ?? discovered;
		if (!selected) return undefined;
		if (!checkResourceAllowed({ requestedResource: serverUrl, configuredResource: selected })) {
			throw new Error("The configured OAuth resource does not match the MCP server URL");
		}
		return new URL(selected);
	}

	invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
		credentials.invalidateOAuth(this.server.id, scope);
	}

	saveResourceUrl(url: string): void {
		credentials.saveResourceUrl(this.server.id, url);
	}

	resourceUrl(): string | undefined {
		return credentials.resourceUrl(this.server.id);
	}

	saveDiscoveryState(state: OAuthDiscoveryState): void {
		credentials.saveDiscovery(this.server.id, state);
	}

	discoveryState(): OAuthDiscoveryState | undefined {
		return credentials.discovery(this.server.id);
	}
}

export function oauthServer(server: McpServerConfig): OAuthServer {
	if (server.type !== "http" || server.auth.mode !== "oauth") {
		throw new Error("Only OAuth HTTP MCP servers can be authorized");
	}
	return server as OAuthServer;
}

/** State is secret-bearing and compared without a timing oracle. */
export function stateMatches(expected: string | undefined, actual: string | null): boolean {
	if (!expected || !actual) return false;
	const left = Buffer.from(expected);
	const right = Buffer.from(actual);
	return left.length === right.length && timingSafeEqual(left, right);
}
