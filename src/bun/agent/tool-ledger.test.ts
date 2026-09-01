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

/**
 * The after-the-fact half of the ledger. Its first producer was the plugin
 * proxy, which was excised for the first release; the API and these tests stay
 * because the question they answer — a supplier that arrives or goes away after
 * a session was built — is asked by every supplier Toad hosts, and the next one
 * to be hosted should find it working rather than rewrite it.
 */
describe("observation after the fact", () => {
	test("a declared row becomes verified when the agent is seen asking", () => {
		new ToolLedger("p4", "acp", "cursor")
			.declared("mcp", "Echo", "echo__shout", "handed over as a descriptor")
			.publish();
		markToolsVerified({
			personaId: "p4",
			source: "mcp",
			origin: "Echo",
			names: ["echo__shout"],
			reason: "the agent listed tools on this teammate's own endpoint",
		});
		const row = teammateTools("p4")!.rows[0]!;
		expect(row.state).toBe("verified");
		expect(row.reason).toContain("own endpoint");
	});

	test("a supplier that goes away turns its rows absent with one cause", () => {
		new ToolLedger("p5", "pi", "pi")
			.verified("mcp", "Echo", "echo__shout", "attached")
			.verified("builtin", "pi", "read", "a built-in")
			.publish();
		markToolsAbsent({
			personaId: "p5",
			source: "mcp",
			origin: "Echo",
			reason: "the Echo server is configured but not answering",
		});
		const rows = teammateTools("p5")!.rows;
		expect(rows.find((row) => row.name === "echo__shout")!.state).toBe("absent");
		// The rest of the teammate's tools are untouched.
		expect(rows.find((row) => row.name === "read")!.state).toBe("verified");
	});

	test("an observation about a teammate with no ledger is a no-op, not a throw", () => {
		expect(() =>
			markToolsVerified({
				personaId: "gone",
				source: "mcp",
				origin: "x",
				names: ["y"],
				reason: "z",
			}),
		).not.toThrow();
	});
});

describe("finding who holds a supplier's tools", () => {
	test("names every teammate whose ledger mentions it — the teardown handle", () => {
		new ToolLedger("a", "pi", "pi").verified("mcp", "Echo", "t", "attached").publish();
		new ToolLedger("b", "acp", "cursor").declared("mcp", "Echo", "t", "handed over").publish();
		new ToolLedger("c", "pi", "pi").verified("builtin", "pi", "read", "built-in").publish();
		expect(ledgersMentioning("mcp", "Echo").sort()).toEqual(["a", "b"]);
	});
});
