import type {
	McpRuntimeServerConfig,
	Persona,
	ToolLedgerRow,
	ToolSourceKind,
	ToolState,
} from "../../shared/types";
import { installedPlugin, listPlugins, pluginState, pluginStateReason } from "./host";
import { pluginMay } from "./permission";
import { pluginProxyToken, pluginProxyUrl } from "./proxy";

/**
 * Plugins as a teammate's session sees them: one more http MCP server each,
 * pointing at Toad's own per-teammate endpoint.
 *
 * The same descriptor reaches both agent kinds, which is the entire reason the
 * proxy exists. `resolveMcpServers` returns this list to an ACP backend whether
 * or not the Toad sidecar attaches — the deny path returns `configured`
 * unchanged — so a plugin's tools reach *every* backend, not the three on the
 * sidecar allow-list, and Toad still sees every call.
 *
 * A descriptor is emitted for a plugin that is down, on purpose. The manifest
 * is the tool list, so the teammate can still see the tool and calling it comes
 * back `plugin_down` naming it. The alternative — dropping the descriptor —
 * is a tool that silently does not exist, which is the bug this whole plan is
 * about.
 */

const PLUGIN_SERVER_PREFIX = "plugin:";

export function isPluginServerId(serverId: string): boolean {
	return serverId.startsWith(PLUGIN_SERVER_PREFIX);
}

export function pluginIdFromServerId(serverId: string): string {
	return serverId.slice(PLUGIN_SERVER_PREFIX.length);
}

/**
 * This teammate's plugin descriptors, one per installed plugin.
 *
 * Keyed by the teammate rather than by the session, and it takes the id alone
 * to make that impossible to get wrong. A peer thread runs on a persona *view*
 * whose `id` is the thread's session key, so handing this a `Persona` invited
 * exactly one mistake: a DM session dialling a door that was opened for
 * somebody who does not exist. One teammate, one door, one row in the ledger —
 * whichever of its sessions is doing the talking.
 */
export function pluginServersFor(teammateId: string): McpRuntimeServerConfig[] {
	return listPlugins().map((plugin) => ({
		id: `${PLUGIN_SERVER_PREFIX}${plugin.id}`,
		type: "http" as const,
		name: plugin.name,
		url: pluginProxyUrl(plugin.id, teammateId),
		auth: { mode: "none" as const },
		headers: { Authorization: `Bearer ${pluginProxyToken(plugin.id, teammateId)}` },
	}));
}

/**
 * The tools a subagent inherits from its parent's plugins.
 *
 * `subagentInherits` is declared per tool with no default, which makes this the
 * runtime replacement for `ARM_TOOL_POLICY`'s compile-time exhaustive record:
 * the manifest cannot be written without answering the question, so nothing
 * arrives in a subagent's hands by omission. Asked through `pluginMay` rather
 * than by reading the flag directly, because there is one decision function and
 * this is one of its readers.
 */
export function subagentInheritsPluginTool(pluginId: string, toolName: string): boolean {
	return pluginMay(
		{ pluginId, manifest: installedPlugin(pluginId), state: pluginState(pluginId) },
		"tool.subagentInherit",
		toolName,
	).allowed;
}

type LedgerInput = {
	state: ToolState;
	source: ToolSourceKind;
	origin: string;
	name: string;
	reason: string;
};

/** What `McpTools` saw, when the caller is the built-in agent and has it. */
export type ObservedAttachment = {
	serverId: string;
	attached: boolean;
	reason: string;
	tools: ReadonlyArray<{ name: string; toolName: string }>;
};

/**
 * A ledger row per plugin tool, for either agent kind.
 *
 * Toad Agent connects to the proxy itself, so `observed` carries the mangled
 * names the model will actually see and the fact that the connection worked.
 * An ACP backend reports nothing, so the rows start `declared` and the proxy
 * promotes them to `verified` the moment an `initialize` arrives on the
 * teammate's own path. Either way a plugin that is not running produces
 * `absent` rows naming the tool and the cause, which is the state that used to
 * be nothing at all.
 */
export function pluginToolRows(
	persona: Persona,
	agentKind: "pi" | "acp",
	observed?: ReadonlyArray<ObservedAttachment>,
): LedgerInput[] {
	const rows: LedgerInput[] = [];
	for (const plugin of listPlugins()) {
		const seen = observed?.find((entry) => entry.serverId === `${PLUGIN_SERVER_PREFIX}${plugin.id}`);
		const running = plugin.state === "running";
		for (const tool of plugin.tools) {
			const shown = seen?.tools.find((entry) => entry.toolName === tool.name)?.name ?? tool.name;
			if (!running) {
				rows.push({
					state: "absent",
					source: "plugin",
					origin: plugin.id,
					name: shown,
					reason: `plugin_down: ${pluginStateReason(plugin.id) ?? plugin.reason}`,
				});
				continue;
			}
			if (seen && !seen.attached) {
				rows.push({
					state: "absent",
					source: "plugin",
					origin: plugin.id,
					name: shown,
					reason: seen.reason,
				});
				continue;
			}
			rows.push({
				state: seen?.attached ? "verified" : "declared",
				source: "plugin",
				origin: plugin.id,
				name: shown,
				reason: seen?.attached
					? `attached from the ${plugin.name} plugin, through Toad's own endpoint for this teammate`
					: `handed to ${persona.backendId} as an http MCP server on Toad's own endpoint for this teammate; an initialize arriving there is the proof it attached`,
			});
		}
		if (plugin.tools.length === 0) {
			rows.push({
				state: "absent",
				source: "plugin",
				origin: plugin.id,
				name: plugin.id,
				reason: `${plugin.name} declares no tools`,
			});
		}
	}
	/* The kind is not read today: the descriptor is identical for both, which
	 * is the property the proxy exists to buy. Named in the signature so a
	 * later divergence is a change to this function and not a new one. */
	void agentKind;
	return rows;
}

/** The plugin rows of a ledger, for the plugin page's per-teammate tool list. */
export function pluginRowsOf(rows: readonly ToolLedgerRow[], pluginId: string): ToolLedgerRow[] {
	return rows.filter((row) => row.source === "plugin" && row.origin === pluginId);
}
