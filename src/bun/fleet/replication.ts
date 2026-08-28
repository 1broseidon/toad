import type { TranscriptEvent } from "../../shared/types";
import { listPersonas } from "../store/personas";
import { listRecords } from "../store/records";
import { createHash } from "node:crypto";
import {
	replicaAppend,
	replicaCursor,
	replicaHoldings,
	replicaMessages,
	replicaReset,
	type ReplicaCursor,
} from "../store/replicas";
import {
	onTranscriptAppended,
	onTranscriptRewritten,
	readSegmentBytes,
	segmentSizes,
} from "../store/transcript";
import { meshCount } from "./metrics";

/**
 * Transcript replication over the node plane: every up wire mirrors this
 * desk's tapes, so the room can still read a teammate's history when the desk
 * it lives on is dark.
 *
 * The protocol is two methods riding the authenticated NodeLink like any
 * other call. On link-up each side tells the other what it holds of THAT
 * side's personas (`transcriptCursors`), and the owner answers by shipping
 * what is missing (`transcriptDelta`): closed epoch segments in full, the
 * open epoch from the held byte offset. After catch-up, every local append
 * ships as it lands. First-hand only, both directions: a desk ships only the
 * transcripts it owns, and a received delta's owner is the link's peer and
 * nobody else — a relayed replica cannot even be expressed here.
 *
 * The replica store's offset check is the appends' consistency story. A
 * refused append answers with the bytes truly held, and the sender re-ships
 * from there out of its own segments — so a dropped frame, a race between
 * catch-up and a live append, and a persona the holder has never heard of all
 * converge through the same recovery, with no state on the wire to get wrong.
 *
 * A mirror must be a mirror: byte-identical to the owner, verifiably. Offsets
 * alone cannot see a rewrite (a compacted open epoch) that lands at the same
 * or a larger size, so each cursor entry carries the sha256 of the bytes held
 * and the owner checks it against its own prefix before shipping. A mismatch
 * — or a mirror holding more than the owner has — means the history was
 * rewritten under it: the owner instructs a reset (`transcriptReset`) and
 * re-ships the epoch from zero. Live rewrites take the same path without
 * waiting for a link-up, via the tape's rewrite seam.
 */

/** One frame's worth of segment bytes. Big enough that a real transcript
 *  ships in a handful of calls, small enough that one giant tape cannot
 *  wedge the link the rest of the room is talking over. */
const configuredChunk = Number(process.env.TOAD_TRANSCRIPT_CHUNK_BYTES);
const CHUNK_BYTES =
	Number.isFinite(configuredChunk) && configuredChunk > 0 ? configuredChunk : 256 * 1024;

