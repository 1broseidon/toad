import { Database } from "bun:sqlite";
import { STORE_FILE, STORE_SNAPSHOT_FILE, ensureLayout } from "../paths";
import { saveJson } from "./durable";

/**
 * The record store: the roster as owner-stamped records rather than a file.
 *
 * A JSON array cannot say who owns a row, which of two edits happened later,
 * or that a teammate was deleted rather than never seen. This store can. Every
 * record carries the node that owns it, a fencing `ownerEpoch` that only an
 * ownership transfer moves, and a `version` that orders edits within one
 * epoch. Deletes leave tombstones so a peer that was offline still learns
 * them, and every replicated-class change appends to a local oplog that a
 * later sync phase can ship.
 *
 * Three classes of state, kept apart on purpose. **Replicated** fields are the
 * teammate's identity and go everywhere. **Portable** fields travel only when
 * the agent itself moves. **Machine-bound** fields — a working directory, a
 * harness session id — mean nothing anywhere else and never leave. Only a
 * replicated change bumps the version, so checkpointing a session forty times
 * an hour never makes a teammate look edited to anyone else.
 *
 * Nothing here talks to the network, and nothing here increments an epoch.
 * `applyRemoteOps` and `oplogAfter` have no callers yet; they exist so the
 * phases that do have callers inherit this transaction shape instead of
 * inventing a second one.
 */

export type ResourceKind = "persona" | "member" | "room" | "desk" | "credential" | "push";

/** Every kind the store accepts, for shape checks here and on the wire. */
export const RESOURCE_KINDS: readonly ResourceKind[] = [
	"persona",
	"member",
	"room",
	"desk",
	"credential",
	"push",
];

export type ResourceMeta = {
	kind: ResourceKind;
	id: string;
	ownerNode: string;
	ownerEpoch: number;
	version: number;
	updatedAt: number;
	deleted: boolean;
};

export type ResourceRecord = ResourceMeta & {
	replicated: Record<string, unknown>;
	portable: Record<string, unknown> | null;
	machine: Record<string, unknown> | null;
};

export type ResourceOp = {
	kind: ResourceKind;
	id: string;
	ownerNode: string;
	ownerEpoch: number;
	version: number;
	op: "put" | "tombstone";
	payload: Record<string, unknown>;
	at: number;
};

export type ApplyResult =
	| { applied: true; seqs: number[] }
	| { applied: false; reason: "stale" | "damaged" | "invalid"; opIndex?: number };

type Row = {
	kind: string;
	id: string;
	owner_node: string;
	owner_epoch: number;
	version: number;
	updated_at: number;
	deleted: number;
	replicated: string;
	portable: string | null;
	machine: string | null;
};

type OplogRow = {
	seq: number;
	owner_node: string;
	kind: string;
	id: string;
	owner_epoch: number;
	version: number;
	op: string;
	payload: string;
	at: number;
};

/**
 * One unit of work for the fenced transaction below.
 *
 * A local write and a remote op differ only in where the pieces come from: an
 * op carries the replicated class, the two local classes ride alongside it,
 * and a patch that touches neither replicated field simply has no op.
 */
type Entry = {
	kind: ResourceKind;
	id: string;
	at: number;
	op?: ResourceOp;
	portable?: Record<string, unknown> | null;
	machine?: Record<string, unknown> | null;
};

const SELECT_ROW = "SELECT * FROM resources WHERE kind = ? AND id = ?";

let db: Database | undefined;
let damaged = false;
let attempted = false;

/**
 * Marks the whole batch for rollback without being mistaken for a real fault.
 *
 * `Database.transaction` rolls back on any throw and rethrows it, which is the
 * only way out of a half-applied batch; the caller catches this one back and
 * answers with the refusal it recorded.
 */
const ROLLBACK = new Error("roster store: batch rejected");

let localNode: string | undefined;

