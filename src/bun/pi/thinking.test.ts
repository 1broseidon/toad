import { describe, expect, test } from "bun:test";
import {
	DEFAULT_THINKING_LEVEL,
	THINKING_LADDER,
	THINKING_MODES,
	isThinkingLevel,
	thinkingLevelOf,
	thinkingModesFor,
} from "./thinking";

describe("the thinking ladder", () => {
	test("offers every rung pi accepts, weakest first", () => {
		// The union in @earendil-works/pi-agent-core, restated: if pi's list ever
		// moves, this is the line that says so out loud.
		expect([...THINKING_LADDER]).toEqual([
			"off",
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
		expect(THINKING_MODES.map((mode) => mode.id)).toEqual([...THINKING_LADDER]);
		// A rung with no words is a rung the picker cannot explain.
		for (const mode of THINKING_MODES) {
			expect(mode.name.length).toBeGreaterThan(0);
			expect((mode.description ?? "").length).toBeGreaterThan(0);
		}
	});

	test("minimal and xhigh are on it, so the picker does not jump high to max", () => {
		const ids = THINKING_MODES.map((mode) => mode.id);
		expect(ids).toContain("minimal");
		expect(ids).toContain("xhigh");
		expect(ids.indexOf("xhigh")).toBe(ids.indexOf("high") + 1);
		expect(ids.indexOf("max")).toBe(ids.indexOf("xhigh") + 1);
	});
});

describe("a missing level reads as a default", () => {
	test("the default is a middle rung, not the bottom one", () => {
		// The whole bug: `?? \"off\"` turned an absent preference into a silent
		// capability cut. It must never be the answer to \"nobody said\".
		expect(DEFAULT_THINKING_LEVEL).toBe("medium");
		expect(DEFAULT_THINKING_LEVEL).not.toBe("off");
	});

	test("undefined, empty, and unknown all land on the default", () => {
		expect(thinkingLevelOf(undefined)).toBe("medium");
		expect(thinkingLevelOf("")).toBe("medium");
		// An ACP backend's mode id, left behind by a harness change.
		expect(thinkingLevelOf("architect")).toBe("medium");
		expect(thinkingLevelOf("plan")).toBe("medium");
		// A level a newer build knew and this one does not.
		expect(thinkingLevelOf("ultra")).toBe("medium");
		// Case is not a rung: pi's union is lowercase.
		expect(thinkingLevelOf("High")).toBe("medium");
	});

	test("a real level passes through untouched, off included", () => {
		for (const level of THINKING_LADDER) {
			expect(thinkingLevelOf(level)).toBe(level);
		}
		// "off" survives because a user really can choose it. Only a *missing*
		// value is the one that must not read as off.
		expect(thinkingLevelOf("off")).toBe("off");
	});

	test("isThinkingLevel refuses everything that is not a rung", () => {
		expect(isThinkingLevel("medium")).toBe(true);
		expect(isThinkingLevel("off")).toBe(true);
		expect(isThinkingLevel("architect")).toBe(false);
		expect(isThinkingLevel(undefined)).toBe(false);
		expect(isThinkingLevel(null)).toBe(false);
		expect(isThinkingLevel(3)).toBe(false);
	});
});

describe("the list is filtered by what the model accepts", () => {
	test("a model without xhigh or max is not offered them", () => {
		const modes = thinkingModesFor(["off", "minimal", "low", "medium", "high"]);
		expect(modes.map((mode) => mode.id)).toEqual(["off", "minimal", "low", "medium", "high"]);
	});

	test("a model with them keeps them, in ladder order whatever order pi answers in", () => {
		const modes = thinkingModesFor(["max", "off", "high", "xhigh", "medium"]);
		expect(modes.map((mode) => mode.id)).toEqual(["off", "medium", "high", "xhigh", "max"]);
	});

	test("a model with no reasoning offers only off", () => {
		expect(thinkingModesFor(["off"]).map((mode) => mode.id)).toEqual(["off"]);
	});

	test("nothing to filter by falls back to the whole ladder", () => {
		expect(thinkingModesFor(undefined).map((mode) => mode.id)).toEqual([...THINKING_LADDER]);
		expect(thinkingModesFor([]).map((mode) => mode.id)).toEqual([...THINKING_LADDER]);
		// A model answering in words this build does not know is not a reason to
		// show an empty picker.
		expect(thinkingModesFor(["ultra", "beyond"]).map((mode) => mode.id)).toEqual([
			...THINKING_LADDER,
		]);
	});
});
