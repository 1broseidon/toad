import { expect, test } from "bun:test";
import { RING_INTENTS, isRingIntent, ringLabel, ringTarget, ringToken } from "./ring";
import type { TranscriptEvent } from "./types";

/**
 * The ring's two rules that are not a matter of taste: what an agent is allowed
 * to name, and which message it is allowed to mark.
 */

let seq = 0;
const at = (kind: TranscriptEvent["kind"], over: Record<string, unknown> = {}): TranscriptEvent =>
	({ kind, id: `e${++seq}`, ts: seq * 1_000, text: "", ...over }) as TranscriptEvent;

test("the intent set is closed", () => {
	expect([...RING_INTENTS]).toEqual(["attention", "warning", "problem"]);
	for (const intent of RING_INTENTS) expect(isRingIntent(intent)).toBe(true);
});

test("nothing outside the set is an intent", () => {
	for (const bad of ["#ff0000", "red", "done", "question", "ATTENTION", "", null, 3, {}]) {
		expect(isRingIntent(bad)).toBe(false);
	}
});

test("every intent maps to a palette family, never a colour", () => {
	const families = RING_INTENTS.map(ringToken);
	expect(families).toEqual(["accent", "warn", "danger"]);
	// A family name is a token prefix; a ring that could carry a literal colour
	// is the footgun the closed set exists to close.
	for (const family of families) expect(family).toMatch(/^[a-z]+$/);
});

test("every intent has a legend word", () => {
	const labels = RING_INTENTS.map(ringLabel);
	expect(new Set(labels).size).toBe(RING_INTENTS.length);
	for (const label of labels) expect(label.length).toBeGreaterThan(0);
});

test("a ring lands on the agent's own latest message", () => {
	const events = [at("user"), at("agent"), at("agent")];
	expect(ringTarget(events)).toBe(events[2]!.id);
});

test("machinery after the message does not move the target", () => {
	const said = at("agent");
	const events = [at("user"), said, at("thought"), at("tool"), at("plan"), at("turn"), at("notice")];
	expect(ringTarget(events)).toBe(said.id);
});

test("an agent that has not spoken since the user did has nothing to ring", () => {
	expect(ringTarget([at("agent"), at("user")])).toBeNull();
	expect(ringTarget([at("agent"), at("user"), at("thought"), at("tool")])).toBeNull();
});

test("an empty tape has nothing to ring", () => {
	expect(ringTarget([])).toBeNull();
});

test("a ring cannot reach back past the user's last message", () => {
	// Two turns: the older reply is history and stays unringable, which is the
	// whole rate guard — an agent gets its own latest bubble and nothing else.
	const older = at("agent");
	const newer = at("agent");
	expect(ringTarget([at("user"), older, at("turn"), at("user"), newer])).toBe(newer.id);
});

test("the user's own message is never the target", () => {
	const events = [at("agent"), at("user")];
	expect(ringTarget(events)).not.toBe(events[1]!.id);
});
