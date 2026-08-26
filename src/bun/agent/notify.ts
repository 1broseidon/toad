import { needsStart } from "../../shared/session";
import type { SessionState } from "../../shared/types";

/**
 * Toad's own words to a teammate when a background job settles.
 *
 * Unlike `wakeTeammate`, this is not a line of the conversation — it is a
 * hidden follow-up, the same path chapters use when they reopen a context.
 * The human chat stays the human's; the job reports beside it.
 */

const MAX_REPLY = 4_000;

type SupervisorLike = {
	info(personaId: string): { state: SessionState };
	start(personaId: string): Promise<unknown>;
	nudge(personaId: string, text: string): void;
};

export async function notifyTeammate(
	supervisor: SupervisorLike,
	personaId: string,
	text: string,
): Promise<void> {
	const state = supervisor.info(personaId).state;
	if (needsStart(state) || state === "error") {
		await supervisor.start(personaId);
	}
	supervisor.nudge(personaId, text);
}

export function teammateReplyNotice(
	name: string,
	targetId: string,
	result: { ok: true; reply: string; note?: string } | { ok: false; detail: string },
): string {
	if (!result.ok) {
		return `Your message to ${name} did not go through: ${result.detail}`;
	}
	const reply = result.reply.trim();
	const clipped =
		reply.length > MAX_REPLY ? `${reply.slice(0, MAX_REPLY)}\n…` : reply;
	const body = clipped
		? `Their reply:\n${clipped}`
		: (result.note ?? "They returned no text.");
	return (
		`Your message to ${name} got a reply. ` +
		`Use read_agent_thread with target ${JSON.stringify(targetId)} to read the full thread.\n\n` +
		body
	);
}

export function humanActionNotice(status: string, reason: string): string {
	return `The human marked your request as ${status}: ${reason}`;
}

export function subagentFinishedNotice(label: string | undefined, report: string): string {
	const who = label?.trim() ? ` (${label.trim()})` : "";
	return `Your subagent${who} finished.\n\n${report}`;
}
