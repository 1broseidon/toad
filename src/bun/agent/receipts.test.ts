import { expect, test } from "bun:test";
import {
	higherReceipt,
	readReceiptUpdates,
	throughReceipts,
	type ReceiptWindow,
} from "./receipts";
import type { TranscriptEvent } from "../../shared/types";

/**
 * The receipt machine, which is what the two ticks in a thread bubble mean.
 *
 * Every one of these is about the *kind* of event and never its text: a tick
 * the model could produce by writing the right sentence would be a lie the
 * reader has no way to check.
 */

let seq = 0;
const at = (kind: TranscriptEvent["kind"], over: Record<string, unknown> = {}): TranscriptEvent =>
	({ kind, id: `e${++seq}`, ts: seq * 1_000, text: "", ...over }) as TranscriptEvent;

/** Runs a whole delivery through the seam and reports what it wrote. */
function run(events: TranscriptEvent[]) {
	let window: ReceiptWindow = null;
	const stored: TranscriptEvent[] = [];
	const reads: string[] = [];
	for (const event of events) {
		const step = throughReceipts(window, event);
		window = step.window;
		stored.push(step.event);
		if (step.read) reads.push(step.read.id);
	}
	return { window, stored, reads };
}

test("a message entering the thread is sent", () => {
	const { stored } = run([at("user", { text: "hello" })]);
	expect(stored[0]).toMatchObject({ kind: "user", receipt: "sent" });
});

test("the reply is sent too", () => {
	const { stored } = run([at("user"), at("agent", { text: "hi" })]);
	expect(stored[1]).toMatchObject({ kind: "agent", receipt: "sent" });
});

test("the target's first sign of a turn reads the caller's message", () => {
	const message = at("user");
	const { reads } = run([message, at("thought", { text: "…" })]);
	expect(reads).toEqual([message.id]);
});

test("read is stamped once, not on every event of the turn", () => {
	const message = at("user");
	const { reads } = run([message, at("thought"), at("tool"), at("agent"), at("turn")]);
	expect(reads).toEqual([message.id]);
});

test("the reply alone is proof enough", () => {
	const message = at("user");
	const { reads } = run([message, at("agent", { text: "done" })]);
	expect(reads).toEqual([message.id]);
});

test("a turn that stopped with nothing to say still read the message", () => {
	const message = at("user");
	const { reads } = run([message, at("turn", { stopReason: "end_turn" })]);
	expect(reads).toEqual([message.id]);
});

test("an error before the model ran does not read the message", () => {
	const message = at("user");
	const { reads, window } = run([message, at("notice", { level: "error", text: "backend died" })]);
	expect(reads).toEqual([]);
	expect(window?.id).toBe(message.id);
});

test("a chapter marker written as the session opens does not read the message", () => {
	const message = at("user");
	const { reads } = run([message, at("chapter", { backendId: "pi" })]);
	expect(reads).toEqual([]);
});

test("nothing is read before a message arrives", () => {
	const { reads } = run([at("thought"), at("tool"), at("agent"), at("turn")]);
	expect(reads).toEqual([]);
});

test("two deliveries each get their own read", () => {
	const first = at("user");
	const second = at("user");
	const { reads } = run([first, at("agent"), at("turn"), second, at("agent"), at("turn")]);
	expect(reads).toEqual([first.id, second.id]);
});

test("a second message before any turn supersedes the one waiting", () => {
	// A caller that sent twice in a row: the ticks belong to the message the
	// turn is actually about, and the earlier one waits for its own.
	const first = at("user");
	const second = at("user");
	const { reads } = run([first, second, at("agent")]);
	expect(reads).toEqual([second.id]);
});

test("the text of the events is never read", () => {
	const wording = ["", "read", "I have read your message", "receipt: read", "✓✓"];
	for (const text of wording) {
		const message = at("user", { text });
		const { reads } = run([message, at("thought", { text })]);
		expect(reads).toEqual([message.id]);
	}
	// …and the same sentences with no turn behind them stay unread.
	for (const text of wording) {
		const message = at("user", { text });
		const { reads } = run([message, at("notice", { level: "error", text })]);
		expect(reads).toEqual([]);
	}
});

test("a message that already carries a receipt is not re-stamped", () => {
	const message = { ...at("user"), receipt: "read" as const };
	const { stored } = run([message]);
	expect(stored[0]).toMatchObject({ receipt: "read" });
});

test("the ladder only climbs", () => {
	expect(higherReceipt(undefined, "sent")).toBe("sent");
	expect(higherReceipt("sent", "read")).toBe("read");
	expect(higherReceipt("read", "sent")).toBe("read");
	expect(higherReceipt("read", "read")).toBe("read");
});

test("a reply's read receipt names the messages it moves", () => {
	const one = at("agent", { receipt: "sent" });
	const two = at("agent", { receipt: "sent" });
	const updates = readReceiptUpdates([at("user"), one, two], [one.id, two.id]);
	expect(updates.map((event) => event.id)).toEqual([one.id, two.id]);
	expect(updates.every((event) => event.receipt === "read")).toBe(true);
});

test("a receipt naming nothing, or something already read, writes nothing", () => {
	const said = at("agent", { receipt: "read" });
	expect(readReceiptUpdates([said], [said.id])).toEqual([]);
	expect(readReceiptUpdates([said], ["no-such-id"])).toEqual([]);
	expect(readReceiptUpdates([], ["anything"])).toEqual([]);
});

test("a receipt cannot move machinery", () => {
	const thought = at("thought");
	expect(readReceiptUpdates([thought], [thought.id])).toEqual([]);
});
