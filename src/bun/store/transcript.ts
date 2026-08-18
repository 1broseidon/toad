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

/**
 * The last thing either side said, for the roster to show under a name.
 *
 * Reads the end of the file rather than the whole of it: this runs for every
 * teammate at startup, and a transcript is only bounded by how much has been
 * said. Reading from an arbitrary offset can land mid-line, which is the same
 * torn-line case `load` already tolerates.
 */
export function preview(personaId: string): Preview | null {
	const file = transcriptPath(personaId);
	if (!existsSync(file)) return null;

	const size = statSync(file).size;
	const length = Math.min(size, TAIL_BYTES);
	const buffer = Buffer.alloc(length);
	const handle = openSync(file, "r");
	try {
		readSync(handle, buffer, 0, length, size - length);
	} finally {
		closeSync(handle);
	}

	const lines = buffer.toString("utf8").split("\n");
	for (let index = lines.length - 1; index >= 0; index--) {
		const trimmed = lines[index]!.trim();
		if (!trimmed) continue;
		let event: TranscriptEvent;
		try {
			event = JSON.parse(trimmed) as TranscriptEvent;
		} catch {
			continue;
		}
		if (event.kind === "user" || event.kind === "agent") {
			return { from: event.kind === "user" ? "me" : "them", text: event.text, at: event.ts };
		}
	}
	return null;
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
