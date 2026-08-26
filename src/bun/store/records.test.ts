import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The throwaway root comes from test/preload.ts. Setting TOAD_DATA_DIR here
// would be far too late: these imports resolve it.
const { STORE_FILE, STORE_SNAPSHOT_FILE } = await import("../paths");
const records = await import("./records");

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

/** Reads the oplog over a second connection, so the tests never take the module's word for it. */
function oplog(id?: string): OplogRow[] {
	const db = new Database(STORE_FILE, { readonly: true });
	try {
		return id
			? db.query<OplogRow, [string]>("SELECT * FROM oplog WHERE id = ? ORDER BY seq").all(id)
			: db.query<OplogRow, []>("SELECT * FROM oplog ORDER BY seq").all();
	} finally {
		db.close();
	}
}

function remotePut(id: string, version: number, payload: Record<string, unknown>) {
	return {
		kind: "persona" as const,
		id,
		ownerNode: "peer-node",
		ownerEpoch: 1,
		version,
		op: "put" as const,
		payload,
		at: Date.now(),
	};
}

describe("record store", () => {
	test("create, update and tombstone round-trip", () => {
		const created = records.putLocal("persona", "round-trip", {
			replicated: { name: "Ada", goal: "prove it", createdAt: 1 },
			portable: { subagents: ["helper"] },
			machine: { cwd: "/tmp/ada" },
		});

		expect(created.version).toBe(1);
		expect(created.ownerEpoch).toBe(1);
		expect(created.ownerNode.length).toBeGreaterThan(0);
		expect(created.deleted).toBe(false);
		expect(created.replicated.name).toBe("Ada");
		expect(created.portable).toEqual({ subagents: ["helper"] });
		expect(created.machine).toEqual({ cwd: "/tmp/ada" });

		const updated = records.putLocal("persona", "round-trip", {
			replicated: { name: "Ada Lovelace", goal: "prove it", createdAt: 1 },
		});
		expect(updated.version).toBe(2);
		expect(updated.ownerEpoch).toBe(1);
		// An untouched class survives a patch that does not name it.
		expect(updated.machine).toEqual({ cwd: "/tmp/ada" });
		expect(records.getRecord("persona", "round-trip")?.replicated.name).toBe("Ada Lovelace");

		records.tombstoneLocal("persona", "round-trip");
		const gone = records.getRecord("persona", "round-trip");
		expect(gone?.deleted).toBe(true);
		expect(gone?.version).toBe(3);
		// The last replicated JSON is kept; the classes this node released are not.
		expect(gone?.replicated.name).toBe("Ada Lovelace");
		expect(gone?.portable).toBeNull();
		expect(gone?.machine).toBeNull();

		const ops = oplog("round-trip");
		expect(ops.map((row) => [row.op, row.owner_epoch, row.version])).toEqual([
			["put", 1, 1],
			["put", 1, 2],
			["tombstone", 1, 3],
		]);
		expect(ops[2]?.payload).toBe("{}");
	});

	test("listRecords hides tombstones unless asked", () => {
		records.putLocal("persona", "listed", { replicated: { name: "Listed" } });
		records.putLocal("persona", "buried", { replicated: { name: "Buried" } });
		records.tombstoneLocal("persona", "buried");

		const visible = records.listRecords("persona").map((record) => record.id);
		expect(visible).toContain("listed");
		expect(visible).not.toContain("buried");

		const all = records.listRecords("persona", { includeTombstones: true }).map((r) => r.id);
		expect(all).toContain("buried");
	});

	test("portable and machine writes bump neither version nor oplog", () => {
		records.putLocal("persona", "private-churn", { replicated: { name: "Churn" } });
		const opsBefore = oplog("private-churn").length;

		const machined = records.putLocal("persona", "private-churn", {
			machine: { sessionCheckpoints: [{ backendId: "acp", sessionId: "s1" }] },
		});
		expect(machined.version).toBe(1);

		const ported = records.putLocal("persona", "private-churn", {
			portable: { mcpPolicy: { mode: "all" } },
		});
		expect(ported.version).toBe(1);
		expect(ported.machine).toEqual({ sessionCheckpoints: [{ backendId: "acp", sessionId: "s1" }] });
		expect(ported.updatedAt).toBeGreaterThanOrEqual(machined.updatedAt);

		expect(oplog("private-churn").length).toBe(opsBefore);
	});

	test("cannot create a record with only portable or machine state", () => {
		expect(() => records.putLocal("persona", "ghost", { machine: { cwd: "/tmp" } })).toThrow(
			/without a replicated class/,
		);
		expect(records.getRecord("persona", "ghost")).toBeUndefined();
		expect(oplog("ghost")).toEqual([]);
	});

	test("replicated writes bump both version and oplog", () => {
		records.putLocal("persona", "replicated-churn", { replicated: { name: "One" } });
		records.putLocal("persona", "replicated-churn", { replicated: { name: "Two" } });
		records.putLocal("persona", "replicated-churn", { replicated: { name: "Three" } });

		expect(records.getRecord("persona", "replicated-churn")?.version).toBe(3);
		const ops = oplog("replicated-churn");
		expect(ops.map((row) => row.version)).toEqual([1, 2, 3]);
		expect(JSON.parse(ops[2]?.payload ?? "{}")).toEqual({ name: "Three" });
	});

	test("currentEpoch answers 1 for a record nobody made", () => {
		expect(records.currentEpoch("persona", "never-existed")).toBe(1);
		records.putLocal("persona", "epoch-check", { replicated: { name: "Epoch" } });
		// Nothing in this phase moves an epoch, least of all a local write.
		expect(records.currentEpoch("persona", "epoch-check")).toBe(1);
	});

	test("oplog_idempotent rejects a duplicate insert", () => {
		records.putLocal("persona", "idempotent", { replicated: { name: "Once" } });
		const existing = oplog("idempotent")[0];
		expect(existing).toBeDefined();
		if (!existing) return;

		const db = new Database(STORE_FILE);
		try {
			expect(() =>
				db.run(
					`INSERT INTO oplog (owner_node, kind, id, owner_epoch, version, op, payload, at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
					[
						"some-other-node",
						existing.kind,
						existing.id,
						existing.owner_epoch,
						existing.version,
						"put",
						JSON.stringify({ name: "Twice" }),
						Date.now(),
					],
				),
			).toThrow(/UNIQUE/i);
		} finally {
			db.close();
		}
		expect(oplog("idempotent").length).toBe(1);
	});

	test("applyRemoteOps is all-or-none on a mixed batch", () => {
		const ahead = records.applyRemoteOps([remotePut("remote-ahead", 5, { name: "Ahead" })]);
		expect(ahead.applied).toBe(true);
		expect(records.getRecord("persona", "remote-ahead")?.version).toBe(5);

		const opsBefore = oplog().length;
		const stale = records.applyRemoteOps([
			remotePut("would-land", 1, { name: "Would land" }),
			remotePut("remote-ahead", 3, { name: "Behind" }),
		]);
		expect(stale).toEqual({ applied: false, reason: "stale", opIndex: 1 });
		// The op before the bad one is rolled back with it.
		expect(records.getRecord("persona", "would-land")).toBeUndefined();
		expect(records.getRecord("persona", "remote-ahead")?.replicated.name).toBe("Ahead");
		expect(oplog().length).toBe(opsBefore);

		const malformed = records.applyRemoteOps([
			remotePut("also-would-land", 1, { name: "Also" }),
			{ ...remotePut("bad", 1, {}), op: "delete" } as unknown as records.ResourceOp,
		]);
		expect(malformed).toEqual({ applied: false, reason: "invalid", opIndex: 1 });
		expect(records.getRecord("persona", "also-would-land")).toBeUndefined();
		expect(oplog().length).toBe(opsBefore);

		const nothing = records.applyRemoteOps([null as unknown as records.ResourceOp]);
		expect(nothing).toEqual({ applied: false, reason: "invalid", opIndex: 0 });
		expect(oplog().length).toBe(opsBefore);

		// Replaying an op this node already recorded is a replay, not a conflict.
		const replay = records.applyRemoteOps([remotePut("remote-ahead", 5, { name: "Ahead" })]);
		expect(replay).toEqual({ applied: true, seqs: [] });
		expect(oplog().length).toBe(opsBefore);
	});

	test("oplogAfter returns an owner's ops in order", () => {
		const mine = oplog("replicated-churn");
		const owner = mine[0]?.owner_node;
		expect(owner).toBeDefined();
		if (!owner) return;

		const tail = records.oplogAfter(owner, 0);
		expect(tail.length).toBeGreaterThan(0);
		expect(tail.every((op) => op.ownerNode === owner)).toBe(true);
		expect([...tail].sort((a, b) => a.seq - b.seq)).toEqual(tail);
		expect(records.oplogAfter("peer-node", 0).every((op) => op.ownerNode === "peer-node")).toBe(
			true,
		);
		expect(records.oplogAfter(owner, 0, 1).length).toBe(1);
	});

	test("the snapshot parses and carries tombstones and all three classes", () => {
		records.putLocal("persona", "snapshot-subject", {
			replicated: { name: "Snapshot" },
			portable: { subagents: [] },
			machine: { cwd: "/tmp/snapshot" },
		});

		const snapshot = JSON.parse(readFileSync(STORE_SNAPSHOT_FILE, "utf8")) as {
			version: number;
			exportedAt: number;
			nodeId: string;
			resources: records.ResourceRecord[];
		};

		expect(snapshot.version).toBe(1);
		expect(typeof snapshot.exportedAt).toBe("number");
		expect(snapshot.nodeId.length).toBeGreaterThan(0);

		const subject = snapshot.resources.find((record) => record.id === "snapshot-subject");
		expect(subject?.replicated).toEqual({ name: "Snapshot" });
		expect(subject?.portable).toEqual({ subagents: [] });
		expect(subject?.machine).toEqual({ cwd: "/tmp/snapshot" });

		expect(snapshot.resources.some((record) => record.deleted)).toBe(true);
		expect(JSON.parse(readFileSync(`${STORE_SNAPSHOT_FILE}.bak`, "utf8"))).toBeDefined();
	});
});

/**
 * The damaged latch runs in its own process.
 *
 * The latch closes once per process by design — a store that failed to open is
 * not retried into existence — so proving it needs an interpreter that has
 * never seen a healthy store, pointed at a data directory of its own.
 */
test("a damaged store answers empty, refuses writes, and is left alone", () => {
	const root = mkdtempSync(join(tmpdir(), "toad-damaged-"));
	const garbage = "this file is emphatically not a sqlite database\n";
	writeFileSync(join(root, "store.sqlite"), garbage);

	const probe = join(root, "probe.ts");
	writeFileSync(
		probe,
		`import { readFileSync } from "node:fs";
import { STORE_FILE } from ${JSON.stringify(join(import.meta.dir, "../paths.ts"))};
import * as store from ${JSON.stringify(join(import.meta.dir, "records.ts"))};

const before = readFileSync(STORE_FILE);
if (store.storeDamaged() !== true) throw new Error("expected the store to latch damaged");
if (store.listRecords("persona").length !== 0) throw new Error("damaged reads must answer empty");
if (store.getRecord("persona", "anyone") !== undefined) throw new Error("damaged reads must answer empty");
if (store.currentEpoch("persona", "anyone") !== 1) throw new Error("damaged epoch must answer 1");
if (store.oplogAfter("anyone", 0).length !== 0) throw new Error("damaged oplog must answer empty");
if (store.applyRemoteOps([]).applied !== false) throw new Error("damaged applyRemoteOps must refuse");

for (const write of [
	() => store.putLocal("persona", "anyone", { replicated: { name: "Anyone" } }),
	() => store.tombstoneLocal("persona", "anyone"),
]) {
	let message = "";
	try {
		write();
	} catch (error) {
		message = error instanceof Error ? error.message : String(error);
	}
	if (!message) throw new Error("a damaged store must refuse writes");
	if (!message.includes(STORE_FILE)) throw new Error("the refusal must name the file: " + message);
	if (!/move it aside/.test(message) || !/[Rr]estore it by hand/.test(message)) {
		throw new Error("the refusal must name the recovery move: " + message);
	}
}

if (!before.equals(readFileSync(STORE_FILE))) throw new Error("a damaged store was rewritten");
console.log("damaged-ok");
`,
	);

	const run = Bun.spawnSync(["bun", "run", probe], {
		env: { ...process.env, TOAD_DATA_DIR: root },
		stdout: "pipe",
		stderr: "pipe",
	});

	expect(run.stderr.toString()).toBe("");
	expect(run.stdout.toString().trim()).toBe("damaged-ok");
	expect(run.exitCode).toBe(0);
	expect(readFileSync(join(root, "store.sqlite"), "utf8")).toBe(garbage);
});
