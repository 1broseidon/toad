import type { Envelope, SyncOp } from "../node/envelope";
import { isEnvelope } from "../node/envelope";
import { notifyMembersChanged } from "../node/members";
import { notifyCredentialsChanged, reconcileCredentialMaterial } from "../store/credentials";
import { notifyPushChanged, reconcilePushMaterial } from "../store/push";
import {
	appliedCursor,
	applyRemoteOps,
	localNodeId,
	onOplogAppended,
	oplogAfter,
	setAppliedCursor,
	storeDamaged,
} from "../store/records";
import { meshCount } from "./metrics";

/**
 * Persona replication between two admitted nodes: a log, not a snapshot.
 *
 * A link coming up says "of your first-hand ops, I have applied through seq N";
 * the other side drains its own oplog from there and then ships each local
 * commit as it happens. Both directions run independently, and nothing here
 * acknowledges, polls, or repeats: the receiver owns its durable cursor, and
 * the sender learns where to resume from the next session's hello. An idle mesh
 * therefore sends nothing at all, which is why there is no damper to write.
 *
 * Two invariants do the safety work. A node ships **only** ops it owns
 * (`oplogAfter` filtered by the local id, rung only by local writes), so an
 * applied remote op can never be re-shipped and a relayed third-node op cannot
 * exist. And every op is idempotent by `(kind, id, ownerEpoch, version)`, so a
 * dropped batch, a crash before the cursor write, and a full history resend all
 * converge on the same rows.
 *
 * This module never opens a socket and never speaks HTTP. It reaches the store
 * through records.ts and a peer through the `envelope()` its caller hands over.
 */

/** Ops per `sync.ops` frame. Bounds one frame, not the catch-up: the drain
 *  loops until the oplog read comes back empty. */
const SYNC_BATCH_LIMIT = 200;

type PeerLink = { envelope(env: Envelope): boolean };

type Session = {
	link: PeerLink;
	/** Highest own seq already sent to this peer; null until their hello. */
	shipped: number | null;
	/** True once catch-up has started, i.e. local commits ship as they land. */
	live: boolean;
	/** A drain is in flight; a doorbell during it must not interleave batches. */
	draining: boolean;
	/** A doorbell rang during a drain: re-read once the current one finishes. */
	again: boolean;
	/** The store latched damaged mid-session; stop touching it for this peer. */
	inboundDead: boolean;
};

type Hooks = {
	publishRoster(): void;
	markSeen(nodeId: string): void;
};

const sessions = new Map<string, Session>();
let hooks: Hooks | undefined;
let doorbell = false;

export function initSync(input: {
	/** Re-publishes the merged roster after remote persona ops applied. */
	publishRoster(): void;
	/** Stamps fleet.json lastSeenAt for one peer. */
	markSeen(nodeId: string): void;
}): void {
	hooks = input;
	// One registration per process, however many times a caller initialises:
	// the doorbell is a listener on a module-level list, and a second one would
	// only cost a redundant drain of an already-drained cursor.
	if (doorbell) return;
	doorbell = true;
	onOplogAppended(() => {
		// Deliberately ignores the notification's ops. The drain reads from the
		// ship cursor, so a missed doorbell costs latency and never an op — and
		// shipping the payload directly would be a second, unordered path.
		for (const [peerId, session] of sessions) {
			if (session.live) drain(peerId, session);
		}
	});
}

/** Peer link came up: send our hello, await theirs. */
export function syncLinkUp(peerId: string, link: PeerLink): void {
	// A node that cannot read its store cannot apply what a hello would bring
	// back, and has nothing to ship when the peer's hello arrives either. It
	// stays silently inert on the sync plane while the link serves RPC.
	if (storeDamaged()) return;
	sessions.set(peerId, {
		link,
		shipped: null,
		live: false,
		draining: false,
		again: false,
		inboundDead: false,
	});
	hooks?.markSeen(peerId);
	const sent = link.envelope({
		v: 1,
		src: localNodeId(),
		dst: peerId,
		kind: "sync.hello",
		payload: { cursor: appliedCursor(peerId) },
	});
	if (sent) meshCount("syncShip", "sync.hello", { nodeId: peerId });
}

/** Peer link dropped: forget the ship session (cursors stay durable). */
export function syncLinkDown(peerId: string): void {
	sessions.delete(peerId);
}

