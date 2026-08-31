import { ringTarget, type RingIntent } from "../../shared/ring";
import type { TranscriptEvent } from "../../shared/types";

/**
 * Putting a ring on a message, and taking it off.
 *
 * Both hands live here — the agent's `ring_message` tool and the user's own
 * menu — because they write the same field on the same record and the only
 * interesting difference between them is which message each may reach. The
 * store is a callback so the decision can be driven without one.
 */

/** How a ring reaches the tape: an append wearing the message's own id. */
export type RingWrite = (event: TranscriptEvent) => void;

/**
 * The agent's ring on its own latest message.
 *
 * `ringTarget` decides which message that is, and in deciding it is also the
 * rate guard: never a bubble from last week, never the user's, and never one
 * from before the user last spoke. An agent that has not written anything yet
 * is refused with a sentence rather than quietly armed for its next message —
 * the model reads the refusal and writes first, and nothing has to remember
 * a pending intent across a turn boundary.
 */
export function ringAgentMessage(
	events: TranscriptEvent[],
	intent: RingIntent,
	write: RingWrite,
): { text: string } | { error: string } {
	const eventId = ringTarget(events);
	const found = eventId ? events.find((event) => event.id === eventId) : undefined;
	if (!found || found.kind !== "agent") {
		return {
			error:
				"Write the message first, then ring it: a ring goes on your own latest message, and you have not said anything since the user last spoke.",
		};
	}
	if (found.ring !== intent) write({ ...found, ring: intent });
	return { text: found.text };
}

/**
 * The user's hand on a ring: put one on any bubble, or clear the one there.
 *
 * The way out for a ring an agent put on, and the only way in for a teammate
 * on a harness Toad's tools cannot reach — a ring is a field on the message,
 * not a capability of whatever wrote it. Returns whether anything changed, so
 * a no-op does not cost a push.
 */
export function setMessageRing(
	events: TranscriptEvent[],
	eventId: string,
	intent: RingIntent | null,
	write: RingWrite,
): boolean {
	const found = events.find((event) => event.id === eventId);
	if (!found || (found.kind !== "user" && found.kind !== "agent")) return false;
	if ((found.ring ?? null) === intent) return false;
	write({ ...found, ...(intent ? { ring: intent } : { ring: undefined }) });
	return true;
}
