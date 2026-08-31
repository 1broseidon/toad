import { createHash } from "node:crypto";
import {
	streamAppend,
	streamCursor,
	streamHoldings,
	streamReset,
	type StreamCursor,
} from "../store/streams";
import { meshCount } from "./metrics";

/**
 * Append-only stream replication over the node plane, for anything that owns
 * one: a teammate's tape (`replication.ts`) and a plugin's log
 * (`plugin/log-plane.ts`).
 *
 * This file is `replication.ts` with the persona lifted out of it, and the
 * disciplines are the ones transcript replication proved, unchanged:
 *
 * - each side tells the other what it holds of THAT side's streams; the owner
 *   answers by shipping what is missing, closed generations in full and the
 *   open one from the held byte offset
 * - the offset check is the consistency story: a refused append answers with
 *   the bytes truly held and the sender re-aims out of its own segments, so a
 *   dropped frame, a race between catch-up and a live append, and a stream the
 *   holder has never heard of all converge through one recovery
 * - a cursor carries the sha256 of the bytes held, because offsets alone
 *   cannot see a rewrite that lands at the same or a larger size; a mismatch,
 *   or a mirror holding more than the owner has, means the history was
 *   rewritten under it and the owner resets and re-ships from zero
 * - one serialized lane per (peer, stream), or two writers race the same
 *   offset and ping-pong through the refusal path forever
 * - first-hand only, both directions: a desk ships only what it owns, and a
 *   received delta's owner is the link's peer and nobody else. There is no
 *   `owner` field on the way in, so a relayed mirror cannot be expressed.
 *
 * What is NOT generic, and is therefore supplied by each `LogSource`:
 * enumeration (what I own, what I expect to mirror), the bytes of an owned
 * segment, and the frame names. Frame names stay per-source deliberately — a
 * teammate's tape has shipped as `transcriptCursors`/`transcriptDelta`/
 * `transcriptReset` since 0.2, and renaming those would silently stop mirroring
 * against every desk in the room that has not upgraded yet. The wire is a
 * compatibility surface, not an abstraction.
 */

/** One frame's worth of segment bytes, shared by every source. */
const configuredChunk = Number(process.env.TOAD_TRANSCRIPT_CHUNK_BYTES);
export const CHUNK_BYTES =
	Number.isFinite(configuredChunk) && configuredChunk > 0 ? configuredChunk : 256 * 1024;

