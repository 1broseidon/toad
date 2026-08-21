import type {
	Persona,
	PersonaSubagents,
	ResolvedSubagent,
	SubagentDefaults,
	SubagentSpec,
} from "./types";

/** Reserved `kind` for the built-in task runner. Operators cannot take this id. */
export const GENERIC_SUBAGENT_KIND = "generic";

export const DEFAULT_TASK_RUNNER_NAME = "Task runner";
export const DEFAULT_TASK_RUNNER_DESCRIPTION =
	"A silent coding runner in this workspace. Use for bounded work that would take many tool calls, or for pieces that can run at the same time.";

export const MAX_SUBAGENT_EXTRAS = 16;
export const MAX_SUBAGENT_NAME = 60;
export const MAX_SUBAGENT_DESCRIPTION = 400;
export const MAX_SUBAGENT_PROMPT = 4_000;
export const MAX_SUBAGENT_ID = 40;

function clip(value: string, max: number): string {
	return value.trim().slice(0, max);
}

function optionalText(value: unknown, max: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = clip(value, max);
	return text.length > 0 ? text : undefined;
}

/** Kind id from a display name. Empty when nothing legal remains. */
export function slugifySubagentId(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, MAX_SUBAGENT_ID);
}

export function isReservedSubagentId(id: string): boolean {
	return id === GENERIC_SUBAGENT_KIND;
}

export function isLegalSubagentId(id: string): boolean {
	return /^[a-z][a-z0-9-]{0,39}$/.test(id) && !isReservedSubagentId(id);
}

function uniqueExtraId(wanted: string, taken: Set<string>): string | undefined {
	const base = isLegalSubagentId(wanted) ? wanted : slugifySubagentId(wanted);
	if (!base || isReservedSubagentId(base)) return undefined;
	if (!taken.has(base) && isLegalSubagentId(base)) return base;
	for (let n = 2; n < 100; n++) {
		const candidate = `${base.slice(0, MAX_SUBAGENT_ID - String(n).length - 1)}-${n}`;
		if (!taken.has(candidate) && isLegalSubagentId(candidate)) return candidate;
	}
	return undefined;
}

function normalizeDefaults(value: unknown): SubagentDefaults | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const raw = value as Record<string, unknown>;
	const defaults: SubagentDefaults = {
		...(optionalText(raw.name, MAX_SUBAGENT_NAME) ? { name: clip(String(raw.name), MAX_SUBAGENT_NAME) } : {}),
		...(optionalText(raw.description, MAX_SUBAGENT_DESCRIPTION)
			? { description: clip(String(raw.description), MAX_SUBAGENT_DESCRIPTION) }
			: {}),
		...(optionalText(raw.prompt, MAX_SUBAGENT_PROMPT)
			? { prompt: clip(String(raw.prompt), MAX_SUBAGENT_PROMPT) }
			: {}),
		...(optionalText(raw.modelId, 120) ? { modelId: clip(String(raw.modelId), 120) } : {}),
	};
	return Object.keys(defaults).length > 0 ? defaults : undefined;
}

function normalizeExtra(value: unknown, taken: Set<string>): SubagentSpec | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const raw = value as Record<string, unknown>;
	const name = optionalText(raw.name, MAX_SUBAGENT_NAME);
	if (!name) return undefined;
	const id = uniqueExtraId(typeof raw.id === "string" ? raw.id : name, taken);
	if (!id) return undefined;
	const description =
		optionalText(raw.description, MAX_SUBAGENT_DESCRIPTION) ?? DEFAULT_TASK_RUNNER_DESCRIPTION;
	taken.add(id);
	return {
		id,
		name,
		description,
		...(optionalText(raw.prompt, MAX_SUBAGENT_PROMPT)
			? { prompt: clip(String(raw.prompt), MAX_SUBAGENT_PROMPT) }
			: {}),
		...(optionalText(raw.modelId, 120) ? { modelId: clip(String(raw.modelId), 120) } : {}),
	};
}

/**
 * Drop anything a hand-edited config could smuggle in. Missing or empty
 * becomes `undefined`, which is the same as "task runner only".
 */
export function normalizePersonaSubagents(value: unknown): PersonaSubagents | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const raw = value as Record<string, unknown>;
	const defaults = normalizeDefaults(raw.defaults);
	const taken = new Set<string>();
	const extras: SubagentSpec[] = [];
	if (Array.isArray(raw.extras)) {
		for (const item of raw.extras) {
			if (extras.length >= MAX_SUBAGENT_EXTRAS) break;
			const extra = normalizeExtra(item, taken);
			if (extra) extras.push(extra);
		}
	}
	if (!defaults && extras.length === 0) return undefined;
	return {
		...(defaults ? { defaults } : {}),
		...(extras.length > 0 ? { extras } : {}),
	};
}

export function defaultTaskRunner(defaults?: SubagentDefaults): ResolvedSubagent {
	return {
		id: GENERIC_SUBAGENT_KIND,
		name: defaults?.name?.trim() || DEFAULT_TASK_RUNNER_NAME,
		description: defaults?.description?.trim() || DEFAULT_TASK_RUNNER_DESCRIPTION,
		...(defaults?.prompt?.trim() ? { prompt: defaults.prompt.trim() } : {}),
		...(defaults?.modelId?.trim() ? { modelId: defaults.modelId.trim() } : {}),
		builtin: true,
	};
}

/** Every kind this teammate may pass to `subagent`, generic first. */
export function resolveSubagentRoster(persona: Pick<Persona, "subagents">): ResolvedSubagent[] {
	const stored = normalizePersonaSubagents(persona.subagents);
	const extras = (stored?.extras ?? []).map(
		(extra): ResolvedSubagent => ({
			id: extra.id,
			name: extra.name,
			description: extra.description,
			...(extra.prompt ? { prompt: extra.prompt } : {}),
			...(extra.modelId ? { modelId: extra.modelId } : {}),
			builtin: false,
		}),
	);
	return [defaultTaskRunner(stored?.defaults), ...extras];
}

export function findSubagent(
	roster: readonly ResolvedSubagent[],
	kind: string | undefined,
): ResolvedSubagent | undefined {
	const id = kind === undefined || kind === "" ? GENERIC_SUBAGENT_KIND : kind;
	return roster.find((entry) => entry.id === id);
}

export function subagentKindList(roster: readonly ResolvedSubagent[]): string {
	return roster.map((entry) => entry.id).join(", ");
}
