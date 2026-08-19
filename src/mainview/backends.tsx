import type { Backend } from "../shared/types";

/**
 * How a backend reads wherever it is listed.
 *
 * Four places name the same thing — the roster's add card, the default in app
 * settings, a teammate's own picker, and the backends list — and an agent that
 * is not installed has to say so in all of them, in the same words. Written out
 * at each one, that is four chances for the wording to drift.
 */

/** Why this backend cannot be launched. */
export function unavailableOf(backend: Backend): string {
	return backend.unavailableReason ?? "not installed";
}

/** The name, and what is wrong with it when something is. */
export function backendOptionLabel(backend: Backend): string {
	return backend.available ? backend.name : `${backend.name} — ${unavailableOf(backend)}`;
}

/** Every backend as an `<option>`, with the unavailable ones unpickable. */
export function BackendOptions({ backends }: { backends: Backend[] }) {
	return (
		<>
			{backends.map((backend) => (
				<option key={backend.id} value={backend.id} disabled={!backend.available}>
					{backendOptionLabel(backend)}
				</option>
			))}
		</>
	);
}
