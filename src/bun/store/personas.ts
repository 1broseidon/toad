import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Persona, PersonaComputer, PersonaDraft } from "../../shared/types";
import { normalizePersonaSubagents } from "../../shared/subagents";
import { DEFAULT_BACKEND_ID } from "../acp/registry";
import { removeComputer, stopComputer } from "../computer/manager";
import { DEFAULT_MCP_POLICY, normalizePolicy } from "../mcp/servers";
import { CONFIG_FILE, defaultWorkspace, ensureLayout } from "../paths";

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

type ConfigFile = { version: 1; personas: Persona[] };

function emptyConfig(): ConfigFile {
	return { version: 1, personas: [] };
}

function read(): ConfigFile {
	ensureLayout();
	if (!existsSync(CONFIG_FILE)) return emptyConfig();
	try {
		const parsed = JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as ConfigFile;
		if (!Array.isArray(parsed.personas)) return emptyConfig();
		for (const p of parsed.personas) {
			// Tolerate configs written before these fields existed. A legacy
			// lastSessionId can only have belonged to the backend selected when
			// that config was written, so that is the one safe migration.
			p.mcpPolicy = normalizePolicy(p.mcpPolicy);
			p.computer = normalizeComputer(p.computer);
			p.subagents = normalizePersonaSubagents(p.subagents);
			p.sessionCheckpoints = Array.isArray(p.sessionCheckpoints)
				? p.sessionCheckpoints.filter(
						(checkpoint) =>
							checkpoint &&
							typeof checkpoint.backendId === "string" &&
							typeof checkpoint.sessionId === "string" &&
							checkpoint.backendId.length > 0 &&
							checkpoint.sessionId.length > 0,
					)
				: [];
			if (
				p.lastSessionId &&
				!p.sessionCheckpoints.some((checkpoint) => checkpoint.backendId === p.backendId)
			) {
				p.sessionCheckpoints.push({ backendId: p.backendId, sessionId: p.lastSessionId });
			}
			delete p.lastSessionId;
		}
		return parsed;
	} catch {
		return emptyConfig();
	}
}

function write(config: ConfigFile): void {
	ensureLayout();
	writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export function listPersonas(): Persona[] {
	return read().personas;
}

export function getPersona(id: string): Persona | undefined {
	return read().personas.find((p) => p.id === id);
}

export function createPersona(draft: PersonaDraft): Persona {
	const config = read();
	const id = randomUUID();
	const now = Date.now();
	const computer = normalizeComputer(draft.computer);
	const persona: Persona = {
		id,
		name: draft.name.trim() || "Untitled",
		goal: draft.goal?.trim() ?? "",
		backendId: draft.backendId ?? DEFAULT_BACKEND_ID,
		...(draft.modelId?.trim() ? { modelId: draft.modelId.trim() } : {}),
		cwd: draft.cwd?.trim() || defaultWorkspace(id),
		mcpPolicy: { ...DEFAULT_MCP_POLICY },
		...(computer ? { computer } : {}),
		sessionCheckpoints: [],
		createdAt: now,
		updatedAt: now,
	};
	config.personas.push(persona);
	write(config);
	materializeWorkspace(persona);
	return persona;
}

export function updatePersona(id: string, patch: Partial<Persona>): Persona {
	const config = read();
	const index = config.personas.findIndex((p) => p.id === id);
	if (index === -1) throw new Error(`No persona ${id}`);

	const previous = config.personas[index]!;
	const next: Persona = { ...previous, ...patch, id: previous.id, updatedAt: Date.now() };
	if ("subagents" in patch) next.subagents = normalizePersonaSubagents(patch.subagents);
	config.personas[index] = next;
	write(config);

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
 * checkpoint a teammate may later return to in another harness.
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

export function deletePersona(id: string): void {
	const config = read();
	config.personas = config.personas.filter((p) => p.id !== id);
	write(config);
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
