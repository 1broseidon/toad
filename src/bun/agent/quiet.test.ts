import { expect, test } from "bun:test";
import type { ScheduledRun, TranscriptEvent } from "../../shared/types";
import {
	QUIET_MAX_MS,
	openQuietWindow,
	quietMutesDeltas,
	stepQuietWindow,
	type QuietWindow,
} from "./quiet";

/**
 * The gate that makes a scheduled turn able to say nothing.
 *
 * The property worth pinning down is negative: there is no event *text* that
 * changes any answer here. Two of the cases below say the same sentence the
 * bug report quoted — "No change — staying silent per protocol" — and one is
 * muted while the other is not, decided entirely by whose turn it is.
 */

const QUIET: ScheduledRun = { jobId: "job-1", kind: "loop", name: "Apple order check", quiet: true };
const LOUD: ScheduledRun = { jobId: "job-2", kind: "loop", name: "Standup" };

const NOW = 1_700_000_000_000;

const agent = (text: string): TranscriptEvent => ({ kind: "agent", id: "a1", ts: NOW, text });
const thought = (text: string): TranscriptEvent => ({ kind: "thought", id: "t1", ts: NOW, text });
const turn = (): TranscriptEvent => ({ kind: "turn", id: "z", ts: NOW, stopReason: "end_turn" });
const user = (text: string): TranscriptEvent => ({ kind: "user", id: "u1", ts: NOW, text });

const open = (busy = false) => {
	const window = openQuietWindow(QUIET, { busy, now: NOW });
	if (!window) throw new Error("expected a window");
	return window;
};

/** Walks a run of events through the machine, collecting what reached the tape. */
function run(
	window: QuietWindow | null,
	events: TranscriptEvent[],
	now = NOW,
): { tape: TranscriptEvent[]; window: QuietWindow | null; muted: number } {
	const tape: TranscriptEvent[] = [];
	let current = window;
	let muted = 0;
	for (const event of events) {
		if (!current) {
			tape.push(event);
			continue;
		}
		const step = stepQuietWindow(current, event, now);
		current = step.window;
		tape.push(step.event);
		if (step.muted) muted++;
	}
	return { tape, window: current, muted };
}

// -- opening ----------------------------------------------------------------

test("only a quiet job opens a window", () => {
	expect(openQuietWindow(LOUD, { busy: false, now: NOW })).toBeNull();
	expect(open()).toEqual({ jobId: "job-1", pendingTurns: 0, until: NOW + QUIET_MAX_MS });
});

test("a firing that lands mid-turn owes the running turn its boundary", () => {
	expect(open(true).pendingTurns).toBe(1);
});

// -- the whole point --------------------------------------------------------

test("a quiet turn leaves no assistant event on the tape", () => {
	const { tape, muted } = run(open(), [
		thought("Checking the order page."),
		agent("No change — staying silent per protocol."),
		turn(),
	]);
	expect(muted).toBe(1);
	expect(tape.filter((event) => event.kind === "agent")).toEqual([]);
	expect(tape.map((event) => event.kind)).toEqual(["thought", "thought", "turn"]);
});

test("the muted words are demoted, not destroyed", () => {
	const { tape } = run(open(), [agent("No change — staying silent per protocol.")]);
	expect(tape[0]).toEqual({
		kind: "thought",
		id: "a1",
		ts: NOW,
		text: "No change — staying silent per protocol.",
	});
});

test("the same sentence is a bubble when no window is open", () => {
	const { tape, muted } = run(null, [agent("No change — staying silent per protocol.")]);
	expect(muted).toBe(0);
	expect(tape[0]?.kind).toBe("agent");
});

test("nothing but the event's kind is read: any text mutes identically", () => {
	for (const text of ["", "ok", "I will now be silent", "🙊", "x".repeat(5_000)]) {
		expect(run(open(), [agent(text)]).tape[0]?.kind).toBe("thought");
	}
});

// -- what stays loud --------------------------------------------------------

test("an error notice is never quiet", () => {
	const notice: TranscriptEvent = {
		kind: "notice",
		id: "n1",
		ts: NOW,
		level: "error",
		text: "Turn failed: the model returned an error",
	};
	const { tape, muted } = run(open(), [notice, turn()]);
	expect(muted).toBe(0);
	expect(tape[0]).toEqual(notice);
});

test("tools, permissions, plans and hand-to-human cards all survive a quiet turn", () => {
	const events: TranscriptEvent[] = [
		{
			kind: "tool",
			id: "tool:1",
			ts: NOW,
			toolCallId: "1",
			title: "Read page",
			status: "completed",
		},
		{ kind: "permission", id: "p1", ts: NOW, requestId: "r1", title: "Run curl", options: [] },
		{ kind: "plan", id: "pl1", ts: NOW, entries: [] },
		{ kind: "human_action", id: "h1", ts: NOW, actionId: "h", reason: "Tap 2FA", status: "pending" },
	];
	const { tape, muted } = run(open(), events);
	expect(muted).toBe(0);
	expect(tape).toEqual(events);
});

// -- closing ----------------------------------------------------------------

test("the turn boundary closes the window, and the next turn speaks", () => {
	const after = run(open(), [agent("quiet one"), turn()]);
	expect(after.window).toBeNull();
	expect(run(after.window, [agent("loud one")]).tape[0]?.kind).toBe("agent");
});

test("a firing behind a running turn stays quiet across that turn's boundary", () => {
	const { tape, window } = run(open(true), [
		agent("the answer to what the human asked"),
		turn(),
		agent("the scheduled run's own words"),
		turn(),
	]);
	expect(tape.map((event) => event.kind)).toEqual(["agent", "turn", "thought", "turn"]);
	expect(window).toBeNull();
});

test("a person typing during a quiet run gets answered", () => {
	const { tape, window } = run(open(), [user("wait, what did you find?"), agent("It moved.")]);
	expect(window).toBeNull();
	expect(tape.map((event) => event.kind)).toEqual(["user", "agent"]);
});

test("a wedged turn cannot mute a teammate forever", () => {
	const late = NOW + QUIET_MAX_MS + 1;
	const { tape, window } = run(open(), [agent("hours later")], late);
	expect(window).toBeNull();
	expect(tape[0]?.kind).toBe("agent");
});

// -- the live stream --------------------------------------------------------

test("deltas are muted exactly while the tape is", () => {
	expect(quietMutesDeltas(undefined, NOW)).toBe(false);
	expect(quietMutesDeltas(null, NOW)).toBe(false);
	expect(quietMutesDeltas(open(), NOW)).toBe(true);
	expect(quietMutesDeltas(open(true), NOW)).toBe(false);
	expect(quietMutesDeltas(open(), NOW + QUIET_MAX_MS)).toBe(false);
});
