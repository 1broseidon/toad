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
 * Membership: a room member as a record, not a row of tokens.
 *
 * A phone joins the plane once. The desk that admits it writes one `member`
 * record — the phone's public identity plus a grant naming which desks it may
 * list and open — and the record replicates over the same first-hand oplog
 * sync personas ride. Every granted desk can then authenticate the phone by
 * challenge against the replicated key; none of them mints a standing bearer
 * token for it. Removing the phone is a tombstone, which is a fact an offline
 * desk still learns, unlike a deleted row.
 *
 * An outside MCP client is the same kind of citizen, so it is the same record:
 * a name, a scoped desk grant, one owning desk, one tombstone. Only the proof
 * differs — a phone holds a key, an agent holds a registered client secret —
 * and `seat` says which. Everything below the proof is deliberately shared,
 * because "admit, list, narrow the grant, revoke" should be one vocabulary for
 * every kind of member rather than one per kind.
 *
 * Ownership rules are the store's, applied without exception: only the desk
 * that owns the member record edits its grant or revokes it. A second desk
 * scanning the same phone finds the record already replicated and writes
 * nothing — which is exactly the "one identity, one membership" gate.
 */

/**
 * Which proof a member holds. Absent on records written before the client
 * seat existed, and those were all phones — so absent reads as "mobile".
 */
export type MemberSeat = "mobile" | "client";

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

/**
 * An outside MCP client's membership.
 *
 * The record id is the OAuth `client_id`, the way a phone's record id is its
 * node id: one identifier, minted once, that every desk in the grant can name.
 *
 * `secretHash` and not the secret, because this record replicates. A phone
 * publishes a public key the whole room can verify against and nobody can
 * spend; the digest of a 256-bit random client secret is the same shape of
 * thing. That is what lets a client authenticate to any desk its grant names,
 * exactly as a phone can, without the room carrying a spendable credential.
 */
export type ClientMember = {
	clientId: string;
	name: string;
	seat: "client";
	/** sha256 of the client secret, hex. The secret itself is never stored. */
	secretHash: string;
	/** The scopes this registration was admitted for, space-separated. */
	scope: string;
	/** Node ids of the desks this client may reach. */
	grant: string[];
	admittedAt: number;
	/** The desk that admitted this client and owns the record. */
	ownerNode: string;
	updatedAt: number;
	/** RFC 7591 `software_id`/`software_version`, when the client sent them. */
	software: { id: string; version: string } | null;
};

export type RoomMember = MobileMember | ClientMember;

/** The record's replicated class for a phone, shaped for writing. */
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
		seat: "mobile",
		name: member.name,
		publicKey: member.publicKey,
		fingerprint: member.fingerprint,
		protocol: member.protocol,
		capabilities: member.capabilities,
		grant: member.grant,
		admittedAt: member.admittedAt,
	};
}

/** The seat a record claims. Silence means the phone seat, which predates it. */
export function seatOf(record: ResourceRecord): MemberSeat {
	return record.replicated.seat === "client" ? "client" : "mobile";
}

/** What the operator calls this seat, for a refusal they can act on. */
function nounOf(seat: MemberSeat): string {
	return seat === "client" ? "agent" : "phone";
}

