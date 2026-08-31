import { expect, test } from "bun:test";
import {
	SCHEDULE_NAME_MAX,
	scheduleName,
	scheduledLine,
	scheduledRunOf,
	scheduledWireText,
} from "./scheduled";
import type { ScheduledJob, TranscriptEvent } from "./types";

/**
 * The line a scheduled firing collapses to, and the name it collapses around.
 *
 * Every one of these is what the user reads once a day forever, so the edges
 * that matter are the ugly inputs: a job with no name, a prompt that starts
 * with a blank line, a runner-mode prompt whose first line is 400 characters.
 */

const job = (over: Partial<ScheduledJob> = {}): ScheduledJob => ({
	id: "job-1",
	personaId: "p1",
	kind: "schedule",
	prompt: "Check the Apple order",
	nextAt: 0,
	createdAt: 0,
	...over,
});

const fired = (over: Partial<Extract<TranscriptEvent, { kind: "user" }>>): TranscriptEvent => ({
	kind: "user",
	id: "e1",
	ts: 0,
	text: "Check the Apple order",
	...over,
});

// -- naming -----------------------------------------------------------------

test("a given name wins, collapsed to one line", () => {
	expect(scheduleName({ name: "  Apple\n  order   check ", prompt: "anything" })).toBe(
		"Apple order check",
	);
});

test("no name falls back to the prompt's first breath", () => {
	expect(scheduleName({ prompt: "Check the Apple order\n\nThen report." })).toBe(
		"Check the Apple order",
	);
});

test("a leading blank line is not the first breath", () => {
	expect(scheduleName({ prompt: "\n   \nCheck the order" })).toBe("Check the order");
});

test("trailing punctuation is not part of a name", () => {
	expect(scheduleName({ prompt: "Runner mode:\nstep one" })).toBe("Runner mode");
	expect(scheduleName({ prompt: "Check the order — " })).toBe("Check the order");
});

test("a long first line is clipped rather than becoming the prompt again", () => {
	const name = scheduleName({ prompt: "x".repeat(400) });
	expect(name.length).toBe(SCHEDULE_NAME_MAX);
	expect(name.endsWith("…")).toBe(true);
});

test("an over-long given name is clipped the same way", () => {
	expect(scheduleName({ name: "y".repeat(200), prompt: "z" }).length).toBe(SCHEDULE_NAME_MAX);
});

test("a prompt of pure whitespace still yields something to render", () => {
	expect(scheduleName({ prompt: "   \n\t " })).toBe("scheduled work");
	expect(scheduleName({ name: "   ", prompt: "   " })).toBe("scheduled work");
});

// -- the stamp a firing writes ----------------------------------------------

test("the stamp carries the job, and carries quiet only when it is set", () => {
	expect(scheduledRunOf(job({ name: "Apple order check" }))).toEqual({
		jobId: "job-1",
		kind: "schedule",
		name: "Apple order check",
	});
	expect(scheduledRunOf(job({ quiet: true })).quiet).toBe(true);
	expect(scheduledRunOf(job({ quiet: false })).quiet).toBeUndefined();
});

test("the wire text is the framing the agent always heard, and says nothing about quiet", () => {
	expect(scheduledWireText({ kind: "schedule" }, "Check it")).toBe("scheduled · Check it");
	expect(scheduledWireText({ kind: "loop" }, "Check it")).toBe("loop · Check it");
	expect(scheduledWireText({ kind: "loop" }, "Check it")).not.toContain("quiet");
	expect(scheduledWireText({ kind: "loop" }, "Check it")).not.toContain("silent");
});

// -- the line the transcript draws ------------------------------------------

test("a firing becomes a label, a name, and the prompt behind them", () => {
	expect(
		scheduledLine(
			fired({
				text: "  Check the Apple order and report only on a change.  ",
				scheduled: { jobId: "job-1", kind: "schedule", name: "Apple order check" },
			}),
		),
	).toEqual({
		label: "Running scheduled task",
		name: "Apple order check",
		prompt: "Check the Apple order and report only on a change.",
		quiet: false,
	});
});

test("a loop says so", () => {
	expect(
		scheduledLine(fired({ scheduled: { jobId: "j", kind: "loop", name: "Inbox sweep" } }))?.label,
	).toBe("Running loop");
});

test("quiet rides through to the line", () => {
	expect(
		scheduledLine(fired({ scheduled: { jobId: "j", kind: "loop", name: "n", quiet: true } }))?.quiet,
	).toBe(true);
});

test("a typed message is not a firing, and neither is anything else on the tape", () => {
	expect(scheduledLine(fired({}))).toBeNull();
	expect(scheduledLine({ kind: "agent", id: "a", ts: 0, text: "hello" })).toBeNull();
	expect(scheduledLine({ kind: "turn", id: "t", ts: 0, stopReason: "end_turn" })).toBeNull();
});

test("a stamp whose name did not survive the round trip still renders", () => {
	expect(
		scheduledLine(fired({ scheduled: { jobId: "j", kind: "schedule", name: "  " } }))?.name,
	).toBe("scheduled work");
});
