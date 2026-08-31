import { describe, expect, test } from "bun:test";
import type { PluginManifest } from "../../shared/types";
import { pluginMay, pluginReach } from "./permission";

/**
 * One decision function, asked the three ways it will be asked: as a gate, as
 * a preview, and as a display. Prediction that can drift from enforcement will
 * drift, so the test is that all three are literally this function.
 */

const manifest: PluginManifest = {
	id: "com.example.board",
	version: "0.1.0",
	name: "Board",
	serve: { command: "bun", args: [] },
	tools: [
		{ name: "board_claim", description: "d", inputSchema: {}, subagentInherits: false },
		{ name: "board_list", description: "d", inputSchema: {}, subagentInherits: true },
	],
	logs: ["ops"],
	rpc: { serves: [] },
	events: [],
	grants: {
		room: ["desks"],
		fleet: { log: ["ops"], rpc: { call: false, serve: [] }, events: true, blobs: false },
		acceptFrom: "members",
	},
};

const installed = { pluginId: manifest.id, manifest, state: "running" as const };

describe("every refusal is distinguishable and named", () => {
	test("plugin_absent when this desk does not have it", () => {
		const verdict = pluginMay({ pluginId: "com.example.board" }, "tool.call", "board_claim");
		expect(verdict.code).toBe("plugin_absent");
		expect(verdict.reason).toContain("not installed on this desk");
	});

	test("plugin_down names the tool, which is the point", () => {
		const verdict = pluginMay(
			{ ...installed, state: "stopped" },
			"tool.call",
			"board_claim",
		);
		expect(verdict.code).toBe("plugin_down");
		expect(verdict.reason).toContain("board_claim");
	});

	test("not_declared for a tool the manifest never promised", () => {
		expect(pluginMay(installed, "tool.call", "rm_rf").code).toBe("not_declared");
	});

	test("refused when this install accepts nothing from other desks", () => {
		const closed = {
			...installed,
			manifest: { ...manifest, grants: { ...manifest.grants, acceptFrom: "none" as const } },
			fromNode: "beastie",
			fromNodeName: "beastie",
		};
		const verdict = pluginMay(closed, "fleet.events", "");
		expect(verdict.code).toBe("refused");
	});

	test("refused when the peer is not on the list", () => {
		const listed = {
			...installed,
			manifest: { ...manifest, grants: { ...manifest.grants, acceptFrom: ["mac-mini"] } },
			fromNode: "beastie",
			fromNodeName: "beastie",
		};
		expect(pluginMay(listed, "fleet.events", "").reason).toContain("beastie");
	});

	test("not_granted for a capability nobody agreed to", () => {
		expect(pluginMay(installed, "fleet.blobs", "").code).toBe("not_granted");
		expect(pluginMay(installed, "fleet.rpc.call", "").code).toBe("not_granted");
		expect(pluginMay(installed, "room.teammates", "").code).toBe("not_granted");
	});

	test("allowed says why too, so the pane can print one column", () => {
		const verdict = pluginMay(installed, "fleet.log", "ops");
		expect(verdict.allowed).toBe(true);
		expect(verdict.reason).toContain("ops");
	});
});

describe("subagent inheritance has no default", () => {
	test("a tool declared false is refused", () => {
		expect(pluginMay(installed, "tool.subagentInherit", "board_claim").allowed).toBe(false);
	});
	test("a tool declared true is allowed", () => {
		expect(pluginMay(installed, "tool.subagentInherit", "board_list").allowed).toBe(true);
	});
});

describe("the display is the same function", () => {
	test("every rung is reported, matched or not", () => {
		const rows = pluginReach(installed);
		const actions = rows.map((row) => row.action);
		expect(actions).toContain("room.teammates");
		expect(actions).toContain("fleet.blobs");
		expect(rows.find((row) => row.action === "fleet.log" && row.target === "ops")!.allowed).toBe(true);
		for (const row of rows) expect(row.reason.length).toBeGreaterThan(0);
	});

	test("a preview of a manifest nobody has installed still answers", () => {
		const rows = pluginReach({ pluginId: manifest.id, manifest, state: "installed" });
		expect(rows.find((row) => row.action === "room.desks")!.allowed).toBe(true);
	});
});
