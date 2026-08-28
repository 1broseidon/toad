import type { McpRuntimeServerConfig, Persona } from "../../shared/types";
import { computerRecord } from "./store";
import { computerProxyUrl } from "./proxy";

/**
 * The computer as its teammate's session sees it: one more http MCP server,
 * pointing at Toad's wake-on-request proxy, authorized by the same bearer
 * token the container enforces. No new protocol, no special path — the same
 * routing every other server uses (docs/computer.md §Shape).
 */
export function computerServerFor(persona: Persona): McpRuntimeServerConfig | null {
	if (!persona.computer?.enabled) return null;
	return {
		id: `computer:${persona.id}`,
		type: "http",
		name: "computer",
		url: computerProxyUrl(persona.id),
		auth: { mode: "none" },
		headers: { Authorization: `Bearer ${computerRecord(persona.id).token}` },
	};
}