/** Every inbound envelope from the link's onEnvelope. */
export function receiveEnvelope(peerId: string, env: unknown): void {
	if (!isEnvelope(env)) {
		// Version skew or a bug, not an intruder — the HMAC already proved the
		// peer. Counted and dropped; closing the link would turn a malformed
		// frame into a reconnect storm.
		meshCount("syncDrop", "malformed", { nodeId: peerId });
		return;
	}
	if (env.src !== peerId || env.dst !== localNodeId()) {
		meshCount("syncDrop", env.kind, { nodeId: peerId });
		return;
	}
	const session = sessions.get(peerId);
	// No session means no link to answer on — a damaged store, or an envelope
	// arriving after the drop that removed it.
	if (!session) {
		meshCount("syncDrop", env.kind, { nodeId: peerId });
		return;
	}
	if (env.kind === "sync.hello") {
		openShipSession(peerId, session, env.payload.cursor);
		return;
	}
	applyBatch(peerId, session, env.src, env.payload.ops);
}

/** For tests and the verify harness. */
export function syncSnapshot(): Array<{
	nodeId: string;
	applied: number;
	shipped: number | null;
	live: boolean;
}> {
	return [...sessions].map(([nodeId, session]) => ({
		nodeId,
		applied: appliedCursor(nodeId),
		shipped: session.shipped,
		live: session.live,
	}));
}

/**
 * A hello sets where to resume from, then catch-up and live ops share one path.
 *
 * The reset is the interesting half: a cursor above every op this node owns
 * means the peer remembers a previous store of ours — moved aside and
 * re-migrated, restarting `AUTOINCREMENT` — and the only honest answer is the
 * whole history again, which idempotent replay makes cheap.
 */
function openShipSession(peerId: string, session: Session, cursor: number): void {
	session.shipped = beyondOurHistory(cursor) ? 0 : cursor;
	// Live before the drain, not after: a commit landing mid-catch-up has to
	// find this peer and set the re-run flag, or its op would wait for the next
	// session. The drain's own re-entry guard keeps the batches in order.
	session.live = true;
	drain(peerId, session);
}

/**
 * True when the peer's cursor sits above every op this node owns.
 *
 * Asked as "is there an op of mine at or after `cursor`?" so it costs one
 * indexed read rather than a max() the store does not export.
 */
function beyondOurHistory(cursor: number): boolean {
	if (cursor <= 0) return false;
	return oplogAfter(localNodeId(), cursor - 1, 1).length === 0;
}

/**
 * Ships this node's own ops from the ship cursor until the log runs out.
 *
 * Re-entrant by flag rather than by lock: a doorbell arriving mid-drain marks
 * the peer for one more pass instead of starting a second interleaved walk,
 * because two walkers reading the same cursor would ship overlapping batches
 * out of order and a receiver's plain-overwrite cursor would believe the last
 * one.
 */
function drain(peerId: string, session: Session): void {
	if (session.draining) {
		session.again = true;
		return;
	}
	session.draining = true;
	try {
		do {
			session.again = false;
			while (session.shipped !== null) {
				const ops = oplogAfter(localNodeId(), session.shipped, SYNC_BATCH_LIMIT);
				if (ops.length === 0) break;
				const sent = session.link.envelope({
					v: 1,
					src: localNodeId(),
					dst: peerId,
					kind: "sync.ops",
					payload: { ops },
				});
				// A link that will not take a frame is a link that is going
				// away; the fresh hello after reconnect resumes from the peer's
				// durable cursor, so there is nothing to retry here.
				if (!sent) return;
				meshCount("syncShip", "sync.ops", { nodeId: peerId });
				session.shipped = ops[ops.length - 1]?.seq ?? session.shipped;
			}
		} while (session.again);
	} finally {
		session.draining = false;
	}
}

/**
 * Applies one inbound batch, then bookmarks it.
 *
 * The cursor is written after the apply commits and deliberately not with it: a
 * crash in between re-delivers the same ops next session and every one of them
 * replays quietly, which is what lets `applyRemoteOps` stay untouched.
 */
