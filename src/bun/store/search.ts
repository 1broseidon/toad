import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ChapterEvent, ThreadSearchHit, TranscriptEvent } from "../../shared/types";
import { ROOT, ensureLayout, transcriptPath, transcriptSegmentPath } from "../paths";
import { chaptersOf, openChapter, sliceOf } from "./chapters";
import { currentEpoch } from "./records";
import * as transcript from "./transcript";

/**
 * Full-text search over every teammate's conversation, in SQLite FTS5.
 *
 * The JSONL transcript stays the record; this is an index of it, rebuilt from
 * the file whenever the two disagree, and kept current by indexing each event
 * as it is appended. Nothing in here is a source of truth, which is what makes
 * it safe to delete.
 *
 * Two things are indexed, because they answer different questions. Messages
 * answer "where did we say X". Chapters — their titles, notes and tags — are
 * summaries an agent wrote, so they answer "what was that thing we did in
 * June" even when the conversation never used the word the searcher reaches
 * for. Chapter hits come first for that reason.
 */

let db: Database | undefined;

/** Which chapter new messages for a persona belong to, so the index need not reread the file. */
const openChapters = new Map<string, string | undefined>();

function open(): Database {
	if (db) return db;
	ensureLayout();
	db = new Database(join(ROOT, "index.sqlite"), { create: true });
	db.run("PRAGMA journal_mode = WAL");
	db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS messages USING fts5(
		persona_id UNINDEXED, event_id UNINDEXED, chapter_id UNINDEXED, kind UNINDEXED, ts UNINDEXED, text,
		tokenize = 'porter unicode61'
	)`);
	db.run(`CREATE TABLE IF NOT EXISTS chapters (
		id TEXT PRIMARY KEY, persona_id TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER,
		title TEXT, note TEXT, status TEXT, session_id TEXT, backend_id TEXT
	)`);
	db.run("CREATE INDEX IF NOT EXISTS chapters_persona ON chapters(persona_id, started_at)");
	db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS chapters_fts USING fts5(
		chapter_id UNINDEXED, persona_id UNINDEXED, text, tokenize = 'porter unicode61'
	)`);
	db.run(
		"CREATE TABLE IF NOT EXISTS index_state (persona_id TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime INTEGER NOT NULL)",
	);
	return db;
}

function fileStamp(personaId: string): { size: number; mtime: number } | undefined {
	const active = transcriptSegmentPath(personaId, currentEpoch("persona", personaId));
	const file = existsSync(active) ? active : transcriptPath(personaId);
	if (!existsSync(file)) return undefined;
	const stat = statSync(file);
	return { size: stat.size, mtime: Math.round(stat.mtimeMs) };
}

function recordStamp(personaId: string): void {
	const stamp = fileStamp(personaId);
	if (!stamp) return;
	open().run(
		"INSERT INTO index_state (persona_id, size, mtime) VALUES (?, ?, ?) ON CONFLICT(persona_id) DO UPDATE SET size = excluded.size, mtime = excluded.mtime",
		[personaId, stamp.size, stamp.mtime],
	);
}

function indexMessage(personaId: string, chapterId: string | undefined, event: TranscriptEvent): void {
	if (event.kind !== "user" && event.kind !== "agent") return;
	const text = event.text.trim();
	if (!text) return;
	open().run(
		"INSERT INTO messages (persona_id, event_id, chapter_id, kind, ts, text) VALUES (?, ?, ?, ?, ?, ?)",
		[personaId, event.id, chapterId ?? null, event.kind, event.ts, text],
	);
}

function indexChapter(personaId: string, chapter: ChapterEvent): void {
	const database = open();
	database.run(
		`INSERT INTO chapters (id, persona_id, started_at, ended_at, title, note, status, session_id, backend_id)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET ended_at = excluded.ended_at, title = excluded.title, note = excluded.note,
		   status = excluded.status, session_id = excluded.session_id, backend_id = excluded.backend_id`,
		[
			chapter.id,
			personaId,
			chapter.ts,
			chapter.endedAt ?? null,
			chapter.title ?? null,
			chapter.note ?? null,
			chapter.status ?? null,
			chapter.sessionId ?? null,
			chapter.backendId,
		],
	);
	database.run("DELETE FROM chapters_fts WHERE chapter_id = ?", [chapter.id]);
	const text = [chapter.title, chapter.note, ...(chapter.tags ?? [])].filter(Boolean).join("\n");
	if (text) {
		database.run("INSERT INTO chapters_fts (chapter_id, persona_id, text) VALUES (?, ?, ?)", [
			chapter.id,
			personaId,
			text,
		]);
	}
}

