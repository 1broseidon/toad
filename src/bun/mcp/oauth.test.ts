import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { platform } from "node:os";
import { McpServer, WebStandardStreamableHTTPServerTransport, fromJsonSchema } from "@modelcontextprotocol/server";
import type { McpServerConfig } from "../../shared/types";
import { MCP_CREDENTIALS_FILE, SETTINGS_FILE } from "../paths";
import { getSettings, updateSettings } from "../store/settings";
import { McpTools } from "../pi/mcp";
import { authorizeMcpServer, disconnectMcpServer } from "./oauth";
import { savePreRegisteredClientSecret, saveStaticHeaders } from "./credentials";
import { resolveMcpServers } from "./servers";

let origin = "";
let http: ReturnType<typeof Bun.serve>;
let clientId = "";
let challenge = "";
let authorizationCode = "";
let accessToken = "";
let refreshToken = "";
let expireAccess = false;
let dcrCalls = 0;
let refreshCalls = 0;
let revokeCalls = 0;
let sawResource = false;
let sawScopes = false;
let sawNonce = false;
let wrongCallbackState = false;
let wrongMetadataIssuer = false;
let expectedClientSecret: string | undefined;
let failRevocation = false;

const mcp = new McpServer({ name: "protected-test", version: "1.0.0" });
mcp.registerTool(
	"echo",
	{
		description: "echo",
		inputSchema: fromJsonSchema({
			type: "object",
			properties: { text: { type: "string" } },
			required: ["text"],
			additionalProperties: false,
		}),
	},
	async ({ text }) => ({ content: [{ type: "text", text: String(text) }] }),
);
const mcpTransport = new WebStandardStreamableHTTPServerTransport({
	sessionIdGenerator: undefined,
	enableJsonResponse: true,
});

beforeAll(async () => {
	await mcp.connect(mcpTransport);
	http = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: route });
	origin = `http://127.0.0.1:${http.port}`;
});

afterAll(async () => {
	http?.stop(true);
	await mcp.close();
});

