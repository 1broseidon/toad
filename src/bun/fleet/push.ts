import { pushKeyDesks } from "../push/apns";
import {
	heldPushRegistrationIds,
	listPushRegistrations,
	onPushChanged,
	pendingPushPrunes,
	pendingPushTeardowns,
	type PushRegistration,
	reportPushTokenDead,
	resealPushRegistrations,
	settlePushTeardowns,
} from "../store/push";
import { localNodeId } from "../store/records";
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
 *
 * And one thing the credential plane has no equivalent of: **electing who
 * sends**. A key is used by whoever needs it; an address that every desk can
 * post to needs exactly one desk to post. See `electPushSenders`.
 */

let callPeer: PeerCall = () => null;
let peerLive: (nodeId: string) => boolean = () => false;
let wired = false;

/** Wires the plane, from `initPeerWires` — the module that owns a way to a peer. */
export function initPushPlane(input: {
	callPeer: PeerCall;
	/** Whether the standing NodeLink to a desk is up right now. */
	peerLive: (nodeId: string) => boolean;
}): void {
	callPeer = input.callPeer;
	peerLive = input.peerLive;
	if (wired) return;
	wired = true;
	onPushChanged(() => {
		void reportPrunes();
	});
}

/* ------------------------------------------------------------ who sends
 *
 * Replication made every desk able to reach every phone, which is the whole
 * point and also, unaddressed, three buzzes for one finished turn. Apple's
 * collapse id folds simultaneous posts into one banner, but a banner is not the
 * promise — a phone that was asleep gets them as separate deliveries, and a
 * feature whose correctness rests on Apple's coalescing timing is not correct.
 *
 * So one desk sends, chosen by a rule rather than by who got there first.
 */

/** Which desk is to post to which registration. Empty means nobody sends. */
export type PushSenderPlan = Record<string, string>;

/**
 * Two registrations that are one phone.
 *
 * A phone admitted to the room gets a device row — and therefore a registration
 * record — on every desk it has connected to, each honestly owned by that desk
 * and all naming the same APNs token. Electing per record would elect two desks
 * for one pocket. `memberNodeId` is the phone's own plane identity, carried
 * plain in the replicated class, so every desk groups them identically without
 * decrypting anything. A pre-plane web pairing has no member id and exists on
 * exactly one desk, so it is its own group.
 */
function phoneKey(row: PushRegistration): string {
	return row.memberNodeId ? `member:${row.memberNodeId}` : `row:${row.id}`;
}

/**
 * Who should post to each phone, decided here and now on this desk's links.
 *
 * The rule: **the owning desk sends while it is up, and the room falls through
 * to the next desk only when the owner's NodeLink is down.** The owner first
 * because it is the desk holding the phone's socket — it is the only desk that
 * knows what the phone is looking at, so its silence-when-you-are-already-there
 * check is the only one that means anything. Falling through by *link* and not
 * by a stored origin or a last-seen timestamp because on this plane the link is
 * the currency: a desk you cannot call is a desk that cannot help you, whatever
 * a record says about it.
 *
 * Candidates are the desks that hold both halves — an address for this phone,
 * and the signing key — read from the two replicated records, so the ordering
 * is a pure function of bytes every desk holds identically. The only local
 * input is liveness, and that is the point of the next paragraph.
 *
 * **Why this cannot double-send.** The plan is computed exactly once per event,
 * by the desk the event happened on, and travels with the envelope; every other
 * desk obeys the name it is given and never forms an opinion of its own. Two
 * desks therefore cannot disagree about whether the owner is up, because only
 * one of them is ever asked — there is no second opinion for the disagreement
 * window to open between. Contrast the obvious alternative, where each desk
 * decides for itself: a desk whose link to the owner is merely flapping would
 * elect itself while the owner, which believes it is up because it is, sends
 * too. The trade is that an elected desk which dies between the election and
 * the envelope drops that one buzz. That is the correct side to fail on — a
 * missed interruption costs one glance at the screen, while a doubled one
 * teaches the human to stop trusting all of them, and the next event elects
 * again on a fresh link table.
 *
 * A desk running alone elects itself for everything, so a room of one is
 * unchanged: it was already the only candidate.
 */
export function electPushSenders(): PushSenderPlan {
	const here = localNodeId();
	const keyDesks = new Set(pushKeyDesks());
	const groups = new Map<string, PushRegistration[]>();
	for (const row of listPushRegistrations()) {
		if (row.dead || row.revoked) continue;
		const key = phoneKey(row);
		groups.set(key, [...(groups.get(key) ?? []), row]);
	}

	const plan: PushSenderPlan = {};
	for (const rows of groups.values()) {
		// Owners first, then everyone sealed a copy. Sorted at both levels so a
		// group with two owners still resolves the same way on every desk.
		const owners = [...new Set(rows.map((row) => row.ownerNode))].sort();
		const standins = [...new Set(rows.flatMap((row) => row.sealedTo))]
			.filter((id) => !owners.includes(id))
			.sort();
		const sender = [...owners, ...standins].find(
			(id) => keyDesks.has(id) && (id === here || peerLive(id)),
		);
		if (!sender) continue;
		for (const row of rows) plan[row.id] = sender;
	}
	return plan;
}

/** A plan off the wire, believed only in the shape it is supposed to have. */
export function readPushSenderPlan(value: unknown): PushSenderPlan | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const plan: PushSenderPlan = {};
	for (const [id, nodeId] of Object.entries(value as Record<string, unknown>)) {
		if (typeof nodeId === "string" && nodeId) plan[id] = nodeId;
	}
	return plan;
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
