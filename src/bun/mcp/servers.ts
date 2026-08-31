import { randomUUID } from "node:crypto";
import type {
	McpHttpAuth,
	McpPolicy,
	McpRuntimeServerConfig,
	McpServerConfig,
	Persona,
} from "../../shared/types";
import { computerServerFor } from "../computer/descriptor";
import { pluginServersFor } from "../plugin/descriptor";
import { getSettings } from "../store/settings";
import { staticHeaders } from "./credentials";

/**
 * Which MCP servers a teammate actually gets.
 *
 * Servers are defined once, in app settings, and teammates reference them by
 * id. That split is deliberate: a server is a piece of infrastructure with a
 * command and often a secret in it, while which teammate may use it is a
 * question about that teammate. Keeping copies on each persona would make
 * changing a command an N-place edit and would scatter tokens across the roster.
 *
 * An id that no longer names a server is dropped rather than treated as an
 * error: deleting a server should not break every teammate that referenced it.
 */
export function resolveMcpServers(persona: Persona): McpRuntimeServerConfig[] {
	const available = getSettings().mcpServers;
	const policy = persona.mcpPolicy;

	const selected =
		policy.mode === "none"
			? []
			: policy.mode === "all"
				? available
				: available.filter((server) => policy.serverIds.includes(server.id));
	const configured: McpRuntimeServerConfig[] = selected.map((server) => {
		if (server.type !== "http" || server.auth.mode !== "static") return server;
		const headers = staticHeaders(server.id);
		return headers ? { ...server, headers } : server;
	});

	// The teammate's computer rides along outside the policy: it is a
	// capability of this teammate that Toad manages, not one of the app's
	// servers a policy selects from — a policy of `none` still includes it.
	const computer = computerServerFor(persona);
	const withComputer = computer ? [...configured, computer] : configured;

	/* Plugins ride along the same way and for the same reason: a plugin is a
	 * desk-level capability Toad supervises, not one of the app's user-defined
	 * servers. Each one is an http descriptor pointing at Toad's own endpoint
	 * for this teammate, which is what makes its tools enumerable on an ACP
	 * backend — that list is returned whether or not the Toad sidecar attaches,
	 * so a plugin reaches every backend rather than the three on the sidecar
	 * allow-list. */
	return [...withComputer, ...pluginServersFor(persona)];
}

/**
 * Server ids this teammate's policy names that no longer exist.
 *
 * `resolveMcpServers` drops them deliberately — deleting a server should not
 * break every teammate that referenced it — but dropping them quietly is how a
 * teammate ends up missing a tool with nothing anywhere saying which one. The
 * drop stays; the silence does not.
 */
export function missingPolicyServers(persona: Persona): string[] {
	if (persona.mcpPolicy.mode !== "some") return [];
	const known = new Set(getSettings().mcpServers.map((server) => server.id));
	return persona.mcpPolicy.serverIds.filter((id) => !known.has(id));
}

export const DEFAULT_MCP_POLICY: McpPolicy = { mode: "all", serverIds: [] };

/** A stored policy, or the default when the field is missing or malformed. */
export function normalizePolicy(value: unknown): McpPolicy {
	const candidate = value as Partial<McpPolicy> | undefined;
	const mode =
		candidate?.mode === "all" || candidate?.mode === "none" || candidate?.mode === "some"
			? candidate.mode
			: DEFAULT_MCP_POLICY.mode;
	const serverIds = Array.isArray(candidate?.serverIds)
		? candidate.serverIds.filter((id): id is string => typeof id === "string")
		: [];
	return { mode, serverIds };
}

/**
 * A stored server list, with anything unusable dropped.
 *
 * Settings are a file a person can edit, and a half-written entry there should
 * cost that one server rather than every teammate's tools.
 */
export function normalizeServers(value: unknown): McpServerConfig[] {
	if (!Array.isArray(value)) return [];
	const servers: McpServerConfig[] = [];
	for (const raw of value) {
		const server = normalizeServer(raw);
		if (server) servers.push(server);
	}
	return servers;
}

function normalizeServer(value: unknown): McpServerConfig | null {
	if (!value || typeof value !== "object") return null;
	const candidate = value as Record<string, unknown>;
	const id = typeof candidate.id === "string" && candidate.id ? candidate.id : randomUUID();
	const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
	if (!name) return null;

	if (candidate.type === "http") {
		const url = typeof candidate.url === "string" ? candidate.url.trim() : "";
		if (!url) return null;
		const legacyHeaders = isStringMap(candidate.headers) ? candidate.headers : undefined;
		return {
			id,
			type: "http",
			name,
			url,
			auth: normalizeHttpAuth(candidate.auth, legacyHeaders),
		};
	}

	const command = typeof candidate.command === "string" ? candidate.command.trim() : "";
	if (!command) return null;
	return {
		id,
		type: "stdio",
		name,
		command,
		args: Array.isArray(candidate.args)
			? candidate.args.filter((arg): arg is string => typeof arg === "string")
			: [],
		...(isStringMap(candidate.env) ? { env: candidate.env } : {}),
	};
}

/** Inline headers existed before the credential boundary; settings migrates them before sanitizing. */
export function legacyMcpHeaders(value: unknown): Array<{ serverId: string; headers: Record<string, string> }> {
	if (!Array.isArray(value)) return [];
	return value.flatMap((raw) => {
		if (!raw || typeof raw !== "object") return [];
		const candidate = raw as Record<string, unknown>;
		return typeof candidate.id === "string" && isStringMap(candidate.headers)
			? [{ serverId: candidate.id, headers: candidate.headers }]
			: [];
	});
}

function normalizeHttpAuth(value: unknown, legacy?: Record<string, string>): McpHttpAuth {
	if (legacy) return { mode: "static", headerNames: Object.keys(legacy) };
	if (!value || typeof value !== "object") return { mode: "none" };
	const candidate = value as Record<string, unknown>;
	if (candidate.mode === "static") {
		return {
			mode: "static",
			headerNames: Array.isArray(candidate.headerNames)
				? candidate.headerNames.filter((name): name is string => typeof name === "string" && name.length > 0)
				: [],
		};
	}
	if (candidate.mode === "oauth") {
		const scopes = Array.isArray(candidate.scopes)
			? [...new Set(candidate.scopes.filter((scope): scope is string => typeof scope === "string").map((scope) => scope.trim()).filter(Boolean))]
			: [];
		const resource = typeof candidate.resource === "string" && candidate.resource.trim()
			? candidate.resource.trim()
			: undefined;
		const rawClient = candidate.client as Record<string, unknown> | undefined;
		const rawMethod = rawClient?.tokenEndpointAuthMethod;
		const method: "none" | "client_secret_basic" | "client_secret_post" | undefined =
			rawMethod === "none" || rawMethod === "client_secret_basic" || rawMethod === "client_secret_post"
				? rawMethod
				: undefined;
		const client = typeof rawClient?.clientId === "string" && rawClient.clientId.trim()
			? {
					clientId: rawClient.clientId.trim(),
					...(method ? { tokenEndpointAuthMethod: method } : {}),
				}
			: undefined;
		return { mode: "oauth", scopes, ...(resource ? { resource } : {}), ...(client ? { client } : {}) };
	}
	return { mode: "none" };
}

function isStringMap(value: unknown): value is Record<string, string> {
	return (
		typeof value === "object" &&
		value !== null &&
		Object.values(value).every((item) => typeof item === "string")
	);
}
