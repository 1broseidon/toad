import { describe, expect, test } from "bun:test";
import { toolListDisagreement, validateManifest } from "./manifest";

/**
 * The manifest is the authoritative tool list, so the validator refuses rather
 * than repairs. Every case below is a thing that, allowed through, would make
 * Toad describe tools to a teammate that are not the tools it can call.
 */

const good = {
	id: "com.example.board",
	version: "0.1.0",
	name: "Board",
	serve: { command: "bun", args: ["server.ts"] },
	tools: [
		{
			name: "board_claim",
			description: "Claim a task",
			inputSchema: { type: "object", properties: { taskId: { type: "string" } } },
			subagentInherits: false,
		},
	],
	logs: ["ops"],
	rpc: { serves: [] },
	events: [{ name: "foldDigest", payload: { type: "object", properties: { digest: { type: "string" } } } }],
	grants: {
		room: ["desks"],
		fleet: { log: ["ops"], rpc: { call: false, serve: [] }, events: true, blobs: false },
		acceptFrom: "members",
	},
};

function problemsOf(patch: Record<string, unknown>): string[] {
	const result = validateManifest({ ...good, ...patch });
	return result.ok ? [] : result.problems;
}

describe("a manifest that is fine", () => {
	test("parses, and keeps every declaration", () => {
		const result = validateManifest(good);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.manifest.id).toBe("com.example.board");
		expect(result.manifest.tools[0]!.subagentInherits).toBe(false);
		expect(result.manifest.grants.fleet.log).toEqual(["ops"]);
	});
});

describe("what it refuses", () => {
	test("an id that is not reverse-DNS: it names a directory and a URL segment", () => {
		expect(problemsOf({ id: "Board!" }).join(" ")).toContain("reverse-DNS");
	});

	test("a tool with no subagentInherits — there is no default", () => {
		const problems = problemsOf({
			tools: [{ name: "t", description: "d", inputSchema: { type: "object" } }],
		});
		expect(problems.join(" ")).toContain("subagentInherits");
	});

	test("a tool with no description, which the model would have read", () => {
		expect(
			problemsOf({
				tools: [{ name: "t", inputSchema: { type: "object" }, subagentInherits: true }],
			}).join(" "),
		).toContain("description");
	});

	test("an env block, because v1 has nowhere safe to put a secret", () => {
		expect(problemsOf({ env: { TOKEN: "x" } }).join(" ")).toContain("`env` is refused");
	});

	test("a ui block, because there is no UI extension surface", () => {
		expect(problemsOf({ ui: { pane: "x" } }).join(" ")).toContain("`ui` is refused");
	});

	test("an event payload declaring `from` — provenance is never a plugin's to set", () => {
		expect(
			problemsOf({
				events: [{ name: "e", payload: { type: "object", properties: { from: { type: "string" } } } }],
			}).join(" "),
		).toContain("provenance is stamped by the receiving desk");
	});

	test("a nested `desk` field, because nesting is not a loophole", () => {
		expect(
			problemsOf({
				events: [
					{
						name: "e",
						payload: {
							type: "object",
							properties: { body: { type: "object", properties: { desk: { type: "string" } } } },
						},
					},
				],
			}).join(" "),
		).toContain("provenance is stamped");
	});

	test("a grant naming a log the manifest never declares", () => {
		expect(
			problemsOf({
				grants: { ...good.grants, fleet: { ...good.grants.fleet, log: ["ops", "ghost"] } },
			}).join(" "),
		).toContain("ghost");
	});

	test("no tools at all: that is an MCP server, not a plugin", () => {
		expect(problemsOf({ tools: [] }).join(" ")).toContain("non-empty");
	});
});

describe("the live tool list against the manifest", () => {
	const manifest = (validateManifest(good) as { ok: true; manifest: never }).manifest as never as {
		tools: Array<{ name: string }>;
	};

	test("the same set agrees", () => {
		expect(toolListDisagreement(manifest as never, [{ name: "board_claim" }])).toEqual([]);
	});

	test("a tool the manifest promised and the plugin does not serve", () => {
		expect(toolListDisagreement(manifest as never, []).join(" ")).toContain("does not serve it");
	});

	test("a tool the plugin serves and nobody agreed to", () => {
		expect(
			toolListDisagreement(manifest as never, [{ name: "board_claim" }, { name: "rm_rf" }]).join(" "),
		).toContain("rm_rf");
	});
});
