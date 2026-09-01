import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * A desk on 0.4.0 or 0.4.1 is still in the room, and it still advertises two
 * fields this build no longer has: `Persona.plugins` and
 * `DeskCapabilities.plugins`. The plugin system was excised for the first
 * release; the desks that shipped with it were not.
 *
 * Tolerance here is not an accident of `JSON.parse` being permissive. Both
 * read paths — `personaOf` and `capabilitiesOf` — rebuild their value field by
 * field, so an unknown field is dropped on the way out rather than carried,
 * and a record carrying one is a record like any other rather than a crash or
 * a row the room silently loses. That property is load-bearing now, so it is
 * asserted here rather than trusted.
 *
 * Every case runs in an interpreter of its own against a data directory of its
 * own, for the same reason `personas.test.ts` does: the store facade latches
 * its migration answers once per process.
 */

const PROBE_PREAMBLE = `
import { Database } from "bun:sqlite";
import { ROOT, STORE_FILE } from ${JSON.stringify(join(import.meta.dir, "../paths.ts"))};
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import * as personas from ${JSON.stringify(join(import.meta.dir, "../store/personas.ts"))};
import { applyRemoteOps, getRecord } from ${JSON.stringify(join(import.meta.dir, "../store/records.ts"))};
import { deskCapabilities } from ${JSON.stringify(join(import.meta.dir, "capabilities.ts"))};
import { resolveHarness } from ${JSON.stringify(join(import.meta.dir, "ladder.ts"))};
import { remotePersonas } from ${JSON.stringify(join(import.meta.dir, "wire.ts"))};

/** The desk id every case here pretends is still running 0.4.1. */
const OLD = "peer-on-0-4-1";

/** Makes the old desk a known peer, so its teammates surface in the roster. */
function knowThePeer() {
	writeFileSync(join(ROOT, "fleet.json"), JSON.stringify({
		version: 1,
		peers: [{
			id: OLD,
			name: "Old Desk",
			origin: "http://127.0.0.1:9",
			callToken: "call",
			acceptToken: "accept",
			addedAt: 1,
		}],
	}));
}

/** A 0.4.1 desk's advertisement, \`plugins\` and all. */
function oldDeskAdvertisement() {
	return {
		platform: "darwin",
		arch: "arm64",
		harnesses: [
			{ id: "pi", name: "Toad Agent", available: true },
			{ id: "cursor", name: "Cursor", available: true },
		],
		builtin: { authenticated: true, providers: ["anthropic"], models: ["anthropic/claude-4"] },
		format: 1,
		plugins: [{ id: "com.example.board", version: "1.2.0", state: "running" }],
		capturedAt: 4_100,
	};
}

/** A 0.4.1 teammate's replicated class, \`plugins\` and all. */
function oldPersonaPayload() {
	return {
		name: "Ada Remote",
		goal: "prove the room outlives a field",
		team: "Away",
		backendId: "pi",
		modelId: "anthropic/claude-4",
		modeId: "high",
		harnessOverride: { backendId: "cursor" },
		plugins: ["com.example.board"],
		createdAt: 4_100,
	};
}

/** Rewrites a local row's replicated class the way 0.4.1 would have written it. */
function addPluginsToLocalRow(id, plugins) {
	const db = new Database(STORE_FILE);
	try {
		const row = db.query("SELECT replicated FROM resources WHERE id = ?").get(id);
		const replicated = JSON.parse(row.replicated);
		replicated.plugins = plugins;
		db.run("UPDATE resources SET replicated = ? WHERE id = ?", [JSON.stringify(replicated), id]);
	} finally {
		db.close();
	}
}

/** One class payload of one row, as stored rather than as assembled. */
function replicatedOf(id) {
	const db = new Database(STORE_FILE, { readonly: true });
	try {
		const row = db.query("SELECT replicated FROM resources WHERE id = ?").get(id);
		return row?.replicated ? JSON.parse(row.replicated) : null;
	} finally {
		db.close();
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
	return mkdtempSync(join(tmpdir(), `toad-skew-${label}-`));
}

describe("a desk still on 0.4.x", () => {
	test("its advertisement applies, is kept whole on disk, and reads back without plugins", () => {
		const observed = probe(
			freshRoot("desk-caps"),
			`
const applied = applyRemoteOps([{
	kind: "desk",
	id: OLD,
	ownerNode: OLD,
	ownerEpoch: 1,
	version: 7,
	op: "put",
	payload: oldDeskAdvertisement(),
	at: 4_100,
}]);

const info = deskCapabilities(OLD);
const record = getRecord("desk", OLD);
report({
	applied,
	info,
	hasPluginsOnRead: info ? Object.hasOwn(info.capabilities, "plugins") : null,
	/* The record itself is untouched: tolerance is in the read, not a rewrite
	 * of what the owner said. */
	storedPlugins: record ? record.replicated.plugins ?? null : null,
});`,
		);

		expect(observed.applied).toMatchObject({ applied: true });
		expect(observed.info).toMatchObject({
			nodeId: "peer-on-0-4-1",
			online: false,
			stale: true,
			capabilities: {
				platform: "darwin",
				arch: "arm64",
				harnesses: [
					{ id: "pi", name: "Toad Agent", available: true },
					{ id: "cursor", name: "Cursor", available: true },
				],
				builtin: {
					authenticated: true,
					providers: ["anthropic"],
					models: ["anthropic/claude-4"],
				},
				format: 1,
				capturedAt: 4_100,
			},
		});
		// Dropped on the way out, and only on the way out.
		expect(observed.hasPluginsOnRead).toBe(false);
		expect(observed.storedPlugins).toEqual([
			{ id: "com.example.board", version: "1.2.0", state: "running" },
		]);
	});

	test("the hop ladder climbs it, on three rungs and not four", () => {
		const observed = probe(
			freshRoot("ladder"),
			`
