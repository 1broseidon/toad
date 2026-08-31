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
	read_agent_thread: "Read a teammate thread",
	read_transcript: "Read a transcript",
	search_transcripts: "Search transcripts",
	schedule: "Schedule a one-shot wake",
	loop: "Loop a prompt on an interval",
	list_schedules: "List scheduled work",
	cancel_schedule: "Cancel scheduled work",
	request_human: "Ask the human to act",
	list_desks: "List the room's desks",
	hop_desk: "Move to another desk",
	react: "React to the user",
	ring_message: "Ring your last message",
	search_thread: "Search this conversation",
	resume_chapter: "Reopen the previous chapter",
	new_chapter: "Start a new chapter",
};

const SNIPPETS: Record<(typeof TOAD_TOOLS)[number]["name"], string> = {
	get_context: "Your Toad name, goal, and working directory.",
	list_teammates: "The other Toad teammates and whether each is running.",
	message_teammate: "Send a message to another teammate; you are notified when they reply.",
	read_agent_thread: "Recent messages from your private thread with another teammate.",
	read_transcript: "Recent messages from another teammate's conversation with the user.",
	search_transcripts: "Find messages across teammate conversations that contain a phrase.",
	schedule: "Wake yourself once later and do a prompt.",
	loop: "Wake yourself on a repeating interval and do a prompt.",
	list_schedules: "See scheduled and looping jobs.",
	cancel_schedule: "Cancel a scheduled or looping job.",
	request_human: "Ask the human to do something you cannot (2FA, credentials).",
	list_desks: "The room's desks and whether each one could run you.",
	hop_desk: "Schedule your own move to another desk; it happens when this turn ends.",
	react: "Put one emoji on the user's latest message.",
	ring_message: "Ring the message you just wrote so the user can find it.",
	search_thread: "Find earlier chapters and messages in your own conversation with the user.",
	resume_chapter: "Reopen the previous chapter's full context to continue mid-flight work.",
	new_chapter: "Close this chapter so the next message starts fresh.",
};

/**
 * Which bridge tools a subagent inherits, and where each one surfaces.
 *
 * A subagent is the teammate's own hands, so it gets the tools a hand needs
 * and none of the teammate's social or temporal reach. `surfaces` records
 * where a tool's effect lands: `chat-card` means the user sees something in
 * the conversation even though the subagent's transcript is dark (the effect
 * rides the bridge, not the session). Anything new added to `TOAD_TOOLS`
 * must take a row here, which is the point — inheriting is a decision.
 */
export const ARM_TOOL_POLICY: Record<
	(typeof TOAD_TOOLS)[number]["name"],
	{ arm: boolean; surfaces: "chat-card" | "none" }
> = {
	// A hand may ask whose hand it is.
	get_context: { arm: true, surfaces: "none" },
	// A hand on the computer must be able to summon the human — the card
	// lands in the parent's conversation, unattributed, as the teammate's own.
	request_human: { arm: true, surfaces: "chat-card" },
	// An arm does not emote as the teammate: reactions are the voice's.
	react: { arm: false, surfaces: "none" },
	// Nor does it ring: a ring marks one of the teammate's own messages, and a
	// subagent has no messages in that conversation to mark.
	ring_message: { arm: false, surfaces: "none" },
	// Arms do not talk: a subagent speaking to teammates as the parent puts
	// two minds behind one name in someone else's thread.
	list_teammates: { arm: false, surfaces: "none" },
	message_teammate: { arm: false, surfaces: "none" },
	read_agent_thread: { arm: false, surfaces: "none" },
	read_transcript: { arm: false, surfaces: "none" },
	search_transcripts: { arm: false, surfaces: "none" },
	// An arm does not move the body: where the teammate lives is the
	// teammate's own decision, made in its own conversation.
	list_desks: { arm: false, surfaces: "none" },
	hop_desk: { arm: false, surfaces: "none" },
	// Arms do not outlive the task: no planting wakeups in the parent's name.
	schedule: { arm: false, surfaces: "none" },
	loop: { arm: false, surfaces: "none" },
	list_schedules: { arm: false, surfaces: "none" },
	cancel_schedule: { arm: false, surfaces: "none" },
	// Memory is the teammate's: an arm neither reads the conversation it was
	// kept out of nor decides when a chapter of it ends.
	search_thread: { arm: false, surfaces: "none" },
	resume_chapter: { arm: false, surfaces: "none" },
	new_chapter: { arm: false, surfaces: "none" },
};

const ARM_REQUEST_HUMAN =
	"Ask the human to take an action you cannot — enter credentials, tap a 2FA prompt, solve a CAPTCHA — usually on your computer. A card appears in the teammate's conversation. This call waits until they answer it (done or dismissed) or the timeout passes, because you cannot continue without their hands. Set the stage first, and say in `reason` exactly what to do.";

/** The bridge tools a subagent inherits, per `ARM_TOOL_POLICY`. */
export function armToadTools(token: string): ToolDefinition[] {
	return toadTools(token, { waitForHuman: true }).filter(
		(tool) => ARM_TOOL_POLICY[tool.name as keyof typeof ARM_TOOL_POLICY]?.arm,
	);
}

/**
 * Toad's own teammate tools, as ordinary pi tools.
 *
 * ACP reaches these through the sidecar MCP server. Toad Agent is already in
 * this process, so the same bridge methods are functions instead of a socket.
 * Nothing is registered unless this process owns the live bridge — the same
 * gate the sidecar descriptor uses.
 */
export function toadTools(
	token: string,
	options?: { waitForHuman?: boolean },
): ToolDefinition[] {
	if (!bridgeAttachmentEnabled()) return [];
	return TOAD_TOOLS.map((tool) =>
		defineTool({
			name: tool.name,
			label: LABELS[tool.name],
			description:
				tool.name === "request_human" && options?.waitForHuman
					? ARM_REQUEST_HUMAN
					: tool.description,
			promptSnippet: SNIPPETS[tool.name],
			parameters: tool.inputSchema as never,
			execute: async (_toolCallId, params) => {
				const args = (params ?? {}) as Record<string, unknown>;
				if (!validToadToolArgs(tool.name, args)) {
					return {
						content: [{ type: "text" as const, text: JSON.stringify({ ok: false, reason: "bad_params" }) }],
						details: {},
					};
				}
				const forwarded =
					tool.name === "request_human" && options?.waitForHuman
						? { ...args, wait: true }
						: args;
				try {
					const result = await invokeBridge(token, tool.name, forwarded);
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
