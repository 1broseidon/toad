import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSubagentRoster } from "../../shared/subagents";
import { subagentTool, type SubagentHost, type SubagentResult } from "./subagent";

function toolText(result: { content: Array<{ type?: string; text?: string }> }): string {
	const block = result.content[0];
	return block && typeof block.text === "string" ? block.text : "";
}

async function once(predicate: () => boolean, ms = 1_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!predicate() && Date.now() < deadline) await Bun.sleep(5);
	expect(predicate()).toBe(true);
}

describe("subagent background spawn", () => {
	test("returns at once and notifies when the run finishes", async () => {
		const deferred = Promise.withResolvers<SubagentResult>();
		const notices: string[] = [];
		let ended = 0;
		const hostContext: SubagentHost = {
			cwd: mkdtempSync(join(tmpdir(), "toad-subagent-bg-")),
			personaId: "verify",
			teammateName: "Scout",
			goal: "",
			model: { id: "stub", provider: "test" } as SubagentHost["model"],
			thinkingLevel: "off",
			runtime: { getModel: () => undefined } as SubagentHost["runtime"],
			extraTools: [],
			armTools: [],
			roster: resolveSubagentRoster({}),
		};
		const result = await subagentTool(
			{
				context: () => hostContext,
				begin: () => "ok",
				end: () => {
					ended += 1;
				},
				track: () => {},
				untrack: () => {},
				notify: (text) => {
					notices.push(text);
				},
				run: async () => deferred.promise,
			},
			hostContext.roster,
		).execute("bg", { prompt: "count the files", label: "count files" }, undefined, undefined, {} as never);

		expect(toolText(result)).toContain("Started");
		expect(toolText(result)).toContain("count files");
		expect(notices).toEqual([]);
		expect(ended).toBe(0);

		deferred.resolve({ ok: true, report: "12 files" });
		await once(() => notices.length === 1 && ended === 1);
		expect(notices[0]).toContain("count files");
		expect(notices[0]).toContain("12 files");
	});
});
