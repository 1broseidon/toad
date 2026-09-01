import type { ConfigChoice } from "../../shared/types";

/**
 * The thinking ladder, and the rule that a missing rung is a default.
 *
 * Kept away from `./runtime` on purpose: nothing here loads pi, so the ladder
 * can be reasoned about — and unit-tested — without the model runtime, and the
 * store can be asked what a stored `modeId` means without starting an agent.
 *
 * pi's own union (`ThinkingLevel` in `@earendil-works/pi-agent-core`) is these
 * same seven, but that package is not a direct dependency here, so the union is
 * restated. The compiler still checks one direction for us: a level pi drops
 * would fail where `PiSession` hands one to `createAgentSession`.
 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Every rung, weakest first. The order is pi's own — `getSupportedThinkingLevels`
 * filters this same sequence — so filtering by it preserves the ladder.
 */
export const THINKING_LADDER: readonly ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

/**
 * What a teammate thinks with when nobody has said.
 *
 * The same value pi defaults to (`DEFAULT_THINKING_LEVEL` in
 * pi-coding-agent — not exported from its entry point, so it is restated
 * rather than imported). It is deliberately a middle rung: a missing value is
 * an absence of a choice, and reading it as `off` turns a lost preference into
 * a silent capability cut, which is the failure direction that looks like the
 * model got dumber.
 */
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";

const LEVELS = new Set<string>(THINKING_LADDER);

/** Whether a stored string is a rung this build knows. */
export function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && LEVELS.has(value);
}

/**
 * A stored `modeId` read as a thinking level.
 *
 * The only way a level enters pi. Anything that is not a rung — missing, an
 * ACP backend's mode id left behind by a harness change, a value written by a
 * build that knew a level this one does not — reads as the default rather than
 * being cast through unchecked.
 */
export function thinkingLevelOf(modeId: string | undefined): ThinkingLevel {
	return isThinkingLevel(modeId) ? modeId : DEFAULT_THINKING_LEVEL;
}

/**
 * The ladder as the UI's mode list.
 *
 * Toad's words for pi's rungs, in one register. Descriptions are the house
 * voice: what the user is choosing, not what the API calls it.
 */
const THINKING_MODE_REGISTER: Record<ThinkingLevel, ConfigChoice> = {
	off: { id: "off", name: "Off", description: "No extended thinking" },
	minimal: { id: "minimal", name: "Minimal", description: "The least thinking there is" },
	low: { id: "low", name: "Low", description: "A little thinking before answering" },
	medium: { id: "medium", name: "Medium", description: "Balanced" },
	high: { id: "high", name: "High", description: "Thinks hard; slower" },
	xhigh: { id: "xhigh", name: "Extra high", description: "Thinks harder; slower again" },
	max: { id: "max", name: "Max", description: "Everything it has" },
};

/** Every rung, for a caller with no model to ask about. */
export const THINKING_MODES: ConfigChoice[] = THINKING_LADDER.map(
	(level) => THINKING_MODE_REGISTER[level],
);

/**
 * The rungs one model actually accepts, in ladder order.
 *
 * Support is per-model — pi's `getSupportedThinkingLevels` reads the model's
 * `thinkingLevelMap`, and `xhigh` and `max` exist only where a model maps them
 * — so the list is asked of the live session rather than being a flat
 * constant. Offering a level the model will refuse is how a picker lies about
 * what it can do; the previous flat five did the opposite, hiding `xhigh` from
 * every model that has it.
 *
 * A caller with nothing to say falls back to the whole ladder, which is what
 * pi does before a model is resolved.
 */
export function thinkingModesFor(levels: readonly string[] | undefined): ConfigChoice[] {
	if (!levels || levels.length === 0) return THINKING_MODES;
	const offered = new Set(levels.filter(isThinkingLevel));
	if (offered.size === 0) return THINKING_MODES;
	return THINKING_LADDER.filter((level) => offered.has(level)).map(
		(level) => THINKING_MODE_REGISTER[level],
	);
}
