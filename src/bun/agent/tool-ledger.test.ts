import { beforeEach, describe, expect, test } from "bun:test";
import {
	ToolLedger,
	clearAllToolLedgers,
	ledgersMentioning,
	markToolsAbsent,
	markToolsVerified,
	teammateTools,
} from "./tool-ledger";

/**
 * The ledger's one promise: a row always says why.
 *
 * These are the assertions the three shipped silent-absence bugs would each
 * have failed — a tool gone with nothing anywhere naming it or the cause.
 */

beforeEach(() => clearAllToolLedgers());

describe("a teammate's tool ledger", () => {
	test("is null before the teammate has ever started, and says so", () => {
		expect(teammateTools("nobody")).toBeNull();
	});

	test("every row carries a reason, in every state", () => {
		new ToolLedger("p1", "pi", "pi")
			.verified("builtin", "pi", "read", "a built-in of the Toad Agent runtime")
			.declared("mcp", "Echo", "echo__shout", "handed to the backend as a descriptor")
			.absent("toad", "Toad", "hop_desk", "this Toad does not own the bridge socket")
			.publish();
		const ledger = teammateTools("p1");
		expect(ledger?.rows).toHaveLength(3);
		for (const row of ledger!.rows) expect(row.reason.length).toBeGreaterThan(0);
	});

	test("an empty reason becomes a loud one rather than an empty cell", () => {
		new ToolLedger("p2", "pi", "pi").absent("mcp", "Echo", "shout", "   ").publish();
		expect(teammateTools("p2")!.rows[0]!.reason).toContain("bug in Toad");
	});

	test("the same tool from two suppliers is two rows, not one overwritten", () => {
		new ToolLedger("p3", "pi", "pi")
			.verified("mcp", "A", "search", "from A")
			.verified("mcp", "B", "search", "from B")
			.publish();
		expect(teammateTools("p3")!.rows).toHaveLength(2);
	});
});

describe("observation after the fact", () => {
	test("a declared row becomes verified when the agent is seen asking", () => {
		new ToolLedger("p4", "acp", "cursor")
			.declared("plugin", "com.example.board", "board_claim", "handed over as a descriptor")
			.publish();
		markToolsVerified({
			personaId: "p4",
			source: "plugin",
			origin: "com.example.board",
			names: ["board_claim"],
			reason: "the agent listed tools on this teammate's own plugin endpoint",
		});
		const row = teammateTools("p4")!.rows[0]!;
		expect(row.state).toBe("verified");
		expect(row.reason).toContain("plugin endpoint");
	});

	test("a supplier that goes away turns its rows absent with one cause", () => {
		new ToolLedger("p5", "pi", "pi")
			.verified("plugin", "com.example.board", "board_claim", "attached")
			.verified("builtin", "pi", "read", "a built-in")
			.publish();
		markToolsAbsent({
			personaId: "p5",
			source: "plugin",
			origin: "com.example.board",
			reason: "the board plugin is installed but not running",
		});
		const rows = teammateTools("p5")!.rows;
		expect(rows.find((row) => row.name === "board_claim")!.state).toBe("absent");
		// The rest of the teammate's tools are untouched.
		expect(rows.find((row) => row.name === "read")!.state).toBe("verified");
	});

	test("an observation about a teammate with no ledger is a no-op, not a throw", () => {
		expect(() =>
			markToolsVerified({
				personaId: "gone",
				source: "plugin",
				origin: "x",
				names: ["y"],
				reason: "z",
			}),
		).not.toThrow();
	});
});

describe("finding who holds a supplier's tools", () => {
	test("names every teammate whose ledger mentions it — the uninstall handle", () => {
		new ToolLedger("a", "pi", "pi").verified("plugin", "com.x", "t", "attached").publish();
		new ToolLedger("b", "acp", "cursor").declared("plugin", "com.x", "t", "handed over").publish();
		new ToolLedger("c", "pi", "pi").verified("builtin", "pi", "read", "built-in").publish();
		expect(ledgersMentioning("plugin", "com.x").sort()).toEqual(["a", "b"]);
	});
});
