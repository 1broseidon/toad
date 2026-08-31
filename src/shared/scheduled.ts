import type { ScheduledJob, ScheduledRun, TranscriptEvent } from "./types";

/**
 * What a scheduled firing looks like, on both sides of the process boundary.
 *
 * A schedule that fires four times a week used to put its whole runner-mode
 * prompt into the chat four times a week. The prompt has to stay — it is the
 * only way to debug a schedule that did the wrong thing — but it does not have
 * to be a message. So the tape keeps the prompt as the event's text and stamps
 * the job on it, and everything here turns that stamp back into the one line
 * the conversation actually wants.
 *
 * Everything in this file is a pure function of a job or an event, which is
 * what lets both the main process and the renderer agree without either one
 * asking the other.
 */

/** Longer than this stops being a name and starts being the prompt again. */
export const SCHEDULE_NAME_MAX = 48;

/** What a job with no name of its own gets called. */
const UNNAMED = "scheduled work";

/**
 * A job's short name: what it was given, else the first breath of its prompt.
 *
 * The fallback matters more than the given name does. Every job written before
 * names existed has none, and a schedule created by an agent that ignored the
 * argument has none either — neither may render as a wall of text, so the
 * derivation has to produce something usable from any prompt at all.
 */
export function scheduleName(job: { name?: string; prompt: string }): string {
	const given = clip(collapse(job.name ?? ""));
	if (given) return given;
	const firstLine = job.prompt.split("\n").find((line) => collapse(line).length > 0) ?? "";
	const derived = clip(collapse(firstLine).replace(/[\s:.,;—-]+$/, ""));
	return derived || UNNAMED;
}

function collapse(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function clip(value: string): string {
	if (value.length <= SCHEDULE_NAME_MAX) return value;
	return `${value.slice(0, SCHEDULE_NAME_MAX - 1).trimEnd()}…`;
}

/** The stamp a firing puts on its user event. */
export function scheduledRunOf(job: ScheduledJob): ScheduledRun {
	return {
		jobId: job.id,
		kind: job.kind,
		name: scheduleName(job),
		...(job.quiet ? { quiet: true } : {}),
	};
}

/**
 * The framing the agent reads when a schedule wakes it.
 *
 * Unchanged from before any of this metadata existed, and deliberately silent
 * about `quiet`: the gate in src/bun/agent/quiet.ts does not need the agent's
 * cooperation, and asking for it is exactly how "No change — staying silent
 * per protocol" ended up in someone's chat.
 */
export function scheduledWireText(run: { kind: "schedule" | "loop" }, prompt: string): string {
	return `${run.kind === "loop" ? "loop" : "scheduled"} · ${prompt}`;
}

/** One scheduled firing, as the transcript draws it. */
export type ScheduledLine = {
	/** The unemphasised half: "Running scheduled task". */
	label: string;
	/** The emphasised half: the job's name. */
	name: string;
	/** What expanding the line reveals. Empty means there is nothing to expand. */
	prompt: string;
	/** True when this run's turn is barred from the chat. */
	quiet: boolean;
};

/**
 * The line a scheduled user event renders as, or null if a person typed it.
 *
 * Null is the whole compatibility story: an event without the stamp — every
 * event written before this shipped, and every message from a human — takes
 * the ordinary bubble path, unchanged.
 */
export function scheduledLine(event: TranscriptEvent): ScheduledLine | null {
	if (event.kind !== "user" || !event.scheduled) return null;
	const run = event.scheduled;
	return {
		label: run.kind === "loop" ? "Running loop" : "Running scheduled task",
		name: collapse(run.name) || UNNAMED,
		prompt: event.text.trim(),
		quiet: run.quiet === true,
	};
}
