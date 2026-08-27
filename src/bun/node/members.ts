import type { NodeIdentity } from "../../shared/types";
import {
	getRecord,
	listRecords,
	localNodeId,
	putLocal,
	tombstoneLocal,
	type ResourceRecord,
} from "../store/records";
import { isNodeIdentity } from "./identity";

/**
 * Mobile membership: the phone as a record, not a row of tokens.
 *
 * A phone joins the plane once. The desk that admits it writes one `member`
 * record — the phone's public identity plus a grant naming which desks it may
 * list and open — and the record replicates over the same first-hand oplog
 * sync personas ride. Every granted desk can then authenticate the phone by
 * challenge against the replicated key; none of them mints a standing bearer
 * token for it. Removing the phone is a tombstone, which is a fact an offline
 * desk still learns, unlike a deleted row.
 *
 * Ownership rules are the store's, applied without exception: only the desk
 * that owns the member record edits its grant or revokes it. A second desk
 * scanning the same phone finds the record already replicated and writes
 * nothing — which is exactly the "one identity, one membership" gate.
 */

export type MobileMember = {
	nodeId: string;
	name: string;
	publicKey: string;
	fingerprint: string;
	protocol: 1;
	capabilities: NodeIdentity["capabilities"];
	/** Node ids of the desks this phone may list and open. */
	grant: string[];
	admittedAt: number;
	/** The desk that admitted this phone and owns the record. */
	ownerNode: string;
	updatedAt: number;
};

/** The record's replicated class, shaped for writing. */
function replicatedOf(member: {
	name: string;
	publicKey: string;
	fingerprint: string;
	protocol: 1;
	capabilities: NodeIdentity["capabilities"];
	grant: string[];
	admittedAt: number;
}): Record<string, unknown> {
	return {
		name: member.name,
		publicKey: member.publicKey,
		fingerprint: member.fingerprint,
		protocol: member.protocol,
		capabilities: member.capabilities,
		grant: member.grant,
		admittedAt: member.admittedAt,
	};
}

/**
 * A member out of a record, or null when the payload does not parse as one.
 *
 * Replicated payloads arrive from peers, so the shape check leans on the same
 * validator the admission surfaces use: a record whose identity fields would
 * not have been accepted as a `NodeIdentity` is not a member here either.
 */
export function mobileMemberOf(record: ResourceRecord): MobileMember | null {
	const body = record.replicated;
	const identity: NodeIdentity = {
		id: record.id,
		name: String(body.name ?? ""),
		publicKey: String(body.publicKey ?? ""),
		fingerprint: String(body.fingerprint ?? ""),
		protocol: 1,
		capabilities: Array.isArray(body.capabilities)
			? (body.capabilities as NodeIdentity["capabilities"])
			: [],
	};
	if (body.protocol !== 1 || !isNodeIdentity(identity)) return null;
	const grant = Array.isArray(body.grant)
		? (body.grant as unknown[]).filter((id): id is string => typeof id === "string")
		: [];
	return {
		nodeId: record.id,
		name: identity.name,
		publicKey: identity.publicKey,
		fingerprint: identity.fingerprint,
		protocol: 1,
		capabilities: identity.capabilities,
		grant,
		admittedAt: typeof body.admittedAt === "number" ? body.admittedAt : record.updatedAt,
		ownerNode: record.ownerNode,
		updatedAt: record.updatedAt,
	};
}

/** Live mobile members, local and replicated alike. */
export function listMobileMembers(): MobileMember[] {
	return listRecords("member")
		.map(mobileMemberOf)
		.filter((member): member is MobileMember => member !== null);
}

/** One live member; null when unknown or tombstoned. */
export function mobileMember(nodeId: string): MobileMember | null {
	const record = getRecord("member", nodeId);
	if (!record || record.deleted) return null;
	return mobileMemberOf(record);
}

export type AdmitOutcome =
	| { ok: true; member: MobileMember; existing: boolean }
	| { ok: false; reason: "revoked" | "invalid" };

/**
 * Admits a phone, or recognises one already admitted.
 *
 * The caller has already checked possession of a live pairing code; this is
 * the membership half. A live record — whoever owns it — means the phone is
 * already a member, and a second scan changes nothing. A tombstone means it
 * was deliberately removed: rejoining after a revocation is an explicit
 * re-admission on the desk that owns the record, never a side effect of
 * scanning a QR, so the desks that did not revoke it refuse too.
 */
export function admitMobileMember(node: NodeIdentity, grant: string[]): AdmitOutcome {
	if (!isNodeIdentity(node) || !node.capabilities.includes("endpoint")) {
		return { ok: false, reason: "invalid" };
	}
	const current = getRecord("member", node.id);
	if (current) {
		if (current.deleted) {
			// Owner may resurrect deliberately via re-admission on its own desk.
			if (current.ownerNode !== localNodeId()) return { ok: false, reason: "revoked" };
		} else {
			const member = mobileMemberOf(current);
			if (member) return { ok: true, member, existing: true };
			// A live record that does not parse is version skew; refuse rather
			// than overwrite identity fields somebody else replicated.
			return { ok: false, reason: "invalid" };
		}
	}
	const admittedAt = Date.now();
	const record = putLocal("member", node.id, {
		replicated: replicatedOf({
			name: node.name,
			publicKey: node.publicKey,
			fingerprint: node.fingerprint,
			protocol: 1,
			capabilities: node.capabilities,
			grant,
			admittedAt,
		}),
	});
	notifyMembersChanged();
	const member = mobileMemberOf(record);
	return member ? { ok: true, member, existing: false } : { ok: false, reason: "invalid" };
}

/**
 * Rewrites the grant. Owner-only: another desk's edit would fork the record.
 */
export function setMemberGrant(nodeId: string, grant: string[]): MobileMember | null {
	const record = getRecord("member", nodeId);
	if (!record || record.deleted) return null;
	if (record.ownerNode !== localNodeId()) {
		throw new Error(`Only ${record.ownerNode} can change this phone's access`);
	}
	const member = mobileMemberOf(record);
	if (!member) return null;
	const clean = [...new Set(grant.filter((id) => typeof id === "string" && id.length > 0))];
	const saved = putLocal("member", nodeId, {
		replicated: replicatedOf({ ...member, grant: clean }),
	});
	notifyMembersChanged();
	return mobileMemberOf(saved);
}

/** Tombstones the membership. Owner-only, and every desk learns it. */
export function revokeMobileMember(nodeId: string): boolean {
	const record = getRecord("member", nodeId);
	if (!record || record.deleted) return false;
	if (record.ownerNode !== localNodeId()) {
		throw new Error(`Only ${record.ownerNode} can remove this phone`);
	}
	tombstoneLocal("member", nodeId);
	notifyMembersChanged();
	return true;
}

/** The grant, or null when the phone is not a live member. */
export function memberGrant(nodeId: string): string[] | null {
	return mobileMember(nodeId)?.grant ?? null;
}

const listeners: Array<() => void> = [];

/**
 * Rings when membership changes here — a local admit, grant edit, or revoke,
 * and remote member ops as sync applies them. The web server listens to close
 * a revoked phone's sockets in the same breath the tombstone lands.
 */
export function onMembersChanged(listener: () => void): void {
	listeners.push(listener);
}

export function notifyMembersChanged(): void {
	for (const listener of listeners) {
		try {
			listener();
		} catch {
			/* a listener's fault is not membership's problem */
		}
	}
}
