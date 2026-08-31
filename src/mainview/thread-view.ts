import type { PeerThread, Receipt, TranscriptEvent } from "../shared/types";

/**
 * The pure half of reading a conversation: whose chair you are in, who is
 * working, and how a bubble says when it was said.
 *
 * It lives out here because none of it needs a DOM, and because the alternative
 * — the same arithmetic inlined in a component — is the half of the UI nothing
 * can prove. Everything in this file has a test beside it.
 */

/**
 * Reads a stored peer thread from one participant's chair.
 *
 * `sides.user`/`sides.agent` are the *file's* orientation, not a point of view:
 * thread meta hands those two roles to the participants by sorted persona id,
 * and every stored event's kind is written in those terms. So which side is
 * outgoing depends on whose thread you opened, and for half of all pairs the
 * reader is the stored `agent`. Flipping the kinds here — rather than swapping
 * only the names — is what actually moves the bubbles: the transcript decides
 * left/right from `kind`, and `speakers` only labels the runs.
 */
export function oriented(thread: PeerThread, selfId: string | null) {
	const mineIsAgent = thread.sides.agent.personaId === selfId;
	const me = mineIsAgent ? thread.sides.agent : thread.sides.user;
	const them = mineIsAgent ? thread.sides.user : thread.sides.agent;
	const events: TranscriptEvent[] = mineIsAgent
		? thread.events.map((event) =>
				event.kind === "user"
					? { ...event, kind: "agent" as const }
					: event.kind === "agent"
						? { ...event, kind: "user" as const }
						: event,
			)
		: thread.events;
	return { me, them, events };
}

export type ThreadView = ReturnType<typeof oriented>;

/**
 * The sentence at the foot of a thread while somebody is mid-reply, or null.
 *
 * Named rather than "they are working", because either side of a thread can be
 * the one answering: you open a thread from one teammate's header, and half the
 * time the teammate doing the work is the one you opened it from.
 */
export function workingLine(view: ThreadView, workingPersonaId: string | undefined): string | null {
	if (!workingPersonaId) return null;
	if (workingPersonaId === view.them.personaId) return `${view.them.name} is working on this`;
	if (workingPersonaId === view.me.personaId) return `${view.me.name} is working on this`;
	return null;
}

/**
 * How precise a per-bubble timestamp has to be, given how long ago it was.
 *
 * A bubble from an hour ago needs a clock; one from last week needs a date, or
 * the reader has to work out which Tuesday. Split from the formatting so the
 * decision can be tested without pinning a locale's punctuation.
 */
export function stampScale(at: number, now: number): "time" | "yesterday" | "date" {
	const days = daysBetween(new Date(at), new Date(now));
	if (days <= 0) return "time";
	if (days === 1) return "yesterday";
	return "date";
}

export function daysBetween(a: Date, b: Date): number {
	const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
	return Math.round((midnight(b) - midnight(a)) / 86_400_000);
}

/** What a receipt's ticks mean, for the reader who hovers them. */
export function receiptTitle(receipt: Receipt): string {
	return receipt === "read" ? "Read by the other agent" : "Sent";
}
