import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { openSync, readSync, closeSync } from "node:fs";
import type { Preview, TranscriptEvent } from "../../shared/types";
import {
	ensureLayout,
	transcriptPath,
	transcriptSegmentPath,
	transcriptSegmentsDir,
} from "../paths";
import { currentEpoch } from "./records";

/**
 * Append-only JSONL, one segment per (persona, ownerEpoch).
 *
 * The legacy flat file is the epoch-1 segment until the first write relocates
 * it by rename. Readers treat the two as the same tape. Some events mutate
 * after they are written: a tool call moves from pending to completed, a
 * permission request gets answered. Rather than rewrite history, later lines
 * with the same `id` supersede earlier ones, and `load` folds them together
 * across every segment on replay.
 */

type Segment = { epoch: number; path: string; size: number };

function parseLines(lines: string[]): TranscriptEvent[] {
	const events: TranscriptEvent[] = [];
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			events.push(JSON.parse(trimmed) as TranscriptEvent);
		} catch {
			// a torn final line from an unclean exit
		}
	}
	return events;
}

function fold(events: TranscriptEvent[]): TranscriptEvent[] {
	const order: string[] = [];
	const byId = new Map<string, TranscriptEvent>();
	for (const event of events) {
		if (!byId.has(event.id)) order.push(event.id);
		byId.set(event.id, event);
	}
	return order.map((id) => byId.get(id)!).filter(Boolean);
}

/**
 * Every on-disk segment, oldest epoch first. The legacy flat file counts as
 * epoch 1 when `1.jsonl` is not already there — readers must not guess if
 * both exist; writers refuse instead.
 */
function segmentsOf(personaId: string): Segment[] {
	const found: Segment[] = [];
	const dir = transcriptSegmentsDir(personaId);
	if (existsSync(dir)) {
		for (const name of readdirSync(dir)) {
			const match = /^([1-9]\d*)\.jsonl$/.exec(name);
			if (!match) continue;
			const epoch = Number(match[1]);
			const path = transcriptSegmentPath(personaId, epoch);
			found.push({ epoch, path, size: statSync(path).size });
		}
	}
	const flat = transcriptPath(personaId);
	if (existsSync(flat) && !found.some((segment) => segment.epoch === 1)) {
		found.push({ epoch: 1, path: flat, size: statSync(flat).size });
	}
	found.sort((a, b) => a.epoch - b.epoch);
	return found;
}

function logicalSize(segments: Segment[]): number {
	return segments.reduce((total, segment) => total + segment.size, 0);
}

/**
 * Relocates the legacy flat file if needed, then returns the segment this
 * node may write: the one for `currentEpoch`, 1 when the record is absent.
 */
function writableSegment(personaId: string): string {
	ensureLayout();
	const flat = transcriptPath(personaId);
	const epoch1 = transcriptSegmentPath(personaId, 1);
	if (existsSync(flat) && existsSync(epoch1)) {
		throw new Error(
			`Refusing to write transcript for ${personaId}: both ${flat} and ${epoch1} exist.`,
		);
	}
	if (existsSync(flat)) {
		mkdirSync(transcriptSegmentsDir(personaId), { recursive: true });
		renameSync(flat, epoch1);
	}
	mkdirSync(transcriptSegmentsDir(personaId), { recursive: true });
	return transcriptSegmentPath(personaId, currentEpoch("persona", personaId));
}

export function append(personaId: string, event: TranscriptEvent): void {
	appendFileSync(writableSegment(personaId), `${JSON.stringify(event)}\n`, "utf8");
}

export function load(personaId: string): TranscriptEvent[] {
	const events: TranscriptEvent[] = [];
	for (const segment of segmentsOf(personaId)) {
		events.push(...parseLines(readFileSync(segment.path, "utf8").split("\n")));
	}
	return fold(events);
}

/* How far back to look for the last thing said. A message is the last line in a
 * transcript far more often than not, and a teammate that has spent the last
 * 64KB on tool calls alone has nothing worth previewing anyway. */
const TAIL_BYTES = 64 * 1024;

/**
 * The last `window` bytes of the logical tape — segments concatenated in
 * epoch order. Starts at the end of the highest-epoch non-empty segment and
 * walks into earlier ones only while the window still needs bytes.
 */
