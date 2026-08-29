import { isBusy } from "../../shared/session";
import type { HopResult, SessionState } from "../../shared/types";
import { getRecord, localNodeId } from "../store/records";

/**
 * The parked self-hop: a teammate that asked, mid-turn, to move itself.
 *
 * A teammate calling a tool is by definition mid-turn, and the hop machinery
 * refuses busy sessions — correctly. So the tool validates and *parks*, and
 * the park fires the normal hop, all guards included, when the session next
 * leaves its busy states. One park per teammate; a second request replaces the
 * first, because the teammate's last word on where it wants to be is the one
 * that counts.
 *
 * Parks are machine-bound, like the hop notice: where the teammate lives is
 * this desk's business. Unlike the hop notice they are deliberately in-memory
 * only. A park is a promise about *this* turn ending, and a process restart
 * dissolves the turn it was about — a stale park firing an hour later, moving
 * a teammate that no longer expects to move, would be far worse than one the
 * teammate has to ask for again. A failed fire is never retried either: the
 * failure lands on the tape as a notice and the park is cleared, so there is
 * no silent retry loop and no wedged pending state.
 */

type SelfHopDeps = {
	/** The real hop, flagged as self-requested so the destination resumes it. */
	hop(personaId: string, toNodeId: string): Promise<HopResult>;
	/** A failed park lands on the teammate's tape, loudly. */
	notice(personaId: string, text: string): void;
};

let deps: SelfHopDeps = {
	hop: async () => ({ ok: false, error: "The self-hop machinery is not wired" }),
	notice: () => {},
};

export function initSelfHop(next: Partial<SelfHopDeps>): void {
	deps = { ...deps, ...next };
}

/**
 * Whether this teammate may move itself between desks. Everyone may today;
 * task-31 lands the control-plane permission system, and its answer plugs in
 * here — one predicate, one call site per tool, nothing more.
 */
export function selfHopAllowed(_personaId: string): boolean {
	return true;
}

export type SelfHopPark = { toNodeId: string; toName: string; parkedAt: number };

const parks = new Map<string, SelfHopPark>();
const firing = new Set<string>();

/** Parks the request, replacing any earlier one. Returns what it replaced. */
export function parkSelfHop(
	personaId: string,
	toNodeId: string,
	toName: string,
): { replaced?: string } {
	const existing = parks.get(personaId);
	parks.set(personaId, { toNodeId, toName, parkedAt: Date.now() });
	return existing && existing.toNodeId !== toNodeId ? { replaced: existing.toName } : {};
}

export function pendingSelfHop(personaId: string): SelfHopPark | undefined {
	return parks.get(personaId);
}

/**
 * The trigger: session state transitions, the same seam the hop's own busy
 * rule reads. Wired from the supervisor's `sessionInfoChanged` broadcast, so
 * the park fires the moment the turn that parked it ends. Firing consumes the
 * park whatever the outcome — on success the teammate has left this desk, and
 * on failure the notice says so and invites asking again.
 */
export function observeSessionForSelfHop(info: { personaId: string; state: SessionState }): void {
	const park = parks.get(info.personaId);
	if (!park || isBusy(info.state) || firing.has(info.personaId)) return;
	// A human-driven hop or a deletion may have raced the park; a park is this
	// desk's business and dissolves with the teammate's residency here.
	const record = getRecord("persona", info.personaId);
	if (!record || record.deleted || record.ownerNode !== localNodeId()) {
		parks.delete(info.personaId);
		return;
	}
	firing.add(info.personaId);
	const failed = (detail: string) =>
		deps.notice(
			info.personaId,
			`The move to "${park.toName}" you asked for did not happen: ${detail} ` +
				"The request is cleared — call hop_desk again if you still want to move.",
		);
	void deps
		.hop(info.personaId, park.toNodeId)
		.then((result) => {
			if (!result.ok) failed(result.error.endsWith(".") ? result.error : `${result.error}.`);
		})
		.catch((error) => failed(error instanceof Error ? error.message : String(error)))
		.finally(() => {
			parks.delete(info.personaId);
			firing.delete(info.personaId);
		});
}
