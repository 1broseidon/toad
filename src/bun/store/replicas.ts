import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { appendFileSync, openSync, readSync, closeSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { ROOT, ensureLayout } from "../paths";
import { nodeIdentity } from "../node/identity";

/**
 * Replicated copies of other desks' transcripts, so the room can still read
 * a teammate's history when the desk it lives on is dark.
 *
 * A replica is a mirror, never an authority. It lives under its owner's node
 * id, apart from this desk's own transcripts, and this desk never writes a
 * line of content into it that the owner did not ship. The unit of
 * replication is the transcript's own on-disk unit: epoch segments. A closed
 * epoch is immutable and ships once; the open epoch is append-only and ships
 * as byte-offset deltas, so a cursor is nothing more than "how many bytes of
 * each segment I hold" — comparable, resumable, and impossible to conflict.
 *
 * Reading a replica is reading history the agent that lived it may never
 * have seen persisted here. The read path marks it as such — the same
 * honesty rule as Restored/Fresh: a mirror must not pretend to be a memory.
 */

const DIR = () => join(ROOT, "replicas");

/**
 * What this desk holds per epoch of one persona's replica: how many bytes,
 * and the sha256 of exactly those bytes. The count alone cannot see a
 * rewrite that lands at the same or a larger size; the fingerprint can, so
 * the owner verifies its mirror instead of trusting arithmetic.
 */
export type ReplicaCursor = Record<string, { held: number; digest: string }>;

function guardOwner(ownerNode: string): void {
	if (!ownerNode || ownerNode.includes("/") || ownerNode.includes("..")) {
		throw new Error(`replica owner id is not a path segment: ${ownerNode}`);
	}
	if (ownerNode === nodeIdentity().id) {
		throw new Error("this desk's own transcripts are not replicas");
	}
}

function guardSegment(personaId: string, epoch: number): void {
	if (!personaId || personaId.includes("/") || personaId.includes("..")) {
		throw new Error(`replica persona id is not a path segment: ${personaId}`);
	}
	if (!Number.isInteger(epoch) || epoch < 1) {
		throw new Error(`replica epoch must be a positive integer: ${epoch}`);
	}
}

function segmentPath(ownerNode: string, personaId: string, epoch: number): string {
	return join(DIR(), ownerNode, personaId, `${epoch}.jsonl`);
}

/** What this desk holds of one persona's transcript, by epoch. */
export function replicaCursor(ownerNode: string, personaId: string): ReplicaCursor {
	guardOwner(ownerNode);
	guardSegment(personaId, 1);
	const dir = join(DIR(), ownerNode, personaId);
	const cursor: ReplicaCursor = {};
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

/** Every persona this desk holds replicas for, per owner. */
export function replicaHoldings(ownerNode: string): string[] {
	guardOwner(ownerNode);
	const dir = join(DIR(), ownerNode);
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter((name) => !name.startsWith("."));
}

/**
 * Appends owner-shipped bytes at the offset they were cut. An offset that is
 * not exactly the bytes held means a gap or a replay — both are answered by
 * refusing, so the cursor exchange re-ships from the true offset instead of
 * this desk guessing content into a mirror.
 */
export function replicaAppend(
	ownerNode: string,
	personaId: string,
	epoch: number,
	offset: number,
	bytes: Uint8Array,
): { ok: true } | { ok: false; held: number } {
	guardOwner(ownerNode);
	guardSegment(personaId, epoch);
	ensureLayout();
	const path = segmentPath(ownerNode, personaId, epoch);
	const held = existsSync(path) ? statSync(path).size : 0;
	if (offset !== held) return { ok: false, held };
	mkdirSync(join(DIR(), ownerNode, personaId), { recursive: true });
	appendFileSync(path, bytes);
	return { ok: true };
}

/**
 * Drops one replica segment because its owner said to. This is the only
 * deletion here, and it is owner-instructed: the owner rewrote that epoch's
 * history (a compaction), so the bytes held mirror nothing anymore — the
 * owner re-ships the epoch from zero right behind the reset, and the mirror
 * invariant "holds only what the owner shipped" carries straight through.
 */
export function replicaReset(ownerNode: string, personaId: string, epoch: number): void {
	guardOwner(ownerNode);
	guardSegment(personaId, epoch);
	rmSync(segmentPath(ownerNode, personaId, epoch), { force: true });
}

/** Reads a byte range of one replica segment, for serving or verification. */
export function replicaRead(
	ownerNode: string,
	personaId: string,
	epoch: number,
	offset: number,
	length: number,
): Uint8Array {
	guardOwner(ownerNode);
	guardSegment(personaId, epoch);
	const path = segmentPath(ownerNode, personaId, epoch);
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
 * The replica's recent messages, newest-last, for the offline read path.
 * Folding mirrors the live transcript store: a superseded event id keeps
 * only its last occurrence, so a tool card that went pending→completed is
 * one entry, not a history of its own edits.
 */
export function replicaMessages(
	ownerNode: string,
	personaId: string,
	limit: number,
): Array<Record<string, unknown>> {
	guardOwner(ownerNode);
	guardSegment(personaId, 1);
	const cursor = replicaCursor(ownerNode, personaId);
	const epochs = Object.keys(cursor)
		.map(Number)
		.sort((a, b) => a - b);
	const folded = new Map<string, Record<string, unknown>>();
	for (const epoch of epochs) {
		const raw = readFileSync(segmentPath(ownerNode, personaId, epoch), "utf8");
		for (const line of raw.split("\n")) {
			if (!line.trim()) continue;
			try {
				const event = JSON.parse(line) as Record<string, unknown>;
				const id = typeof event.id === "string" ? event.id : `${epoch}:${folded.size}`;
				folded.delete(id);
				folded.set(id, event);
			} catch {
				// A torn tail line is the shipping cut mid-record; the next
				// delta completes it and until then it does not exist.
			}
		}
	}
	const events = [...folded.values()];
	return events.slice(Math.max(0, events.length - limit));
}
