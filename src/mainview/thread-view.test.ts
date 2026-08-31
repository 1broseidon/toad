import { expect, test } from "bun:test";
import { oriented, receiptTitle, stampScale, workingLine } from "./thread-view";
import type { PeerThread, TranscriptEvent } from "../shared/types";

/**
 * Whose chair the thread is read from, and what the foot of it is allowed to
 * say. Both are things a screenshot cannot settle: the bubbles look correct
 * from either side until you check which teammate you opened.
 */

const message = (kind: "user" | "agent", id: string): TranscriptEvent =>
	({ kind, id, ts: 1, text: id }) as TranscriptEvent;

const thread = (): PeerThread => ({
	threadKey: "a~b",
	sides: {
		user: { personaId: "a", name: "Ada" },
		agent: { personaId: "b", name: "Bo" },
	},
	events: [message("user", "from-a"), message("agent", "from-b"), { kind: "turn", id: "t", ts: 2, stopReason: "end_turn" }],
});

test("the stored user side reads its own thread unflipped", () => {
	const view = oriented(thread(), "a");
	expect(view.me.name).toBe("Ada");
	expect(view.them.name).toBe("Bo");
	expect(view.events.map((event) => event.kind)).toEqual(["user", "agent", "turn"]);
});

test("the stored agent side reads the same file with the sides swapped", () => {
	const view = oriented(thread(), "b");
	expect(view.me.name).toBe("Bo");
	expect(view.them.name).toBe("Ada");
	// The bubbles move, which is the point: the transcript decides left/right
	// from `kind`, so renaming the speakers alone would leave Bo on the wrong side.
	expect(view.events.map((event) => event.kind)).toEqual(["agent", "user", "turn"]);
});

test("machinery is never flipped", () => {
	const view = oriented(thread(), "b");
	expect(view.events[2]).toEqual({ kind: "turn", id: "t", ts: 2, stopReason: "end_turn" });
});

test("a thread opened by nobody falls back to the file's own orientation", () => {
	const view = oriented(thread(), null);
	expect(view.me.personaId).toBe("a");
	expect(view.events[0]!.kind).toBe("user");
});

test("the working line names whichever side is actually working", () => {
	const mine = oriented(thread(), "a");
	expect(workingLine(mine, "b")).toBe("Bo is working on this");
	expect(workingLine(mine, "a")).toBe("Ada is working on this");
});

test("the working line follows the chair, not the file", () => {
	// Same thread, same worker, opened from the other teammate's header.
	expect(workingLine(oriented(thread(), "b"), "b")).toBe("Bo is working on this");
});

test("nobody working is no line, and a stranger is no line", () => {
	const view = oriented(thread(), "a");
	expect(workingLine(view, undefined)).toBeNull();
	expect(workingLine(view, "someone-else")).toBeNull();
});

test("a bubble from today shows a clock, yesterday says so, older gets a date", () => {
	const now = new Date(2026, 7, 31, 14, 0).getTime();
	expect(stampScale(new Date(2026, 7, 31, 9, 30).getTime(), now)).toBe("time");
	expect(stampScale(new Date(2026, 7, 30, 23, 59).getTime(), now)).toBe("yesterday");
	expect(stampScale(new Date(2026, 7, 29, 23, 59).getTime(), now)).toBe("date");
	expect(stampScale(new Date(2025, 7, 31, 14, 0).getTime(), now)).toBe("date");
});

test("midnight is the boundary, not twenty-four hours", () => {
	const now = new Date(2026, 7, 31, 0, 10).getTime();
	// Twenty minutes ago, but on the other side of midnight.
	expect(stampScale(new Date(2026, 7, 30, 23, 50).getTime(), now)).toBe("yesterday");
});

test("a clock skew into the future still reads as today", () => {
	const now = new Date(2026, 7, 31, 14, 0).getTime();
	expect(stampScale(new Date(2026, 7, 31, 14, 5).getTime(), now)).toBe("time");
});

test("the ticks say what they mean", () => {
	expect(receiptTitle("sent")).not.toBe(receiptTitle("read"));
	expect(receiptTitle("read")).toContain("Read");
});
