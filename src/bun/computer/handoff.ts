import { randomUUID } from "node:crypto";
import type { TranscriptEvent } from "../../shared/types";

/**
 * The hand-to-human flow: an agent that hits something only a person can do
 * — credentials, a 2FA prompt, a CAPTCHA — calls `request_human`, and a card
 * lands in its conversation with a button that opens the computer screen.
 * The Promise still waits. The human-facing tool returns at once and is
 * told when the card settles; a subagent awaits this Promise, because it
 * is a job that cannot continue without their hands.
 *
 * One request per teammate at a time: a second request supersedes the first
 * rather than stacking cards the human has to reason about.
 */

export type HumanActionStatus = "done" | "dismissed" | "expired";

type Emit = {
	append(personaId: string, event: TranscriptEvent): void;
	update(personaId: string, event: TranscriptEvent): void;
};

let emit: Emit | null = null;

/** Wired once at boot; requests before then fail rather than vanish. */
export function configureHandoff(emitters: Emit): void {
	emit = emitters;
}

type Pending = {
	actionId: string;
	personaId: string;
	event: TranscriptEvent & { kind: "human_action" };
	timer: ReturnType<typeof setTimeout>;
	resolve(status: HumanActionStatus): void;
};

const pending = new Map<string, Pending>();
const byPersona = new Map<string, string>();

const DEFAULT_TIMEOUT_S = 600;
const MAX_TIMEOUT_S = 3600;

function settle(entry: Pending, status: HumanActionStatus): void {
	pending.delete(entry.actionId);
	if (byPersona.get(entry.personaId) === entry.actionId) byPersona.delete(entry.personaId);
	clearTimeout(entry.timer);
	const updated = { ...entry.event, status };
	emit?.update(entry.personaId, updated);
	entry.resolve(status);
}

/**
 * Posts the card and blocks until the human answers it or the timeout runs
 * out. The card outlives a caller that gives up early — a harness that
 * times the tool call out at its own limit leaves a card the human can
 * still act on, and the agent learns the outcome by looking at the screen.
 */
export function requestHuman(
	personaId: string,
	reason: string,
	timeoutS?: number,
): Promise<{ status: HumanActionStatus }> {
	if (!emit) return Promise.reject(new Error("Human handoff is not available yet."));

	// A newer request replaces a stale one instead of stacking.
	const previous = byPersona.get(personaId);
	if (previous) {
		const entry = pending.get(previous);
		if (entry) settle(entry, "expired");
	}

	const actionId = randomUUID();
	const event: TranscriptEvent & { kind: "human_action" } = {
		kind: "human_action",
		id: `human:${actionId}`,
		ts: Date.now(),
		actionId,
		reason,
		status: "pending",
	};
	emit.append(personaId, event);

	const seconds = Math.min(Math.max(timeoutS ?? DEFAULT_TIMEOUT_S, 10), MAX_TIMEOUT_S);
	return new Promise((resolve) => {
		const entry: Pending = {
			actionId,
			personaId,
			event,
			timer: setTimeout(() => settle(entry, "expired"), seconds * 1000),
			resolve: (status) => resolve({ status }),
		};
		pending.set(actionId, entry);
		byPersona.set(personaId, actionId);
	});
}

/** The card's buttons land here. Answering an already-settled card is a no-op. */
export function answerHuman(actionId: string, status: "done" | "dismissed"): boolean {
	const entry = pending.get(actionId);
	if (!entry) return false;
	settle(entry, status);
	return true;
}
