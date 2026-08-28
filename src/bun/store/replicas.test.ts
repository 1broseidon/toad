import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
	replicaAppend,
	replicaCursor,
	replicaHoldings,
	replicaMessages,
	replicaRead,
	replicaReset,
} from "./replicas";

const OWNER = "aaaa1111bbbb2222";
const line = (id: string, text: string) => `${JSON.stringify({ id, kind: "agent", text })}\n`;
const bytes = (s: string) => new TextEncoder().encode(s);
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

describe("transcript replicas", () => {
	test("appends at the held offset, refuses gaps and replays with the truth", () => {
		const first = line("e1", "hello");
		expect(replicaAppend(OWNER, "p-offsets", 1, 0, bytes(first))).toEqual({ ok: true });
		// A replay of offset 0 is refused and answered with what is held.
		expect(replicaAppend(OWNER, "p-offsets", 1, 0, bytes(first))).toEqual({
			ok: false,
			held: first.length,
		});
		// A gap is refused the same way — the cursor exchange re-ships.
		expect(replicaAppend(OWNER, "p-offsets", 1, first.length + 10, bytes("x"))).toEqual({
			ok: false,
			held: first.length,
		});
		const second = line("e2", "world");
		expect(replicaAppend(OWNER, "p-offsets", 1, first.length, bytes(second))).toEqual({ ok: true });
		// The cursor fingerprints exactly the bytes held, so the owner can
		// verify the mirror instead of trusting the byte count alone.
		expect(replicaCursor(OWNER, "p-offsets")).toEqual({
			"1": { held: first.length + second.length, digest: sha256(first + second) },
		});
	});

	test("cursor spans epochs and holdings list personas", () => {
		replicaAppend(OWNER, "p-epochs", 1, 0, bytes(line("a", "one")));
		replicaAppend(OWNER, "p-epochs", 2, 0, bytes(line("b", "two")));
		const cursor = replicaCursor(OWNER, "p-epochs");
		expect(Object.keys(cursor).sort()).toEqual(["1", "2"]);
		expect(replicaHoldings(OWNER)).toContain("p-epochs");
	});

	test("a torn tail line does not exist until its delta completes it", () => {
		const whole = line("t1", "complete");
		const torn = `{"id":"t2","kind":"agent","te`;
		replicaAppend(OWNER, "p-torn", 1, 0, bytes(whole + torn));
		expect(replicaMessages(OWNER, "p-torn", 10).map((event) => event.id)).toEqual(["t1"]);
		// The completing delta lands at the byte offset, mid-line, and the
		// record springs into existence.
		const rest = `xt":"finished"}\n`;
		const held = (whole + torn).length;
		expect(replicaAppend(OWNER, "p-torn", 1, held, bytes(rest))).toEqual({ ok: true });
		expect(replicaMessages(OWNER, "p-torn", 10).map((event) => event.id)).toEqual(["t1", "t2"]);
	});

	test("folding keeps the last occurrence of a superseded event", () => {
		const pending = `${JSON.stringify({ id: "tool-1", kind: "tool", state: "pending" })}\n`;
		const done = `${JSON.stringify({ id: "tool-1", kind: "tool", state: "completed" })}\n`;
		replicaAppend(OWNER, "p-fold", 1, 0, bytes(pending));
		replicaAppend(OWNER, "p-fold", 1, pending.length, bytes(done));
		const events = replicaMessages(OWNER, "p-fold", 10);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ id: "tool-1", state: "completed" });
	});

	test("reads back exactly the bytes shipped", () => {
		const content = line("r1", "read me");
		replicaAppend(OWNER, "p-read", 1, 0, bytes(content));
		const read = replicaRead(OWNER, "p-read", 1, 0, content.length);
		expect(new TextDecoder().decode(read)).toBe(content);
	});

	test("an owner-instructed reset drops the segment so a re-ship starts from zero", () => {
		replicaAppend(OWNER, "p-reset", 1, 0, bytes(line("old", "rewritten away")));
		replicaAppend(OWNER, "p-reset", 2, 0, bytes(line("keep", "other epoch")));
		replicaReset(OWNER, "p-reset", 1);
		// Only the reset epoch is gone; the re-shipped history lands at zero.
		expect(Object.keys(replicaCursor(OWNER, "p-reset"))).toEqual(["2"]);
		const fresh = line("new", "compacted");
		expect(replicaAppend(OWNER, "p-reset", 1, 0, bytes(fresh))).toEqual({ ok: true });
		expect(replicaCursor(OWNER, "p-reset")["1"]).toEqual({
			held: fresh.length,
			digest: sha256(fresh),
		});
		// Resetting what is not held is a no-op, not an error.
		replicaReset(OWNER, "p-reset", 7);
	});

	test("this desk's own transcripts are not replicas, and ids stay path-shaped", () => {
		const { nodeIdentity } = require("../node/identity");
		expect(() => replicaAppend(nodeIdentity().id, "p", 1, 0, bytes("x"))).toThrow(/own transcripts/);
		expect(() => replicaAppend(OWNER, "../escape", 1, 0, bytes("x"))).toThrow(/path segment/);
		expect(() => replicaAppend("../up", "p", 1, 0, bytes("x"))).toThrow(/path segment/);
		expect(() => replicaAppend(OWNER, "p", 0, 0, bytes("x"))).toThrow(/positive integer/);
		expect(() => replicaReset(nodeIdentity().id, "p", 1)).toThrow(/own transcripts/);
		expect(() => replicaReset(OWNER, "../escape", 1)).toThrow(/path segment/);
		expect(() => replicaReset(OWNER, "p", 0)).toThrow(/positive integer/);
	});
});
