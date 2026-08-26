import { describe, expect, test } from "bun:test";
import {
	humanActionNotice,
	notifyTeammate,
	subagentFinishedNotice,
	teammateReplyNotice,
} from "./notify";

describe("job notices", () => {
	test("a reply points at the thread and includes the text", () => {
		const text = teammateReplyNotice("Bob", "bob", { ok: true, reply: "ship it" });
		expect(text).toContain("Bob");
		expect(text).toContain("read_agent_thread");
		expect(text).toContain('"bob"');
		expect(text).toContain("ship it");
	});

	test("a failed send is a single sentence", () => {
		expect(teammateReplyNotice("Bob", "bob", { ok: false, detail: "busy" })).toBe(
			"Your message to Bob did not go through: busy",
		);
	});

	test("a human card names the outcome", () => {
		expect(humanActionNotice("done", "Tap 2FA")).toBe(
			"The human marked your request as done: Tap 2FA",
		);
	});

	test("a subagent report carries the label", () => {
		const text = subagentFinishedNotice("count files", "12 ts files");
		expect(text).toContain("count files");
		expect(text).toContain("12 ts files");
	});
});

describe("notifyTeammate", () => {
	test("starts a stopped teammate before nudging", async () => {
		const calls: string[] = [];
		await notifyTeammate(
			{
				info: () => ({ state: "stopped" as const }),
				start: async () => {
					calls.push("start");
				},
				nudge: (_id, text) => {
					calls.push(text);
				},
			},
			"alice",
			"hello",
		);
		expect(calls).toEqual(["start", "hello"]);
	});

	test("nudges a ready teammate without restarting", async () => {
		const calls: string[] = [];
		await notifyTeammate(
			{
				info: () => ({ state: "ready" as const }),
				start: async () => {
					calls.push("start");
				},
				nudge: (_id, text) => {
					calls.push(text);
				},
			},
			"alice",
			"hello",
		);
		expect(calls).toEqual(["hello"]);
	});
});
