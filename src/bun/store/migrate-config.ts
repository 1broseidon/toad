import { Database } from "bun:sqlite";
import type { Persona } from "../../shared/types";
import { CONFIG_FILE, STORE_FILE } from "../paths";
import { loadJson } from "./durable";
import { exportSnapshot, listRecords, putLocal, storeDamaged } from "./records";
import { normalizeLegacyPersona, personaClasses } from "./personas";

/**
 * Reading the legacy roster in, once, and never writing it back.
 *
 * `config.json` was the only copy of something a person typed, so it is
 * treated from here on as evidence rather than as storage: this module reads
 * it, and no code in the app writes, rewrites, or deletes it again. If the
 * store is ever lost, moving it aside re-runs this migration from those same
 * frozen bytes.
 *
 * Paranoid in three specific ways. A config that neither parsed nor had a
 * usable backup is refused rather than mistaken for an empty roster — the
 * facade then holds its writes, and the next launch tries again. A persona
 * whose id is unusable stops the whole read before a single row is written. And
 * an id the store already holds is left alone, so a run interrupted halfway
 * finishes on the next launch instead of arriving twice.
 */

type ConfigFile = { version: 1; personas: Persona[] };

const MIGRATED_KEY = "config_migrated_at";

let attempted = false;
let held = false;

/**
 * True when the legacy roster could not be read and so was not migrated.
 *
 * Distinct from an empty roster on purpose: writing over state this build could
 * not parse is how one unreadable read becomes a real loss.
 */
export function configHeld(): boolean {
	return held;
}

/**
 * The migration stamp, read over its own connection.
 *
 * `records.ts` owns the store's schema and exposes no meta API, and it should
 * not grow one for a single one-way flag. A second read-only handle on a WAL
 * database sees everything the first has committed, and can see nothing else.
 */
function migratedAt(): string | undefined {
	try {
		const db = new Database(STORE_FILE, { readonly: true });
		try {
			return db
				.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?")
				.get(MIGRATED_KEY)?.value;
		} finally {
			db.close();
		}
	} catch {
		// No file, no schema, or no read: all mean "not migrated yet", and the
		// steps below decide what to do about it.
		return undefined;
	}
}

function stampMigrated(): void {
	const db = new Database(STORE_FILE);
	try {
		db.run(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING`, [
			MIGRATED_KEY,
			String(Date.now()),
		]);
	} finally {
		db.close();
	}
}

/**
 * The roster-store spec, §7. One-way, idempotent, and safe to interrupt.
 *
 * The spec wants the rows and the stamp in one transaction. `records.ts` has no
 * batch API and this slice may not give it one, so the rows go in first and the
 * stamp last: a partial migration is recoverable because ids the store already
 * holds are skipped on the next attempt, which can only ever add the personas
 * that did not make it and never a second copy or a second version of one that
 * did.
 */
export function migrateConfig(): void {
	if (attempted) return;
	attempted = true;

	// A store that will not open has nothing to migrate into, and every facade
	// write is already refusing. `config.json` stays untouched either way.
	if (storeDamaged()) return;
	if (migratedAt() !== undefined) return;

	const loaded = loadJson<ConfigFile>(CONFIG_FILE);
	if (loaded.damaged) {
		held = true;
		return;
	}
	// A file whose shape this build does not recognise is not an empty roster,
	// so it is held rather than migrated past — same reason as an unparseable
	// one.
	if (loaded.value !== null && !Array.isArray(loaded.value.personas)) {
		held = true;
		return;
	}

	// Normalized whole before anything is written, so a config that falls apart
	// halfway through leaves no rows and no stamp at all.
	let personas: Persona[];
	try {
		personas = (loaded.value?.personas ?? []).map((raw) => {
			const persona = normalizeLegacyPersona(raw);
			if (typeof persona.id !== "string" || !persona.id) {
				throw new Error("a persona with no id cannot key a record");
			}
			return persona;
		});
	} catch {
		held = true;
		return;
	}

	const known = new Set(listRecords("persona", { includeTombstones: true }).map(({ id }) => id));
	for (const persona of personas) {
		if (known.has(persona.id)) continue;
		putLocal("persona", persona.id, personaClasses(persona));
	}

	stampMigrated();
	exportSnapshot();
}
