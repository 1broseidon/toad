import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { appendFileSync, openSync, readSync, closeSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { ROOT, decodeFileComponent, encodeFileComponent, ensureLayout } from "../paths";
import { nodeIdentity } from "../node/identity";

/**
 * Replicated copies of other desks' append-only streams.
 *
 * This is transcript replication with one key replaced, and nothing else. The
 * key used to be `(ownerNode, personaId, epoch)`; it is now
 * `(ownerNode, streamId, gen)`, and a teammate's tape is the first client of it
 * under `streamId = persona:<id>` (see `replicas.ts`, which is that client). A
 * plugin's log is the second, under `plugin:<pluginId>/<logId>`.
 *
 * Everything the tape learned is in here unchanged, because it was all learned
 * the hard way and none of it was about transcripts:
 *
 * - a mirror is a mirror, never an authority: it lives under its owner's node
 *   id and this desk never writes a byte into it the owner did not ship
 * - a cursor is "how many bytes of each segment I hold" **plus the sha256 of
 *   exactly those bytes**, because a count cannot see a rewrite that lands at
 *   the same or a larger size
 * - an append at the wrong offset is refused with the truth, so the sender
 *   re-aims instead of this desk guessing content into a mirror
 * - deletion is owner-instructed only
 *
 * The third key component is deliberately called `gen` and never `epoch`. A
 * persona's epoch means *ownership* and rotates on a hop; a plugin log has no
 * ownership epoch and gets a generation counter minted when the log is opened.
 * One field with two meanings sharing all the code that reasons about it is a
 * comment away from a bug, and the comment will eventually be wrong.
 */

const DIR = () => join(ROOT, "streams");
/** Where mirrors lived when a mirror could only be a transcript. */
const LEGACY_DIR = () => join(ROOT, "replicas");

/** How the tape names its streams. Kept here because the migration needs it. */
export const PERSONA_STREAM_PREFIX = "persona:";

/**
 * What this desk holds per generation of one stream: how many bytes, and the
 * sha256 of exactly those bytes.
 */
export type StreamCursor = Record<string, { held: number; digest: string }>;

function guardOwner(ownerNode: string): void {
	if (!ownerNode || ownerNode.includes("/") || ownerNode.includes("..")) {
		throw new Error(`replica owner id is not a path segment: ${ownerNode}`);
	}
	if (ownerNode === nodeIdentity().id) {
		throw new Error("this desk's own transcripts and logs are not replicas");
	}
}

/**
 * A stream id may carry a `/` — `plugin:<id>/<log>` does — because it is
 * encoded into a single directory name and never walked as a path. `..` is
 * still refused: it is never a legitimate part of an id, and refusing it is
 * cheaper than proving the encoder can never be bypassed.
 */
function guardSegment(streamId: string, gen: number): void {
	if (!streamId || streamId.includes("..") || streamId.includes("\\")) {
		throw new Error(`replica stream id is not a path segment: ${streamId}`);
	}
	if (!Number.isInteger(gen) || gen < 1) {
		throw new Error(`replica generation must be a positive integer: ${gen}`);
	}
}

function streamDir(ownerNode: string, streamId: string): string {
	return join(DIR(), ownerNode, encodeFileComponent(streamId));
}

function segmentPath(ownerNode: string, streamId: string, gen: number): string {
	return join(streamDir(ownerNode, streamId), `${gen}.jsonl`);
}

/**
 * Mirrors written before streams had ids, moved once.
 *
 * `ROOT/replicas/<owner>/<personaId>` becomes
 * `ROOT/streams/<owner>/persona%3A<personaId>`. Skipping this would not
 * corrupt anything — a mirror the cursor exchange cannot see re-ships from
 * zero, which is correct — but it would re-ship every tape in the room on one
 * upgrade and leave the old bytes on disk forever.
 */
let migrated = false;
function migrateLegacyReplicas(): void {
	if (migrated) return;
	migrated = true;
	const legacy = LEGACY_DIR();
	if (!existsSync(legacy)) return;
	try {
		for (const owner of readdirSync(legacy)) {
			if (owner.startsWith(".")) continue;
			const ownerDir = join(legacy, owner);
			if (!statSync(ownerDir).isDirectory()) continue;
			for (const personaId of readdirSync(ownerDir)) {
				if (personaId.startsWith(".")) continue;
				const target = streamDir(owner, `${PERSONA_STREAM_PREFIX}${decodeFileComponent(personaId)}`);
				if (existsSync(target)) continue;
				mkdirSync(join(DIR(), owner), { recursive: true });
				renameSync(join(ownerDir, personaId), target);
			}
			rmSync(ownerDir, { recursive: true, force: true });
		}
		rmSync(legacy, { recursive: true, force: true });
	} catch {
		/* A half-finished move is safe: what moved is found under its stream id
		 * and what did not is re-shipped from zero. Failing loudly here would
		 * take down boot over a directory nobody has read from yet. */
	}
}

/** Test seam: run the legacy move again against a directory a test just built. */
export function resetStreamMigrationForTests(): void {
	migrated = false;
}

/** What this desk holds of one stream, by generation. */
export function streamCursor(ownerNode: string, streamId: string): StreamCursor {
	guardOwner(ownerNode);
	guardSegment(streamId, 1);
	migrateLegacyReplicas();
	const dir = streamDir(ownerNode, streamId);
	const cursor: StreamCursor = {};
	if (!existsSync(dir)) return cursor;
	for (const name of readdirSync(dir)) {
		const match = /^([1-9]\d*)\.jsonl$/.exec(name);
		if (!match) continue;
		const data = readFileSync(join(dir, name));
		cursor[match[1]!] = {
			held: data.length,
			digest: createHash("sha256").update(data).digest("hex"),
		};
	}
	return cursor;
}

/** Every stream this desk holds a mirror of, per owner, by stream id. */
export function streamHoldings(ownerNode: string): string[] {
	guardOwner(ownerNode);
	migrateLegacyReplicas();
	const dir = join(DIR(), ownerNode);
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => !name.startsWith("."))
		.map((name) => decodeFileComponent(name));
}