type ReplicationLink = {
	call(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
};

const links = new Map<string, ReplicationLink>();

/* One lane per (peer, persona): catch-up chunks and live deltas for the same
 * tape must not interleave, or two writers would race the same offset and
 * ping-pong through the refusal path forever. Different personas and
 * different peers ship independently. */
const lanes = new Map<string, Promise<void>>();

function enqueue(peerId: string, personaId: string, task: () => Promise<void>): void {
	const key = `${peerId}\n${personaId}`;
	const lane = (lanes.get(key) ?? Promise.resolve()).then(task, () => {});
	lanes.set(
		key,
		lane.catch(() => {}),
	);
}

let subscribed = false;

/** Hooks the tape's append seam once per process. */
export function initTranscriptReplication(): void {
	if (subscribed) return;
	subscribed = true;
	onTranscriptAppended(({ personaId, epoch, offset, bytes }) => {
		for (const [peerId, link] of links) {
			enqueue(peerId, personaId, () =>
				shipDelta(peerId, link, personaId, epoch, offset, bytes),
			);
		}
	});
	/* A rewrite while links are up: every mirror of that epoch is now wrong,
	 * so each gets a reset and a full re-ship on its own lane. Startup
	 * compaction runs before any wire exists and never reaches here — the
	 * cursor fingerprints catch those mirrors on the next link-up instead. */
	onTranscriptRewritten(({ personaId, epoch }) => {
		for (const [peerId, link] of links) {
			enqueue(peerId, personaId, () =>
				resetAndReship(peerId, link, personaId, epoch, currentSegmentSize(personaId, epoch)),
			);
		}
	});
}

/** Link came up: tell the owner what we hold of its personas. */
export function replicationLinkUp(peerId: string, link: ReplicationLink): void {
	links.set(peerId, link);
	const personas = new Set<string>(replicaHoldings(peerId));
	for (const record of listRecords("persona")) {
		if (record.ownerNode === peerId) personas.add(record.id);
	}
	const cursors: Record<string, ReplicaCursor> = {};
	for (const personaId of personas) {
		cursors[personaId] = replicaCursor(peerId, personaId);
	}
	/* An older peer answers unknown-method; the mirror simply stays where it
	 * was, which is exactly what a mirror of an older desk should do. */
	void link
		.call("transcriptCursors", { cursors })
		.then(() => meshCount("replicaShip", "transcriptCursors", { nodeId: peerId }))
		.catch(() => {});
}

export function replicationLinkDown(peerId: string): void {
	links.delete(peerId);
}

/**
 * The peer told us what it holds of OUR personas; ship the difference.
 *
 * Only this desk's own tapes leave here — a persona id in the cursors that
 * this desk does not own is somebody else's transcript and ships nothing.
 * Personas the peer did not mention ship from zero: on a first link-up the
 * peer may not even know they exist yet.
 */
export function handleTranscriptCursors(peerId: string, params: unknown): { ok: boolean } {
	const link = links.get(peerId);
	if (!link) return { ok: false };
	const cursors =
		((params as { cursors?: Record<string, ReplicaCursor> } | null)?.cursors ?? {}) as Record<
			string,
			ReplicaCursor
		>;
	for (const persona of listPersonas()) {
		const held = cursors[persona.id] ?? {};
		enqueue(peerId, persona.id, () => shipPersona(peerId, link, persona.id, held));
	}
	return { ok: true };
}

/** One owner-shipped byte range landing in the local mirror. The owner is the
 *  authenticated link peer by construction — the frame does not carry one. */
export function handleTranscriptDelta(
	peerId: string,
	params: unknown,
): { ok: true } | { ok: false; held: number } {
	const input = params as {
		personaId?: string;
		epoch?: number;
		offset?: number;
		data?: string;
	} | null;
	if (
		!input ||
		typeof input.personaId !== "string" ||
		!Number.isInteger(input.epoch) ||
		!Number.isInteger(input.offset) ||
		(input.offset as number) < 0 ||
		typeof input.data !== "string"
	) {
		throw new Error("bad transcript delta");
	}
	const bytes = Buffer.from(input.data, "base64");
	const result = replicaAppend(peerId, input.personaId, input.epoch!, input.offset!, bytes);
	meshCount(result.ok ? "replicaApply" : "replicaRefuse", "transcriptDelta", {
		nodeId: peerId,
		bytes: result.ok ? bytes.length : 0,
	});
	return result;
}

/** The owner rewrote this epoch's history; drop the mirror of it. The bytes
 *  that replace it arrive as ordinary deltas right behind this call. */
export function handleTranscriptReset(peerId: string, params: unknown): { ok: true } {
	const input = params as { personaId?: string; epoch?: number } | null;
	if (!input || typeof input.personaId !== "string" || !Number.isInteger(input.epoch)) {
		throw new Error("bad transcript reset");
	}
	replicaReset(peerId, input.personaId, input.epoch!);
	meshCount("replicaReset", "transcriptReset", { nodeId: peerId });
	return { ok: true };
}

/**
 * Ships every epoch the peer is behind on, oldest first — closed segments
 * complete, then the open one from its held offset. Before resuming an epoch
 * mid-segment, the mirror's fingerprint is checked against this desk's own
 * first `held` bytes: a mismatch, or a mirror holding more than exists, means
 * the history was rewritten under it and the epoch restarts from zero behind
 * a reset instead of silently diverging.
 */
async function shipPersona(
	peerId: string,
	link: ReplicationLink,
	personaId: string,
	held: ReplicaCursor,
): Promise<void> {
	const sizes = segmentSizes(personaId);
	const epochs = Object.keys(sizes)
		.map(Number)
		.sort((a, b) => a - b);
	for (const epoch of epochs) {
		const size = sizes[String(epoch)]!;
		const entry = held[String(epoch)];
		const from =
			entry && Number.isInteger(entry.held) && entry.held > 0 ? entry.held : 0;
		if (from === 0) {
			await shipRange(peerId, link, personaId, epoch, 0, size);
			continue;
		}
		if (from <= size && segmentDigest(personaId, epoch, from) === entry!.digest) {
			await shipRange(peerId, link, personaId, epoch, from, size);
			continue;
		}
		await resetAndReship(peerId, link, personaId, epoch, size);
	}
}

/** sha256 (hex) of the first `length` bytes of one epoch segment, read in
 *  shipping-sized chunks so a long tape never sits in memory whole. */
function segmentDigest(personaId: string, epoch: number, length: number): string {
	const hash = createHash("sha256");
	let offset = 0;
	while (offset < length) {
		const bytes = readSegmentBytes(personaId, epoch, offset, Math.min(CHUNK_BYTES, length - offset));
		if (bytes.length === 0) break;
		hash.update(bytes);
		offset += bytes.length;
	}
	return hash.digest("hex");
}

/**
 * The recovery from a rewrite: tell the mirror to drop the epoch, then ship
 * it again from zero. An older peer that does not know the method leaves its
 * mirror as it was — stale but honest, and healed the day it upgrades.
 */
async function resetAndReship(
	peerId: string,
	link: ReplicationLink,
	personaId: string,
	epoch: number,
	size: number,
): Promise<void> {
	try {
		await link.call("transcriptReset", { personaId, epoch });
	} catch {
		return;
	}
	meshCount("replicaShip", "transcriptReset", { nodeId: peerId });
	await shipRange(peerId, link, personaId, epoch, 0, size);
}

/**
 * Ships one epoch from a byte offset to a target size, chunked, following the
 * holder's refusals: `{ ok: false, held }` re-aims the next chunk at the
 * truth. A refusal claiming more than this desk has means our history was
 * rewritten under the mirror mid-flight; there is no honest byte to append to
 * that, so the epoch is skipped and counted — the rewrite seam or the next
 * link-up's fingerprints reset and re-ship it.
 */
async function shipRange(
	peerId: string,
	link: ReplicationLink,
	personaId: string,
	epoch: number,
	offset: number,
	size: number,
): Promise<void> {
	let from = offset;
	while (from < size) {
		const bytes = readSegmentBytes(personaId, epoch, from, Math.min(CHUNK_BYTES, size - from));
		if (bytes.length === 0) return;
		let result: { ok?: boolean; held?: number };
		try {
			result = (await link.call("transcriptDelta", {
				personaId,
				epoch,
				offset: from,
				data: Buffer.from(bytes).toString("base64"),
			})) as { ok?: boolean; held?: number };
		} catch {
			// Link gone or peer too old; the next link-up's cursors resume this.
			return;
		}
		if (result.ok) {
			meshCount("replicaShip", "transcriptDelta", { nodeId: peerId, bytes: bytes.length });
			from += bytes.length;
			continue;
		}
		const truth = typeof result.held === "number" ? result.held : Number.NaN;
		if (!Number.isInteger(truth) || truth === from || truth > size) {
			if (truth > size) meshCount("replicaDrop", "mirror-ahead", { nodeId: peerId });
			return;
		}
		from = truth;
	}
}

/** One live append, shipped where the mirror expects it. A refusal means the
 *  mirror is elsewhere — behind (it never got earlier bytes: re-ship from its
 *  truth) or already past this write (a catch-up lane shipped it first). */
async function shipDelta(
	peerId: string,
	link: ReplicationLink,
	personaId: string,
	epoch: number,
	offset: number,
	bytes: Uint8Array,
): Promise<void> {
	if (bytes.length <= CHUNK_BYTES) {
		let result: { ok?: boolean; held?: number };
		try {
			result = (await link.call("transcriptDelta", {
				personaId,
				epoch,
				offset,
				data: Buffer.from(bytes).toString("base64"),
			})) as { ok?: boolean; held?: number };
		} catch {
			return;
		}
		if (result.ok) {
			meshCount("replicaShip", "transcriptDelta", { nodeId: peerId, bytes: bytes.length });
			return;
		}
		const truth = typeof result.held === "number" ? result.held : Number.NaN;
		if (!Number.isInteger(truth) || truth >= offset + bytes.length) return;
		await shipRange(peerId, link, personaId, epoch, truth, currentSegmentSize(personaId, epoch));
		return;
	}
	/* An append bigger than a frame (one enormous pasted event) takes the
	 * chunked path from its own offset; the target is wherever the segment
	 * stands now, which includes this write. */
	await shipRange(peerId, link, personaId, epoch, offset, currentSegmentSize(personaId, epoch));
}

function currentSegmentSize(personaId: string, epoch: number): number {
	return segmentSizes(personaId)[String(epoch)] ?? 0;
}

/* ------------------------------------------------------------ replica reads */

/**
 * The offline read path for the UI's transcript replay: the mirror's folded
 * events, led by a notice saying so. A mirror must not pretend to be a
 * memory — the marker is a transcript event because the response contract is
 * a list of transcript events, and a notice is the honest one to lead with.
 * Null when this desk holds nothing, so the caller can fail as it always has.
 */
export function replicaTranscript(
	ownerNode: string,
	personaId: string,
	ownerName: string,
	limit = 500,
): TranscriptEvent[] | null {
	let events: Array<Record<string, unknown>>;
	try {
		events = replicaMessages(ownerNode, personaId, limit);
	} catch {
		return null;
	}
	if (events.length === 0) return null;
	const marker = {
		kind: "notice",
		id: `replica:${ownerNode}/${personaId}`,
		ts: Date.now(),
		level: "info",
		text: `Read from this desk's replica — ${ownerName} is unreachable, so the newest moments may be missing.`,
	};
	return [marker, ...events] as TranscriptEvent[];
}

/**
 * The offline read path for a teammate's `read_transcript`: recent user/agent
 * messages out of the mirror, in the peer-read shape. Null when nothing is
 * held. The caller marks the payload `replica: true`.
 */
export function replicaRecentMessages(
	ownerNode: string,
	personaId: string,
	limit: number,
): { name: string; messages: Array<{ from: string; text: string; at: number }> } | null {
	let events: Array<Record<string, unknown>>;
	try {
		events = replicaMessages(ownerNode, personaId, Math.max(limit * 4, 200));
	} catch {
		return null;
	}
	const messages = events
		.filter((event) => event.kind === "user" || event.kind === "agent")
		.map((event) => ({
			from: event.kind === "user" ? "user" : "teammate",
			text: typeof event.text === "string" ? event.text : "",
			at: typeof event.ts === "number" ? event.ts : 0,
		}))
		.slice(-limit);
	if (messages.length === 0) return null;
	const record = listRecords("persona").find(
		(row) => row.ownerNode === ownerNode && row.id === personaId,
	);
	const name = (record?.replicated as { name?: string } | undefined)?.name ?? personaId;
	return { name, messages };
}
