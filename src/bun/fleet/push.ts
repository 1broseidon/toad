import {
	heldPushRegistrationIds,
	onPushChanged,
	pendingPushPrunes,
	pendingPushTeardowns,
	reportPushTokenDead,
	resealPushRegistrations,
	settlePushTeardowns,
} from "../store/push";
import type { PeerCall } from "./credentials";

/**
 * The push plane's wiring: what turns owned registrations into a room that can
 * reach one phone from any desk.
 *
 * `store/push.ts` knows how to seal, open, withdraw and account, and knows
 * nothing about wires. This module is the other half — the three consequences
 * of a registration changing, none of which the store should be reaching out to
 * do. It is deliberately the same three shapes `fleet/credentials.ts` runs, on
 * the same sweep, because a push registration is a sealed owned record and there
 * is no second replication model here:
 *
 * 1. **Re-seal.** A desk admitted after a phone registered has no box until
 *    somebody makes one, and a desk that left should stop being sealed to.
 * 2. **Confirm the teardown.** Unpairing publishes a record with no boxes in it,
 *    which *is* the deletion — but only for a desk that has applied it. So the
 *    owner asks each pending desk what it actually holds. A dark desk is not
 *    asked, stays pending, and settles on the sweep after it returns.
 * 3. **Report a prune upstream.** Apple's `BadDeviceToken` can arrive at any
 *    desk, but only the owner may publish the fact. So a desk that watched a
 *    token die stops using it at once, durably, and keeps telling the owner
 *    until the owner's op comes back. That is the difference between a prune
 *    that travels and a desk quietly forgetting on the room's behalf.
 */

let callPeer: PeerCall = () => null;
let wired = false;

/** Wires the plane, from `initPeerWires` — the module that owns a way to a peer. */
export function initPushPlane(input: { callPeer: PeerCall }): void {
	callPeer = input.callPeer;
	if (wired) return;
	wired = true;
	onPushChanged(() => {
		void reportPrunes();
	});
}

/**
 * One pass, on whatever the room looks like right now.
 *
 * Cheap by construction and safe on every sweep: the re-seal writes only when
 * the recipient set moved, and both conversations happen only when something is
 * actually outstanding. An idle room's pass is three reads.
 */
export async function syncRoomPush(): Promise<void> {
	try {
		resealPushRegistrations();
	} catch {
		/* A damaged store is loud on its own path; a background sweep must not
		 * turn it into an unhandled rejection. */
	}
	await Promise.all([confirmTeardowns(), reportPrunes()]);
}

/** The peer-facing half: of these registrations, what this desk still holds. */
export function handlePushHeld(params: unknown): { held: string[] } {
	const ids = (params as { ids?: unknown } | null)?.ids;
	if (!Array.isArray(ids)) return { held: [] };
	return { held: heldPushRegistrationIds(ids.filter((id): id is string => typeof id === "string")) };
}

/**
 * "Apple told me this address of yours is dead."
 *
 * Answered only for a registration this desk owns, and only when the generation
 * still matches — a report that crossed paths with the phone's next launch names
 * a token that has already been replaced, and honouring it would kill the live
 * one. `reportPushTokenDead` enforces both; this is the door.
 */
export function handlePushTokenDead(params: unknown): { pruned: boolean } {
	const body = (params ?? {}) as { id?: unknown; generation?: unknown };
	if (typeof body.id !== "string" || typeof body.generation !== "number") return { pruned: false };
	return { pruned: reportPushTokenDead(body.id, body.generation) };
}

let confirming = false;
let confirmAgain = false;

/**
 * Asks every desk a withdrawal is waiting on what it holds, and records it.
 *
 * Re-entrant by flag rather than by lock, for the same reason the credential
 * sweep is: recording a confirmation rings the push bell, which can land back
 * here, and two overlapping sweeps would ask the same desks the same question
 * and write the same op twice.
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
			const pending = pendingPushTeardowns();
			if (pending.length === 0) return;

			const asking = new Map<string, string[]>();
			for (const row of pending) {
				for (const desk of row.pending) asking.set(desk, [...(asking.get(desk) ?? []), row.id]);
			}

			const gone: Record<string, string[]> = {};
			await Promise.all(
				[...asking].map(async ([nodeId, ids]) => {
					const answer = callPeer(nodeId, "pushRegistrationsHeld", { ids });
					// A dark desk is not asked and is not confirmed. That is the whole
					// point: it stays pending until it comes back.
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
			settlePushTeardowns(gone);
		} while (confirmAgain);
	} finally {
		confirming = false;
	}
}

let reporting = false;

/**
 * Tells each owner about the addresses of theirs this desk watched die.
 *
 * No acknowledgement is recorded and none is wanted. The proof the report
 * landed is the owner's own op coming back with `dead` set, which is what
 * clears the pending list — so a lost call, a dark owner, or a restart in
 * between all resolve into "tell it again on the next sweep".
 */
async function reportPrunes(): Promise<void> {
	if (reporting) return;
	reporting = true;
	try {
		const pending = pendingPushPrunes();
		await Promise.all(
			pending.map(async (row) => {
				const answer = callPeer(row.ownerNode, "pushTokenDead", {
					id: row.id,
					generation: row.generation,
				});
				if (!answer) return;
				try {
					await answer;
				} catch {
					/* A desk too old to know the method keeps its dead token until it
					 * is upgraded; this desk has already stopped using it. */
				}
			}),
		);
	} finally {
		reporting = false;
	}
}