/** Every desk this one holds any mirror of. The uninstall sweep's entry point. */
export function streamOwners(): string[] {
	migrateLegacyReplicas();
	const dir = DIR();
	if (!existsSync(dir)) return [];
	const self = nodeIdentity().id;
	return readdirSync(dir).filter((name) => !name.startsWith(".") && name !== self);
}

/**
 * Appends owner-shipped bytes at the offset they were cut. An offset that is
 * not exactly the bytes held means a gap or a replay — both are answered by
 * refusing, so the cursor exchange re-ships from the true offset instead of
 * this desk guessing content into a mirror.
 */
export function streamAppend(
	ownerNode: string,
	streamId: string,
	gen: number,
	offset: number,
	bytes: Uint8Array,
): { ok: true } | { ok: false; held: number } {
	guardOwner(ownerNode);
	guardSegment(streamId, gen);
	ensureLayout();
	migrateLegacyReplicas();
	const path = segmentPath(ownerNode, streamId, gen);
	const held = existsSync(path) ? statSync(path).size : 0;
	if (offset !== held) return { ok: false, held };
	mkdirSync(streamDir(ownerNode, streamId), { recursive: true });
	appendFileSync(path, bytes);
	return { ok: true };
}

/**
 * Drops one mirrored segment because its owner said to. This is the only
 * deletion here that content can cause, and it is owner-instructed: the owner
 * rewrote that generation's history, so the bytes held mirror nothing anymore
 * — the owner re-ships from zero right behind the reset, and the mirror
 * invariant "holds only what the owner shipped" carries straight through.
 */
export function streamReset(ownerNode: string, streamId: string, gen: number): void {
	guardOwner(ownerNode);
	guardSegment(streamId, gen);
	migrateLegacyReplicas();
	rmSync(segmentPath(ownerNode, streamId, gen), { force: true });
}

