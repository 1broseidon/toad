import {
	PERSONA_STREAM_PREFIX,
	streamAdopt,
	streamAppend,
	streamCursor,
	streamHoldings,
	streamLines,
	streamRead,
	streamReset,
	streamSegmentFile,
	type StreamCursor,
} from "./streams";

/**
 * Replicated copies of other desks' transcripts, so the room can still read
 * a teammate's history when the desk it lives on is dark.
 *
 * The machinery moved to `streams.ts` and this is the tape's client of it: a
 * persona's transcript is the stream `persona:<id>`, and its epoch is that
 * stream's generation. Nothing about how a mirror behaves changed — the offset
 * refusal, the fingerprinted cursor, the owner-instructed reset and the hop's
 * adopt are the same functions doing the same thing under a wider key.
 *
 * Why a client and not a rename: an epoch is *ownership*, minted by a hop, and
 * a generation is not. The two happen to be the same number here because a
 * tape's segments are cut by ownership; nothing else's are. Keeping the
 * translation in one small file is what stops the wider store from acquiring a
 * field that means one thing for tapes and another for everything else.
 *
 * Reading a replica is reading history the agent that lived it may never have
 * seen persisted here. The read path marks it as such — the same honesty rule
 * as Restored/Fresh: a mirror must not pretend to be a memory.
 */

export type ReplicaCursor = StreamCursor;

function stream(personaId: string): string {
	return `${PERSONA_STREAM_PREFIX}${personaId}`;
}

/** What this desk holds of one persona's transcript, by epoch. */
export function replicaCursor(ownerNode: string, personaId: string): ReplicaCursor {
	return streamCursor(ownerNode, stream(personaId));
}

/** Every persona this desk holds replicas for, per owner. */
export function replicaHoldings(ownerNode: string): string[] {
	return streamHoldings(ownerNode)
		.filter((id) => id.startsWith(PERSONA_STREAM_PREFIX))
		.map((id) => id.slice(PERSONA_STREAM_PREFIX.length));
}

/** Appends owner-shipped bytes at the offset they were cut, or refuses with
 *  the bytes truly held so the sender re-aims. */
export function replicaAppend(
	ownerNode: string,
	personaId: string,
	epoch: number,
	offset: number,
	bytes: Uint8Array,
): { ok: true } | { ok: false; held: number } {
	return streamAppend(ownerNode, stream(personaId), epoch, offset, bytes);
}

/** Drops one replica segment because its owner said to. */
export function replicaReset(ownerNode: string, personaId: string, epoch: number): void {
	streamReset(ownerNode, stream(personaId), epoch);
}

/** Where one replica segment lives, for the hop's promotion — which renames
 *  the file into the persona's own tape rather than copying through memory. */
export function replicaSegmentFile(ownerNode: string, personaId: string, epoch: number): string {
	return streamSegmentFile(ownerNode, stream(personaId), epoch);
}

/** Adopts this desk's former tape segment as a replica of the new owner — the
 *  hop's demotion, the mirror invariant's one deliberate exception. */
export function replicaAdopt(
	ownerNode: string,
	personaId: string,
	epoch: number,
	sourcePath: string,
): void {
	streamAdopt(ownerNode, stream(personaId), epoch, sourcePath);
}

/** Reads a byte range of one replica segment, for serving or verification. */
export function replicaRead(
	ownerNode: string,
	personaId: string,
	epoch: number,
	offset: number,
	length: number,
): Uint8Array {
	return streamRead(ownerNode, stream(personaId), epoch, offset, length);
}

/** The replica's recent messages, newest-last, for the offline read path. */
export function replicaMessages(
	ownerNode: string,
	personaId: string,
	limit: number,
): Array<Record<string, unknown>> {
	return streamLines(ownerNode, stream(personaId), limit);
}
