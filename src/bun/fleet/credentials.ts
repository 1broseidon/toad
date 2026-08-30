import {
	credentialSecret,
	heldCredentialIds,
	isRoomSecretProvider,
	listCredentials,
	onCredentialsChanged,
	pendingCredentialTeardowns,
	resealCredentials,
	settleCredentialTeardowns,
} from "../store/credentials";

/**
 * The credential plane's wiring: what turns owned records into a shared key.
 *
 * The store (`store/credentials.ts`) knows how to seal, open, withdraw and
 * account. It deliberately knows nothing about wires, membership sweeps or the
 * built-in agent. This module is the other half — the three consequences of a
 * credential changing, none of which the store should be reaching out to do:
 *
 * 1. **Re-seal.** A desk admitted after an opt-in has no box until somebody
 *    makes one, and a desk that left the room should stop being sealed to. Both
 *    show up as a changed recipient set, so one idempotent pass on every wire
 *    sweep covers admission, exile and startup without a callback per event.
 * 2. **Confirm the teardown.** Withdrawing publishes a record with no boxes in
 *    it, which *is* the deletion — but only for a desk that has applied it. So
 *    the owner asks each pending desk what it actually holds and records the
 *    answer. A dark desk simply is not asked, stays pending, and settles on the
 *    sweep that follows its return. Never a promise; always a look.
 * 3. **Hand the key to the built-in agent.** A replicated key that no agent can
 *    use would make the capability advertisement a lie, so the secret is pushed
 *    into pi's *runtime* credential overlay — in memory, never written to
 *    auth.json. Decrypt at injection, and nowhere else.
 *
 * ACP backends are not covered by any of this, per task-37 4.5: an external
 * harness holds its own provider auth in its own config, and Toad speaks the
 * protocol rather than the login. That is a decision, not an omission, and the
 * credential surface has to say so where an operator will meet it.
 */

/** Calls one peer over its live NodeLink, or null when that desk is dark. */
export type PeerCall = (
	nodeId: string,
	method: string,
	params: unknown,
) => Promise<unknown> | null;

let callPeer: PeerCall = () => null;
let wired = false;

/**
 * Wires the plane. Called from `initPeerWires`, because everything here needs a
 * way to reach a peer and that is the module that owns one.
 */
export function initCredentialPlane(input: { callPeer: PeerCall }): void {
	callPeer = input.callPeer;
	if (wired) return;
	wired = true;
	onCredentialsChanged(() => {
		void injectRuntimeKeys();
		void confirmTeardowns();
	});
	void injectRuntimeKeys();
}

/**
 * One pass of the plane, on whatever the room looks like right now.
 *
 * Cheap by construction and safe to call on every sweep: the re-seal writes only
 * when the recipient set moved, and the confirmation asks only about withdrawals
 * that are still outstanding. An idle room's pass is two reads.
 */
export async function syncRoomCredentials(): Promise<void> {
	try {
		resealCredentials();
	} catch {
		/* A damaged store or an unreadable vault is loud on its own path; a
		 * background sweep must not turn it into an unhandled rejection. */
	}
	await confirmTeardowns();
}

/** The peer-facing half: of these ids, what this desk still holds. */
export function handleCredentialsHeld(params: unknown): { held: string[] } {
	const ids = (params as { ids?: unknown } | null)?.ids;
	if (!Array.isArray(ids)) return { held: [] };
	return {
		held: heldCredentialIds(ids.filter((id): id is string => typeof id === "string")),
	};
}

let confirming = false;
let confirmAgain = false;

/**
 * Asks every desk a withdrawal is waiting on what it holds, and records it.
 *
 * Re-entrant by flag rather than by lock, for the same reason the sync drain is:
 * recording a confirmation rings the credential bell, which lands back here, and
 * two overlapping sweeps would ask the same desks the same question and write
 * the same op twice.
 */