/**
 * The local node id, resolved on first use rather than at import.
 *
 * `node/identity` reaches `web/devices` for the install id it preserves. A
 * static import would put that — and the files it touches — in the graph of
 * every module that only wanted to read the roster, so the require stays
 * inside the one function that needs an owner to stamp.
 */
function ownerNode(): string {
	if (localNode) return localNode;
	const identity = require("../node/identity") as typeof import("../node/identity");
	localNode = identity.nodeIdentity().id;
	return localNode;
}

/**
 * The same owner id, for callers outside this module.
 *
 * Sync needs it twice: to read back only its own first-hand ops, and to know
 * which owner's records it must never accept from a peer. Both questions are
 * about the id records are *stamped* with, so they ask the stamper rather than
 * resolving identity a second way.
 */
export function localNodeId(): string {
	return ownerNode();
}

function createSchema(database: Database): void {
	database.run(`CREATE TABLE IF NOT EXISTS meta (
		key   TEXT PRIMARY KEY,
		value TEXT NOT NULL
	) STRICT`);
	database.run(`CREATE TABLE IF NOT EXISTS resources (
		kind        TEXT    NOT NULL,
		id          TEXT    NOT NULL,
		owner_node  TEXT    NOT NULL,
		owner_epoch INTEGER NOT NULL,
		version     INTEGER NOT NULL,
		updated_at  INTEGER NOT NULL,
		deleted     INTEGER NOT NULL DEFAULT 0,
		replicated  TEXT    NOT NULL,
		portable    TEXT,
		machine     TEXT,
		PRIMARY KEY (kind, id)
	) STRICT`);
	database.run(`CREATE TABLE IF NOT EXISTS oplog (
		seq         INTEGER PRIMARY KEY AUTOINCREMENT,
		owner_node  TEXT    NOT NULL,
		kind        TEXT    NOT NULL,
		id          TEXT    NOT NULL,
		owner_epoch INTEGER NOT NULL,
		version     INTEGER NOT NULL,
		op          TEXT    NOT NULL CHECK (op IN ('put','tombstone')),
		payload     TEXT    NOT NULL,
		at          INTEGER NOT NULL
	) STRICT`);
	// The idempotency key is the record and its epoch, not the sender: two
	// peers relaying the same change must not append it twice.
	database.run(
		"CREATE UNIQUE INDEX IF NOT EXISTS oplog_idempotent ON oplog (kind, id, owner_epoch, version)",
	);
	database.run("CREATE INDEX IF NOT EXISTS oplog_by_owner ON oplog (owner_node, seq)");
	database.run(`CREATE TABLE IF NOT EXISTS applied_cursor (
		owner_node  TEXT    PRIMARY KEY,
		applied_seq INTEGER NOT NULL
	) STRICT`);

	database.run(
		"INSERT INTO meta (key, value) VALUES ('schema_version', '1') ON CONFLICT(key) DO NOTHING",
	);
}

function integrityOk(database: Database): boolean {
	const rows = database.query("PRAGMA quick_check").values() as unknown[][];
	return rows.length === 1 && rows[0]?.[0] === "ok";
}

/**
 * Opens the store once, latching it damaged rather than repairing it.
 *
 * A file that will not open, or that fails `quick_check`, is the only copy of
 * a roster somebody typed. Recreating it would answer "empty" for state that
 * is merely unreadable, and the first write after that would make the loss
 * real. So the latch closes, reads answer empty, writes refuse, and the bytes
 * stay exactly where they are for someone to look at.
 */
