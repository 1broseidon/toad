import type { ResourceOp } from "../store/records";

/**
 * The one typed value new inter-node frames carry.
 *
 * Every future inter-node message is a `{ v, src, dst, kind, payload }` value
 * riding inside the existing HMAC-sealed NodeLink body, rather than a new
 * top-level frame member per feature. The link already authenticates both ends,
 * so `src`/`dst` are routing sanity — not proof — and nothing here carries auth
 * material, a frame-level idempotency key, or a record version: the store's
 * `(kind, id, ownerEpoch, version)` key is the only one that decides whether an
 * op is news.
 */

/** An op as shipped: the owner's oplog row, seq included so the
 *  receiver can advance its applied cursor. */
export type SyncOp = ResourceOp & { seq: number };

type EnvelopeBase = {
	/** Envelope version. Literal 1. Required. */
	v: 1;
	/** Sender's NodeIdentity id. Required; must equal the link's peer id. */
	src: string;
	/** Receiver's NodeIdentity id. Required; must equal the local id. */
	dst: string;
	/**
	 * Correlation id, reserved for future request/response kinds. Both sync
	 * kinds are one-way and never set it. Optional.
	 */
	corr?: string;
};

export type Envelope =
	| (EnvelopeBase & { kind: "sync.hello"; payload: { cursor: number } })
	| (EnvelopeBase & { kind: "sync.ops"; payload: { ops: SyncOp[] } });

function isObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * The same shape rules the store enforces on an op, plus the shipped seq.
 *
 * Checked here so a malformed op never reaches a transaction: the store's own
 * refusal would answer `invalid` for the whole batch, which is a worse place to
 * learn that a peer is running a different version.
 */
function isSyncOp(value: unknown): value is SyncOp {
	if (!isObject(value)) return false;
	return (
		value.kind === "persona" &&
		typeof value.id === "string" &&
		value.id.length > 0 &&
		typeof value.ownerNode === "string" &&
		value.ownerNode.length > 0 &&
		Number.isInteger(value.ownerEpoch) &&
		(value.ownerEpoch as number) >= 1 &&
		Number.isInteger(value.version) &&
		(value.version as number) >= 1 &&
		(value.op === "put" || value.op === "tombstone") &&
		isObject(value.payload) &&
		Number.isInteger(value.at) &&
		Number.isInteger(value.seq) &&
		(value.seq as number) >= 1
	);
}

/** Structural check only: shape, kinds, integer cursor ≥ 0, non-empty ops
 *  array with each op passing the same shape rules records.ts enforces.
 *  Sender/receiver identity is the caller's check, not this one. */
export function isEnvelope(value: unknown): value is Envelope {
	if (!isObject(value)) return false;
	if (value.v !== 1) return false;
	if (typeof value.src !== "string" || value.src.length === 0) return false;
	if (typeof value.dst !== "string" || value.dst.length === 0) return false;
	if (value.corr !== undefined && typeof value.corr !== "string") return false;
	if (!isObject(value.payload)) return false;
	if (value.kind === "sync.hello") {
		const cursor = value.payload.cursor;
		return Number.isInteger(cursor) && (cursor as number) >= 0;
	}
	if (value.kind === "sync.ops") {
		const ops = value.payload.ops;
		return Array.isArray(ops) && ops.length > 0 && ops.every(isSyncOp);
	}
	return false;
}
