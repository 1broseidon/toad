import { createHash, randomUUID } from "node:crypto";
import type { HarnessChoice, HopResult, SessionState } from "../../shared/types";
import { isBusy, isUp } from "../../shared/session";
import { nodeIdentity } from "../node/identity";
import { getPersona, materializeWorkspace, updatePersona } from "../store/personas";
import { claimLocal, getRecord, listRecords, localNodeId } from "../store/records";
import {
	replicaAdopt,
	replicaCursor,
	replicaSegmentFile,
	type ReplicaCursor,
} from "../store/replicas";
import {
	adoptSegment,
	append,
	readSegmentBytes,
	segmentFiles,
	segmentSizes,
} from "../store/transcript";
import { deskCapabilities, resolveTeammateHarness } from "./capabilities";
import { callFleetPeer, listFleetPeers } from "./fleet";
import { peerOnline, peerWireFor } from "./wire";

/**
 * The persona hop: one teammate, one tape, moving between desks.
 *
 * A hop names (personaId, destination) and can be issued from any member; it
 * routes to the DESTINATION, which drives the pull. The move is three acts and
 * one pivot. The owner *prepares*: refuses while the teammate is mid-turn,
 * stops the idle-but-live session, closes the open chapter with its handoff
 * note, and stamps a notice on the tape — all harmless to repeat, because
 * nothing has moved yet. The destination *verifies* its mirror against the
 * owner's final cursor and digests — the same fingerprints replication trusts
 * — and then *claims*: promotes the byte-identical replica segments to the
 * persona's own tape by rename, bumps the owner epoch (higher epoch wins
 * outright, so the record flips on every member the moment the op lands), and
 * materializes the working directory and managed goal. The claim is the one
 * atomic pivot; a hop that dies anywhere before it leaves the teammate exactly
 * where it was, owned and runnable on the old desk.
 *
 * The old owner demotes on seeing the record flip — told directly as a
 * courtesy, swept periodically so a missed call cannot wedge a tape half-moved
 * — by moving its former segments into its replica store under the new owner.
 * Its own filters do the rest: a persona it no longer owns already left its
 * roster, its ship set, and its first-hand sync.
 *
 * Both agent kinds ride the same fact: session checkpoints are machine-bound
 * and never travel, so the destination starts a fresh session — Toad Agent
 * in-process, an ACP backend as a child spawned from the materialized goal and
 * the tape. No backend is ever asked to resume a session another machine owns,
 * which is why neither kind needs a refusal here.
 */

type HopDeps = {
	/** The local session's state for one teammate — the rollout's busy rule. */
	state(personaId: string): SessionState;
	/** Stops the local live session; idle is not the same as no process. */
	stop(personaId: string): Promise<void>;
	/** Closes the open chapter, writing its handoff note onto the marker. */
	closeChapter(personaId: string): Promise<void>;
	/** Re-publishes the roster after ownership moved in either direction. */
	publish(): void;
};

let deps: HopDeps = {
	state: () => "stopped",
	stop: async () => {},
	closeChapter: async () => {},
	publish: () => {},
};

/** How long the destination waits for its mirror to reach the owner's cursor. */
const REPLICA_WAIT_MS = 30_000;
const REPLICA_POLL_MS = 200;
/** How long the old owner waits to see the claim before demoting on request. */
const FLIP_WAIT_MS = 5_000;
/** A missed demote call heals on this sweep instead of wedging a tape. */
const DEMOTE_SWEEP_MS = 60_000;

export function initHop(next: Partial<HopDeps>): void {
	deps = { ...deps, ...next };
	const sweep = setInterval(() => {
		try {
			demoteForeignTapes();
		} catch {
			/* the next sweep tries again */
		}
	}, DEMOTE_SWEEP_MS);
	sweep.unref?.();
	// Startup: a crash between another desk's claim and our demote left the
	// record flipped and the files behind. Same cure as the sweep, now.
	try {
		demoteForeignTapes();
	} catch {
		/* the sweep will retry */
	}
}

