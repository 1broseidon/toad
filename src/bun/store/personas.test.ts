import { describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Every case here runs in an interpreter of its own, against a data directory
 * of its own.
 *
 * The facade answers two questions exactly once per process — whether the
 * legacy `config.json` has been migrated, and whether it was readable at all —
 * and both are latched deliberately. A case sharing a process with another
 * cannot ask either question honestly, and a case sharing `TOAD_DATA_DIR` with
 * another test file would be answered with that file's fixture instead of its
 * own. So each case writes its fixtures into a fresh root and reads the answers
 * back out of a child process as JSON.
 */

const MARKER = "<!-- managed by Toad -->";

const PROBE_PREAMBLE = `
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_FILE, ROOT, STORE_FILE, defaultWorkspace } from ${JSON.stringify(join(import.meta.dir, "../paths.ts"))};
import * as personas from ${JSON.stringify(join(import.meta.dir, "personas.ts"))};

function sha(file) {
	return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** The store as a second connection sees it, rather than as the facade tells it. */
function store(id) {
	const db = new Database(STORE_FILE, { readonly: true });
	try {
		const where = id ? " WHERE id = ?" : "";
		const args = id ? [id] : [];
		return {
			migratedAt:
				db.query("SELECT value FROM meta WHERE key = 'config_migrated_at'").get()?.value ?? null,
			resources: db
				.query(
					"SELECT id, version, owner_epoch AS epoch, deleted, updated_at AS updatedAt FROM resources" +
						where +
						" ORDER BY rowid",
				)
				.all(...args),
			oplog: db
				.query("SELECT id, op, owner_epoch AS epoch, version FROM oplog" + where + " ORDER BY seq")
				.all(...args),
		};
	} finally {
		db.close();
	}
}

function refusal(run) {
	try {
		run();
		return null;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

function report(value) {
	console.log("PROBE " + JSON.stringify(value));
}
`;

/** Runs one probe body in a throwaway interpreter and hands back what it reported. */
function probe(root: string, body: string): Record<string, unknown> {
	const file = join(root, `probe-${randomUUID()}.ts`);
	writeFileSync(file, `${PROBE_PREAMBLE}\n${body}\n`);
	const run = Bun.spawnSync(["bun", "run", file], {
		env: { ...process.env, TOAD_DATA_DIR: root },
		stdout: "pipe",
		stderr: "pipe",
	});

	expect(run.stderr.toString()).toBe("");
	expect(run.exitCode).toBe(0);
	const line = run.stdout
		.toString()
		.split("\n")
		.find((candidate) => candidate.startsWith("PROBE "));
	expect(line).toBeDefined();
	return JSON.parse((line ?? "PROBE {}").slice("PROBE ".length)) as Record<string, unknown>;
}

function freshRoot(label: string): string {
	return mkdtempSync(join(tmpdir(), `toad-${label}-`));
}

function sha(file: string): string {
	return createHash("sha256").update(readFileSync(file)).digest("hex");
}

describe("persona facade", () => {
	test("create, update, checkpoint and delete round-trip", () => {
		const observed = probe(
			freshRoot("round-trip"),
			`
const created = personas.createPersona({
	name: "  Round Trip  ",
	goal: " ship it ",
	team: " QA ",
	backendId: "pi",
	modelId: " m1 ",
});
const fetched = personas.getPersona(created.id);
const afterCreate = store(created.id);

const renamed = personas.updatePersona(created.id, { name: "Renamed" });
const afterRename = store(created.id);

const checkpointed = personas.checkpointSession(created.id, "pi", "s-1");
const afterCheckpoint = store(created.id);

personas.clearCheckpoint(created.id, "pi", "some-other-session");
const kept = personas.getPersona(created.id).sessionCheckpoints;
personas.clearCheckpoint(created.id, "pi", "s-1");
const cleared = personas.getPersona(created.id).sessionCheckpoints;
const afterClear = store(created.id);

personas.deletePersona(created.id);
report({
	created,
	fetched,
	expectedCwd: defaultWorkspace(created.id),
	afterCreate,
	renamed,
	afterRename,
	checkpointed,
	afterCheckpoint,
	kept,
	cleared,
	afterClear,
	gone: personas.getPersona(created.id) ?? null,
	stillListed: personas.listPersonas().some((persona) => persona.id === created.id),
	afterDelete: store(created.id),
});`,
		);

		expect(observed.created).toMatchObject({
			name: "Round Trip",
			goal: "ship it",
			team: "QA",
			backendId: "pi",
			modelId: "m1",
			cwd: observed.expectedCwd,
			mcpPolicy: { mode: "all", serverIds: [] },
			sessionCheckpoints: [],
		});
		expect(observed.fetched).toEqual(observed.created);
		expect(observed.afterCreate).toMatchObject({
			resources: [{ version: 1, epoch: 1, deleted: 0 }],
			oplog: [{ op: "put", epoch: 1, version: 1 }],
		});

		// A replicated change is the one thing every other desk has to hear about.
		expect(observed.renamed).toMatchObject({
			name: "Renamed",
			createdAt: (observed.created as { createdAt: number }).createdAt,
		});
		expect(observed.afterRename).toMatchObject({
			resources: [{ version: 2 }],
			oplog: [{ version: 1 }, { version: 2 }],
		});

		// A harness session id means nothing elsewhere: no version, no op.
		expect(observed.checkpointed).toMatchObject({
			sessionCheckpoints: [{ backendId: "pi", sessionId: "s-1" }],
		});
		expect(observed.afterCheckpoint).toMatchObject({
			resources: [{ version: 2 }],
			oplog: [{ version: 1 }, { version: 2 }],
		});

		// `onlyIf` leaves a checkpoint that has since moved on alone.
		expect(observed.kept).toEqual([{ backendId: "pi", sessionId: "s-1" }]);
		expect(observed.cleared).toEqual([]);
		expect(observed.afterClear).toMatchObject({ resources: [{ version: 2 }] });

		expect(observed.gone).toBeNull();
		expect(observed.stillListed).toBe(false);
		expect(observed.afterDelete).toMatchObject({
			resources: [{ version: 3, deleted: 1 }],
			oplog: [{ version: 1 }, { version: 2 }, { op: "tombstone", epoch: 1, version: 3 }],
		});
	});

	test("portable and machine patches leave the replicated version alone", () => {
		const observed = probe(
			freshRoot("classes"),
			`
const created = personas.createPersona({ name: "Private churn", backendId: "pi" });
personas.updatePersona(created.id, { mcpPolicy: { mode: "some", serverIds: ["one"] } });
personas.updatePersona(created.id, { cwd: "/tmp/private-churn" });
personas.updatePersona(created.id, { modeId: "architect" });
personas.updatePersona(created.id, { subagents: { extras: [{ id: "", name: "", description: "" }] } });
report({ after: personas.getPersona(created.id), ...store(created.id) });`,
		);

		expect(observed.after).toMatchObject({
			name: "Private churn",
			mcpPolicy: { mode: "some", serverIds: ["one"] },
			cwd: "/tmp/private-churn",
			modeId: "architect",
		});
		// An unusable subagent list normalizes away rather than being stored.
		expect(observed.after).not.toHaveProperty("subagents");
		expect(observed.resources).toMatchObject([{ version: 1, epoch: 1 }]);
		expect(observed.oplog).toMatchObject([{ op: "put", version: 1 }]);
	});

	test("reorderPersonas ranks listed ids without rewriting a stored row", () => {
		const observed = probe(
			freshRoot("reorder"),
			`
const first = personas.createPersona({ name: "Rank first", backendId: "pi" });
const second = personas.createPersona({ name: "Rank second", backendId: "pi" });
const before = store();
report({
	first: first.id,
	second: second.id,
	created: personas.listPersonas().map((persona) => persona.id),
	reordered: personas.reorderPersonas([second.id, first.id]).map((persona) => persona.id),
	relisted: personas.listPersonas().map((persona) => persona.id),
	rosterFile: JSON.parse(readFileSync(join(ROOT, "roster.json"), "utf8")),
	before,
	after: store(),
});`,
		);

		// Insertion order is the order config.json had, until somebody drags.
		expect(observed.created).toEqual([observed.first, observed.second]);
		expect(observed.reordered).toEqual([observed.second, observed.first]);
		expect(observed.relisted).toEqual([observed.second, observed.first]);
		expect(observed.rosterFile).toEqual({ order: [observed.second, observed.first] });
		// A drag is this desk's view of the room, not an edit to a teammate.
		expect(observed.after).toEqual(observed.before);
	});

	test("materializeWorkspace writes the marked body and spares a hand-written file", () => {
		const observed = probe(
			freshRoot("workspace"),
			`
const created = personas.createPersona({ name: "Scribe", goal: "write things down", backendId: "pi" });
const file = join(created.cwd, "AGENTS.md");
const onCreate = readFileSync(file, "utf8");

const renamed = personas.updatePersona(created.id, { name: "Scribe II", goal: "" });
const onUpdate = readFileSync(file, "utf8");

writeFileSync(file, "# Mine, actually\\n");
personas.materializeWorkspace(renamed);
report({ onCreate, onUpdate, onHandWritten: readFileSync(file, "utf8") });`,
		);

		expect(observed.onCreate).toBe(`${MARKER}\n# Scribe\n\nwrite things down\n`);
		expect(observed.onUpdate).toBe(`${MARKER}\n# Scribe II\n\n_No goal set yet._\n`);
		expect(observed.onHandWritten).toBe("# Mine, actually\n");
	});
});

const FIXTURE = {
	version: 1,
	personas: [
		{
			id: "fixture-ada",
			name: "Ada",
			goal: "prove the machine",
			team: "Maths",
			backendId: "pi",
			cwd: "/tmp/fixture-ada",
			modelId: "m1",
			modeId: "architect",
			mcpPolicy: { mode: "some", serverIds: ["one", 7] },
			computer: { enabled: true, image: "  toad/computer  " },
			sessionCheckpoints: [
				{ backendId: "pi", sessionId: "s-pi" },
				{ backendId: "", sessionId: "junk" },
			],
			createdAt: 1000,
			updatedAt: 2000,
		},
		{
			id: "fixture-grace",
			name: "Grace",
			backendId: "claude",
			cwd: "/tmp/fixture-grace",
			lastSessionId: "legacy-session",
			createdAt: 3000,
			updatedAt: 4000,
		},
	],
};

const LIST_AND_STORE = `report({ personas: personas.listPersonas(), configHash: sha(CONFIG_FILE), ...store() });`;

test("a fixture config.json migrates once and is left byte-identical", () => {
	const root = freshRoot("migrate");
	const config = join(root, "config.json");
	writeFileSync(config, `${JSON.stringify(FIXTURE, null, 2)}\n`);
	const before = sha(config);

	const first = probe(root, LIST_AND_STORE);

	expect(first.configHash).toBe(before);
	expect(sha(config)).toBe(before);
	expect(first.migratedAt).not.toBeNull();

	const listed = first.personas as Array<Record<string, unknown>>;
	expect(listed.map((persona) => persona.id)).toEqual(["fixture-ada", "fixture-grace"]);
	expect(listed[0]).toMatchObject({
		name: "Ada",
		goal: "prove the machine",
		team: "Maths",
		backendId: "pi",
		modelId: "m1",
		modeId: "architect",
		cwd: "/tmp/fixture-ada",
		createdAt: 1000,
	});
	// Normalization that used to run on every read now runs once, here.
	expect(listed[0]?.mcpPolicy).toEqual({ mode: "some", serverIds: ["one"] });
	expect(listed[0]?.computer).toEqual({ enabled: true, image: "toad/computer" });
	expect(listed[0]?.sessionCheckpoints).toEqual([{ backendId: "pi", sessionId: "s-pi" }]);

	// A legacy lastSessionId can only have belonged to the backend that config
	// named, so that is where it lands — and it is never stored under its own
	// name again.
	expect(listed[1]).toMatchObject({ name: "Grace", backendId: "claude", createdAt: 3000 });
	expect(listed[1]?.sessionCheckpoints).toEqual([
		{ backendId: "claude", sessionId: "legacy-session" },
	]);
	expect(listed[1]).not.toHaveProperty("lastSessionId");
	expect(listed[1]?.mcpPolicy).toEqual({ mode: "all", serverIds: [] });

	expect(first.oplog).toEqual([
		{ id: "fixture-ada", op: "put", epoch: 1, version: 1 },
		{ id: "fixture-grace", op: "put", epoch: 1, version: 1 },
	]);

	// A second launch finds the stamp and adds nothing: no second row, and no
	// second version of a row that already arrived.
	const second = probe(root, LIST_AND_STORE);
	expect(second.configHash).toBe(before);
	expect(sha(config)).toBe(before);
	expect(second.migratedAt).toBe(first.migratedAt);
	expect(second.oplog).toEqual(first.oplog);
	expect(second.resources).toEqual(first.resources);
	expect(second.personas).toEqual(first.personas);
});

/**
 * Every mutation the facade owns, tried against a roster it must not touch.
 * `checkpointSession` is reported apart from the rest: it looks the teammate up
 * first, and a store that answers empty makes it the same "no such persona" it
 * has always been.
 */
const REFUSALS = `report({
	personas: personas.listPersonas(),
	refusals: {
		create: refusal(() => personas.createPersona({ name: "New", goal: "g", backendId: "pi" })),
		update: refusal(() => personas.updatePersona("fixture-ada", { name: "Renamed" })),
		reorder: refusal(() => personas.reorderPersonas(["fixture-ada"])),
		remove: refusal(() => personas.deletePersona("fixture-ada")),
	},
	checkpoint: refusal(() => personas.checkpointSession("fixture-ada", "pi", "s-1")),
	clearCheckpoint: refusal(() => personas.clearCheckpoint("fixture-ada", "pi")),
	configHash: sha(CONFIG_FILE),
	storeHash: sha(STORE_FILE),
});`;

function refusals(observed: Record<string, unknown>): Array<[string, string]> {
	return Object.entries(observed.refusals as Record<string, string | null>).map(
		([name, message]) => [name, `${name}: ${message}`],
	);
}

test("a damaged config.json blocks migration, refuses writes, and is left alone", () => {
	const root = freshRoot("damaged-config");
	const config = join(root, "config.json");
	const garbage = '{ "version": 1, "personas": [ this was never JSON\n';
	writeFileSync(config, garbage);
	const before = sha(config);

	const observed = probe(root, REFUSALS);

	// Reads answer empty — an empty rail is survivable — and writes stop.
	expect(observed.personas).toEqual([]);
	for (const [, labelled] of refusals(observed)) {
		expect(labelled).toContain(config);
		expect(labelled).toContain("config.json.bak");
	}
	expect(observed.checkpoint).toBe("No persona fixture-ada");
	expect(observed.clearCheckpoint).toBeNull();

	expect(observed.configHash).toBe(before);
	expect(sha(config)).toBe(before);
	expect(readFileSync(config, "utf8")).toBe(garbage);

	// Nothing was migrated, so nothing may claim it was: the next launch retries.
	const after = probe(root, `report({ ...store() });`);
	expect(after.migratedAt).toBeNull();
	expect(after.resources).toEqual([]);
	expect(after.oplog).toEqual([]);
});

test("a damaged store answers empty, refuses every facade write, and is left alone", () => {
	const root = freshRoot("damaged-store");
	const config = join(root, "config.json");
	writeFileSync(config, `${JSON.stringify(FIXTURE, null, 2)}\n`);
	const store = join(root, "store.sqlite");
	const garbage = "this file is emphatically not a sqlite database\n";
	writeFileSync(store, garbage);
	const configBefore = sha(config);

	const observed = probe(root, REFUSALS);

	expect(observed.personas).toEqual([]);
	for (const [, labelled] of refusals(observed)) {
		expect(labelled).toContain(store);
		expect(labelled).toContain("move it aside");
	}

	// Neither file is repaired, replaced, or migrated behind anyone's back.
	expect(observed.storeHash).toBe(sha(store));
	expect(readFileSync(store, "utf8")).toBe(garbage);
	expect(observed.configHash).toBe(configBefore);
	expect(sha(config)).toBe(configBefore);
});