/**
 * Drops every generation of one mirrored stream, because the thing that owned
 * it is gone — an uninstalled plugin, here or on the owner. Not owner-shipped
 * content being deleted; a whole stream ceasing to have a reason to exist.
 */
export function streamRetire(ownerNode: string, streamId: string): boolean {
	guardOwner(ownerNode);
	guardSegment(streamId, 1);
	migrateLegacyReplicas();
	const dir = streamDir(ownerNode, streamId);
	if (!existsSync(dir)) return false;
	rmSync(dir, { recursive: true, force: true });
	return true;
}

/** Where one mirrored segment lives, for the hop's promotion — which renames
 *  the file into the persona's own tape rather than copying through memory. */
export function streamSegmentFile(ownerNode: string, streamId: string, gen: number): string {
	guardOwner(ownerNode);
	guardSegment(streamId, gen);
	migrateLegacyReplicas();
	return segmentPath(ownerNode, streamId, gen);
}

/**
 * Adopts this desk's former segment as a mirror of the new owner — the hop's
 * demotion, the mirror invariant's one deliberate exception. The bytes did not
 * arrive on a wire, but they are exactly what the new owner promoted
 * byte-identically before it claimed, so "holds only what the owner shipped" is
 * true of them in substance; any drift the move could hide is caught by the
 * same cursor fingerprints that catch a rewrite, on the next exchange.
 */
export function streamAdopt(
	ownerNode: string,
	streamId: string,
	gen: number,
	sourcePath: string,
): void {
	guardOwner(ownerNode);
	guardSegment(streamId, gen);
	ensureLayout();
	migrateLegacyReplicas();
	mkdirSync(streamDir(ownerNode, streamId), { recursive: true });
	renameSync(sourcePath, segmentPath(ownerNode, streamId, gen));
}

/** Reads a byte range of one mirrored segment, for serving or verification. */
export function streamRead(
	ownerNode: string,
	streamId: string,
	gen: number,
	offset: number,
	length: number,
): Uint8Array {
	guardOwner(ownerNode);
	guardSegment(streamId, gen);
	migrateLegacyReplicas();
	return readFileRange(segmentPath(ownerNode, streamId, gen), offset, length);
}

/** The one range read both sides of replication use, mirror or original. */
export function readFileRange(path: string, offset: number, length: number): Uint8Array {
	if (!existsSync(path)) return new Uint8Array(0);
	const fd = openSync(path, "r");
	try {
		const buffer = Buffer.alloc(Math.max(0, length));
		const read = readSync(fd, buffer, 0, buffer.length, offset);
		return buffer.subarray(0, read);
	} finally {
		closeSync(fd);
	}
}

/**
 * The mirror's recent lines, newest-last, folded the way the live transcript
 * store folds: a superseded event id keeps only its last occurrence, so a tool
 * card that went pending→completed is one entry and not a history of its own
 * edits. A torn tail line is the shipping cut mid-record; the next delta
 * completes it and until then it does not exist.
 */
export function streamLines(
	ownerNode: string,
	streamId: string,
	limit: number,
): Array<Record<string, unknown>> {
	guardOwner(ownerNode);
	guardSegment(streamId, 1);
	const cursor = streamCursor(ownerNode, streamId);
	const gens = Object.keys(cursor)
		.map(Number)
		.sort((a, b) => a - b);
	const folded = new Map<string, Record<string, unknown>>();
	for (const gen of gens) {
		const raw = readFileSync(segmentPath(ownerNode, streamId, gen), "utf8");
		for (const line of raw.split("\n")) {
			if (!line.trim()) continue;
			try {
				const event = JSON.parse(line) as Record<string, unknown>;
				const id = typeof event.id === "string" ? event.id : `${gen}:${folded.size}`;
				folded.delete(id);
				folded.set(id, event);
			} catch {
				// A torn tail line does not exist until its delta completes it.
			}
		}
	}
	const events = [...folded.values()];
	return events.slice(Math.max(0, events.length - limit));
}