const bareId = (personaId: string): string => personaId.slice(personaId.lastIndexOf("/") + 1);

function refuse(error: string): HopResult {
	return { ok: false, error };
}

function peerName(nodeId: string): string {
	return listFleetPeers().find((peer) => peer.id === nodeId)?.name ?? nodeId;
}

/**
 * What the teammate is told about the move. The move is never silent: the
 * agent resuming on the new desk must know it changed machines and must not
 * assume any of the old machine's filesystem state — open files, uncommitted
 * changes, build artifacts — exists here. One text serves both places it
 * lands: the tape's handoff notice, and the message funnel on the new desk.
 */
function hopNoticeText(fromName: string, toName: string, platform: string): string {
	return (
		`Hopped desks: this teammate moved from "${fromName}" to "${toName}"` +
		`${platform ? ` (${platform})` : ""}. The conversation history is intact — continue the work. ` +
		"Verify the workspace first: the working directory on this machine may be a fresh checkout, " +
		"a different path, or missing the repository entirely, so check what actually exists before " +
		"assuming any files, uncommitted changes, or build artifacts from the old desk are here."
	);
}

/** sha256 (hex) of the first `length` bytes of one local tape segment. */
function tapeDigest(personaId: string, epoch: number, length: number): string {
	const hash = createHash("sha256");
	let offset = 0;
	while (offset < length) {
		const bytes = readSegmentBytes(personaId, epoch, offset, Math.min(256 * 1024, length - offset));
		if (bytes.length === 0) break;
		hash.update(bytes);
		offset += bytes.length;
	}
	return hash.digest("hex");
}

/** The owner's final word on its tape: bytes held and their fingerprints. */
function tapeCursor(personaId: string): ReplicaCursor {
	const cursor: ReplicaCursor = {};
	for (const [epoch, size] of Object.entries(segmentSizes(personaId))) {
		cursor[epoch] = { held: size, digest: tapeDigest(personaId, Number(epoch), size) };
	}
	return cursor;
}

function cursorsEqual(a: ReplicaCursor, b: ReplicaCursor): boolean {
	const epochs = Object.keys(a);
	if (epochs.length !== Object.keys(b).length) return false;
	return epochs.every(
		(epoch) => b[epoch] && a[epoch]!.held === b[epoch]!.held && a[epoch]!.digest === b[epoch]!.digest,
	);
}

/* ---------------------------------------------------------------- the way in */

/**
 * The hop, issued from anywhere: run here when this desk is the destination,
 * otherwise handed to the destination to drive.
 */
export async function requestHop(personaId: string, toNodeId: string): Promise<HopResult> {
	const bare = bareId(personaId);
	if (toNodeId === localNodeId()) return performHop(bare);
	const result = await callFleetPeer<HopResult>(
		toNodeId,
		"hopTeammate",
		{ personaId: bare },
		2 * 60_000,
	);
	if (!result) {
		return refuse(`Could not reach ${peerName(toNodeId)} to run the hop`);
	}
	return result;
}

/* ------------------------------------------------------- destination: drive */

