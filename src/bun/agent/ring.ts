import { ringTarget, type RingIntent } from "../../shared/ring";
import type { TranscriptEvent } from "../../shared/types";

/**
 * Putting a ring on a message.
 *
 * One hand puts one on in the product — the agent's `ring_message` tool —
 * over a general by-id write that the RPC contract still exposes and the
 * harnesses drive. Both write the same field on the same record; the only
 * interesting difference is which message each may reach. The store is a
 * callback so the decision can be driven without one.
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
 * Setting or clearing a ring on any bubble by id.
 *
 * **No UI reaches this any more.** The window shipped a right-click menu and a
 * long-press row over it; both are gone, because a ring is attention paint and
 * not a control — it goes on from `ring_message` and it stays on, the way a
 * chapter stamp stays on. Anything that needs an acknowledgement is what the
 * attention card is for, and blurring the two made the ring read as a thing to
 * dismiss.
 *
 * The function stays because a ring is a field on the message rather than a
 * capability of whatever wrote it, so the by-id path is the general one behind
 * `setRing` on the RPC contract: the agent may re-ring, and the clear path
 * (`intent: null`) is exercised by `verify-ring.ts` and `verify-ring-plane.ts`.
 * Returns whether anything changed, so a no-op does not cost a push.
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
