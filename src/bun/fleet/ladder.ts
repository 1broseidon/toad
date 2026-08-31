import type {
	DeskCapabilities,
	HarnessChoice,
	HarnessResolution,
	HarnessRungReport,
} from "../../shared/types";
import { PI_BACKEND_ID } from "../acp/registry";

/**
 * The matching ladder: what would run a teammate on a given desk, and why.
 *
 * Three rungs, tried in order — the exact harness+model the teammate uses now,
 * its configured override, the room's default — against nothing but the
 * destination's advertised capabilities. Pure on purpose: no store, no wire,
 * no clock, so the answer is the same wherever in the room it is computed and
 * a test can hand it any world it likes.
 *
 * Every rung's verdict is reported, matched or not, because the answer a
 * teammate's card needs is not just "codex" but "codex, because the exact
 * harness is missing there and the override matched". The walk does not stop
 * at the first match for the same reason.
 *
 * Deliberately not pi-only. The built-in agent is one harness among the
 * advertised ones; what deepens for it is the model check, because a desk
 * advertises the built-in agent's model catalog and advertises nothing about
 * an external harness's — the harness resolves its own models when it starts.
 */
export function resolveHarness(input: {
	/** What the teammate runs today — the exact rung. */
	current: HarnessChoice;
	/** The teammate's configured fallback, if any — the override rung. */
	override?: HarnessChoice;
	/** The room's configured fallback, if any — the default rung. */
	roomDefault?: HarnessChoice;
	/** Plugin ids this teammate's work depends on. Empty is the common case. */
	requiredPlugins?: readonly string[];
	/** The destination desk's advertisement. */
	destination: DeskCapabilities;
}): HarnessResolution {
	const rungs: HarnessRungReport[] = [];
	let matched: { rung: "exact" | "override" | "default"; choice: HarnessChoice } | undefined;


	const climb: Array<{ rung: "exact" | "override" | "default"; choice?: HarnessChoice }> = [
		{ rung: "exact", choice: input.current },
		{ rung: "override", choice: input.override },
		{ rung: "default", choice: input.roomDefault },
	];
	for (const { rung, choice } of climb) {
		if (!choice) {
			rungs.push({ rung, choice: null, ok: false, reason: "nothing configured at this rung" });
			continue;
		}
		const verdict = runsOn(choice, input.destination);
		rungs.push({ rung, choice, ok: verdict.ok, reason: verdict.reason });
		if (verdict.ok && !matched) matched = { rung, choice };
	}

	/* Reported after the climb, and always — even when the teammate needs no
	 * plugin, because an absent line would read as "we did not check". It is not
	 * part of the climb: a missing plugin is not something a different harness
	 * fixes, so this one is a veto over whatever the climb matched rather than a
	 * fourth thing to try. */
	const plugins = pluginsOn(input.requiredPlugins ?? [], input.destination);
	rungs.push({ rung: "plugins", choice: null, ok: plugins.ok, reason: plugins.reason });

	return matched && plugins.ok ? { ...matched, rungs } : { rung: "unavailable", rungs };
}

/**
 * Whether the destination has every plugin this teammate needs.
 *
 * The three answers are deliberately distinct. A desk that advertises a
 * `format` and does not list the plugin really does not have it. A desk with no
 * `format` is running a build from before plugins were advertised, and its
 * silence means "too old to say" — refusing on that would be a refusal whose
 * stated reason is false, which is worse than either allowing or refusing
 * honestly. A version difference never refuses: the destination's version runs,
 * and the hop's own notice names the delta.
 */
function pluginsOn(
	required: readonly string[],
	desk: DeskCapabilities,
): { ok: boolean; reason: string } {
	if (required.length === 0) return { ok: true, reason: "this teammate needs no plugins" };
	if (desk.format === undefined) {
		return {
			ok: false,
			reason: `that desk is too old to say which plugins it has, and this teammate needs ${required.join(", ")}`,
		};
	}
	const held = new Set((desk.plugins ?? []).map((entry) => entry.id));
	const missing = required.filter((id) => !held.has(id));
	if (missing.length > 0) {
		return { ok: false, reason: `that desk does not have ${missing.join(", ")}` };
	}
	return { ok: true, reason: `that desk has ${required.join(", ")}` };
}

/** Whether one choice runs on one desk, per its advertisement, and why. */
function runsOn(choice: HarnessChoice, desk: DeskCapabilities): { ok: boolean; reason: string } {
	const harness = desk.harnesses.find((entry) => entry.id === choice.backendId);
	if (!harness) {
		return { ok: false, reason: `${choice.backendId} is not advertised by that desk` };
	}
	if (!harness.available) {
		return { ok: false, reason: `${harness.name} is not available on that desk` };
	}
	if (choice.backendId === PI_BACKEND_ID) {
		if (!desk.builtin.authenticated) {
			return { ok: false, reason: `${harness.name} has no signed-in provider on that desk` };
		}
		if (choice.modelId) {
			/* The catalog is a hint, not a gate. Desks' model lists drift — a
			 * stale provider probe on one desk must not strand a teammate whose
			 * provider is signed in there (the live room proved it: one desk's
			 * zai catalog lacked glm-5.3 while its zai auth served it fine). A
			 * model runs where its provider is authenticated; only a provider
			 * the desk has never signed into is a real refusal. */
			const provider = choice.modelId.split("/")[0] ?? "";
			const inCatalog = desk.builtin.models.includes(choice.modelId);
			if (!inCatalog && !desk.builtin.providers.includes(provider)) {
				return { ok: false, reason: `${harness.name} there is not signed into ${provider}` };
			}
			return {
				ok: true,
				reason: inCatalog
					? `${harness.name} there serves ${choice.modelId}`
					: `${harness.name} there is signed into ${provider}, which serves ${choice.modelId}`,
			};
		}
		return { ok: true, reason: `${harness.name} is signed in on that desk` };
	}
	return { ok: true, reason: `${harness.name} is available on that desk` };
}
