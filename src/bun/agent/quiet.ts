import type { ScheduledRun, TranscriptEvent } from "../../shared/types";

/**
 * How a scheduled turn finishes with nothing in the chat.
 *
 * The bug this exists for: a teammate told to check something every morning
 * and report only on a change still posted "No change — staying silent per
 * protocol", every morning. The instruction worked — the agent understood it
 * perfectly and said so. That is the problem. Any mechanism that asks the
 * model to produce no text is a mechanism the model can satisfy by producing
 * text about producing no text.
 *
 * So nothing here asks. A job the user marked `quiet` opens a window over its
 * own turn, and while that window is open an `agent` event is rewritten into a
 * `thought` before it reaches the tape. The rewrite is a function of the event
 * *kind* and of a boolean the user set — never of what the event says — so:
 *
 *   - no phrasing can defeat it, because no phrasing is read;
 *   - the agent is never told it is being quiet, so it has nothing to announce;
 *   - the words are not destroyed, only demoted: the transcript keeps them
 *     under thinking, where `Transcript.tsx` already leaves machinery off
 *     screen, so a quiet run is still debuggable.
 *
 * What stays loud, deliberately: `notice` (the error path), `permission`,
 * `human_action`, `peer`, `tool`, `computer_frame`, and the `turn` event
 * itself. Silence was asked of the agent's voice, not of the app — and push
 * fires off `permission`/`human_action` only, so notification behaviour is
 * untouched by anything in this file.
 *
 * Both agent kinds are covered by one gate because both are downstream of it:
 * Toad Agent (pi, in-process) and an ACP backend (a child process with its own
 * tools) each hand their assistant text to `Supervisor`'s `appendEvent` as an
 * already-translated `agent` event, and that funnel is where this runs.
 */

/**
 * The longest a schedule may hold a teammate's voice.
 *
 * A turn that never ends — a wedged backend, a cancelled run whose boundary
 * never arrived — must not mute a teammate for the rest of the session. Past
 * this the window simply expires and the teammate speaks normally again.
 */
export const QUIET_MAX_MS = 30 * 60_000;

export type QuietWindow = {
	/** Which job asked for the silence. Carried for diagnostics, not for logic. */
	jobId: string;
	/**
	 * Turn boundaries owed to work that was already in flight when the schedule
	 * fired. A firing that lands mid-turn is queued behind the running one, so
	 * the first `turn` event to arrive belongs to that turn and not to ours.
	 */
	pendingTurns: number;
	/** Wall-clock expiry; see QUIET_MAX_MS. */
	until: number;
};

/** Opens a window for a firing, or returns null when the job was not quiet. */
export function openQuietWindow(
	run: ScheduledRun,
	context: { busy: boolean; now: number },
): QuietWindow | null {
	if (!run.quiet) return null;
	return {
		jobId: run.jobId,
		pendingTurns: context.busy ? 1 : 0,
		until: context.now + QUIET_MAX_MS,
	};
}

export type QuietStep = {
	/** The window after this event, or null once it has closed. */
	window: QuietWindow | null;
	/** What to write to the tape in place of the event. */
	event: TranscriptEvent;
	/** True when the agent's words were taken out of the chat. */
	muted: boolean;
};

/**
 * Advances the window by one transcript event, and says what to write.
 *
 * The window closes on whichever comes first: the turn boundary that belongs
 * to the scheduled run, someone else speaking, or the expiry. A human message
 * closing it is the important one — a person who types during a quiet run is
 * owed an answer they can read, and the schedule's silence was never about
 * them.
 */
export function stepQuietWindow(
	window: QuietWindow,
	event: TranscriptEvent,
	now: number,
): QuietStep {
	if (now >= window.until) return { window: null, event, muted: false };

	/* Anything with a speaker behind it ends the silence. The scheduled event
	 * itself never reaches here: it opens its window after it is stamped. */
	if (event.kind === "user") return { window: null, event, muted: false };

	if (event.kind === "turn") {
		if (window.pendingTurns > 0) {
			return { window: { ...window, pendingTurns: window.pendingTurns - 1 }, event, muted: false };
		}
		return { window: null, event, muted: false };
	}

	if (event.kind === "agent" && window.pendingTurns === 0) {
		return {
			window,
			event: { kind: "thought", id: event.id, ts: event.ts, text: event.text },
			muted: true,
		};
	}

	return { window, event, muted: false };
}

/**
 * Whether a live `agent` delta should be shown as thinking instead.
 *
 * Without this the composer's writing indicator runs for a message that will
 * never land — the app visibly typing and then producing nothing, which reads
 * as a bug rather than as silence.
 */
export function quietMutesDeltas(window: QuietWindow | null | undefined, now: number): boolean {
	if (!window) return false;
	return window.pendingTurns === 0 && now < window.until;
}