async function confirmTeardowns(): Promise<void> {
	if (confirming) {
		confirmAgain = true;
		return;
	}
	confirming = true;
	try {
		do {
			confirmAgain = false;
			const pending = pendingCredentialTeardowns();
			if (pending.length === 0) return;

			const asking = new Map<string, string[]>();
			for (const row of pending) {
				for (const desk of row.pending) {
					asking.set(desk, [...(asking.get(desk) ?? []), row.id]);
				}
			}

			const gone: Record<string, string[]> = {};
			await Promise.all(
				[...asking].map(async ([nodeId, ids]) => {
					const answer = callPeer(nodeId, "credentialsHeld", { ids });
					// A dark desk is not asked and is not confirmed. That is the
					// whole point: it stays pending until it comes back.
					if (!answer) return;
					try {
						const held = (await answer) as { held?: unknown };
						const still = new Set(
							Array.isArray(held?.held)
								? held.held.filter((id): id is string => typeof id === "string")
								: [],
						);
						gone[nodeId] = ids.filter((id) => !still.has(id));
					} catch {
						/* A desk too old to know the method, or one that dropped
						 * mid-question, has not been observed holding nothing. */
					}
				}),
			);
			settleCredentialTeardowns(gone);
		} while (confirmAgain);
	} finally {
		confirming = false;
	}
}

/* ---------------------------------------------------------- the built-in agent
 * pi keeps a runtime credential overlay that shadows its stored auth and is
 * never persisted (`RuntimeCredentials` in pi-coding-agent). That is exactly
 * the shape a replicated key wants: present for the life of the process, gone
 * when it exits, and nowhere on this disk in plaintext.
 */

/** Providers this module put into pi's overlay, so it can take them back out. */
const injected = new Map<string, string>();
let injecting = false;
let injectAgain = false;

async function injectRuntimeKeys(): Promise<void> {
	if (injecting) {
		injectAgain = true;
		return;
	}
	injecting = true;
	try {
		do {
			injectAgain = false;
			await pushRuntimeKeys();
		} while (injectAgain);
	} finally {
		injecting = false;
	}
}

async function pushRuntimeKeys(): Promise<void> {
	const wanted = new Map<string, string>();
	for (const credential of listCredentials()) {
		if (credential.kind !== "api_key" || credential.revoked || !credential.usableHere) continue;
		// Toad's own secrets — the APNs signing key — live in this vault because
		// it is the right vault, not because they authenticate a model provider.
		if (isRoomSecretProvider(credential.providerId)) continue;
		if (wanted.has(credential.providerId)) continue;
		const secret = credentialSecret(credential.id);
		if (secret) wanted.set(credential.providerId, secret);
	}

	let runtime: Awaited<ReturnType<typeof import("../pi/runtime").piRuntime>>;
	try {
		const { piRuntime } = await import("../pi/runtime");
		runtime = await piRuntime();
	} catch {
		/* A runtime that cannot load the built-in agent's tree — a verify
		 * harness, an ACP-only launch — still replicates and still advertises;
		 * it just has no in-process agent to hand a key to. Same forgiveness
		 * `capabilities.ts` extends for the same reason. */
		return;
	}

	for (const [providerId, key] of wanted) {
		if (injected.get(providerId) === key) continue;
		if (!runtime.getProvider(providerId)) continue;
		/* Toad's vault fills gaps in pi's own authentication; it never shadows a
		 * login pi already holds. A person who signed in on this machine did so
		 * deliberately, and silently answering with somebody else's key instead
		 * would be the kind of surprise no error message could explain. Our own
		 * previous injection reads back as `runtime`, and replacing that is just
		 * this function catching up with a rotated record. */
		const status = runtime.getProviderAuthStatus(providerId);
		if (status.configured && status.source !== "runtime") continue;
		try {
			await runtime.setRuntimeApiKey(providerId, key);
			injected.set(providerId, key);
		} catch {
			/* A provider that refuses the key stays uninjected and unadvertised
			 * on the next refresh; nothing here is worth failing a sweep over. */
		}
	}

	for (const providerId of [...injected.keys()]) {
		if (wanted.has(providerId)) continue;
		injected.delete(providerId);
		try {
			await runtime.removeRuntimeApiKey(providerId);
		} catch {
			/* Already gone, or a provider pi has since forgotten. */
		}
	}
}
