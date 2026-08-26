import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { TranscriptEvent } from "../../shared/types";
import {
	ensureLayout,
	transcriptPath,
	transcriptSegmentPath,
	transcriptSegmentsDir,
} from "../paths";
import { allMessages, append, compact, load, preview, recentMessages } from "./transcript";

beforeAll(() => {
	ensureLayout();
});

function user(id: string, text: string, ts = 1): TranscriptEvent {
	return { kind: "user", id, ts, text };
}

function thought(id: string, text: string, ts = 1): TranscriptEvent {
	return { kind: "thought", id, ts, text };
}

function tool(id: string, status: "pending" | "completed", ts = 1): TranscriptEvent {
	return { kind: "tool", id, ts, toolCallId: id, title: "run", status };
}

function writeJsonl(path: string, events: TranscriptEvent[]): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
}

describe("transcript segments", () => {
	test("legacy flat file reads as epoch 1", () => {
		const id = "legacy-flat";
		const flat = transcriptPath(id);
		writeJsonl(flat, [user("u1", "from the flat file")]);

		expect(load(id)).toEqual([user("u1", "from the flat file")]);
		expect(preview(id)).toEqual({ from: "me", text: "from the flat file", at: 1 });
		expect(existsSync(flat)).toBe(true);
		expect(existsSync(transcriptSegmentsDir(id))).toBe(false);
	});

	test("lazy relocation by rename keeps bytes identical", () => {
		const id = "relocate-rename";
		const original = `${JSON.stringify(user("u1", "keep these bytes"))}\n`;
		writeFileSync(transcriptPath(id), original);
		const added = user("u2", "after the move");
		append(id, added);

		expect(existsSync(transcriptPath(id))).toBe(false);
		const moved = readFileSync(transcriptSegmentPath(id, 1), "utf8");
		expect(moved.slice(0, original.length)).toBe(original);
		expect(moved.slice(original.length)).toBe(`${JSON.stringify(added)}\n`);
	});

	test("append lands in <dir>/1.jsonl", () => {
		const id = "append-segment";
		append(id, user("u1", "first write"));

		expect(existsSync(transcriptPath(id))).toBe(false);
		expect(readFileSync(transcriptSegmentPath(id, 1), "utf8")).toBe(
			`${JSON.stringify(user("u1", "first write"))}\n`,
		);
	});

	test("load folds across segments", () => {
		const id = "fold-across";
		writeJsonl(transcriptSegmentPath(id, 1), [tool("t1", "pending", 1), user("u1", "go", 2)]);
		writeJsonl(transcriptSegmentPath(id, 2), [tool("t1", "completed", 3)]);

		const events = load(id);
		expect(events.map((event) => event.id)).toEqual(["t1", "u1"]);
		expect(events[0]).toMatchObject({ kind: "tool", status: "completed" });
	});

	test("preview and recentMessages walk segments newest-first", () => {
		const id = "walk-newest";
		writeJsonl(transcriptSegmentPath(id, 1), [
			user("u1", "one", 1),
			user("u2", "two", 2),
			user("u3", "three", 3),
		]);
		writeJsonl(transcriptSegmentPath(id, 2), [user("u4", "four", 4)]);

		expect(preview(id)).toEqual({ from: "me", text: "four", at: 4 });
		expect(recentMessages(id, 3).messages.map((message) => message.text)).toEqual([
			"two",
			"three",
			"four",
		]);
		expect(allMessages(id).messages.map((message) => message.text)).toEqual([
			"one",
			"two",
			"three",
			"four",
		]);

		const quiet = "walk-quiet-tail";
		writeJsonl(transcriptSegmentPath(quiet, 1), [user("old", "hello", 1)]);
		writeJsonl(transcriptSegmentPath(quiet, 2), [thought("th1", "still thinking", 2)]);
		expect(preview(quiet)).toEqual({ from: "me", text: "hello", at: 1 });
		expect(recentMessages(quiet, 5).messages.map((message) => message.text)).toEqual(["hello"]);
	});

	test("compact touches only the current segment", () => {
		const id = "compact-current";
		writeJsonl(transcriptSegmentPath(id, 1), [
			tool("t1", "pending", 1),
			tool("t1", "completed", 2),
			user("u1", "in epoch 1", 3),
		]);
		const later = `${JSON.stringify(user("u2", "in epoch 2", 4))}\n`;
		writeFileSync(transcriptSegmentPath(id, 2), later);

		compact(id);

		expect(readFileSync(transcriptSegmentPath(id, 2), "utf8")).toBe(later);
		expect(load(id).map((event) => event.id)).toEqual(["t1", "u1", "u2"]);
		const current = load(id).filter((event) => event.id !== "u2");
		expect(readFileSync(transcriptSegmentPath(id, 1), "utf8")).toBe(
			`${current.map((event) => JSON.stringify(event)).join("\n")}\n`,
		);
		expect(current).toHaveLength(2);
	});

	test("refuses append when both the flat file and 1.jsonl exist", () => {
		const id = "both-exist";
		const flat = transcriptPath(id);
		const epoch1 = transcriptSegmentPath(id, 1);
		writeJsonl(flat, [user("flat", "legacy")]);
		writeJsonl(epoch1, [user("seg", "segment")]);
		const flatBytes = readFileSync(flat);
		const segBytes = readFileSync(epoch1);

		expect(() => append(id, user("nope", "should not land"))).toThrow(/both/);
		expect(() => compact(id)).toThrow(/both/);
		expect(readFileSync(flat)).toEqual(flatBytes);
		expect(readFileSync(epoch1)).toEqual(segBytes);
	});
});
