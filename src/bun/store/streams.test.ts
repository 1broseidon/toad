import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { ROOT } from "../paths";
import { nodeIdentity } from "../node/identity";
import {
	PERSONA_STREAM_PREFIX,
	resetStreamMigrationForTests,
	streamAppend,
	streamCursor,
	streamHoldings,
	streamLines,
	streamOwners,
	streamRead,
	streamReset,
	streamRetire,
} from "./streams";
import { replicaCursor, replicaMessages } from "./replicas";

const OWNER = "cccc3333dddd4444";
const LOG = "other:com.example.board/ops";
const line = (id: string, text: string) => `${JSON.stringify({ id, kind: "op", text })}\n`;
const bytes = (s: string) => new TextEncoder().encode(s);
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

describe("the stream store under a non-persona key", () => {
	test("a stream id carrying a colon and a slash is one directory, not a path", () => {
		const first = line("o1", "claim");
		expect(streamAppend(OWNER, LOG, 1, 0, bytes(first))).toEqual({ ok: true });
		expect(streamCursor(OWNER, LOG)).toEqual({
			"1": { held: first.length, digest: sha256(first) },
		});
		// Round-trips through the encoding: what went in is what comes back out.
		expect(streamHoldings(OWNER)).toContain(LOG);
		expect(new TextDecoder().decode(streamRead(OWNER, LOG, 1, 0, first.length))).toBe(first);
	});

	test("generations are independent and reset is per generation", () => {
		streamAppend(OWNER, "other:com.example.board/gens", 1, 0, bytes(line("a", "one")));
		streamAppend(OWNER, "other:com.example.board/gens", 2, 0, bytes(line("b", "two")));
		expect(Object.keys(streamCursor(OWNER, "other:com.example.board/gens")).sort()).toEqual([
			"1",
			"2",
		]);
		streamReset(OWNER, "other:com.example.board/gens", 1);
		expect(Object.keys(streamCursor(OWNER, "other:com.example.board/gens"))).toEqual(["2"]);
	});

	test("retiring a stream removes every generation of it, and says whether it did", () => {
		streamAppend(OWNER, "other:com.example.board/gone", 1, 0, bytes(line("x", "one")));
		streamAppend(OWNER, "other:com.example.board/gone", 2, 0, bytes(line("y", "two")));
		expect(streamRetire(OWNER, "other:com.example.board/gone")).toBe(true);
		expect(streamCursor(OWNER, "other:com.example.board/gone")).toEqual({});
		// A stream nobody holds is not an error; it is a `false`, so an uninstall
		// can report which desks actually had something to delete.
		expect(streamRetire(OWNER, "other:com.example.board/gone")).toBe(false);
	});

	test("folding and the torn tail behave for a log exactly as for a tape", () => {
		const whole = line("t1", "complete");
		const torn = `{"id":"t2","kind":"op","te`;
		streamAppend(OWNER, "other:com.example.board/torn", 1, 0, bytes(whole + torn));
		expect(streamLines(OWNER, "other:com.example.board/torn", 10).map((e) => e.id)).toEqual(["t1"]);
		streamAppend(
			OWNER,
			"other:com.example.board/torn",
			1,
			(whole + torn).length,
			bytes(`xt":"finished"}\n`),
		);
		expect(streamLines(OWNER, "other:com.example.board/torn", 10).map((e) => e.id)).toEqual([
			"t1",
			"t2",
		]);
	});

	test("the owners list names every desk mirrored here and never this one", () => {
		streamAppend(OWNER, LOG, 1, line("o1", "claim").length, bytes(line("o2", "more")));
		expect(streamOwners()).toContain(OWNER);
		expect(streamOwners()).not.toContain(nodeIdentity().id);
	});

	test("the guards refuse a traversal, a self-owner and a zero generation", () => {
		expect(() => streamAppend(nodeIdentity().id, LOG, 1, 0, bytes("x"))).toThrow(/own transcripts/);
		expect(() => streamAppend(OWNER, "other:../escape", 1, 0, bytes("x"))).toThrow(/path segment/);
		expect(() => streamAppend("../up", LOG, 1, 0, bytes("x"))).toThrow(/path segment/);
		expect(() => streamAppend(OWNER, LOG, 0, 0, bytes("x"))).toThrow(/positive integer/);
	});
});

describe("mirrors written before streams had ids", () => {
	test("a legacy replica directory becomes the persona stream, once", () => {
		const legacyOwner = "eeee5555ffff6666";
		const personaId = "legacy-persona";
		const content = line("old", "written by 0.3.8");
		mkdirSync(join(ROOT, "replicas", legacyOwner, personaId), { recursive: true });
		writeFileSync(join(ROOT, "replicas", legacyOwner, personaId, "1.jsonl"), content);
		resetStreamMigrationForTests();

		// Read through the tape's own client — the point of the move is that the
		// transcript path finds its bytes again without re-shipping them.
		expect(replicaCursor(legacyOwner, personaId)).toEqual({
			"1": { held: content.length, digest: sha256(content) },
		});
		expect(replicaMessages(legacyOwner, personaId, 10).map((e) => e.id)).toEqual(["old"]);
		expect(streamHoldings(legacyOwner)).toEqual([`${PERSONA_STREAM_PREFIX}${personaId}`]);
	});
});
