import type { TranscriptEvent } from "../../shared/types";
import { listPersonas } from "../store/personas";
import { listRecords } from "../store/records";
import { replicaMessages } from "../store/replicas";
import { PERSONA_STREAM_PREFIX, type StreamCursor } from "../store/streams";
import {
	onTranscriptAppended,
	onTranscriptRewritten,
	readSegmentBytes,
	segmentSizes,
} from "../store/transcript";
import {
	answerCursors,
	applyDelta,
	applyReset,
	noteAppend,
	noteRewrite,
	registerLogSource,
	streamLinkDown,
	streamLinkUp,
	type LogSource,
	type ReplicationLink,
} from "./stream-replication";

/**
 * Transcript replication: every up wire mirrors this desk's tapes, so the room
 * can still read a teammate's history when the desk it lives on is dark.
 *
 * The engine moved to `stream-replication.ts` and this is the tape's client of
 * it — the first one, and the one that taught it everything it knows. What
 * stays here is exactly what is specific to a teammate's transcript:
 *
 * - **Enumeration.** "What I own" is `listPersonas()`; "what I expect to
 *   mirror of a peer" is the persona records it owns. The engine cannot know
 *   either, which is why a `LogSource` supplies them.
 * - **Reads.** A tape's bytes come from `store/transcript.ts`, not from the
 *   mirror store.
 * - **The frame names.** `transcriptCursors` / `transcriptDelta` /
 *   `transcriptReset` have been on the wire since 0.2. Renaming them to
 *   something generic would silently stop mirroring against every desk in the
 *   room that has not upgraded, so the names stay and the algorithm is shared.
 * - **The epoch.** A persona's stream is `persona:<id>` and its generation is
 *   its epoch — which the wire keeps calling an epoch, because that is what the
 *   other end of a 0.3.8 link is expecting to read.
 */

/** A teammate's tape as the stream store names it. */
function streamOf(personaId: string): string {
	return `${PERSONA_STREAM_PREFIX}${personaId}`;
}

function personaOf(streamId: string): string {
	return streamId.slice(PERSONA_STREAM_PREFIX.length);
}

const transcriptSource: LogSource = {
	prefix: PERSONA_STREAM_PREFIX,
	owned: () => listPersonas().map((persona) => streamOf(persona.id)),
	expected: (peerId) =>
		listRecords("persona")
			.filter((record) => record.ownerNode === peerId)
			.map((record) => streamOf(record.id)),
	sizes: (streamId) => segmentSizes(personaOf(streamId)),
	read: (streamId, gen, offset, length) => readSegmentBytes(personaOf(streamId), gen, offset, length),
	frames: { cursors: "transcriptCursors", delta: "transcriptDelta", reset: "transcriptReset" },
	wire: {
		cursors: (link, cursors) => {
			const byPersona: Record<string, unknown> = {};
			for (const [streamId, cursor] of Object.entries(cursors)) {
				byPersona[personaOf(streamId)] = cursor;
			}
			return link.call("transcriptCursors", { cursors: byPersona });
		},
		delta: (link, streamId, gen, offset, data) =>
			link.call("transcriptDelta", {
				personaId: personaOf(streamId),
				epoch: gen,
				offset,
				data,
			}) as Promise<{ ok?: boolean; held?: number }>,
		reset: (link, streamId, gen) =>
			link.call("transcriptReset", { personaId: personaOf(streamId), epoch: gen }),
	},
};

let subscribed = false;

/** Hooks the tape's append seam once per process, and registers its source. */
export function initTranscriptReplication(): void {
	if (subscribed) return;
	subscribed = true;
	registerLogSource(transcriptSource);
	onTranscriptAppended(({ personaId, epoch, offset, bytes }) => {
		noteAppend(streamOf(personaId), epoch, offset, bytes);
	});
	onTranscriptRewritten(({ personaId, epoch }) => {
		noteRewrite(streamOf(personaId), epoch);
	});
}

/** Link came up: tell every owner what we hold of its streams. */
export function replicationLinkUp(peerId: string, link: ReplicationLink): void {
	streamLinkUp(peerId, link);
}

export function replicationLinkDown(peerId: string): void {
	streamLinkDown(peerId);
}

/** The peer told us what it holds of OUR tapes; ship the difference. */
export function handleTranscriptCursors(peerId: string, params: unknown): { ok: boolean } {
	const raw =
		((params as { cursors?: Record<string, StreamCursor> } | null)?.cursors ?? {}) as Record<
			string,
			StreamCursor
		>;
	const cursors: Record<string, StreamCursor> = {};
	for (const [personaId, cursor] of Object.entries(raw)) cursors[streamOf(personaId)] = cursor;
	return answerCursors(peerId, transcriptSource, cursors);
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
	return applyDelta(
		peerId,
		streamOf(input.personaId),
		input.epoch!,
		input.offset!,
		bytes,
		"transcriptDelta",
	);
}

/** The owner rewrote this epoch's history; drop the mirror of it. */
export function handleTranscriptReset(peerId: string, params: unknown): { ok: true } {
	const input = params as { personaId?: string; epoch?: number } | null;
	if (!input || typeof input.personaId !== "string" || !Number.isInteger(input.epoch)) {
		throw new Error("bad transcript reset");
	}
	applyReset(peerId, streamOf(input.personaId), input.epoch!, "transcriptReset");
	return { ok: true };
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