/**
 * Indexes one event as it lands. A chapter marker moves the "current chapter"
 * pointer for the messages that follow it; its close updates the row in place.
 */
export function indexEvent(personaId: string, event: TranscriptEvent): void {
	try {
		if (event.kind === "chapter") {
			indexChapter(personaId, event);
			openChapters.set(personaId, event.endedAt === undefined ? event.id : undefined);
			recordStamp(personaId);
			return;
		}
		if (event.kind !== "user" && event.kind !== "agent") return;
		if (!openChapters.has(personaId)) {
			openChapters.set(personaId, openChapter(transcript.load(personaId))?.id);
		}
		// Messages are written once; a repeated id is a replay, not a change.
		const seen = open()
			.query("SELECT 1 FROM messages WHERE persona_id = ? AND event_id = ? LIMIT 1")
			.get(personaId, event.id);
		if (seen) return;
		indexMessage(personaId, openChapters.get(personaId), event);
		recordStamp(personaId);
	} catch (error) {
		console.error(`Search index: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** Throws the persona's rows away and re-reads the file. */
export function reindex(personaId: string): void {
	const database = open();
	const events = transcript.load(personaId);
	const run = database.transaction(() => {
		database.run("DELETE FROM messages WHERE persona_id = ?", [personaId]);
		database.run("DELETE FROM chapters WHERE persona_id = ?", [personaId]);
		database.run("DELETE FROM chapters_fts WHERE persona_id = ?", [personaId]);
		const chapters = chaptersOf(events);
		for (const chapter of chapters) indexChapter(personaId, chapter);
		// Messages before the first marker belong to no chapter.
		const firstMarker = events.findIndex((event) => event.kind === "chapter");
		const unchaptered = firstMarker === -1 ? events : events.slice(0, firstMarker);
		for (const event of unchaptered) indexMessage(personaId, undefined, event);
		for (const chapter of chapters) {
			for (const event of sliceOf(events, chapter)) indexMessage(personaId, chapter.id, event);
		}
		recordStamp(personaId);
	});
	run();
	openChapters.set(personaId, openChapter(events)?.id);
}

export function forget(personaId: string): void {
	try {
		const database = open();
		database.run("DELETE FROM messages WHERE persona_id = ?", [personaId]);
		database.run("DELETE FROM chapters WHERE persona_id = ?", [personaId]);
		database.run("DELETE FROM chapters_fts WHERE persona_id = ?", [personaId]);
		database.run("DELETE FROM index_state WHERE persona_id = ?", [personaId]);
		openChapters.delete(personaId);
	} catch {
		/* an index that cannot forget is rebuilt next start */
	}
}

/**
 * Brings the index in line with the files at startup. A transcript whose size
 * or mtime differs from what was last indexed — the startup fold rewrites
 * them, and a crash can leave events unindexed — is re-read whole.
 */
export function sync(personaIds: string[]): void {
	try {
		const database = open();
		for (const personaId of personaIds) {
			const stamp = fileStamp(personaId);
			if (!stamp) continue;
			const known = database
				.query<{ size: number; mtime: number }, [string]>(
					"SELECT size, mtime FROM index_state WHERE persona_id = ?",
				)
				.get(personaId);
			if (known && known.size === stamp.size && known.mtime === stamp.mtime) continue;
			reindex(personaId);
		}
	} catch (error) {
		console.error(`Search index: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/**
 * An FTS5 query from what a person typed.
 *
 * Each word becomes a quoted prefix term, so punctuation cannot reach the
 * parser and "contain" finds "container". Words are ANDed; if nothing matches
 * and there was more than one, they are ORed, because the searcher was
 * describing a memory rather than quoting it.
 */
function termsOf(query: string): string[] {
	return query
		.split(/\s+/)
		.map((word) => word.replace(/["*]/g, "").trim())
		.filter((word) => word.length > 0)
		.map((word) => `"${word}"*`);
}

const MAX_QUERY = 200;

type MessageRow = {
	event_id: string;
	chapter_id: string | null;
	kind: string;
	ts: number;
	excerpt: string;
};
type ChapterRow = {
	id: string;
	started_at: number;
	title: string | null;
	status: string | null;
	excerpt: string;
};

/**
 * Chapters first, then messages, each ranked by BM25. Results carry the ids
 * the transcript can scroll to.
 */
export function search(
	personaId: string,
	query: string,
	limit = 20,
): { hits: ThreadSearchHit[]; truncated: boolean } {
	const terms = termsOf(query.slice(0, MAX_QUERY));
	if (terms.length === 0) return { hits: [], truncated: false };
	const database = open();
	const attempt = (match: string) => {
		const chapters = database
			.query<ChapterRow, [string, string, number]>(
				`SELECT c.id, c.started_at, c.title, c.status,
				        snippet(chapters_fts, 2, '', '', '…', 24) AS excerpt
				 FROM chapters_fts JOIN chapters c ON c.id = chapters_fts.chapter_id
				 WHERE chapters_fts MATCH ? AND chapters_fts.persona_id = ?
				 ORDER BY bm25(chapters_fts) LIMIT ?`,
			)
			.all(match, personaId, limit);
		const messages = database
			.query<MessageRow, [string, string, number]>(
				`SELECT event_id, chapter_id, kind, ts, snippet(messages, 5, '', '', '…', 24) AS excerpt
				 FROM messages WHERE messages MATCH ? AND persona_id = ?
				 ORDER BY bm25(messages) LIMIT ?`,
			)
			.all(match, personaId, limit + 1);
		return { chapters, messages };
	};
	let found = attempt(terms.join(" "));
	if (found.chapters.length === 0 && found.messages.length === 0 && terms.length > 1) {
		found = attempt(terms.join(" OR "));
	}
	const hits: ThreadSearchHit[] = [
		...found.chapters.map(
			(row): ThreadSearchHit => ({
				kind: "chapter",
				chapterId: row.id,
				ts: row.started_at,
				title: row.title ?? "Untitled chapter",
				excerpt: row.excerpt,
				...(row.status ? { status: row.status } : {}),
			}),
		),
		...found.messages.slice(0, limit).map(
			(row): ThreadSearchHit => ({
				kind: "message",
				eventId: row.event_id,
				...(row.chapter_id ? { chapterId: row.chapter_id } : {}),
				ts: row.ts,
				from: row.kind === "user" ? "me" : "them",
				excerpt: row.excerpt,
			}),
		),
	];
	return { hits, truncated: found.messages.length > limit };
}

/**
 * The same search, across every teammate at once. One index already holds
 * them all — per-conversation search was a WHERE clause, and removing it is
 * the whole feature. Chapter hits still outrank messages, for the same
 * reason: a note is an agent's own summary of the thing.
 */
export function searchAll(
	query: string,
	limit = 30,
): { hits: Array<ThreadSearchHit & { personaId: string }>; truncated: boolean } {
	const terms = termsOf(query.slice(0, MAX_QUERY));
	if (terms.length === 0) return { hits: [], truncated: false };
	const database = open();
	const attempt = (match: string) => {
		const chapters = database
			.query<ChapterRow & { persona_id: string }, [string, number]>(
				`SELECT c.id, c.persona_id, c.started_at, c.title, c.status,
				        snippet(chapters_fts, 2, '', '', '…', 24) AS excerpt
				 FROM chapters_fts JOIN chapters c ON c.id = chapters_fts.chapter_id
				 WHERE chapters_fts MATCH ?
				 ORDER BY bm25(chapters_fts) LIMIT ?`,
			)
			.all(match, limit);
		const messages = database
			.query<MessageRow & { persona_id: string }, [string, number]>(
				`SELECT persona_id, event_id, chapter_id, kind, ts,
				        snippet(messages, 5, '', '', '…', 24) AS excerpt
				 FROM messages WHERE messages MATCH ?
				 ORDER BY bm25(messages) LIMIT ?`,
			)
			.all(match, limit + 1);
		return { chapters, messages };
	};
	let found = attempt(terms.join(" "));
	if (found.chapters.length === 0 && found.messages.length === 0 && terms.length > 1) {
		found = attempt(terms.join(" OR "));
	}
	const hits: Array<ThreadSearchHit & { personaId: string }> = [
		...found.chapters.map((row) => ({
			kind: "chapter" as const,
			personaId: row.persona_id,
			chapterId: row.id,
			ts: row.started_at,
			title: row.title ?? "Untitled chapter",
			excerpt: row.excerpt,
			...(row.status ? { status: row.status } : {}),
		})),
		...found.messages.slice(0, limit).map((row) => ({
			kind: "message" as const,
			personaId: row.persona_id,
			eventId: row.event_id,
			...(row.chapter_id ? { chapterId: row.chapter_id } : {}),
			ts: row.ts,
			from: row.kind === "user" ? ("me" as const) : ("them" as const),
			excerpt: row.excerpt,
		})),
	];
	return { hits, truncated: found.messages.length > limit };
}

export function close(): void {
	db?.close();
	db = undefined;
}