applyRemoteOps([{
	kind: "desk",
	id: OLD,
	ownerNode: OLD,
	ownerEpoch: 1,
	version: 1,
	op: "put",
	payload: oldDeskAdvertisement(),
	at: 4_100,
}]);

const destination = deskCapabilities(OLD).capabilities;
report({
	resolution: resolveHarness({
		current: { backendId: "pi", modelId: "anthropic/claude-4" },
		roomDefault: { backendId: "cursor" },
		destination,
	}),
});`,
		);

		const resolution = observed.resolution as {
			rung: string;
			choice?: unknown;
			rungs: Array<{ rung: string }>;
		};
		expect(resolution.rung).toBe("exact");
		expect(resolution.choice).toEqual({ backendId: "pi", modelId: "anthropic/claude-4" });
		// The plugin rung is gone; a desk that still advertises plugins does not
		// bring it back, and the ladder does not refuse for want of it.
		expect(resolution.rungs.map((rung) => rung.rung)).toEqual(["exact", "override", "default"]);
	});

	test("its teammate replicates in and surfaces in the roster without plugins", () => {
		const observed = probe(
			freshRoot("remote-persona"),
			`
knowThePeer();
const applied = applyRemoteOps([{
	kind: "persona",
	id: "old-ada",
	ownerNode: OLD,
	ownerEpoch: 1,
	version: 3,
	op: "put",
	payload: oldPersonaPayload(),
	at: 4_100,
}]);

const remotes = remotePersonas();
report({
	applied,
	remoteCount: remotes.length,
	remote: remotes[0] ?? null,
	hasPlugins: remotes[0] ? Object.hasOwn(remotes[0], "plugins") : null,
	/* The stored class, which is what the hop reads — nothing the old desk
	 * said was dropped on the way in, the unknown field included. */
	stored: replicatedOf("old-ada"),
});`,
		);

		expect(observed.applied).toMatchObject({ applied: true });
		// The record is not dropped, and neither is anything else it carried.
		expect(observed.remoteCount).toBe(1);
		expect(observed.remote).toMatchObject({
			id: "peer-on-0-4-1/old-ada",
			node: { id: "peer-on-0-4-1", name: "Old Desk" },
			name: "Ada Remote",
			goal: "prove the room outlives a field",
			team: "Away",
			backendId: "pi",
			modelId: "anthropic/claude-4",
			createdAt: 4_100,
		});
		expect(observed.hasPlugins).toBe(false);
		expect(observed.stored).toEqual({
			name: "Ada Remote",
			goal: "prove the room outlives a field",
			team: "Away",
			backendId: "pi",
			modelId: "anthropic/claude-4",
			modeId: "high",
			harnessOverride: { backendId: "cursor" },
			plugins: ["com.example.board"],
			createdAt: 4_100,
		});
	});
});

describe("a local row written by 0.4.x", () => {
	test("assembles into a whole teammate, minus the field this build forgot", () => {
		const observed = probe(
			freshRoot("local-row"),
			`
const created = personas.createPersona({
	name: "Local Ada",
	goal: "hold every other field",
	team: "Home",
	backendId: "pi",
	modelId: "anthropic/claude-4",
});
addPluginsToLocalRow(created.id, ["com.example.board"]);

const listed = personas.listPersonas();
const fetched = personas.getPersona(created.id);
report({
	id: created.id,
	listedIds: listed.map((persona) => persona.id),
	fetched,
	hasPlugins: fetched ? Object.hasOwn(fetched, "plugins") : null,
	storedPlugins: replicatedOf(created.id)?.plugins ?? null,
});`,
		);

		expect(observed.listedIds).toEqual([observed.id]);
		expect(observed.fetched).toMatchObject({
			name: "Local Ada",
			goal: "hold every other field",
			team: "Home",
			backendId: "pi",
			modelId: "anthropic/claude-4",
		});
		expect(observed.hasPlugins).toBe(false);
		expect(observed.storedPlugins).toEqual(["com.example.board"]);
	});

	test("keeps the stale field until a replicated edit rewrites the class, then loses it", () => {
		const observed = probe(
			freshRoot("strip"),
			`
const created = personas.createPersona({ name: "Local Ada", backendId: "pi" });
addPluginsToLocalRow(created.id, ["com.example.board"]);

/* A portable-class edit writes only the portable class, so the stale
 * replicated field is not even read, let alone rewritten. */
personas.updatePersona(created.id, { mcpPolicy: { mode: "none", serverIds: [] } });
const afterPortableEdit = replicatedOf(created.id)?.plugins ?? null;

/* A rename rewrites the replicated class whole from a teammate this build
 * assembled, and this build has no \`plugins\` to put back. */
personas.updatePersona(created.id, { name: "Local Ada II" });
const afterReplicatedEdit = replicatedOf(created.id)?.plugins ?? null;

report({
	afterPortableEdit,
	afterReplicatedEdit,
	stillWhole: personas.getPersona(created.id).name,
});`,
		);

		expect(observed.afterPortableEdit).toEqual(["com.example.board"]);
		/* The one-way door, asserted so it is a known property rather than a
		 * surprise: the first edit to a teammate's identity strips `plugins`
		 * from what this desk re-advertises, and a peer still on 0.4.x then
		 * reads that teammate as requiring no plugins. Graceful — nothing
		 * crashes, nothing is dropped — but it does not come back. */
		expect(observed.afterReplicatedEdit).toBeNull();
		expect(observed.stillWhole).toBe("Local Ada II");
	});
});
