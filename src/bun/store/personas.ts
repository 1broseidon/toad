import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { HarnessChoice, Persona, PersonaComputer, PersonaDraft } from "../../shared/types";
import { normalizePersonaSubagents } from "../../shared/subagents";
import { DEFAULT_BACKEND_ID } from "../acp/registry";
import { removeComputer, stopComputer } from "../computer/manager";
import { DEFAULT_MCP_POLICY, normalizePolicy } from "../mcp/servers";
import { CONFIG_FILE, STORE_FILE, defaultWorkspace } from "../paths";
import {
	getRecord,
	listRecords,
	localNodeId,
	putLocal,
	storeDamaged,
	tombstoneLocal,
	type ResourceRecord,
} from "./records";
import { applyRosterOrder, mergeRosterRank } from "./roster";

/**
 * The roster, as the rest of the app still wants to see it.
 *
 * Every function here keeps the shape it had when a teammate was one entry in
 * a JSON array. Underneath, a teammate is now a record in the store: owned by
 * a node, versioned, tombstoned rather than spliced out, and split into the
 * three classes of state that decide how far each field is allowed to travel
 * (the roster-store spec, §6). `config.json` is read exactly once, by the
 * migration, and never written again.
 *
 * The split is the whole point of the move. A session checkpoint written after
 * every turn is machine-bound: it must not make a teammate look edited on
 * anybody else's desk. A name is replicated: it must. Assembling a `Persona`
 * back out of the three classes is what lets callers stay ignorant of all of
 * it.
 */

/** A stored harness choice, or nothing when missing or malformed. */
function normalizeHarness(value: unknown): HarnessChoice | undefined {
	const candidate = value as Partial<HarnessChoice> | undefined;
	if (typeof candidate?.backendId !== "string" || candidate.backendId.length === 0) {
		return undefined;
	}
	return {
		backendId: candidate.backendId,
		...(typeof candidate.modelId === "string" && candidate.modelId.length > 0
			? { modelId: candidate.modelId }
			: {}),
	};
}

/** A stored computer setting, or nothing when missing or malformed. */
function normalizeComputer(value: unknown): PersonaComputer | undefined {
	const candidate = value as Partial<PersonaComputer> | undefined;
	if (typeof candidate?.enabled !== "boolean") return undefined;
	return {
		enabled: candidate.enabled,
		...(typeof candidate.image === "string" && candidate.image.trim()
			? { image: candidate.image.trim() }
			: {}),
	};
}

