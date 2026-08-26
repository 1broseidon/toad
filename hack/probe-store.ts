/**
 * One store round-trip, written to be run twice — from source and from a
 * bundle — because those are two different programs. See
 * hack/verify-store-bundle.ts.
 *
 * Prints one `key=value` line per result so the caller can assert on it
 * without parsing prose.
 */
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.TOAD_DATA_DIR = mkdtempSync(join(tmpdir(), "toad-probe-store-"));

const { applyRemoteOps, listRecords, putLocal, tombstoneLocal } = await import(
	"../src/bun/store/records"
);
const { STORE_FILE } = await import("../src/bun/paths");

putLocal("persona", "probe-ada", { replicated: { name: "Ada" } });
putLocal("persona", "probe-boris", { replicated: { name: "Boris" } });
tombstoneLocal("persona", "probe-boris");

// A same-(epoch, version) replay is idempotent success. A lower epoch is
// stale only after this node has already accepted a higher one.
const ahead = applyRemoteOps([
	{
		kind: "persona",
		id: "probe-ada",
		ownerNode: "peer-node",
		ownerEpoch: 2,
		version: 1,
		op: "put",
		payload: { name: "Ada-remote" },
		at: Date.now(),
	},
]);
if (!ahead.applied) {
	throw new Error(`expected the higher-epoch op to apply, got ${JSON.stringify(ahead)}`);
}

const stale = applyRemoteOps([
	{
		kind: "persona",
		id: "probe-ada",
		ownerNode: "peer-node",
		ownerEpoch: 1,
		version: 99,
		op: "put",
		payload: { name: "Stale" },
		at: Date.now(),
	},
]);
if (stale.applied || stale.reason !== "stale") {
	throw new Error(`expected stale refusal, got ${JSON.stringify(stale)}`);
}

const visible = listRecords("persona");
const includingGone = listRecords("persona", { includeTombstones: true });
if (visible.length !== 1 || visible[0]?.id !== "probe-ada") {
	throw new Error(`expected one live record, got ${visible.map((row) => row.id).join(",")}`);
}
if (includingGone.length !== 2) {
	throw new Error(`expected two rows including the tombstone, got ${includingGone.length}`);
}

const db = new Database(STORE_FILE, { readonly: true });
try {
	const rows = db
		.query<{ id: string; deleted: number; owner_epoch: number; version: number }, []>(
			"SELECT id, deleted, owner_epoch, version FROM resources ORDER BY id",
		)
		.all();
	const ops = db
		.query<{ id: string; op: string; owner_epoch: number; version: number }, []>(
			"SELECT id, op, owner_epoch, version FROM oplog ORDER BY seq",
		)
		.all();

	if (rows.length !== 2) throw new Error(`expected 2 resource rows, got ${rows.length}`);
	const ada = rows.find((row) => row.id === "probe-ada");
	const boris = rows.find((row) => row.id === "probe-boris");
	if (ada?.deleted !== 0 || ada.owner_epoch !== 2) {
		throw new Error(`unexpected ada row ${JSON.stringify(ada)}`);
	}
	if (boris?.deleted !== 1) {
		throw new Error(`expected boris tombstone, got ${JSON.stringify(boris)}`);
	}
	if (!ops.some((op) => op.id === "probe-boris" && op.op === "tombstone")) {
		throw new Error(`missing tombstone op: ${JSON.stringify(ops)}`);
	}
	if (ops.some((op) => op.id === "probe-ada" && op.owner_epoch === 1 && op.version === 99)) {
		throw new Error("stale op was written to the oplog");
	}

	console.log(`stale=refused`);
	console.log(`visible=${visible.length}`);
	console.log(`rows=${rows.length}`);
	console.log(`oplog=${ops.length}`);
} finally {
	db.close();
}