/** The whole move, driven on the destination desk. */
export async function performHop(personaId: string): Promise<HopResult> {
	const bare = bareId(personaId);
	const record = getRecord("persona", bare);
	if (!record || record.deleted) return refuse(`No teammate ${bare}`);
	const owner = record.ownerNode;
	const name = typeof record.replicated.name === "string" ? record.replicated.name : bare;
	if (owner === localNodeId()) return refuse(`${name} already lives on this desk`);
	if (!peerOnline(owner)) {
		return refuse(`The desk that owns ${name} (${peerName(owner)}) is not reachable`);
	}

	// The ladder, before anything is asked of the owner: a teammate nothing
	// here can run must not be stopped, chaptered, or moved.
	const resolved = resolveTeammateHarness(bare, localNodeId());
	if (!resolved.ok) return refuse(resolved.error);
	const resolution = resolved.resolution;
	if (resolution.rung === "unavailable") {
		const verdicts = resolution.rungs
			.map((rung) => `${rung.rung} — ${rung.reason}`)
			.join("; ");
		return { ok: false, error: `Nothing on this desk runs ${name}: ${verdicts}`, rungs: resolution.rungs };
	}

	const prepared = await callFleetPeer<
		| { ok: true; cursor: ReplicaCursor; portable: Record<string, unknown> | null }
		| { ok: false; error: string }
	>(owner, "hopPrepare", { personaId: bare }, 90_000);
	if (!prepared) return refuse(`${peerName(owner)} did not answer the hop's prepare`);
	if (!prepared.ok) return refuse(prepared.error);

	// The mirror must reach the owner's final word — held bytes AND
	// fingerprints, the same proof replication itself trusts — before any claim.
	const deadline = Date.now() + REPLICA_WAIT_MS;
	for (;;) {
		if (cursorsEqual(prepared.cursor, replicaCursor(owner, bare))) break;
		if (Date.now() >= deadline) {
			return refuse(
				`This desk's replica of ${name} did not reach ${peerName(owner)}'s final cursor — nothing moved`,
			);
		}
		await new Promise((resolve) => setTimeout(resolve, REPLICA_POLL_MS));
	}

	// Somebody else may have claimed while we verified; the record is the truth.
	if (getRecord("persona", bare)?.ownerNode !== owner) {
		return refuse(`${name} changed desks while this hop was verifying — nothing moved`);
	}

	// Promotion: byte-identical mirrors become the tape, by rename. A segment
	// already here with the same fingerprint is a retried hop's own earlier
	// work; anything else is a fork and stops the move before the pivot.
	for (const [epochKey, entry] of Object.entries(prepared.cursor)) {
		const epoch = Number(epochKey);
		const held = segmentSizes(bare)[epochKey];
		if (held !== undefined) {
			if (held === entry.held && tapeDigest(bare, epoch, held) === entry.digest) continue;
			return refuse(`This desk already holds different bytes for ${name}'s epoch ${epochKey} — nothing moved`);
		}
		adoptSegment(bare, epoch, replicaSegmentFile(owner, bare, epoch));
	}

	// The pivot. The matched rung becomes the teammate's harness when it is not
	// the exact one — the destination must record what actually runs it here.
	const choice: HarnessChoice = resolution.choice;
	const replicated = { ...record.replicated };
	if (resolution.rung !== "exact") {
		replicated.backendId = choice.backendId;
		if (choice.modelId) replicated.modelId = choice.modelId;
		else delete replicated.modelId;
	}
	const claimed = claimLocal("persona", bare, {
		replicated,
		portable: prepared.portable ?? record.portable,
		machine: {},
	});

	// The teammate's working directory and managed goal, materialized where it
	// now lives. The cwd falls back to this desk's default workspace — pulling
	// the repo there is the goal's business, not the hop's.
	const persona = getPersona(bare);
	if (persona) {
		materializeWorkspace(persona);
		// The move is announced to the agent itself, not just the transcript:
		// parked on the machine class so it survives a restart, consumed once by
		// the message funnel ahead of the first words heard here — the same seam
		// for Toad Agent in-process and an ACP child, because both speak
		// through it.
		updatePersona(bare, {
			hopNotice: `${hopNoticeText(peerName(owner), nodeIdentity().name, process.platform)} The working directory here is ${persona.cwd}.`,
		});
	}

	// Courtesy call; the old owner's sweep covers a miss. Then every peer is
	// nudged to re-announce its cursors, so promoted history ships from the new
	// owner without waiting for the next link bounce.
	await callFleetPeer(owner, "hopDemote", { personaId: bare }, 15_000).catch(() => null);
	for (const peer of listFleetPeers()) {
		const wire = peerWireFor(peer.id);
		if (wire) void wire.call("replicaResync", {}, 10_000).catch(() => {});
	}
	deps.publish();

	return {
		ok: true,
		personaId: bare,
		from: owner,
		to: localNodeId(),
		epoch: claimed.ownerEpoch,
		rung: resolution.rung,
		choice,
	};
}

