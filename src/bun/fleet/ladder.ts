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

	return matched ? { ...matched, rungs } : { rung: "unavailable", rungs };
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