/** Checkpoints with a usable backend and session id; anything else is dropped. */
function normalizeCheckpoints(value: unknown): Persona["sessionCheckpoints"] {
	if (!Array.isArray(value)) return [];
	const checkpoints: Persona["sessionCheckpoints"] = [];
	for (const entry of value as Array<{ backendId?: unknown; sessionId?: unknown }>) {
		const backendId = typeof entry?.backendId === "string" ? entry.backendId : "";
		const sessionId = typeof entry?.sessionId === "string" ? entry.sessionId : "";
		if (backendId && sessionId) checkpoints.push({ backendId, sessionId });
	}
	return checkpoints;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/**
 * Which class each `Persona` field belongs to — the roster-store spec, §6.
 *
 * `id` is the record key, `updatedAt` is record meta, and `node` and
 * `lastSessionId` are stored nowhere: the first is a reader's own
 * qualification of somebody else's teammate, the second is a v1 field that the
 * migration folds into `sessionCheckpoints` and then forgets.
 */
const REPLICATED_KEYS = [
	"name",
	"goal",
	"face",
	"team",
	"backendId",
	"modelId",
	// The hop-ladder override travels with identity: any desk may be asked what
	// would run this teammate elsewhere, so every desk must know the preference.
	"harnessOverride",
	// The plugin requirement travels for the same reason, and it is the one the
	// ladder can refuse on: a teammate moved to a desk without its plugin does
	// not lose a preference, it loses its tools.
	"plugins",
	"createdAt",
] as const satisfies readonly (keyof Persona)[];

const PORTABLE_KEYS = [
	"mcpPolicy",
	"webSearchPolicy",
	"subagents",
	"computer",
] as const satisfies readonly (keyof Persona)[];

const MACHINE_KEYS = [
	"cwd",
	"modeId",
	"hopNotice",
	"sessionCheckpoints",
] as const satisfies readonly (keyof Persona)[];

export type PersonaClasses = {
	replicated: Record<string, unknown>;
	portable: Record<string, unknown>;
	machine: Record<string, unknown>;
};

function pick(persona: Persona, keys: readonly (keyof Persona)[]): Record<string, unknown> {
	const picked: Record<string, unknown> = {};
	for (const key of keys) {
		const value = persona[key];
		if (value !== undefined) picked[key] = value;
	}
	return picked;
}

/**
 * Splits a whole teammate into the three class payloads a record carries.
 *
 * Class values are stored whole rather than as diffs, so this always answers
 * with all three; the caller decides which of them a given write is allowed to
 * touch. Exported for the migration in `migrate-config.ts`, which needs the
 * same split for rows it writes from the frozen `config.json`.
 */
export function personaClasses(persona: Persona): PersonaClasses {
	return {
		replicated: pick(persona, REPLICATED_KEYS),
		portable: pick(persona, PORTABLE_KEYS),
		machine: pick(persona, MACHINE_KEYS),
	};
}

function touches(patch: Partial<Persona>, keys: readonly (keyof Persona)[]): boolean {
	return keys.some((key) => key in patch);
}

/**
 * Assembles a teammate from a record's three classes.
 *
 * Normalization happens here rather than once at write time because the store
 * can hold rows written by an older build — the same reason the JSON reader
 * normalized on every read. A field the store never learned falls back to what
 * a fresh teammate would have had.
 */
function personaOf(record: ResourceRecord): Persona {
	const replicated = record.replicated as Partial<Persona>;
	const portable = (record.portable ?? {}) as Partial<Persona>;
	const machine = (record.machine ?? {}) as Partial<Persona>;

	const team = text(replicated.team);
	const modelId = text(replicated.modelId);
	const modeId = text(machine.modeId);
	const hopNotice = text(machine.hopNotice);
	const harnessOverride = normalizeHarness(replicated.harnessOverride);
	const computer = normalizeComputer(portable.computer);
	const subagents = normalizePersonaSubagents(portable.subagents);

	return {
		id: record.id,
		name: text(replicated.name) ?? "Untitled",
		goal: text(replicated.goal) ?? "",
		...(replicated.face ? { face: replicated.face } : {}),
		...(team !== undefined ? { team } : {}),
		backendId: text(replicated.backendId) || DEFAULT_BACKEND_ID,
		cwd: text(machine.cwd) || defaultWorkspace(record.id),
		...(modelId !== undefined ? { modelId } : {}),
		...(modeId !== undefined ? { modeId } : {}),
		...(hopNotice !== undefined ? { hopNotice } : {}),
		...(harnessOverride ? { harnessOverride } : {}),
		mcpPolicy: normalizePolicy(portable.mcpPolicy),
		...(portable.webSearchPolicy ? { webSearchPolicy: portable.webSearchPolicy } : {}),
		...(computer ? { computer } : {}),
		...(subagents ? { subagents } : {}),
		sessionCheckpoints: normalizeCheckpoints(machine.sessionCheckpoints),
		createdAt:
			typeof replicated.createdAt === "number" ? replicated.createdAt : record.updatedAt,
		updatedAt: record.updatedAt,
	};
}

/**
 * One config-era persona, cleaned up the way the JSON reader used to clean it.
 *
 * Tolerates configs written before these fields existed. A legacy
 * `lastSessionId` can only have belonged to the backend selected when that
 * config was written, so that is the one safe place to fold it. Exported for
 * the migration, which is the only caller that ever sees a v1 persona.
 */
export function normalizeLegacyPersona(raw: Persona): Persona {
	const persona: Persona = { ...raw };
	persona.mcpPolicy = normalizePolicy(persona.mcpPolicy);
	persona.computer = normalizeComputer(persona.computer);
	persona.subagents = normalizePersonaSubagents(persona.subagents);
	persona.sessionCheckpoints = normalizeCheckpoints(persona.sessionCheckpoints);
	if (
		persona.lastSessionId &&
		persona.backendId &&
		!persona.sessionCheckpoints.some((checkpoint) => checkpoint.backendId === persona.backendId)
	) {
		persona.sessionCheckpoints.push({
			backendId: persona.backendId,
			sessionId: persona.lastSessionId,
		});
	}
	delete persona.lastSessionId;
	return persona;
}

type MigrateModule = typeof import("./migrate-config");

let migrateModule: MigrateModule | undefined;

/**
 * Brings the legacy roster in before the first read or write, once.
 *
 * Required rather than imported: the migration needs this module's class split
 * and legacy normalizer, so a static import in both directions would make the
 * pair a cycle. `records.ts` reaches the node identity the same way, for the
 * same kind of reason.
 */
function migration(): MigrateModule {
	if (!migrateModule) {
		migrateModule = require("./migrate-config") as MigrateModule;
		migrateModule.migrateConfig();
	}
	return migrateModule;
}

/**
 * Stops a mutation that would be written over state this build cannot read.
 *
 * Two different holds, one rule. A `config.json` that neither parsed nor had a
 * usable backup has not been migrated, so writing a roster now would strand
 * whatever it held; a damaged store cannot be written at all. Reads still
 * answer — an empty rail is survivable — and both files stay exactly where
 * they are for recovery by hand.
 */
function guardWrite(): void {
	if (migration().configHeld()) {
		throw new Error(
			`Refusing to write a roster while ${CONFIG_FILE} is unreadable and unmigrated. ` +
				"Restore it from config.json.bak, or move it aside to start fresh.",
		);
	}
	if (storeDamaged()) {
		throw new Error(
			`Refusing to write to a damaged record store at ${STORE_FILE}. ` +
				"Restore it by hand from store-snapshot.json, or move it aside so the " +
				"roster is rebuilt from config.json.",
		);
	}
}

/**
 * This desk's teammates, in this desk's order.
 *
 * Order is view state now (the roster-store spec, §9), so it is applied on the
 * way out rather than being the order rows happen to sit in. A roster nobody
 * ever dragged sorts by insertion, which is the order `config.json` had.
 */
export function listPersonas(): Persona[] {
	migration();
	return applyRosterOrder(
		listRecords("persona")
			.filter((record) => record.ownerNode === localNodeId())
			.map(personaOf),
	);
}

export function getPersona(id: string): Persona | undefined {
	migration();
	const record = getRecord("persona", id);
	if (!record || record.deleted || record.ownerNode !== localNodeId()) return undefined;
	return personaOf(record);
}

export function createPersona(draft: PersonaDraft): Persona {
	guardWrite();
	const id = randomUUID();
	const now = Date.now();
	const computer = normalizeComputer(draft.computer);
	const persona: Persona = {
		id,
		name: draft.name.trim() || "Untitled",
		goal: draft.goal?.trim() ?? "",
		...(draft.team?.trim() ? { team: draft.team.trim() } : {}),
		backendId: draft.backendId ?? DEFAULT_BACKEND_ID,
		...(draft.modelId?.trim() ? { modelId: draft.modelId.trim() } : {}),
		cwd: draft.cwd?.trim() || defaultWorkspace(id),
		mcpPolicy: { ...DEFAULT_MCP_POLICY },
		...(computer ? { computer } : {}),
		sessionCheckpoints: [],
		createdAt: now,
		updatedAt: now,
	};

	const created = personaOf(putLocal("persona", id, personaClasses(persona)));
	materializeWorkspace(created);
	return created;
}

/**
 * The roster's order, as this desk arranged it.
 *
 * A drag no longer rewrites the teammates themselves: where a row sits is true
 * of the desk looking at it and of nobody else, so it is merged into
 * `roster.json` instead. Ids the caller forgot keep their relative place after
 * the ones it named, so a stale client reordering an old roster cannot drop
 * anyone.
 */
export function reorderPersonas(ids: string[]): Persona[] {
	guardWrite();
	mergeRosterRank(ids);
	return listPersonas();
}

export function updatePersona(id: string, patch: Partial<Persona>): Persona {
	guardWrite();
	const previous = getPersona(id);
	if (!previous) throw new Error(`No persona ${id}`);

	const merged: Persona = { ...previous, ...patch, id: previous.id };
	if ("subagents" in patch) merged.subagents = normalizePersonaSubagents(patch.subagents);
	const classes = personaClasses(merged);

	// One transaction carrying only the classes the patch reached. A patch that
	// names nothing replicated leaves the version — and so every teammate's
	// idea of who this is — exactly where it was.
	const next = personaOf(
		putLocal("persona", id, {
			...(touches(patch, REPLICATED_KEYS) ? { replicated: classes.replicated } : {}),
			...(touches(patch, PORTABLE_KEYS) ? { portable: classes.portable } : {}),
			...(touches(patch, MACHINE_KEYS) ? { machine: classes.machine } : {}),
		}),
	);

	if (patch.goal !== undefined || patch.cwd !== undefined || patch.name !== undefined) {
		materializeWorkspace(next);
	}
	// Switching the computer off stops it now rather than waiting out the idle
	// timer; the container and its rw layer stay for a change of mind.
	if (previous.computer?.enabled && patch.computer && !patch.computer.enabled) {
		void stopComputer(id).catch(() => undefined);
	}
	return next;
}

/**
 * Records a session only after that backend has completed a turn.
 *
 * Some agents issue an id at session/new but cannot load it until the first
 * prompt has committed. Replacing only this backend's entry also preserves the
 * checkpoint a teammate may later return to in another harness. Machine-bound:
 * a harness session id means nothing on another machine, so writing one moves
 * no version and appends no op.
 */
export function checkpointSession(id: string, backendId: string, sessionId: string): Persona {
	const persona = getPersona(id);
	if (!persona) throw new Error(`No persona ${id}`);

	const sessionCheckpoints = persona.sessionCheckpoints.filter(
		(checkpoint) => checkpoint.backendId !== backendId,
	);
	sessionCheckpoints.push({ backendId, sessionId });
	return updatePersona(id, { sessionCheckpoints });
}

/**
 * Forgets a backend's checkpoint, so the next start opens a fresh session.
 *
 * This is how a chapter closes: the session is not touched, the promise to
 * reopen it is withdrawn. With `onlyIf`, a checkpoint that has since moved on
 * to a newer session is left alone.
 */
export function clearCheckpoint(id: string, backendId: string, onlyIf?: string): void {
	const persona = getPersona(id);
	if (!persona) return;
	const current = persona.sessionCheckpoints.find((checkpoint) => checkpoint.backendId === backendId);
	if (!current) return;
	if (onlyIf !== undefined && current.sessionId !== onlyIf) return;
	updatePersona(id, {
		sessionCheckpoints: persona.sessionCheckpoints.filter(
			(checkpoint) => checkpoint.backendId !== backendId,
		),
	});
}

/**
 * The pending moved-desks notice, consumed once.
 *
 * A hop parks the notice on the machine class so it survives a restart between
 * the move and the next message; the prompt funnel takes it here, exactly once,
 * and lays it ahead of the first words the teammate hears on the new desk —
 * both agent kinds, because both speak through that one funnel.
 */
export function takeHopNotice(id: string): string | undefined {
	const persona = getPersona(id);
	if (!persona?.hopNotice) return undefined;
	updatePersona(id, { hopNotice: undefined });
	return persona.hopNotice;
}

/**
 * Deletes by remembering the delete.
 *
 * Dropping the row would let a desktop that was offline for it hand the
 * teammate back on its next sync, so what stays behind is a tombstone: gone
 * from every listing, still legible to anyone who has not heard yet.
 */
export function deletePersona(id: string): void {
	guardWrite();
	tombstoneLocal("persona", id);
	// A deleted teammate's computer goes with it: container, token, record.
	void removeComputer(id).catch(() => undefined);
}

const TOAD_MARKER = "<!-- managed by Toad -->";

/**
 * Writes the persona's identity into its working directory.
 *
 * ACP's session/new has no system-prompt parameter, so identity has to arrive
 * through a channel the agent already reads. AGENTS.md is that channel, which
 * makes the working directory the persona rather than mere bookkeeping.
 *
 * Only files carrying Toad's marker are overwritten, so a hand-written
 * AGENTS.md in a real repository is never clobbered.
 */
export function materializeWorkspace(persona: Persona): void {
	mkdirSync(persona.cwd, { recursive: true });
	const file = join(persona.cwd, "AGENTS.md");

	if (existsSync(file)) {
		const current = readFileSync(file, "utf8");
		if (!current.includes(TOAD_MARKER)) return;
	}

	const goal = persona.goal.trim();
	const body = goal.length > 0 ? goal : "_No goal set yet._";
	writeFileSync(
		file,
		`${TOAD_MARKER}\n# ${persona.name}\n\n${body}\n`,
		"utf8",
	);
}