export type ReplicationLink = {
	call(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
};

export type DeltaAnswer = { ok?: boolean; held?: number };

/**
 * Everything that owns replicated streams registers one of these.
 *
 * It is also the uninstall handle: unregistering a source stops its streams
 * being enumerated, offered, or shipped, which is what makes "delete the
 * plugin and its mirrors go away" a thing that can actually happen rather than
 * a promise. The tape's source is registered for the life of the process.
 */
export type LogSource = {
	/** Every stream id this source owns starts with this. One prefix, one owner. */
	prefix: string;
	/** Stream ids this desk owns and will ship on request. */
	owned(): string[];
	/** Stream ids owned by `peerId` this desk expects to mirror, beyond what it
	 *  already holds — a first link-up has to ask for tapes it has never seen. */
	expected(peerId: string): string[];
	/** Byte length of each generation of an owned stream, keyed by generation. */
	sizes(streamId: string): Record<string, number>;
	/** Bytes of an owned stream's generation. */
	read(streamId: string, gen: number, offset: number, length: number): Uint8Array;
	/** Frame labels, for the mesh counters. Bounded, because `MAX_KEYS` is. */
	frames: { cursors: string; delta: string; reset: string };
	/** How this source names its frames on the wire. */
	wire: {
		cursors(link: ReplicationLink, cursors: Record<string, StreamCursor>): Promise<unknown>;
		delta(
			link: ReplicationLink,
			streamId: string,
			gen: number,
			offset: number,
			data: string,
		): Promise<DeltaAnswer>;
		reset(link: ReplicationLink, streamId: string, gen: number): Promise<unknown>;
	};
};

const sources = new Map<string, LogSource>();

export function registerLogSource(source: LogSource): () => void {
	sources.set(source.prefix, source);
	return () => {
		if (sources.get(source.prefix) === source) sources.delete(source.prefix);
	};
}

export function logSources(): LogSource[] {
	return [...sources.values()];
}

/** The source that owns a stream id, or nothing — an id no source claims is a
 *  mirror of something this desk no longer has any reason to hold. */
export function sourceFor(streamId: string): LogSource | undefined {
	for (const source of sources.values()) {
		if (streamId.startsWith(source.prefix)) return source;
	}
	return undefined;
}

const links = new Map<string, ReplicationLink>();

export function replicationLinks(): ReadonlyMap<string, ReplicationLink> {
	return links;
}

/* One lane per (peer, stream): catch-up chunks and live deltas for the same
 * stream must not interleave. Different streams and different peers ship
 * independently. */
const lanes = new Map<string, Promise<void>>();

export function enqueue(peerId: string, streamId: string, task: () => Promise<void>): void {
	const key = `${peerId}\n${streamId}`;
	const lane = (lanes.get(key) ?? Promise.resolve()).then(task, () => {});
	lanes.set(
		key,
		lane.catch(() => {}),
	);
}

/** Link came up: tell the owner what we hold of each source's streams. */
export function streamLinkUp(peerId: string, link: ReplicationLink): void {
	links.set(peerId, link);
	const held = new Set<string>(streamHoldings(peerId));
	for (const source of sources.values()) {
		const mine = new Set<string>([...held].filter((id) => id.startsWith(source.prefix)));
		for (const id of source.expected(peerId)) mine.add(id);
		const cursors: Record<string, StreamCursor> = {};
		for (const streamId of mine) cursors[streamId] = streamCursor(peerId, streamId);
		/* An older peer answers unknown-method; the mirror simply stays where it
		 * was, which is exactly what a mirror of an older desk should do. */
		void source.wire
			.cursors(link, cursors)
			.then(() => meshCount("replicaShip", source.frames.cursors, { nodeId: peerId }))
			.catch(() => {});
	}
}

export function streamLinkDown(peerId: string): void {
	links.delete(peerId);
}

/**
 * The peer told us what it holds of OUR streams; ship the difference.
 *
 * Only what this desk owns leaves here — a stream id in the cursors this desk
 * does not own is somebody else's and ships nothing. Streams the peer did not
 * mention ship from zero: on a first link-up it may not know they exist yet.
 */
export function answerCursors(
	peerId: string,
	source: LogSource,
	held: Record<string, StreamCursor>,
): { ok: boolean } {
	const link = links.get(peerId);
	if (!link) return { ok: false };
	for (const streamId of source.owned()) {
		const cursor = held[streamId] ?? {};
		enqueue(peerId, streamId, () => shipStream(peerId, link, source, streamId, cursor));
	}
	return { ok: true };
}

/** One owner-shipped byte range landing in the local mirror. The owner is the
 *  authenticated link peer by construction — the frame does not carry one. */
export function applyDelta(
	peerId: string,
	streamId: string,
	gen: number,
	offset: number,
	bytes: Uint8Array,
	label: string,
): { ok: true } | { ok: false; held: number } {
	const result = streamAppend(peerId, streamId, gen, offset, bytes);
	meshCount(result.ok ? "replicaApply" : "replicaRefuse", label, {
		nodeId: peerId,
		bytes: result.ok ? bytes.length : 0,
	});
	return result;
}

/** The owner rewrote this generation's history; drop the mirror of it. The
 *  bytes that replace it arrive as ordinary deltas right behind this call. */
export function applyReset(peerId: string, streamId: string, gen: number, label: string): void {
	streamReset(peerId, streamId, gen);
	meshCount("replicaReset", label, { nodeId: peerId });
}

/** A local append on an owned stream, shipped to every up link. */
export function noteAppend(
	streamId: string,
	gen: number,
	offset: number,
	bytes: Uint8Array,
): void {
	const source = sourceFor(streamId);
	if (!source) return;
	for (const [peerId, link] of links) {
		enqueue(peerId, streamId, () =>
			shipDelta(peerId, link, source, streamId, gen, offset, bytes),
		);
	}
}

/**
 * A rewrite while links are up: every mirror of that generation is now wrong,
 * so each gets a reset and a full re-ship on its own lane. A rewrite that
 * happens before any wire exists never reaches here — the cursor fingerprints
 * catch those mirrors on the next link-up instead.
 */
export function noteRewrite(streamId: string, gen: number): void {
	const source = sourceFor(streamId);
	if (!source) return;
	for (const [peerId, link] of links) {
		enqueue(peerId, streamId, () =>
			resetAndReship(peerId, link, source, streamId, gen, currentSize(source, streamId, gen)),
		);
	}
}

/**
 * Ships every generation the peer is behind on, oldest first — closed segments
 * complete, then the open one from its held offset. Before resuming mid-segment
 * the mirror's fingerprint is checked against this desk's own first `held`
 * bytes: a mismatch, or a mirror holding more than exists, means the history was
 * rewritten under it and the generation restarts from zero behind a reset
 * instead of silently diverging.
 */
async function shipStream(
	peerId: string,
	link: ReplicationLink,
	source: LogSource,
	streamId: string,
	held: StreamCursor,
): Promise<void> {
	const sizes = source.sizes(streamId);
	const gens = Object.keys(sizes)
		.map(Number)
		.sort((a, b) => a - b);
	for (const gen of gens) {
		const size = sizes[String(gen)]!;
		const entry = held[String(gen)];
		const from = entry && Number.isInteger(entry.held) && entry.held > 0 ? entry.held : 0;
		if (from === 0) {
			await shipRange(peerId, link, source, streamId, gen, 0, size);
			continue;
		}
		if (from <= size && segmentDigest(source, streamId, gen, from) === entry!.digest) {
			await shipRange(peerId, link, source, streamId, gen, from, size);
			continue;
		}
		await resetAndReship(peerId, link, source, streamId, gen, size);
	}
}

/** sha256 (hex) of the first `length` bytes of one segment, read in
 *  shipping-sized chunks so a long stream never sits in memory whole. */
function segmentDigest(source: LogSource, streamId: string, gen: number, length: number): string {
	const hash = createHash("sha256");
	let offset = 0;
	while (offset < length) {
		const bytes = source.read(streamId, gen, offset, Math.min(CHUNK_BYTES, length - offset));
		if (bytes.length === 0) break;
		hash.update(bytes);
		offset += bytes.length;
	}
	return hash.digest("hex");
}

/**
 * The recovery from a rewrite: tell the mirror to drop the generation, then
 * ship it again from zero. An older peer that does not know the method leaves
 * its mirror as it was — stale but honest, and healed the day it upgrades.
 */
async function resetAndReship(
	peerId: string,
	link: ReplicationLink,
	source: LogSource,
	streamId: string,
	gen: number,
	size: number,
): Promise<void> {
	try {
		await source.wire.reset(link, streamId, gen);
	} catch {
		return;
	}
	meshCount("replicaShip", source.frames.reset, { nodeId: peerId });
	await shipRange(peerId, link, source, streamId, gen, 0, size);
}

/**
 * Ships one generation from a byte offset to a target size, chunked, following
 * the holder's refusals: `{ ok: false, held }` re-aims the next chunk at the
 * truth. A refusal claiming more than this desk has means our history was
 * rewritten under the mirror mid-flight; there is no honest byte to append to
 * that, so the generation is skipped and counted — the rewrite seam or the next
 * link-up's fingerprints reset and re-ship it.
 */
async function shipRange(
	peerId: string,
	link: ReplicationLink,
	source: LogSource,
	streamId: string,
	gen: number,
	offset: number,
	size: number,
): Promise<void> {
	let from = offset;
	while (from < size) {
		const bytes = source.read(streamId, gen, from, Math.min(CHUNK_BYTES, size - from));
		if (bytes.length === 0) return;
		let result: DeltaAnswer;
		try {
			result = await source.wire.delta(
				link,
				streamId,
				gen,
				from,
				Buffer.from(bytes).toString("base64"),
			);
		} catch {
			// Link gone or peer too old; the next link-up's cursors resume this.
			return;
		}
		if (result.ok) {
			meshCount("replicaShip", source.frames.delta, { nodeId: peerId, bytes: bytes.length });
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
	source: LogSource,
	streamId: string,
	gen: number,
	offset: number,
	bytes: Uint8Array,
): Promise<void> {
	if (bytes.length <= CHUNK_BYTES) {
		let result: DeltaAnswer;
		try {
			result = await source.wire.delta(
				link,
				streamId,
				gen,
				offset,
				Buffer.from(bytes).toString("base64"),
			);
		} catch {
			return;
		}
		if (result.ok) {
			meshCount("replicaShip", source.frames.delta, { nodeId: peerId, bytes: bytes.length });
			return;
		}
		const truth = typeof result.held === "number" ? result.held : Number.NaN;
		if (!Number.isInteger(truth) || truth >= offset + bytes.length) return;
		await shipRange(peerId, link, source, streamId, gen, truth, currentSize(source, streamId, gen));
		return;
	}
	/* An append bigger than a frame (one enormous pasted event) takes the
	 * chunked path from its own offset; the target is wherever the segment
	 * stands now, which includes this write. */
	await shipRange(peerId, link, source, streamId, gen, offset, currentSize(source, streamId, gen));
}

function currentSize(source: LogSource, streamId: string, gen: number): number {
	return source.sizes(streamId)[String(gen)] ?? 0;
}
