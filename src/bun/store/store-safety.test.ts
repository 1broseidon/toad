import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The throwaway root comes from test/preload.ts. Setting TOAD_DATA_DIR here
// would be far too late: these imports resolve it.
const { ROOT, SETTINGS_FILE } = await import("../paths");
const records = await import("./records");
const { setLastPersonaId } = await import("./settings");
const { saveRosterOrder } = await import("./roster");

describe("store safety", () => {
	test("applyRemoteOps of a stale epoch is refused", () => {
		const ahead = records.applyRemoteOps([
			{
				kind: "persona",
				id: "safety-stale-epoch",
				ownerNode: "peer-node",
				ownerEpoch: 2,
				version: 1,
				op: "put",
				payload: { name: "Ahead" },
				at: Date.now(),
			},
		]);
		expect(ahead.applied).toBe(true);

		const stale = records.applyRemoteOps([
			{
				kind: "persona",
				id: "safety-stale-epoch",
				ownerNode: "peer-node",
				ownerEpoch: 1,
				version: 1,
				op: "put",
				payload: { name: "Behind" },
				at: Date.now(),
			},
		]);
		expect(stale).toEqual({ applied: false, reason: "stale", opIndex: 0 });
		expect(records.getRecord("persona", "safety-stale-epoch")?.replicated.name).toBe("Ahead");
	});

	test("setLastPersonaId and saveRosterOrder persist bare ids only", () => {
		setLastPersonaId("node/abc");
		saveRosterOrder(["node/abc", "local"]);

		const settings = readFileSync(SETTINGS_FILE, "utf8");
		const roster = readFileSync(join(ROOT, "roster.json"), "utf8");
		expect(settings).not.toContain("/");
		expect(roster).not.toContain("/");
		expect(JSON.parse(settings).lastPersonaId).toBe("abc");
		expect(JSON.parse(roster).order).toEqual(["abc", "local"]);
	});
});

/**
 * The damaged latch runs in its own process.
 *
 * The latch closes once per process by design — a store that failed to open is
 * not retried into existence — so proving it needs an interpreter that has
 * never seen a healthy store, pointed at a data directory of its own.
 */
test("a damaged store is not overwritten", () => {
	const root = mkdtempSync(join(tmpdir(), "toad-safety-damaged-"));
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

let message = "";
try {
	store.putLocal("persona", "anyone", { replicated: { name: "Anyone" } });
} catch (error) {
	message = error instanceof Error ? error.message : String(error);
}
if (!message) throw new Error("a damaged store must refuse writes");
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
