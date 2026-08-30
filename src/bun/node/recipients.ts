import { isBannedFromRoom } from "./facts";
import { nodeIdentity } from "./identity";
import { listAdmittedNodes } from "./membership";

/**
 * Every desk this room would seal a secret to: admitted here, not this one,
 * not banned.
 *
 * One list, because there is one answer. Two sealed classes now ride the
 * record plane — provider credentials and push registrations — and a second
 * copy of this rule is a second place for "and also not banned" to be
 * forgotten.
 *
 * The ban check is not redundant with the admission list. A revocation tears
 * the admission down through the fleet path, and a desk sealing in the window
 * between hearing the fact and finishing that teardown would mint a fresh box
 * for a machine the room has just removed.
 */
export function sealRecipients(): Array<{ nodeId: string; publicKey: string }> {
	const self = nodeIdentity().id;
	return listAdmittedNodes()
		.filter((admission) => admission.node.id !== self && !isBannedFromRoom(admission.node.id))
		.map((admission) => ({ nodeId: admission.node.id, publicKey: admission.node.publicKey }));
}

/** The same list as ids alone, sorted — the shape a `sealedTo` compares against. */
export function sealRecipientIds(): string[] {
	return sealRecipients()
		.map((desk) => desk.nodeId)
		.sort();
}
