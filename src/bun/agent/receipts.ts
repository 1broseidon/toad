import type { Receipt, TranscriptEvent } from "../../shared/types";

/** The two event kinds that are messages — the only ones that carry a receipt. */
export type ThreadMessage = Extract<TranscriptEvent, { kind: "user" | "agent" }>;

export function isThreadMessage(event: TranscriptEvent): event is ThreadMessage {
	return event.kind === "user" || event.kind === "agent";
}

/** A receipt only ever climbs: nothing un-reads a message. */
const RUNG: Record<Receipt, number> = { sent: 0, read: 1 };

export function higherReceipt(current: Receipt | undefined, next: Receipt): Receipt {
	return current !== undefined && RUNG[current] >= RUNG[next] ? current : next;
}

/**
 * What, arriving from the recipient's own session, proves it took the message
 * into a turn.
 *
 * Everything a running agent produces counts — a thought, a tool call, a plan,
 * a permission request, the reply itself, even a turn that stopped with nothing
 * to say. Two kinds do not. A `notice` can be an error raised before the prompt
 * ever reached the model, which is the precise case a read tick would lie
 * about. A `chapter` marker is written as the session opens, ahead of the
 * prompt, for the same reason.
 */
function provesATurn(event: TranscriptEvent): boolean {
	return event.kind !== "notice" && event.kind !== "chapter";
}

/**
 * The one message a delivery is currently waiting on a turn for, or null.
 *
 * There is at most one: a peer session takes one prompt at a time, and the
 * message that opened the window is the one the events that follow belong to.
 */
export type ReceiptWindow = ThreadMessage | null;

/**
 * The receipt seam, as a fold over everything one peer session emits.
 *
 * Both rungs are decided here, from the *kind* of event and nothing else — no
 * text is read, and the agent is never told a tick exists, so there is no
 * behaviour of the model that can forge one. It sits in `PeerSessions`'
 * emitters, which is downstream of the protocol: `PiSession` and `AcpSession`
 * have both already translated their output into this vocabulary by the time it
 * arrives, so one gate covers both agent kinds and ACP needs no cooperation
 * from the child process.
 *
 * Returns the event to store (stamped `sent` if it is a message that has no
 * receipt yet) and, when this event is the proof, the earlier message to
 * re-append at `read`. The thread's JSONL folds by id, so an update is an
 * append wearing the same id.
 */
export function throughReceipts(
	window: ReceiptWindow,
	event: TranscriptEvent,
): { window: ReceiptWindow; event: TranscriptEvent; read: ThreadMessage | null } {
	if (isThreadMessage(event)) {
		const stamped = event.receipt ? event : { ...event, receipt: "sent" as const };
		/* A message from the caller is what a turn is about to answer, so it
		 * becomes the one waiting — and a second one before any turn replaces
		 * it, because the turn that follows is about the newer message. */
		if (event.kind === "user") return { window: stamped, event: stamped, read: null };
		/* The reply is two things at once: a message of its own on its way out,
		 * and the plainest possible proof that the turn ran. Whether the *caller*
		 * ever read the reply is not knowable here — that word comes back from
		 * the desk that asked, through `readReceiptUpdates`. */
		return {
			window: null,
			event: stamped,
			read: window ? { ...window, receipt: "read" } : null,
		};
	}
	if (window && provesATurn(event)) {
		return { window: null, event, read: { ...window, receipt: "read" } };
	}
	return { window, event, read: null };
}

/**
 * The messages in a thread that a named set of ids should now be read.
 *
 * Used by both halves of the reply's receipt — the local pair, where the
 * caller's notice is written in this process, and the remote one, where the
 * asking desk says so over the wire. Ids that name nothing, or a message that
 * is already read, are simply not in the answer, so an old or duplicated
 * receipt writes nothing.
 */
export function readReceiptUpdates(
	events: TranscriptEvent[],
	eventIds: readonly string[],
): ThreadMessage[] {
	const wanted = new Set(eventIds);
	const updates: ThreadMessage[] = [];
	for (const event of events) {
		if (!wanted.has(event.id) || !isThreadMessage(event)) continue;
		if (event.receipt === "read") continue;
		updates.push({ ...event, receipt: "read" });
	}
	return updates;
}
