/**
 * Proves the roster survives the ways it has actually been lost.
 *
 * On 2026-08-26 a live roster was replaced by two test personas, and the same
 * week's design review found the worse version of that bug waiting: a
 * truncated `config.json` read as "no teammates", then saved back over the only
 * copy by the next session checkpoint. The store era freezes `config.json` as
 * evidence and keeps the roster in `store.sqlite`. These checks cover both
 * files — a damaged one is held, never overwritten — plus the import-order
 * trap that pointed a test at the real data directory.
 *
 * Damaged-store and damaged-config latches close once per process, so those
 * cases run in a child interpreter with a data directory of their own.
 *
 * Run: bun scripts/verify-roster-durability.ts
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CASE = process.argv[2] ?? "main";
const self = decodeURIComponent(new URL(import.meta.url).pathname);

const FIXTURE = {
	version: 1,
	personas: [
		{ id: "ada", name: "Ada", createdAt: 1, updatedAt: 1 },
		{ id: "boris", name: "Boris", createdAt: 2, updatedAt: 2 },
	],
};

function sha(file: string): string {
	return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function writeFixture(dir: string): string {
	const config = join(dir, "config.json");
	writeFileSync(config, `${JSON.stringify(FIXTURE, null, 2)}\n`);
	return config;
}

if (CASE === "main") {
	process.env.TOAD_DATA_DIR = mkdtempSync(join(tmpdir(), "toad-durability-"));
	writeFixture(process.env.TOAD_DATA_DIR);
} else if (!process.env.TOAD_DATA_DIR) {
	throw new Error(`${CASE} must inherit TOAD_DATA_DIR`);
}

const { createPersona, listPersonas, deletePersona, checkpointSession, clearCheckpoint } =
	await import("../src/bun/store/personas");
const paths = await import("../src/bun/paths");

type OplogRow = {
	id: string;
	op: string;
	owner_epoch: number;
	version: number;
};

type ResourceRow = {
	id: string;
	deleted: number;
	owner_epoch: number;
	version: number;
};

function openStore(): Database {
	return new Database(paths.STORE_FILE, { readonly: true });
}

function oplog(id?: string): OplogRow[] {
	const db = openStore();
	try {
		return id
			? db
					.query<OplogRow, [string]>(
						"SELECT id, op, owner_epoch, version FROM oplog WHERE id = ? ORDER BY seq",
					)
					.all(id)
			: db
					.query<OplogRow, []>("SELECT id, op, owner_epoch, version FROM oplog ORDER BY seq")
					.all();
	} finally {
		db.close();
	}
}

function resources(id?: string): ResourceRow[] {
	const db = openStore();
	try {
		return id
			? db
					.query<ResourceRow, [string]>(
						"SELECT id, deleted, owner_epoch, version FROM resources WHERE id = ? ORDER BY rowid",
					)
					.all(id)
			: db
					.query<ResourceRow, []>(
						"SELECT id, deleted, owner_epoch, version FROM resources ORDER BY rowid",
					)
					.all();
	} finally {
		db.close();
	}
}

function names(): string {
	return listPersonas()
		.map((persona) => persona.name)
		.join(",");
}

if (CASE === "damaged-config") {
	if (listPersonas().length !== 0) throw new Error("damaged config must list no personas");
	let refused = false;
	try {
		createPersona({ name: "Ghost" });
	} catch {
		refused = true;
	}
	if (!refused) throw new Error("createPersona must throw while config.json is unreadable");
	console.log("damaged-config-ok");
	process.exit(0);
}

if (CASE === "migrate") {
	if (names() !== "Ada,Boris") throw new Error(`expected Ada,Boris after migration, got ${names()}`);
	console.log("migrated-ok");
	process.exit(0);
}

if (CASE === "damaged-store") {
	const before = readFileSync(paths.STORE_FILE);
	if (listPersonas().length !== 0) throw new Error("damaged store must list no personas");
	for (const write of [
		() => createPersona({ name: "Ghost" }),
		() => deletePersona("ada"),
	]) {
		let refused = false;
		try {
			write();
		} catch {
			refused = true;
		}
		if (!refused) throw new Error("a facade write must throw while the store is damaged");
	}
	if (!before.equals(readFileSync(paths.STORE_FILE))) {
		throw new Error("a damaged store.sqlite was rewritten");
	}
	console.log("damaged-store-ok");
	process.exit(0);
}

let pass = 0;
let fail = 0;
const temps = [process.env.TOAD_DATA_DIR];

function check(label: string, ok: boolean, detail?: string): void {
	if (ok) {
		pass += 1;
		console.log(`\x1b[32m✓\x1b[0m ${label}`);
		return;
	}
	fail += 1;
	console.log(`\x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`);
}

function spawnCase(name: string, dir: string): { ok: boolean; stdout: string; stderr: string } {
	const result = Bun.spawnSync(["bun", self, name], {
		env: { ...process.env, TOAD_DATA_DIR: dir },
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		ok: result.exitCode === 0,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
	};
}

const config = paths.CONFIG_FILE;
const beforeHash = sha(config);

check("two teammates migrate from the fixture", names() === "Ada,Boris", names());
check("config.json is byte-identical after migration", sha(config) === beforeHash);

const migrated = oplog();
check(
	"oplog has one put per persona at (owner_epoch 1, version 1)",
	JSON.stringify(migrated) ===
		JSON.stringify([
			{ id: "ada", op: "put", owner_epoch: 1, version: 1 },
			{ id: "boris", op: "put", owner_epoch: 1, version: 1 },
		]),
	JSON.stringify(migrated),
);

// The store exists so this write never touches config.json again.
createPersona({ name: "Cleo" });
check("createPersona does not rewrite config.json", sha(config) === beforeHash);

const adaOps = oplog("ada").length;
checkpointSession("ada", "pi", "session-1");
clearCheckpoint("ada", "pi");
check(
	"checkpoint then clearCheckpoint adds no oplog rows",
	oplog("ada").length === adaOps,
	`${adaOps} -> ${oplog("ada").length}`,
);

deletePersona("boris");
check("deleted teammates leave the listing", !listPersonas().some((persona) => persona.id === "boris"));
const buried = resources("boris")[0];
check("deletePersona leaves a tombstone row", buried?.deleted === 1, JSON.stringify(buried));
check(
	"deletePersona leaves a tombstone oplog op",
	oplog("boris").some((row) => row.op === "tombstone"),
	JSON.stringify(oplog("boris")),
);

check("store-snapshot.json exists", existsSync(paths.STORE_SNAPSHOT_FILE));
let snapshotOk = false;
try {
	JSON.parse(readFileSync(paths.STORE_SNAPSHOT_FILE, "utf8"));
	snapshotOk = true;
} catch {
	snapshotOk = false;
}
check("store-snapshot.json parses", snapshotOk);

let guarded = false;
const realOverride = process.env.TOAD_DATA_DIR;
process.env.TOAD_DATA_DIR = join(tmpdir(), "somewhere-else");
try {
	paths.ensureLayout();
} catch {
	guarded = true;
}
process.env.TOAD_DATA_DIR = realOverride;
check("a data directory set too late fails loudly", guarded);

const damagedConfigDir = mkdtempSync(join(tmpdir(), "toad-durability-config-"));
temps.push(damagedConfigDir);
const damagedConfig = "{ not json at all";
writeFileSync(join(damagedConfigDir, "config.json"), damagedConfig);
const damagedConfigRun = spawnCase("damaged-config", damagedConfigDir);
check(
	"a damaged config.json lists nobody and refuses createPersona",
	damagedConfigRun.ok && damagedConfigRun.stdout.includes("damaged-config-ok"),
	damagedConfigRun.stderr || damagedConfigRun.stdout,
);
check(
	"the damaged config.json is left exactly as found",
	readFileSync(join(damagedConfigDir, "config.json"), "utf8") === damagedConfig,
);

const damagedStoreDir = mkdtempSync(join(tmpdir(), "toad-durability-store-"));
temps.push(damagedStoreDir);
writeFixture(damagedStoreDir);
const migratedRun = spawnCase("migrate", damagedStoreDir);
check(
	"a fresh process migrates the fixture before the store is damaged",
	migratedRun.ok && migratedRun.stdout.includes("migrated-ok"),
	migratedRun.stderr || migratedRun.stdout,
);
const storeFile = join(damagedStoreDir, "store.sqlite");
	const damagedStore = "this file is emphatically not a sqlite database\n";
	writeFileSync(storeFile, damagedStore);
	// A leftover WAL is a recovery journal for the good database the migrate
	// process just closed. Leave it and the next open serves that roster out of
	// the journal while the main file stays garbage — the opposite of damaged.
	rmSync(`${storeFile}-wal`, { force: true });
	rmSync(`${storeFile}-shm`, { force: true });
const damagedStoreRun = spawnCase("damaged-store", damagedStoreDir);
check(
	"a damaged store.sqlite lists nobody and refuses facade writes",
	damagedStoreRun.ok && damagedStoreRun.stdout.includes("damaged-store-ok"),
	damagedStoreRun.stderr || damagedStoreRun.stdout,
);
check("the damaged store.sqlite is left exactly as found", readFileSync(storeFile, "utf8") === damagedStore);

for (const dir of temps) {
	if (dir) rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