function applyBatch(peerId: string, session: Session, src: string, ops: SyncOp[]): void {
	// First-hand only. An op about a third node's records is a relay, which
	// this version does not do in either direction.
	if (ops.some((op) => op.ownerNode !== src)) {
		meshCount("syncDrop", "sync.ops", { nodeId: peerId });
		return;
	}
	if (session.inboundDead) {
		meshCount("syncDrop", "inbound-dead", { nodeId: peerId });
		return;
	}
	const last = ops[ops.length - 1];
	if (!last) return;

	const result = applyRemoteOps(ops);
	if (result.applied) {
		remember(peerId, last.seq);
		meshCount("syncApply", "sync.ops", { nodeId: peerId });
		if (result.seqs.length > 0 && ops.some((op) => op.kind === "persona")) {
			hooks?.publishRoster();
		}
		// A member op landing here is another desk's admit, grant edit, or
		// revocation. The bell is what closes a revoked phone's sockets and
		// drops a revoked agent's access tokens — either seat, one bell.
		if (result.seqs.length > 0 && ops.some((op) => op.kind === "member")) {
			notifyMembersChanged();
		}
		if (result.seqs.length > 0 && ops.some((op) => op.kind === "credential")) {
			credentialsApplied();
		}
		hooks?.markSeen(peerId);
		return;
	}
	if (result.reason === "damaged") {
		// Durability rule: a damaged store is read-only until a person looks at
		// it. Nothing more from this peer touches it this session.
		session.inboundDead = true;
		meshCount("syncDrop", "damaged", { nodeId: peerId });
		return;
	}
	if (result.reason === "invalid") {
		// Should be unreachable: isEnvelope mirrors the store's own op shape
		// rules. Drop the frame and leave the cursor where it is.
		meshCount("syncDrop", "invalid", { nodeId: peerId });
		return;
	}
	applyStaleBatch(peerId, session, ops, last.seq);
}

/**
 * One op of the batch is behind a row this node already holds, so the all-or-
 * none apply refused the lot. Apply them one at a time instead.
 *
 * Skipping the refused op is safe because only the owner ever writes its
 * records' versions: a local row *ahead* of the owner's op can only have come
 * from that same owner, so the op is history this node has already superseded.
 * The cursor still advances past it — a stale op refused once refuses forever,
 * and re-requesting it would wedge the cursor there for good.
 */
function applyStaleBatch(
	peerId: string,
	session: Session,
	ops: SyncOp[],
	lastSeq: number,
): void {
	let fresh = false;
	let membersFresh = false;
	let credentialsFresh = false;
	let pushFresh = false;
	for (const op of ops) {
		const one = applyRemoteOps([op]);
		if (one.applied) {
			if (one.seqs.length > 0 && op.kind === "persona") fresh = true;
			if (one.seqs.length > 0 && op.kind === "member") membersFresh = true;
			if (one.seqs.length > 0 && op.kind === "credential") credentialsFresh = true;
			if (one.seqs.length > 0 && op.kind === "push") pushFresh = true;
			continue;
		}
		if (one.reason === "damaged") {
			session.inboundDead = true;
			meshCount("syncDrop", "damaged", { nodeId: peerId });
			return;
		}
		meshCount("syncDrop", one.reason === "stale" ? "stale-op" : "invalid", {
			nodeId: peerId,
		});
	}
	remember(peerId, lastSeq);
	if (fresh) hooks?.publishRoster();
	if (membersFresh) notifyMembersChanged();
	if (credentialsFresh) credentialsApplied();
	if (pushFresh) pushApplied();
	hooks?.markSeen(peerId);
}

/**
 * A peer's credential ops just landed here.
 *
 * The op that withdrew a copy already deleted it — the record it wrote has no
 * box for this desk in it, so there is nothing left to erase. What is left is
 * the *plaintext* case: a credential this desk owned and another desk now says
 * is revoked leaves a vault entry no record justifies, which is precisely the
 * live key on a machine the operator believes is clean. Then the bell, because
 * this desk's reach may have changed in either direction and the advertisement,
 * the built-in agent's key overlay, and the surface all follow from it.
 */
function credentialsApplied(): void {
	try {
		reconcileCredentialMaterial();
	} catch {
		/* An unreadable vault is loud on its own path; it must not fail a batch
		 * that has already committed. */
	}
	notifyCredentialsChanged();
}

/**
 * A peer's push ops just landed here.
 *
 * The same two consequences a credential op has, for the same two reasons. The
 * op that withdrew an address already deleted it — the record it wrote has no
 * box for this desk — but a registration this desk *owns* that another desk's
 * op has since superseded leaves a plaintext token in web.json that no record
 * justifies, and a prune note about a generation the phone has replaced is an
 * observation about a token that no longer exists. Then the bell, because the
 * set of phones this desk can reach may have changed in either direction.
 */
function pushApplied(): void {
	try {
		reconcilePushMaterial();
	} catch {
		/* An unwritable pairing file is loud on its own path; it must not fail a
		 * batch that has already committed. */
	}
	notifyPushChanged();
}

/**
 * Bookmarks the owner's seq, and never fails the frame over it.
 *
 * `setAppliedCursor` refuses a damaged store, and the store can latch damaged
 * between an apply and its bookmark. That window is exactly the crash the
 * cursor's non-atomicity already tolerates: the ops replay next session.
 */
function remember(peerId: string, seq: number): void {
	try {
		setAppliedCursor(peerId, seq);
	} catch {
		meshCount("syncDrop", "cursor", { nodeId: peerId });
	}
}
