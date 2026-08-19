import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { openSync, readSync, closeSync } from "node:fs";
import type { Preview, TranscriptEvent } from "../../shared/types";
import { ensureLayout, transcriptPath } from "../paths";

/**
 * Append-only JSONL, one file per persona.
 *
 * Some events mutate after they are written: a tool call moves from pending to
 * completed, a permission request gets answered. Rather than rewrite history,
 * later lines with the same `id` supersede earlier ones, and `load` folds them
 * together on replay.
 */
export function append(personaId: string, event: TranscriptEvent): void {
	ensureLayout();
	appendFileSync(transcriptPath(personaId), `${JSON.stringify(event)}\n`, "utf8");
}

export function load(personaId: string): TranscriptEvent[] {
	const file = transcriptPath(personaId);
	if (!existsSync(file)) return [];

	const order: string[] = [];
	const byId = new Map<string, TranscriptEvent>();

	for (const line of readFileSync(file, "utf8").split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let event: TranscriptEvent;
		try {
			event = JSON.parse(trimmed) as TranscriptEvent;
		} catch {
			continue; // a torn final line from an unclean exit
		}
		if (!byId.has(event.id)) order.push(event.id);
		byId.set(event.id, event);
	}

	return order.map((id) => byId.get(id)!).filter(Boolean);
}

/* How far back to look for the last thing said. A message is the last line in a
 * transcript far more often than not, and a teammate that has spent the last
 * 64KB on tool calls alone has nothing worth previewing anyway. */
const TAIL_BYTES = 64 * 1024;

/** The last `window` bytes of `file`, parsed into events, oldest first. */
function readTail(file: string, size: number, window: number): TranscriptEvent[] {
	const length = Math.min(size, window);
	const buffer = Buffer.alloc(length);
	const handle = openSync(file, "r");
	try {
		readSync(handle, buffer, 0, length, size - length);
	} finally {
		closeSync(handle);
	}
	const lines = buffer.toString("utf8").split("\n");
	// A read that doesn't start at byte 0 can land mid-line; drop that leading
	// partial line rather than mis-parse it. A read of the whole file has
	// nothing before it to be a fragment of, so nothing to drop.
	const usable = length < size ? lines.slice(1) : lines;
	const events: TranscriptEvent[] = [];
	for (const line of usable) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			events.push(JSON.parse(trimmed) as TranscriptEvent);
		} catch {
			// torn line, ignore
		}
	}
	return events;
}

/**
 * The last thing either side said, for the roster to show under a name.
 *
 * Reads the end of the file rather than the whole of it: this runs for every
 * teammate at startup, and a transcript is only bounded by how much has been
 * said.
 */
export function preview(personaId: string): Preview | null {
	const file = transcriptPath(personaId);
	if (!existsSync(file)) return null;
	const size = statSync(file).size;
	const events = readTail(file, size, TAIL_BYTES);
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
 * the file, doubling the window backward only if it doesn't yet have
 * `limit` messages, so a request for "the last 30" costs roughly 30
 * messages' worth of I/O even when the full history is enormous, rather
 * than the size of everything that teammate has ever said or done. That
 * matters because this runs synchronously on the single process that also
 * owns the bridge socket for every other teammate: an unbounded read here
 * would stall all of them, not just the one being read.
 */
export function recentMessages(personaId: string, limit: number): { messages: Message[]; truncated: boolean } {
	const file = transcriptPath(personaId);
	if (!existsSync(file)) return { messages: [], truncated: false };
	const size = statSync(file).size;

	let window = Math.min(size, TAIL_BYTES);
	for (;;) {
		const matched = readTail(file, size, window).filter(isMessage);
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
	const file = transcriptPath(personaId);
	if (!existsSync(file)) return { messages: [], truncated: false };
	const size = statSync(file).size;
	const window = Math.min(size, SEARCH_CAP_BYTES);
	return { messages: readTail(file, size, window).filter(isMessage), truncated: window < size };
}

/** Rewrites the file with folded history. Called on startup to bound growth. */
export function compact(personaId: string): void {
	const events = load(personaId);
	if (events.length === 0) return;
	writeFileSync(
		transcriptPath(personaId),
		`${events.map((e) => JSON.stringify(e)).join("\n")}\n`,
		"utf8",
	);
}