async function route(request: Request): Promise<Response> {
	const url = new URL(request.url);
	if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
		return json({ resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ["tools.read"] });
	}
	if (url.pathname.startsWith("/.well-known/oauth-authorization-server") || url.pathname.startsWith("/.well-known/openid-configuration")) {
		return json({
			issuer: wrongMetadataIssuer ? `${origin}/wrong-issuer` : origin,
			authorization_endpoint: `${origin}/authorize`,
			token_endpoint: `${origin}/token`,
			registration_endpoint: `${origin}/register`,
			revocation_endpoint: `${origin}/revoke`,
			response_types_supported: ["code"],
			grant_types_supported: ["authorization_code", "refresh_token"],
			code_challenge_methods_supported: ["S256"],
			token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
			authorization_response_iss_parameter_supported: true,
		});
	}
	if (url.pathname === "/register" && request.method === "POST") {
		const metadata = (await request.json()) as {
			redirect_uris?: string[];
			scope?: string;
			application_type?: string;
		};
		expect(metadata.redirect_uris?.[0]).toBe("http://127.0.0.1:53682/oauth/callback");
		expect(metadata.scope).toBe("tools.read profile");
		expect(metadata.application_type).toBe("native");
		dcrCalls++;
		clientId = `client-${dcrCalls}`;
		return json({
			...metadata,
			client_id: clientId,
			client_id_issued_at: Math.floor(Date.now() / 1_000),
			client_secret_expires_at: 0,
		});
	}
	if (url.pathname === "/authorize") {
		expect(url.searchParams.get("client_id")).toBe(clientId);
		expect(url.searchParams.get("code_challenge_method")).toBe("S256");
		sawResource = url.searchParams.get("resource") === `${origin}/mcp`;
		sawScopes = url.searchParams.get("scope") === "tools.read profile";
		sawNonce = Boolean(url.searchParams.get("nonce"));
		challenge = url.searchParams.get("code_challenge") ?? "";
		authorizationCode = randomUUID();
		const callback = new URL(url.searchParams.get("redirect_uri") ?? "");
		callback.searchParams.set("code", authorizationCode);
		callback.searchParams.set("state", wrongCallbackState ? "attacker-state" : (url.searchParams.get("state") ?? ""));
		callback.searchParams.set("iss", origin);
		return new Response(null, { status: 302, headers: { location: callback.toString() } });
	}
	if (url.pathname === "/token" && request.method === "POST") {
		const body = new URLSearchParams(await request.text());
		expect(body.get("resource")).toBe(`${origin}/mcp`);
		if (body.get("grant_type") === "authorization_code") {
			expect(body.get("code")).toBe(authorizationCode);
			if (expectedClientSecret) {
				expect(body.get("client_id")).toBe("known-client");
				expect(body.get("client_secret")).toBe(expectedClientSecret);
			}
			expect(createHash("sha256").update(body.get("code_verifier") ?? "").digest("base64url")).toBe(challenge);
			accessToken = "access-1";
			refreshToken = "refresh-1";
			return json({ access_token: accessToken, refresh_token: refreshToken, token_type: "Bearer", expires_in: 1, scope: "tools.read profile" });
		}
		expect(body.get("grant_type")).toBe("refresh_token");
		expect(body.get("refresh_token")).toBe(refreshToken);
		refreshCalls++;
		accessToken = `access-${refreshCalls + 1}`;
		refreshToken = `refresh-${refreshCalls + 1}`;
		expireAccess = false;
		return json({ access_token: accessToken, refresh_token: refreshToken, token_type: "Bearer", expires_in: 3600, scope: "tools.read profile" });
	}
	if (url.pathname === "/revoke" && request.method === "POST") {
		const body = new URLSearchParams(await request.text());
		if (body.has("token")) revokeCalls++;
		return new Response(null, { status: failRevocation ? 503 : 200 });
	}
	if (url.pathname === "/mcp-static") {
		if (request.headers.get("x-api-key") !== "static-secret") return new Response("unauthorized", { status: 401 });
		return mcpTransport.handleRequest(request);
	}
	if (url.pathname === "/mcp") {
		const bearer = request.headers.get("authorization");
		if (bearer !== `Bearer ${accessToken}` || expireAccess) {
			return new Response("unauthorized", {
				status: 401,
				headers: {
					"www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource", scope="tools.read profile"`,
				},
			});
		}
		return mcpTransport.handleRequest(request);
	}
	return new Response("not found", { status: 404 });
}

function json(value: unknown): Response {
	return Response.json(value, { headers: { "cache-control": "no-store" } });
}

async function addOAuthServer(name: string): Promise<{ server: McpServerConfig; before: McpServerConfig[] }> {
	const server: McpServerConfig = {
		id: randomUUID(),
		type: "http",
		name,
		url: `${origin}/mcp`,
		auth: { mode: "oauth", scopes: ["tools.read", "profile"], resource: `${origin}/mcp` },
	};
	const before = getSettings().mcpServers;
	updateSettings({ mcpServers: [...before, server] });
	return { server, before };
}

async function followAuthorization(url: string): Promise<void> {
	const response = await fetch(url, { redirect: "manual" });
	const location = response.headers.get("location");
	expect(location).toBeTruthy();
	await fetch(location!);
}

test("static headers still reach the Streamable HTTP transport from the credential store", async () => {
	const before = getSettings().mcpServers;
	const server: McpServerConfig = {
		id: randomUUID(),
		type: "http",
		name: "static",
		url: `${origin}/mcp-static`,
		auth: { mode: "static", headerNames: ["x-api-key"] },
	};
	updateSettings({ mcpServers: [...before, server] });
	saveStaticHeaders(server.id, { "x-api-key": "static-secret" });
	try {
		const persona = {
			id: randomUUID(),
			mcpPolicy: { mode: "some" as const, serverIds: [server.id] },
		} as Parameters<typeof resolveMcpServers>[0];
		const tools = await McpTools.connect(resolveMcpServers(persona), () => undefined);
		try {
			expect(tools.tools().some((tool) => tool.name.includes("echo"))).toBe(true);
		} finally {
			await tools.close();
		}
		expect(readFileSync(SETTINGS_FILE, "utf8")).not.toContain("static-secret");
	} finally {
		updateSettings({ mcpServers: before });
	}
});

test("OAuth 2.1 discovers, registers, authorizes, refreshes, persists and revokes", async () => {
	const { server, before } = await addOAuthServer("protected");
	const id = server.id;
	try {
		await authorizeMcpServer(id, followAuthorization);
		expect(dcrCalls).toBe(1);
		expect(sawResource).toBe(true);
		expect(sawScopes).toBe(true);
		expect(sawNonce).toBe(true);

		const publicSettings = readFileSync(SETTINGS_FILE, "utf8");
		expect(publicSettings).not.toContain(accessToken);
		expect(publicSettings).not.toContain(refreshToken);
		expect(publicSettings).not.toContain("code_verifier");
		const credentialFile = readFileSync(MCP_CREDENTIALS_FILE, "utf8");
		expect(credentialFile).toContain("refresh-1");
		expect(credentialFile).toContain('"client_secret_expires_at": 0');
		if (platform() !== "win32") expect(statSync(MCP_CREDENTIALS_FILE).mode & 0o777).toBe(0o600);

		// A fresh runtime provider reads the persisted token. The resource rejects
		// it once, causing SDK-managed refresh and one safe request retry.
		expireAccess = true;
		const persona = {
			id: randomUUID(),
			mcpPolicy: { mode: "some" as const, serverIds: [id] },
		} as Parameters<typeof resolveMcpServers>[0];
		const tools = await McpTools.connect(resolveMcpServers(persona), () => undefined);
		try {
			expect(refreshCalls).toBe(1);
			const echo = tools.tools().find((tool) => tool.name.includes("echo"));
			expect(echo).toBeTruthy();
			const result = await echo!.execute("call", { text: "persisted" }, new AbortController().signal, () => undefined);
			expect(JSON.stringify(result)).toContain("persisted");
		} finally {
			await tools.close();
		}
		expect(readFileSync(MCP_CREDENTIALS_FILE, "utf8")).toContain("refresh-2");

		await disconnectMcpServer(id);
		expect(revokeCalls).toBeGreaterThanOrEqual(2);
		expect(readFileSync(MCP_CREDENTIALS_FILE, "utf8")).not.toContain("refresh-2");
	} finally {
		updateSettings({ mcpServers: before });
	}
});

test("a pre-registered confidential client bypasses DCR and keeps its secret out of settings", async () => {
	const secret = `secret-${randomUUID()}`;
	const before = getSettings().mcpServers;
	const server: McpServerConfig = {
		id: randomUUID(),
		type: "http",
		name: "pre-registered",
		url: `${origin}/mcp`,
		auth: {
			mode: "oauth",
			scopes: ["tools.read", "profile"],
			resource: `${origin}/mcp`,
			client: { clientId: "known-client", tokenEndpointAuthMethod: "client_secret_post" },
		},
	};
	const registrations = dcrCalls;
	clientId = "known-client";
	expectedClientSecret = secret;
	updateSettings({ mcpServers: [...before, server] });
	savePreRegisteredClientSecret(server.id, secret);
	try {
		await authorizeMcpServer(server.id, followAuthorization);
		expect(dcrCalls).toBe(registrations);
		expect(readFileSync(SETTINGS_FILE, "utf8")).not.toContain(secret);
	} finally {
		expectedClientSecret = undefined;
		failRevocation = true;
		await disconnectMcpServer(server.id);
		failRevocation = false;
		expect(readFileSync(MCP_CREDENTIALS_FILE, "utf8")).not.toContain(secret);
		updateSettings({ mcpServers: before });
	}
});

test("OAuth callback rejects a mismatched state without retaining tokens", async () => {
	const { server, before } = await addOAuthServer("wrong-state");
	wrongCallbackState = true;
	try {
		await expect(authorizeMcpServer(server.id, followAuthorization)).rejects.toThrow("state did not match");
		expect(readFileSync(MCP_CREDENTIALS_FILE, "utf8")).not.toContain("access-1");
	} finally {
		wrongCallbackState = false;
		await disconnectMcpServer(server.id);
		updateSettings({ mcpServers: before });
	}
});

test("OAuth discovery rejects authorization-server issuer mismatch", async () => {
	const { server, before } = await addOAuthServer("wrong-issuer");
	wrongMetadataIssuer = true;
	try {
		await expect(authorizeMcpServer(server.id, followAuthorization)).rejects.toThrow(/issuer/i);
	} finally {
		wrongMetadataIssuer = false;
		await disconnectMcpServer(server.id);
		updateSettings({ mcpServers: before });
	}
});