function open(): Database | undefined {
	if (attempted) return db;
	attempted = true;
	// Outside the try: a data-root mismatch is a wiring bug in the caller, not
	// a damaged database, and it must stay loud.
	ensureLayout();
	let opening: Database | undefined;
	try {
		opening = new Database(STORE_FILE, { create: true });
		opening.run("PRAGMA journal_mode = WAL");
		// The roster is irreplaceable and its writes are rare. Pay the fsync.
		opening.run("PRAGMA synchronous = FULL");
		if (!integrityOk(opening)) throw new Error("quick_check failed");
		createSchema(opening);
		db = opening;
	} catch {
		try {
			opening?.close();
		} catch {
			/* a handle that will not close is still a handle nothing will use */
		}
		damaged = true;
		db = undefined;
		return undefined;
	}

	const database = db;
	if (!database) return undefined;
	// Stamped after the latch, and deliberately outside it: an identity this
	// node cannot read is a broken install, not a damaged store, and saying
	// otherwise would send someone to repair the wrong file. Recorded rather
	// than enforced — a copied database is a later phase's problem.
	if (!database.query("SELECT value FROM meta WHERE key = 'node_id'").get()) {
		database.run("INSERT INTO meta (key, value) VALUES ('node_id', ?)", [ownerNode()]);
	}
	exportSnapshot();
	return database;
}

function refuse(): never {
	throw new Error(
		`Refusing to write to a damaged record store at ${STORE_FILE}. ` +
			"Restore it by hand from store-snapshot.json, or move it aside so the " +
			"roster is rebuilt from config.json.",
	);
}

