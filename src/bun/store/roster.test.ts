import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../paths";
import { applyRosterOrder, mergeRosterRank, rosterOrder, saveRosterOrder } from "./roster";

const ROSTER_FILE = join(ROOT, "roster.json");

function readOrderFile(): { order: unknown } {
	return JSON.parse(readFileSync(ROSTER_FILE, "utf8")) as { order: unknown };
}

describe("roster order keys", () => {
	test("saveRosterOrder strips and dedupes to bare ids", () => {
		saveRosterOrder(["node/abc", "local", "node/abc"]);
		const written = readOrderFile();
		expect(written.order).toEqual(["abc", "local"]);
		expect(readFileSync(ROSTER_FILE, "utf8")).not.toContain("/");
	});

	test("rosterOrder heals a legacy qualified file to bare ids", () => {
		writeFileSync(ROSTER_FILE, `${JSON.stringify({ order: ["a2acf878/47af-uuid", "local"] })}\n`);
		expect(rosterOrder()).toEqual(["47af-uuid", "local"]);
	});

	test("applyRosterOrder ranks a qualified persona by its bare id", () => {
		saveRosterOrder(["abc", "local"]);
		const sorted = applyRosterOrder([{ id: "other" }, { id: "local" }, { id: "node/abc" }]);
		expect(sorted.map((row) => row.id)).toEqual(["node/abc", "local", "other"]);
	});

	test("mergeRosterRank lists new ids first and keeps the rest", () => {
		saveRosterOrder(["a", "b"]);
		mergeRosterRank(["c"]);
		expect(rosterOrder()).toEqual(["c", "a", "b"]);
	});
});