function readTailLogical(segments: Segment[], window: number): TranscriptEvent[] {
	const size = logicalSize(segments);
	if (size === 0 || window <= 0) return [];
	const length = Math.min(size, window);

	let remaining = length;
	const parts: Buffer[] = [];
	let startedMid = false;
	for (let index = segments.length - 1; index >= 0 && remaining > 0; index--) {
		const segment = segments[index]!;
		if (segment.size === 0) continue;
		const take = Math.min(segment.size, remaining);
		const offset = segment.size - take;
		const buffer = Buffer.alloc(take);
		const handle = openSync(segment.path, "r");
		try {
			readSync(handle, buffer, 0, take, offset);
		} finally {
			closeSync(handle);
		}
		parts.unshift(buffer);
		// The last segment we touch is the oldest in the window. A read that
		// does not start at that file's byte 0 can land mid-line.
		startedMid = offset > 0;
		remaining -= take;
	}

	const lines = Buffer.concat(parts).toString("utf8").split("\n");
	return parseLines(startedMid ? lines.slice(1) : lines);
}

/**
 * The last thing either side said, for the roster to show under a name.
 *
 * Reads the end of the tape rather than the whole of it: this runs for every
 * teammate at startup, and a transcript is only bounded by how much has been
 * said.
 */
export function preview(personaId: string): Preview | null {
	const segments = segmentsOf(personaId);
	if (logicalSize(segments) === 0) return null;
	const events = readTailLogical(segments, TAIL_BYTES);
	for (let index = events.length - 1; index >= 0; index--) {
		const event = events[index]!;
		if (event.kind === "user" || event.kind === "agent") {
			return { from: event.kind === "user" ? "me" : "them", text: event.text, at: event.ts };
		}
	}
	return null;
}

type Message = Extract<TranscriptEvent, { kind: "user" | "agent" }>;

function isMessage(event: TranscriptEvent): event is Message {
	return event.kind === "user" || event.kind === "agent";
}

/**
 * The most recent `limit` user/agent messages, for a teammate reading
 * another's conversation over the MCP bridge.
 *
 * Deliberately not `load`: that folds tool/permission events that mutate in
 * place by id, which messages never do — each is written once and stands
 * forever — so no fold is needed here. Instead this reads from the end of
 * the tape, doubling the window backward only if it doesn't yet have
 * `limit` messages, so a request for "the last 30" costs roughly 30
 * messages' worth of I/O even when the full history is enormous, rather
 * than the size of everything that teammate has ever said or done. That
 * matters because this runs synchronously on the single process that also
 * owns the bridge socket for every other teammate: an unbounded read here
 * would stall all of them, not just the one being read.
 */
export function recentMessages(personaId: string, limit: number): { messages: Message[]; truncated: boolean } {
	const segments = segmentsOf(personaId);
	const size = logicalSize(segments);
	if (size === 0) return { messages: [], truncated: false };

	let window = Math.min(size, TAIL_BYTES);
	for (;;) {
		const matched = readTailLogical(segments, window).filter(isMessage);
		if (matched.length >= limit || window >= size) {
			return { messages: matched.slice(-limit), truncated: matched.length > limit || window < size };
		}
		window = Math.min(size, window * 4);
	}
}

/* A full-text search still has to look at everything that could match, but
 * this caps how much of a single enormous history it will scan before
 * giving up on anything older, for the same reason `recentMessages` bounds
 * its own read: this runs synchronously against every teammate's file, one
 * at a time, on the process that also owns the bridge socket. */
const SEARCH_CAP_BYTES = 8 * 1024 * 1024;

/**
 * Every user/agent message within the search cap, oldest first, for
 * full-text search across a teammate's conversation. See `recentMessages`
 * for why this skips `load`'s id-folding.
 */
export function allMessages(personaId: string): { messages: Message[]; truncated: boolean } {
	const segments = segmentsOf(personaId);
	const size = logicalSize(segments);
	if (size === 0) return { messages: [], truncated: false };
	const window = Math.min(size, SEARCH_CAP_BYTES);
	return { messages: readTailLogical(segments, window).filter(isMessage), truncated: window < size };
}

/** Rewrites the current-epoch segment with folded history. Older segments stay put. */
export function compact(personaId: string): void {
	const file = writableSegment(personaId);
	if (!existsSync(file)) return;
	const events = fold(parseLines(readFileSync(file, "utf8").split("\n")));
	if (events.length === 0) return;
	writeFileSync(file, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");
}