function objectOf(text: string | null): Record<string, unknown> | null {
	if (text === null) return null;
	try {
		const parsed = JSON.parse(text) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

function jsonOrNull(value: Record<string, unknown> | null | undefined): string | null {
	return value == null ? null : JSON.stringify(value);
}

function recordOf(row: Row): ResourceRecord {
	return {
		kind: row.kind as ResourceKind,
		id: row.id,
		ownerNode: row.owner_node,
		ownerEpoch: row.owner_epoch,
		version: row.version,
		updatedAt: row.updated_at,
		deleted: row.deleted === 1,
		replicated: objectOf(row.replicated) ?? {},
		portable: objectOf(row.portable),
		machine: objectOf(row.machine),
	};
}

function opOf(row: OplogRow): ResourceOp & { seq: number } {
	return {
		seq: row.seq,
		kind: row.kind as ResourceKind,
		id: row.id,
		ownerNode: row.owner_node,
		ownerEpoch: row.owner_epoch,
		version: row.version,
		op: row.op as "put" | "tombstone",
		payload: objectOf(row.payload) ?? {},
		at: row.at,
	};
}

function isObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validOp(op: ResourceOp): boolean {
	return (
		isObject(op) &&
		RESOURCE_KINDS.includes(op.kind) &&
		typeof op.id === "string" &&
		op.id.length > 0 &&
		typeof op.ownerNode === "string" &&
		op.ownerNode.length > 0 &&
		Number.isInteger(op.ownerEpoch) &&
		op.ownerEpoch >= 1 &&
		Number.isInteger(op.version) &&
		op.version >= 1 &&
		(op.op === "put" || op.op === "tombstone") &&
		isObject(op.payload) &&
		Number.isInteger(op.at)
	);
}

/** Higher epoch wins outright; version only orders edits inside one epoch. */
function wins(op: ResourceOp, row: Row): boolean {
	if (op.ownerEpoch !== row.owner_epoch) return op.ownerEpoch > row.owner_epoch;
	return op.version > row.version;
}

type Outcome = { seq?: number; reject?: ApplyResult };

function applyEntry(database: Database, entry: Entry, index: number): Outcome {
	const op = entry.op;
	// Shape first: a malformed op must not reach a query, let alone a row.
	if (op && !validOp(op)) return { reject: { applied: false, reason: "invalid", opIndex: index } };

	const current = database.query<Row, [string, string]>(SELECT_ROW).get(entry.kind, entry.id);

	if (op) {
		if (current && !wins(op, current)) {
			// The op is at or behind what this node already holds. If it is
			// literally the change we recorded, saying so again is a replay and
			// succeeds quietly; anything else is a sender working from history
			// this node has moved past, and the whole batch stops.
			const seen = database
				.query<{ seq: number }, [string, string, number, number]>(
					"SELECT seq FROM oplog WHERE kind = ? AND id = ? AND owner_epoch = ? AND version = ? LIMIT 1",
				)
				.get(op.kind, op.id, op.ownerEpoch, op.version);
			if (seen) return {};
			return { reject: { applied: false, reason: "stale", opIndex: index } };
		}
	}

	const tombstone = op?.op === "tombstone";
	// A tombstone releases the state that belonged to this node's copy and
	// keeps the last replicated JSON, so a reader still knows who was deleted.
	const portable = tombstone
		? null
		: "portable" in entry
			? jsonOrNull(entry.portable)
			: (current?.portable ?? null);
	const machine = tombstone
		? null
		: "machine" in entry
			? jsonOrNull(entry.machine)
			: (current?.machine ?? null);

	database.run(
		`INSERT INTO resources
		   (kind, id, owner_node, owner_epoch, version, updated_at, deleted, replicated, portable, machine)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(kind, id) DO UPDATE SET
		   owner_node = excluded.owner_node, owner_epoch = excluded.owner_epoch,
		   version = excluded.version, updated_at = excluded.updated_at,
		   deleted = excluded.deleted, replicated = excluded.replicated,
		   portable = excluded.portable, machine = excluded.machine`,
		[
			entry.kind,
			entry.id,
			op?.ownerNode ?? current?.owner_node ?? ownerNode(),
			op?.ownerEpoch ?? current?.owner_epoch ?? 1,
			op?.version ?? current?.version ?? 1,
			op?.at ?? entry.at,
			tombstone ? 1 : op ? 0 : (current?.deleted ?? 0),
			op?.op === "put" ? JSON.stringify(op.payload) : (current?.replicated ?? "{}"),
			portable,
			machine,
		],
	);

	if (!op) return {};

	const inserted = database
		.query<{ seq: number }, [string, string, string, number, number, string, string, number]>(
			`INSERT INTO oplog (owner_node, kind, id, owner_epoch, version, op, payload, at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING seq`,
		)
		.get(
			op.ownerNode,
			op.kind,
			op.id,
			op.ownerEpoch,
			op.version,
			op.op,
			JSON.stringify(op.payload),
			op.at,
		);
	return { seq: inserted?.seq };
}

/**
 * The one write path. Every entry lands or none of them do.
 *
 * A move in a later phase is a batch of ops that must arrive together — half a
 * moved agent is worse than none of it — so local writes take the same road
 * from the first day, and the road is exercised long before a remote uses it.
 */
function runFenced(entries: Entry[]): ApplyResult {
	const database = open();
	if (!database) return { applied: false, reason: "damaged" };

	const seqs: number[] = [];
	let rejection: ApplyResult | undefined;
	const batch = database.transaction(() => {
		seqs.length = 0;
		for (const [index, entry] of entries.entries()) {
			const outcome = applyEntry(database, entry, index);
			if (outcome.reject) {
				rejection = outcome.reject;
				throw ROLLBACK;
			}
			if (outcome.seq !== undefined) seqs.push(outcome.seq);
		}
	});

	try {
		batch();
	} catch (error) {
		if (rejection) return rejection;
		throw error;
	}
	return { applied: true, seqs };
}

/** True when the db failed to open or `quick_check`. Reads answer empty; writes throw. */
export function storeDamaged(): boolean {
	open();
	return damaged;
}

export function getRecord(kind: ResourceKind, id: string): ResourceRecord | undefined {
	const database = open();
	if (!database) return undefined;
	const row = database.query<Row, [string, string]>(SELECT_ROW).get(kind, id);
	return row ? recordOf(row) : undefined;
}

export function listRecords(
	kind: ResourceKind,
	opts?: { includeTombstones?: boolean },
): ResourceRecord[] {
	const database = open();
	if (!database) return [];
	const where = opts?.includeTombstones ? "" : " AND deleted = 0";
	return database
		.query<Row, [string]>(`SELECT * FROM resources WHERE kind = ?${where} ORDER BY rowid`)
		.all(kind)
		.map(recordOf);
}

/** The record's `ownerEpoch`; 1 when the record does not exist. */
export function currentEpoch(kind: ResourceKind, id: string): number {
	const database = open();
	if (!database) return 1;
	const row = database
		.query<{ owner_epoch: number }, [string, string]>(
			"SELECT owner_epoch FROM resources WHERE kind = ? AND id = ?",
		)
		.get(kind, id);
	return row?.owner_epoch ?? 1;
}

const appendListeners: Array<(ops: Array<ResourceOp & { seq: number }>) => void> = [];

/**
 * Registers a doorbell for committed local writes.
 *
 * `putLocal` and `tombstoneLocal` ring it with the rows they appended;
 * `applyRemoteOps` never does. That asymmetry is the loop brake: a node cannot
 * be told to ship an op it only just received, because the only thing that
 * rings is a change this node made itself. It is a doorbell rather than a
 * delivery — a listener that misses one loses latency, not an op, because the
 * ops are still in the log for `oplogAfter` to read.
 */
export function onOplogAppended(
	listener: (ops: Array<ResourceOp & { seq: number }>) => void,
): void {
	appendListeners.push(listener);
}

/**
 * Rings every listener once, after the transaction that appended these seqs.
 *
 * A listener is somebody else's code — a socket that just closed, a peer table
 * mid-rewrite. It must not be able to fail a write that is already committed,
 * so each one is called in its own try and a thrower costs only its own turn.
 */
function notifyAppended(seqs: number[]): void {
	if (seqs.length === 0 || appendListeners.length === 0) return;
	const database = open();
	if (!database) return;
	const query = database.query<OplogRow, [number]>("SELECT * FROM oplog WHERE seq = ?");
	const ops: Array<ResourceOp & { seq: number }> = [];
	for (const seq of seqs) {
		const row = query.get(seq);
		if (row) ops.push(opOf(row));
	}
	if (ops.length === 0) return;
	for (const listener of appendListeners) {
		try {
			listener(ops);
		} catch {
			/* a listener's fault is not the writer's problem */
		}
	}
}

/**
 * Local mutation, in one transaction.
 *
 * The patch carries whole class values, not diffs. A patch that names
 * `replicated` bumps the version and appends an oplog op; a patch that names
 * only `portable` or `machine` moves `updated_at` and nothing else, so private
 * churn — a checkpoint, a mode switch, a working directory — never makes a
 * teammate look edited on anybody else's desk.
 *
 * Creating a record stamps version 1, epoch 1, and this node as the owner.
 * Nothing in this phase moves an epoch afterwards.
 */
export function putLocal(
	kind: ResourceKind,
	id: string,
	patch: {
		replicated?: Record<string, unknown>;
		portable?: Record<string, unknown> | null;
		machine?: Record<string, unknown> | null;
	},
): ResourceRecord {
	const database = open();
	if (!database) refuse();

	const current = database.query<Row, [string, string]>(SELECT_ROW).get(kind, id);
	// A brand-new row with no replicated class would exist only as private
	// state — no oplog op, no identity a peer could learn. The facade always
	// creates with a name; refuse the intersection the spec left open.
	if (!current && !patch.replicated) {
		throw new Error(`Roster store cannot create ${kind}/${id} without a replicated class`);
	}
	const at = Date.now();
	const entry: Entry = { kind, id, at };
	if (patch.replicated) {
		entry.op = {
			kind,
			id,
			ownerNode: ownerNode(),
			ownerEpoch: current?.owner_epoch ?? 1,
			version: current ? current.version + 1 : 1,
			op: "put",
			payload: patch.replicated,
			at,
		};
	}
	if ("portable" in patch) entry.portable = patch.portable ?? null;
	if ("machine" in patch) entry.machine = patch.machine ?? null;

	const result = runFenced([entry]);
	if (!result.applied) {
		if (result.reason === "damaged") refuse();
		throw new Error(`Roster store refused a local write to ${kind}/${id}: ${result.reason}`);
	}
	exportSnapshot();
	// A patch that named no replicated class appended nothing, so there is no
	// doorbell to ring: private churn is not news to anybody else.
	notifyAppended(result.seqs);

	const saved = getRecord(kind, id);
	if (!saved) throw new Error(`Roster store lost ${kind}/${id} immediately after writing it`);
	return saved;
}

/**
 * Takes ownership of a record another node owns — the hop's atomic pivot.
 *
 * The claim is one op: this node as owner, the epoch bumped past the previous
 * owner's, version restarted at 1. "Higher epoch wins outright" is what makes
 * it total — every member that hears the op flips to the new owner regardless
 * of how many edits the old epoch had, and the old owner's still-shipping ops
 * refuse quietly as stale. The replicated payload defaults to what the record
 * already says (identity travels unchanged); the machine class defaults to
 * empty because machine-bound state never survives a move.
 */
export function claimLocal(
	kind: ResourceKind,
	id: string,
	patch?: {
		replicated?: Record<string, unknown>;
		portable?: Record<string, unknown> | null;
		machine?: Record<string, unknown> | null;
	},
): ResourceRecord {
	const database = open();
	if (!database) refuse();

	const current = database.query<Row, [string, string]>(SELECT_ROW).get(kind, id);
	if (!current || current.deleted === 1) {
		throw new Error(`Roster store cannot claim ${kind}/${id}: no such live record`);
	}
	if (current.owner_node === ownerNode()) {
		throw new Error(`Roster store refuses to claim ${kind}/${id}: this node already owns it`);
	}

	const at = Date.now();
	const entry: Entry = {
		kind,
		id,
		at,
		op: {
			kind,
			id,
			ownerNode: ownerNode(),
			ownerEpoch: current.owner_epoch + 1,
			version: 1,
			op: "put",
			payload: patch?.replicated ?? objectOf(current.replicated) ?? {},
			at,
		},
		portable: patch?.portable ?? null,
		machine: patch?.machine ?? null,
	};

	const result = runFenced([entry]);
	if (!result.applied) {
		if (result.reason === "damaged") refuse();
		throw new Error(`Roster store refused to claim ${kind}/${id}: ${result.reason}`);
	}
	exportSnapshot();
	notifyAppended(result.seqs);

	const saved = getRecord(kind, id);
	if (!saved) throw new Error(`Roster store lost ${kind}/${id} immediately after claiming it`);
	return saved;
}

/**
 * Deletes by remembering the delete.
 *
 * Removing the row would let a peer that was offline hand the teammate back on
 * its next sync. The tombstone keeps the last replicated JSON so the record
 * stays legible, drops the portable and machine classes it no longer owns, and
 * appends an op that carries the delete to anyone still behind.
 */
export function tombstoneLocal(kind: ResourceKind, id: string): void {
	const database = open();
	if (!database) refuse();

	const current = database.query<Row, [string, string]>(SELECT_ROW).get(kind, id);
	const at = Date.now();
	const result = runFenced([
		{
			kind,
			id,
			at,
			op: {
				kind,
				id,
				ownerNode: ownerNode(),
				ownerEpoch: current?.owner_epoch ?? 1,
				version: current ? current.version + 1 : 1,
				op: "tombstone",
				payload: {},
				at,
			},
		},
	]);
	if (!result.applied) {
		if (result.reason === "damaged") refuse();
		throw new Error(`Roster store refused to tombstone ${kind}/${id}: ${result.reason}`);
	}
	exportSnapshot();
	notifyAppended(result.seqs);
}

/**
 * RESERVED — nothing calls this yet.
 *
 * It is here so the sync and handover phases inherit the all-or-none shape
 * `putLocal` already runs through, rather than growing a second, subtly
 * different one when there is a peer on the other end to get it wrong with.
 */
export function applyRemoteOps(ops: ResourceOp[]): ApplyResult {
	if (storeDamaged()) return { applied: false, reason: "damaged" };
	// Shape is checked before a transaction opens: an op that names no record
	// has nothing to fence against, and neither does the batch carrying it.
	const malformed = ops.findIndex((op) => !validOp(op));
	if (malformed !== -1) return { applied: false, reason: "invalid", opIndex: malformed };
	return runFenced(ops.map((op) => ({ kind: op.kind, id: op.id, at: op.at, op })));
}

/** RESERVED read for the sync phase: this owner's ops after `afterSeq`, ascending. */
export function oplogAfter(
	ownerNode: string,
	afterSeq: number,
	limit?: number,
): Array<ResourceOp & { seq: number }> {
	const database = open();
	if (!database) return [];
	return database
		.query<OplogRow, [string, number, number]>(
			"SELECT * FROM oplog WHERE owner_node = ? AND seq > ? ORDER BY seq ASC LIMIT ?",
		)
		.all(ownerNode, afterSeq, limit ?? -1)
		.map(opOf);
}

/**
 * How far this node has applied one owner's ops, durably.
 *
 * Zero is the honest answer for an owner never synced, and also for a damaged
 * store: a node that cannot read cannot claim to have applied anything, and
 * asking for a history it already holds costs a replay that changes nothing.
 */
export function appliedCursor(ownerNode: string): number {
	const database = open();
	if (!database) return 0;
	const row = database
		.query<{ applied_seq: number }, [string]>(
			"SELECT applied_seq FROM applied_cursor WHERE owner_node = ?",
		)
		.get(ownerNode);
	return row?.applied_seq ?? 0;
}

/**
 * Moves the bookmark, in either direction.
 *
 * Deliberately an overwrite and not a `max()`. An owner whose store was moved
 * aside and rebuilt restarts its `AUTOINCREMENT`, so its seqs legitimately
 * come back lower than the ones this node once applied; a monotonic cursor
 * would sit above the whole new history and silently skip it forever.
 */
export function setAppliedCursor(ownerNode: string, seq: number): void {
	const database = open();
	if (!database) refuse();
	database.run(
		`INSERT INTO applied_cursor (owner_node, applied_seq) VALUES (?, ?)
		 ON CONFLICT(owner_node) DO UPDATE SET applied_seq = excluded.applied_seq`,
		[ownerNode, seq],
	);
}

/**
 * Forgets one owner entirely: its records, its ops, and its cursor.
 *
 * The single sanctioned deletion from an otherwise append-only log, for the
 * moment a peer is revoked. Leaving the rows would keep a revoked machine's
 * teammates on screen, and leaving the cursor would make a re-admission resume
 * mid-history instead of learning the room again from zero.
 *
 * The local owner is refused: this node's oplog is the only copy of its own
 * history, and a caller that asks to erase it is a bug, not a cleanup.
 */
export function purgeOwner(ownerNode: string): void {
	const database = open();
	if (!database) refuse();
	if (ownerNode === localNodeId()) {
		throw new Error(`Roster store refuses to purge its own owner ${ownerNode}`);
	}
	database.transaction(() => {
		database.run("DELETE FROM resources WHERE owner_node = ?", [ownerNode]);
		database.run("DELETE FROM oplog WHERE owner_node = ?", [ownerNode]);
		database.run("DELETE FROM applied_cursor WHERE owner_node = ?", [ownerNode]);
	})();
	exportSnapshot();
}

/**
 * Writes the whole store out as plain JSON, for eyes rather than for code.
 *
 * SQLite is not something a person can read over somebody's shoulder or
 * rescue a name out of with a text editor. This file can be, and it is written
 * atomically beside a backup, so the cost of keeping one is a few kilobytes
 * after each roster edit. The app never reads it back.
 */
export function exportSnapshot(): void {
	const database = open();
	if (!database) return;
	const resources = database
		.query<Row, []>("SELECT * FROM resources ORDER BY rowid")
		.all()
		.map(recordOf);
	saveJson(STORE_SNAPSHOT_FILE, {
		version: 1,
		exportedAt: Date.now(),
		nodeId: ownerNode(),
		resources,
	});
}