/* ------------------------------------------------------------ owner: prepare */

/**
 * The owner's half, on the destination's request. Everything here is harmless
 * to repeat: a stopped session stays stopped, a closed chapter stays closed,
 * and one more notice on the tape is one more true line.
 */
export async function handleHopPrepare(
	peerId: string,
	params: unknown,
): Promise<
	{ ok: true; cursor: ReplicaCursor; portable: Record<string, unknown> | null } | { ok: false; error: string }
> {
	const personaId = bareId(String((params as { personaId?: unknown } | null)?.personaId ?? ""));
	if (!personaId) return { ok: false, error: "personaId required" };
	const record = getRecord("persona", personaId);
	if (!record || record.deleted) return { ok: false, error: `No teammate ${personaId}` };
	if (record.ownerNode !== localNodeId()) {
		return { ok: false, error: `${nodeIdentity().name} does not own ${personaId}` };
	}
	const name = typeof record.replicated.name === "string" ? record.replicated.name : personaId;

	const state = deps.state(personaId);
	if (isBusy(state)) {
		return { ok: false, error: `${name} is ${state} — a hop waits for the turn to end` };
	}
	if (isUp(state)) await deps.stop(personaId);
	try {
		await deps.closeChapter(personaId);
	} catch {
		/* a chapter note that failed must not strand the move; the notice below
		 * still records the handoff */
	}

	// The handoff event: from-desk, to-desk, the destination's platform (its
	// advertisement is replicated, so the owner can name it), and the standing
	// instruction to verify the workspace before trusting it.
	append(personaId, {
		kind: "notice",
		id: `hop:${randomUUID()}`,
		ts: Date.now(),
		level: "info",
		text: hopNoticeText(
			nodeIdentity().name,
			peerName(peerId),
			deskCapabilities(peerId)?.capabilities.platform ?? "",
		),
	});

	return { ok: true, cursor: tapeCursor(personaId), portable: record.portable };
}

/* ------------------------------------------------------------- owner: demote */

/**
 * Moves this desk's tape segments for every persona the record store says
 * another desk now owns into the replica store under that owner. Idempotent
 * and record-driven, so the direct call, the sweep, and the startup pass are
 * the same act — and a desk that never hears any of them merely keeps inert
 * files that its own filters already stopped shipping or showing.
 */
export function demoteForeignTapes(): string[] {
	const demoted: string[] = [];
	for (const record of listRecords("persona")) {
		if (record.ownerNode === localNodeId()) continue;
		const files = segmentFiles(record.id);
		if (files.length === 0) continue;
		if (isUp(deps.state(record.id))) void deps.stop(record.id).catch(() => {});
		for (const file of files) {
			replicaAdopt(record.ownerNode, record.id, file.epoch, file.path);
		}
		demoted.push(record.id);
	}
	if (demoted.length > 0) deps.publish();
	return demoted;
}

/** The new owner says the record has flipped; demote as soon as we see it too. */
export async function handleHopDemote(
	_peerId: string,
	params: unknown,
): Promise<{ ok: boolean; error?: string }> {
	const personaId = bareId(String((params as { personaId?: unknown } | null)?.personaId ?? ""));
	if (!personaId) return { ok: false, error: "personaId required" };
	const deadline = Date.now() + FLIP_WAIT_MS;
	for (;;) {
		const record = getRecord("persona", personaId);
		if (!record || record.ownerNode !== localNodeId()) break;
		if (Date.now() >= deadline) {
			return { ok: false, error: "the record has not flipped here yet — the sweep will demote" };
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	demoteForeignTapes();
	return { ok: true };
}
