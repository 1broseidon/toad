import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	bridgeAttachmentEnabled,
	invokeBridge,
} from "../mcp/bridge";
import {
	TOAD_TOOLS,
	formatToadToolError,
	formatToadToolOutput,
	validToadToolArgs,
} from "../mcp/tools";

const LABELS: Record<(typeof TOAD_TOOLS)[number]["name"], string> = {
	get_context: "Your Toad identity",
	list_teammates: "List teammates",
	message_teammate: "Message a teammate",
	read_transcript: "Read a transcript",
	search_transcripts: "Search transcripts",
	schedule: "Schedule a one-shot wake",
	loop: "Loop a prompt on an interval",
	list_schedules: "List scheduled work",
	cancel_schedule: "Cancel scheduled work",
	request_human: "Ask the human to act",
};

const SNIPPETS: Record<(typeof TOAD_TOOLS)[number]["name"], string> = {
	get_context: "Your Toad name, goal, and working directory.",
	list_teammates: "The other Toad teammates and whether each is running.",
	message_teammate: "Send one message to another teammate and get its single reply.",
	read_transcript: "Recent messages from another teammate's conversation with the user.",
	search_transcripts: "Find messages across teammate conversations that contain a phrase.",
	schedule: "Wake yourself once later and do a prompt.",
	loop: "Wake yourself on a repeating interval and do a prompt.",
	list_schedules: "See scheduled and looping jobs.",
	cancel_schedule: "Cancel a scheduled or looping job.",
	request_human: "Ask the human to do something you cannot (2FA, credentials) and wait for them.",
};

/**
 * Toad's own teammate tools, as ordinary pi tools.
 *
 * ACP reaches these through the sidecar MCP server. Toad Agent is already in
 * this process, so the same bridge methods are functions instead of a socket.
 * Nothing is registered unless this process owns the live bridge — the same
 * gate the sidecar descriptor uses.
 */
export function toadTools(token: string): ToolDefinition[] {
	if (!bridgeAttachmentEnabled()) return [];
	return TOAD_TOOLS.map((tool) =>
		defineTool({
			name: tool.name,
			label: LABELS[tool.name],
			description: tool.description,
			promptSnippet: SNIPPETS[tool.name],
			parameters: tool.inputSchema as never,
			...(tool.name === "message_teammate" ? { executionMode: "sequential" as const } : {}),
			execute: async (_toolCallId, params) => {
				const args = (params ?? {}) as Record<string, unknown>;
				if (!validToadToolArgs(tool.name, args)) {
					return {
						content: [{ type: "text" as const, text: JSON.stringify({ ok: false, reason: "bad_params" }) }],
						details: {},
					};
				}
				try {
					const result = await invokeBridge(token, tool.name, args);
					return {
						content: [{ type: "text" as const, text: formatToadToolOutput(tool.name, result) }],
						details: {},
					};
				} catch (error) {
					return {
						content: [{ type: "text" as const, text: formatToadToolError(error) }],
						details: {},
					};
				}
			},
		}) as ToolDefinition,
	);
}
