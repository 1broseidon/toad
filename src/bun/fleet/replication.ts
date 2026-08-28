import type { TranscriptEvent } from "../../shared/types";
import { listPersonas } from "../store/personas";
import { listRecords } from "../store/records";
import {
	replicaAppend,
	replicaCursor,
	replicaHoldings,
	replicaMessages,
	type ReplicaCursor,
} from "../store/replicas";
import {
	onTranscriptAppended,
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
 * The replica store's offset check is the whole consistency story. A refused
 * append answers with the bytes truly held, and the sender re-ships from
 * there out of its own segments — so a dropped frame, a race between catch-up
 * and a live append, and a persona the holder has never heard of all converge
 * through the same recovery, with no state on the wire to get wrong.
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

/** Ships every epoch the peer is behind on, oldest first — closed segments
 *  complete, then the open one from its held offset. */
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
		const from = held[String(epoch)] ?? 0;
		await shipRange(peerId, link, personaId, epoch, from, sizes[String(epoch)]!);
	}
}

/**
 * Ships one epoch from a byte offset to a target size, chunked, following the
 * holder's refusals: `{ ok: false, held }` re-aims the next chunk at the
 * truth. A mirror holding more of an epoch than this desk does means our
 * history was rewritten under it (a compacted open epoch, a restored desk);
 * there is no honest byte to append to that, so the epoch is skipped and
 * counted rather than guessed at.
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