function grantOf(record: ResourceRecord): string[] {
	const grant = record.replicated.grant;
	return Array.isArray(grant) ? grant.filter((id): id is string => typeof id === "string") : [];
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
	if (seatOf(record) !== "mobile") return null;
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

/**
 * A client member out of a record, or null when the payload is not one.
 *
 * The mirror of `mobileMemberOf`, and just as strict about replicated input:
 * a client row with no id to authenticate against, or no digest to check a
 * secret with, is not a seat anyone can sit in.
 */
export function clientMemberOf(record: ResourceRecord): ClientMember | null {
	if (seatOf(record) !== "client") return null;
	const body = record.replicated;
	const secretHash = typeof body.secretHash === "string" ? body.secretHash : "";
	const name = typeof body.name === "string" ? body.name : "";
	if (!/^[0-9a-f]{64}$/.test(secretHash) || record.id.length === 0 || name.length === 0) return null;
	const software = body.software as { id?: unknown; version?: unknown } | undefined;
	return {
		clientId: record.id,
		name,
		seat: "client",
		secretHash,
		scope: typeof body.scope === "string" ? body.scope : "",
		grant: grantOf(record),
		admittedAt: typeof body.admittedAt === "number" ? body.admittedAt : record.updatedAt,
		ownerNode: record.ownerNode,
		updatedAt: record.updatedAt,
		software:
			software && typeof software.id === "string" && typeof software.version === "string"
				? { id: software.id, version: software.version }
				: null,
	};
}

/** Live client members, local and replicated alike. */
export function listClientMembers(): ClientMember[] {
	return listRecords("member")
		.map(clientMemberOf)
		.filter((member): member is ClientMember => member !== null);
}

/** One live client member; null when unknown or tombstoned. */
export function clientMember(clientId: string): ClientMember | null {
	const record = getRecord("member", clientId);
	if (!record || record.deleted) return null;
	return clientMemberOf(record);
}

/** Either seat, whichever this id names. What a listing or a revoke wants. */
export function roomMember(id: string): RoomMember | null {
	const record = getRecord("member", id);
	if (!record || record.deleted) return null;
	return seatOf(record) === "client" ? clientMemberOf(record) : mobileMemberOf(record);
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

export type AdmitClientDraft = {
	clientId: string;
	name: string;
	secretHash: string;
	scope: string;
	grant: string[];
	software: { id: string; version: string } | null;
};

export type AdmitClientOutcome =
	| { ok: true; member: ClientMember }
	| { ok: false; reason: "revoked" | "taken" | "invalid" };

/**
 * Admits an outside MCP client against a spent enrollment code.
 *
 * Unlike a phone, a re-registration is never a recognition: the client id was
 * minted here a moment ago, so a collision means the id names some *other*
 * member and the answer is refusal, not adoption. A tombstoned id is likewise
 * refused everywhere — an agent that was removed rejoins by registering
 * afresh against a new code, which is the same "removal is a decision, not a
 * race" rule the phone seat has.
 */
export function admitClientMember(draft: AdmitClientDraft): AdmitClientOutcome {
	if (!/^[0-9a-f]{64}$/.test(draft.secretHash) || !draft.clientId || !draft.name) {
		return { ok: false, reason: "invalid" };
	}
	const current = getRecord("member", draft.clientId);
	if (current) return { ok: false, reason: current.deleted ? "revoked" : "taken" };
	const record = putLocal("member", draft.clientId, {
		replicated: {
			seat: "client",
			name: draft.name,
			secretHash: draft.secretHash,
			scope: draft.scope,
			grant: draft.grant,
			admittedAt: Date.now(),
			...(draft.software ? { software: draft.software } : {}),
		},
	});
	notifyMembersChanged();
	const member = clientMemberOf(record);
	return member ? { ok: true, member } : { ok: false, reason: "invalid" };
}

/**
 * Rewrites the grant. Owner-only: another desk's edit would fork the record.
 *
 * The write patches the body it read rather than rebuilding it from a parsed
 * member, so a field a newer desk added — the client seat's `secretHash` is
 * the first — survives an older desk narrowing a grant.
 */
export function setMemberGrant(id: string, grant: string[]): RoomMember | null {
	const record = getRecord("member", id);
	if (!record || record.deleted) return null;
	if (record.ownerNode !== localNodeId()) {
		throw new Error(`Only ${record.ownerNode} can change this ${nounOf(seatOf(record))}'s access`);
	}
	const clean = [...new Set(grant.filter((entry) => typeof entry === "string" && entry.length > 0))];
	const saved = putLocal("member", id, {
		replicated: { ...record.replicated, grant: clean },
	});
	notifyMembersChanged();
	return seatOf(saved) === "client" ? clientMemberOf(saved) : mobileMemberOf(saved);
}

/** Tombstones the membership. Owner-only, and every desk learns it. */
export function revokeMember(id: string): boolean {
	const record = getRecord("member", id);
	if (!record || record.deleted) return false;
	if (record.ownerNode !== localNodeId()) {
		throw new Error(`Only ${record.ownerNode} can remove this ${nounOf(seatOf(record))}`);
	}
	tombstoneLocal("member", id);
	notifyMembersChanged();
	return true;
}

/**
 * The grant, or null when the id is not a live member.
 *
 * Read off the record rather than a parsed member, so it answers for both
 * seats — the wire's gate and the client seat's token endpoint ask the same
 * question and must not get different answers.
 */
export function memberGrant(id: string): string[] | null {
	const record = getRecord("member", id);
	if (!record || record.deleted) return null;
	return grantOf(record);
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
