import { randomUUID } from "node:crypto";
import type { McpPolicy, McpServerConfig, Persona } from "../../shared/types";
import { computerServerFor } from "../computer/descriptor";
import { getSettings } from "../store/settings";

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
export function resolveMcpServers(persona: Persona): McpServerConfig[] {
	const available = getSettings().mcpServers;
	const policy = persona.mcpPolicy;

	const configured =
		policy.mode === "none"
			? []
			: policy.mode === "all"
				? available
				: available.filter((server) => policy.serverIds.includes(server.id));

	// The teammate's computer rides along outside the policy: it is a
	// capability of this teammate that Toad manages, not one of the app's
	// servers a policy selects from — a policy of `none` still includes it.
	const computer = computerServerFor(persona);
	return computer ? [...configured, computer] : configured;
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
		return {
			id,
			type: "http",
			name,
			url,
			...(isStringMap(candidate.headers) ? { headers: candidate.headers } : {}),
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

function isStringMap(value: unknown): value is Record<string, string> {
	return (
		typeof value === "object" &&
		value !== null &&
		Object.values(value).every((item) => typeof item === "string")
	);
}
