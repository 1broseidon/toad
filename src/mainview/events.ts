import type { TranscriptEvent } from "../shared/types";

/**
 * A transcript with one more event folded into it.
 *
 * Events arrive on two channels — once when they happen, again each time they
 * change, as a tool call finishes or a permission is answered — and either one
 * can be the first copy a conversation sees, because a thread can be opened
 * halfway through a turn. So neither channel gets to assume: the id decides
 * whether this is a new event or a newer version of one already here.
 */
export function fold(events: TranscriptEvent[], event: TranscriptEvent): TranscriptEvent[] {
	const index = events.findIndex((existing) => existing.id === event.id);
	if (index === -1) return [...events, event];
	const next = events.slice();
	next[index] = event;
	return next;
}
