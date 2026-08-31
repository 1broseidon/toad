import type { TranscriptEvent } from "./types";

/**
 * A ring: an agent's mark on one of its own messages, saying "this is the one".
 *
 * The motivating case is a teammate that runs a daily review and posts it. In a
 * scroll of ordinary chat that is one more bubble; ringed, it is the thing you
 * came for, and it is still findable a week later.
 *
 * The set is closed and the theme owns the colours. An agent naming a hex would
 * be an agent doing visual design: the picks clash with each other, they do not
 * survive a palette change, and nothing in the UI could legend them. An intent
 * is a word the model can reason about and the theme can translate.
 *
 * Three intents, not the four first sketched. "done" would have painted a
 * dimmer version of attention's colour, which is a distinction the eye does not
 * make and a legend cannot justify — a finished thing is what a ring already
 * means. "question" is what `request_human` and permission cards are for; a
 * ringed question is a question Toad cannot route to an answer.
 */
export const RING_INTENTS = ["attention", "warning", "problem"] as const;

export type RingIntent = (typeof RING_INTENTS)[number];

export function isRingIntent(value: unknown): value is RingIntent {
	return typeof value === "string" && (RING_INTENTS as readonly string[]).includes(value);
}

/**
 * The token family a ring paints in — never a colour.
 *
 * The names are the palette's own (`--color-accent`, `--color-warn`,
 * `--color-danger` and their wash/edge siblings), so a ring is the same signal
 * the rest of the window already uses for the same meaning.
 */
export function ringToken(intent: RingIntent): "accent" | "warn" | "danger" {
	if (intent === "warning") return "warn";
	if (intent === "problem") return "danger";
	return "accent";
}

/**
 * The word above a ringed bubble.
 *
 * A ring with no legend is a mystery: the reader sees an emphasis and has to
 * guess what earned it. Said in the register the rest of the conversation is
 * written in, not as a taxonomy label.
 */
export function ringLabel(intent: RingIntent): string {
	if (intent === "warning") return "heads up";
	if (intent === "problem") return "this went wrong";
	return "look at this";
}

/**
 * Which message a ring lands on: the agent's own latest, if it has spoken since
 * the user last did.
 *
 * This is the whole rate guard, and it is structural rather than a quota. An
 * agent can ring the message it just wrote and nothing else — never a bubble
 * from last week, never the user's, and at most one per turn without writing
 * another message first. An agent that rings everything is then an agent that
 * says everything twice, which is visible in the conversation itself.
 *
 * Machinery is walked straight past: thinking, tool calls, plans, turn markers
 * and notices are not messages and never carried a ring.
 */
export function ringTarget(events: TranscriptEvent[]): string | null {
	for (let index = events.length - 1; index >= 0; index--) {
		const event = events[index]!;
		if (event.kind === "agent") return event.id;
		if (event.kind === "user") return null;
	}
	return null;
}
