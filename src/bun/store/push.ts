import type { CredentialTeardown } from "../../shared/types";
import { sealRecipientIds, sealRecipients } from "../node/recipients";
import { isSealedSecret, openSealed, sealTo, type SealedSecret } from "../node/seal";
import type { PushEnvironment } from "../push/apns";
import {
	clearDevicePush,
	deviceIdentity,
	localPushTokens,
	revokeDevice,
	revokeDevicesForMember,
	setDevicePush,
} from "../web/devices";
import { getRecord, listRecords, localNodeId, putLocal, tombstoneLocal } from "./records";

/**
 * A phone's push registration as a record the whole room holds.
 *
 * Before this, a phone's APNs token lived only in `web.json` on the desk it
 * paired with. Every other desk had to route its notification through that
 * desk, so a teammate on one machine could only reach the human while another
 * machine happened to be up — the single-path fragility the plane removed
 * everywhere else. An address you cannot post to is not reach.
 *
 * So the registration is an owned record on the same plane, with the same two
 * shapes for the material and exactly two, as `store/credentials.ts` puts it.
 * On the **owning** desk the token stays where it already is: `device.push` in
 * `web.json`, beside the per-device bearer token that pairing minted. It is not
 * copied into a second plaintext home, and unpairing still deletes it in one
 * place. On **every other** desk it exists only as a box sealed to that desk's
 * own node key, carried in the record's replicated class. Desk B's copy is
 * ciphertext to desk C, to a backup, and to a synced folder.
 *
 * A device token is not a password. Token plus the APNs signing key, though, is
 * the ability to buzz a human's phone, so it is sealed like a password and the
 * discipline costs nothing. The signing key itself is an ordinary replicated
 * credential — `push/apns.ts` puts it in the vault under a reserved provider id
 * rather than inventing a second sealed store.
 *
 * Replication is not opt-in here, and that is the one place this differs from a
 * provider key. A credential defaults machine-local because sharing a key is a
 * decision. A push registration exists *only* to be posted to, and a room whose
 * desks are already admitted to each other has already made the trust decision;
 * an opt-in switch would ship the feature turned off. Withdrawal is still a
 * teardown, so the way out is the same either way.
 */

/**
 * The replicated class of a `push` record, exactly as it goes on the wire.
 *
 * Everything here is a name, a number, a boolean, or ciphertext nobody but the
 * addressed desk can read. There is no field a reader could log by accident.
 */
export type PushRegistrationClass = {
	/** What the operator calls this phone, so a room-level list is legible. */
	deviceName: string;
	/** The phone's plane node id, or "" for a pre-plane web pairing. */
	memberNodeId: string;
	/** Which APNs host the token was minted against. A token obeys exactly one. */
	environment: PushEnvironment;
	/**
	 * Bumped whenever the phone hands over a *different* token.
	 *
	 * The name of a token without being the token. A prune observed on one desk
	 * names the generation it saw die, so a report that crosses paths with a
	 * fresh registration cannot kill the new token by arriving late.
	 */
	generation: number;
	/**
	 * Apple has said this token is finished. Set by the owner, cleared only by a
	 * fresh registration — which is a new generation, so it is not an un-setting.
	 */
	dead: boolean;
	/** Withdrawn: the pairing behind this registration is gone for good. */
	revoked: boolean;
	registeredAt: number;
	/** One sealed copy of the device token per recipient desk, keyed by node id. */
	seals: Record<string, SealedSecret>;
	/**
	 * A withdrawal in progress, or null. Identical in shape and meaning to a
	 * credential's: the op that empties `seals` is the deletion, but a dark desk
	 * has not applied it yet, so the desks that held a copy are named and each
	 * moves to `confirmed` only after it has been asked and has answered that it
	 * holds nothing.
	 */
	teardown: { at: number; desks: string[]; confirmed: string[] } | null;
};

/** This desk's private note about a registration. Never replicated. */
type PushMachineClass = {
	/**
	 * The generation this desk watched Apple reject, awaiting the owner's op.
	 *
	 * Durable rather than in-memory because a desk that learns a token is dead
	 * and then restarts would otherwise spend the rest of the token's life
	 * posting to it. The owner is the only writer of the *fact*; this is the
	 * observation, which stops this desk immediately and keeps being reported.
	 */
	deadGeneration?: number;
};

/** One registration as the room reads it. Never carries the token. */
export type PushRegistration = {
	id: string;
	/** The pairing desk: the only desk that may change this record. */
	ownerNode: string;
	deviceName: string;
	memberNodeId: string | null;
	environment: PushEnvironment;
	generation: number;
	dead: boolean;
	revoked: boolean;
	/** Desks currently holding a sealed copy. */
	sealedTo: string[];
	/**
	 * Whether this desk could post to the phone right now — a live token in its
	 * own `web.json`, or a box sealed to it. Answered from the record, never by
	 * decrypting anything.
	 */
	addressableHere: boolean;
	teardown: CredentialTeardown | null;
	registeredAt: number;
	updatedAt: number;
};

/** One address this desk can actually post to. */
export type PushTarget = {
	registrationId: string;
	/** The pairing desk. The only desk that may publish a fact about this row. */
	ownerNode: string;
	/** Which token this is, without being it — what a prune report names. */
	generation: number;
	token: string;
	environment: PushEnvironment;
};

function sealMap(value: unknown): Record<string, SealedSecret> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const seals: Record<string, SealedSecret> = {};
	for (const [nodeId, sealed] of Object.entries(value as Record<string, unknown>)) {
		// A box whose `to` disagrees with its key would fail to open anyway;
		// dropping it here keeps the map legible.
		if (isSealedSecret(sealed) && sealed.to === nodeId) seals[nodeId] = sealed;
	}
	return seals;
}

function strings(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const ids = value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
	return [...new Set(ids)].sort();
}

function teardownOf(value: unknown): PushRegistrationClass["teardown"] {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const candidate = value as Partial<NonNullable<PushRegistrationClass["teardown"]>>;
	const desks = strings(candidate.desks);
	if (desks.length === 0) return null;
	return {
		at: typeof candidate.at === "number" ? candidate.at : 0,
		desks,
		confirmed: strings(candidate.confirmed).filter((id) => desks.includes(id)),
	};
}

/** A replicated payload as a registration class, tolerant of an older build's row. */
function classOf(payload: Record<string, unknown>): PushRegistrationClass | null {
	const candidate = payload as Partial<PushRegistrationClass>;
	if (typeof candidate.deviceName !== "string") return null;
	return {
		deviceName: candidate.deviceName || "Phone",
		memberNodeId: typeof candidate.memberNodeId === "string" ? candidate.memberNodeId : "",
		environment: candidate.environment === "production" ? "production" : "sandbox",
		generation:
			typeof candidate.generation === "number" && candidate.generation >= 1
				? Math.floor(candidate.generation)
				: 1,
		dead: candidate.dead === true,
		revoked: candidate.revoked === true,
		registeredAt: typeof candidate.registeredAt === "number" ? candidate.registeredAt : 0,
		seals: sealMap(candidate.seals),
		teardown: teardownOf(candidate.teardown),
	};
}

type Held = {
	id: string;
	ownerNode: string;
	updatedAt: number;
	value: PushRegistrationClass;
	machine: PushMachineClass;
};

function machineOf(value: Record<string, unknown> | null): PushMachineClass {
	const generation = value?.deadGeneration;
	return typeof generation === "number" ? { deadGeneration: generation } : {};
}

function held(id: string): Held | undefined {
	const record = getRecord("push", id);
	if (!record || record.deleted) return undefined;
	const value = classOf(record.replicated);
	if (!value) return undefined;
	return {
		id: record.id,
		ownerNode: record.ownerNode,
		updatedAt: record.updatedAt,
		value,
		machine: machineOf(record.machine),
	};
}

function allHeld(): Held[] {
	const rows: Held[] = [];
	for (const record of listRecords("push")) {
		const value = classOf(record.replicated);
		if (!value) continue;
		rows.push({
			id: record.id,
			ownerNode: record.ownerNode,
			updatedAt: record.updatedAt,
			value,
			machine: machineOf(record.machine),
		});
	}
	return rows;
}

/**
 * Whether this desk holds an address for a registration — asked structurally.
 *
 * Deliberately not "can I decrypt it", for the same reason `usableHere` is not:
 * the room list is drawn often and opening every box to compute a boolean would
 * put every phone's token through memory to answer a question the record
 * already answers.
 */
function addressableHere(entry: Held, ownTokens: Map<string, string>): boolean {
	if (entry.value.dead || entry.value.revoked) return false;
	if (entry.machine.deadGeneration === entry.value.generation) return false;
	if (entry.ownerNode === localNodeId()) return ownTokens.has(entry.id);
	return entry.value.seals[localNodeId()] !== undefined;
}

function teardownView(teardown: PushRegistrationClass["teardown"]): CredentialTeardown | null {
	if (!teardown) return null;
	return {
		at: teardown.at,
		pending: teardown.desks.filter((id) => !teardown.confirmed.includes(id)),
		confirmed: [...teardown.confirmed],
	};
}

function viewOf(entry: Held, ownTokens: Map<string, string>): PushRegistration {
	return {
		id: entry.id,
		ownerNode: entry.ownerNode,
		deviceName: entry.value.deviceName,
		memberNodeId: entry.value.memberNodeId || null,
		environment: entry.value.environment,
		generation: entry.value.generation,
		dead: entry.value.dead,
		revoked: entry.value.revoked,
		sealedTo: Object.keys(entry.value.seals).sort(),
		addressableHere: addressableHere(entry, ownTokens),
		teardown: teardownView(entry.value.teardown),
		registeredAt: entry.value.registeredAt || entry.updatedAt,
		updatedAt: entry.updatedAt,
	};
}

/**
 * The point of use, and the only place a token is ever decrypted.
 *
 * On the owning desk the answer is `web.json`. Anywhere else it is this desk's
 * own sealed copy, opened here and handed to the caller — never written back to
 * disk, never cached, never logged.
 */
function readToken(entry: Held, ownTokens: Map<string, string>): string | undefined {
	if (!addressableHere(entry, ownTokens)) return undefined;
	if (entry.ownerNode === localNodeId()) return ownTokens.get(entry.id);
	const sealed = entry.value.seals[localNodeId()];
	return sealed ? openSealed(sealed, entry.id) : undefined;
}

function sealFor(id: string, token: string): Record<string, SealedSecret> {
	const seals: Record<string, SealedSecret> = {};
	for (const desk of sealRecipients()) seals[desk.nodeId] = sealTo(desk, id, token);
	return seals;
}

/** The owning desk's plaintext tokens, keyed by the registration id. */
function ownTokens(): Map<string, string> {
	return new Map(localPushTokens().map((row) => [row.deviceId, row.token]));
}

function write(entry: Held, next: PushRegistrationClass): PushRegistration {
	putLocal("push", entry.id, { replicated: next as unknown as Record<string, unknown> });
	const saved = held(entry.id);
	if (!saved) throw new Error(`Push registry lost ${entry.id} immediately after writing it`);
	const view = viewOf(saved, ownTokens());
	notifyPushChanged();
	return view;
}

const changeListeners: Array<() => void> = [];

/**
 * Rings when the addresses this desk holds changed — a local registration, a
 * prune, a withdrawal, or a peer's push op that sync just applied.
 */
export function onPushChanged(listener: () => void): void {
	changeListeners.push(listener);
}

export function notifyPushChanged(): void {
	for (const listener of changeListeners) {
		try {
			listener();
		} catch {
			/* a listener's fault is not the registry's problem */
		}
	}
}

// ---------------------------------------------------------------------------
// The read path. Names, numbers and booleans only.
// ---------------------------------------------------------------------------

/** Every push registration the room knows, this desk's and every other desk's. */
export function listPushRegistrations(): PushRegistration[] {
	const tokens = ownTokens();
	return allHeld().map((entry) => viewOf(entry, tokens));
}

export function getPushRegistration(id: string): PushRegistration | undefined {
	const entry = held(id);
	return entry ? viewOf(entry, ownTokens()) : undefined;
}

/**
 * Every phone this desk can post to, deduplicated by the address itself.
 *
 * A phone granted several desks gets a device row — and therefore a
 * registration — on each one it has connected to, all naming the same APNs
 * token. Two rows are two records, honestly owned; they are still one phone, so
 * the fan-out collapses them here rather than posting the same alert twice.
 */
export function pushFanout(): PushTarget[] {
	const tokens = ownTokens();
	const byToken = new Map<string, PushTarget>();
	for (const entry of allHeld()) {
		const token = readToken(entry, tokens);
		if (!token) continue;
		const key = `${entry.value.environment}:${token}`;
		if (byToken.has(key)) continue;
		byToken.set(key, {
			registrationId: entry.id,
			ownerNode: entry.ownerNode,
			generation: entry.value.generation,
			token,
			environment: entry.value.environment,
		});
	}
	return [...byToken.values()];
}

/**
 * How many phones this desk could reach right now, without opening a box.
 *
 * The count `canNotify()` wants, and the count the settings pane shows. Asked
 * structurally for the same reason `addressableHere` is: it runs on every event
 * a peer forwards, and decrypting the room's tokens to produce a number would be
 * a hot path through every secret in the room to answer "any?".
 */
export function pushReach(): number {
	const tokens = ownTokens();
	return allHeld().filter((entry) => addressableHere(entry, tokens)).length;
}

// ---------------------------------------------------------------------------
// The way in, the way out, and the facts that travel
// ---------------------------------------------------------------------------

/**
 * The phone registered, or re-registered. Owner-side only.
 *
 * APNs mints a fresh token whenever it feels like it, so the phone writes on
 * every launch and this is the convergence point: the same address re-declared
 * writes nothing at all, because an op per launch per phone is chatter the
 * whole room would have to store forever. A *different* address is a new
 * generation with fresh boxes for the room, so a prune report that crosses
 * paths with it names a generation that has already been replaced and cannot
 * kill the new token by arriving late.
 *
 * The plaintext lands in `web.json` before the record does: a record promising
 * an address the owning desk cannot post to would be worse than no record.
 */
export function registerPushDevice(input: {
	deviceId: string;
	token: string;
	environment: PushEnvironment;
}): PushRegistration | null {
	if (!input.token) return null;
	const identity = deviceIdentity(input.deviceId);
	if (!identity) return null;
	const entry = held(input.deviceId);
	// Read before the write: `setDevicePush` is what makes the two disagree.
	const heldToken = ownTokens().get(input.deviceId);
	if (!setDevicePush(input.deviceId, input.token, input.environment)) return null;

	const previous = entry?.value;
	const addressMoved =
		!previous ||
		previous.dead ||
		previous.revoked ||
		previous.environment !== input.environment ||
		heldToken !== input.token;
	const deviceName = identity.name.slice(0, 80) || "Phone";
	const memberNodeId = identity.memberNodeId ?? "";
	const staleSeals =
		JSON.stringify(Object.keys(previous?.seals ?? {}).sort()) !==
		JSON.stringify(sealRecipientIds());

	if (
		entry &&
		previous &&
		!addressMoved &&
		!staleSeals &&
		previous.teardown === null &&
		previous.deviceName === deviceName &&
		previous.memberNodeId === memberNodeId
	) {
		return viewOf(entry, ownTokens());
	}

	const value: PushRegistrationClass = {
		deviceName,
		memberNodeId,
		environment: input.environment,
		generation: previous ? previous.generation + (addressMoved ? 1 : 0) : 1,
		dead: false,
		revoked: false,
		registeredAt: previous?.registeredAt || Date.now(),
		seals: sealFor(input.deviceId, input.token),
		// Re-registering hands the room a live address again, so any withdrawal
		// this record was waiting on has nothing left to report.
		teardown: null,
	};

	if (entry) return write(entry, value);
	putLocal("push", input.deviceId, { replicated: value as unknown as Record<string, unknown> });
	const saved = held(input.deviceId);
	if (!saved) throw new Error(`Push registry lost ${input.deviceId} immediately after creating it`);
	const view = viewOf(saved, ownTokens());
	notifyPushChanged();
	return view;
}

/**
 * The phone declared the wrong APNs host and the sender proved it.
 *
 * `notify.ts` retries a dead-looking token against the other environment and,
 * when that works, the record was simply wrong about which door to use. Only
 * the owner may write it; another desk's success still teaches this desk
 * nothing it is allowed to publish, so it reports the correction the same way
 * it reports a prune.
 */
export function correctPushEnvironment(id: string, environment: PushEnvironment): boolean {
	const entry = held(id);
	if (!entry || entry.ownerNode !== localNodeId()) return false;
	if (entry.value.environment === environment) return true;
	const token = ownTokens().get(id);
	if (!token) return false;
	setDevicePush(id, token, environment);
	write(entry, { ...entry.value, environment, dead: false });
	return true;
}

/**
 * Apple says this token is finished. A prune, as a fact rather than a local
 * cleanup.
 *
 * On the owning desk the fact is published at once: the plaintext goes, the
 * boxes go, and every desk that hears stops posting to a phone that is not
 * there. Anywhere else this desk can only record what it *observed* — the
 * generation it watched die — which stops it immediately and durably, and is
 * reported to the owner by `fleet/push.ts` until the owner's op comes back. A
 * dark owner therefore leaves one desk quiet and the others still trying, which
 * is the honest state; it is never a desk silently forgetting on the room's
 * behalf.
 */
export function reportPushTokenDead(id: string, generation?: number): boolean {
	const entry = held(id);
	if (!entry) return false;
	if (generation !== undefined && generation !== entry.value.generation) return false;
	if (entry.ownerNode === localNodeId()) {
		if (entry.value.dead) return true;
		clearDevicePush(id);
		write(entry, { ...entry.value, dead: true, seals: {}, teardown: null });
		return true;
	}
	if (entry.machine.deadGeneration === entry.value.generation) return true;
	putLocal("push", id, { machine: { deadGeneration: entry.value.generation } });
	notifyPushChanged();
	return true;
}

/**
 * The pairing is gone: withdraw the address from the room.
 *
 * The op carries no boxes, so it *is* the deletion on every desk that applies
 * it — and the desks that held a copy are named, so a dark desk reads as pending
 * rather than as done. `revoked` rides along so a desk drops the address the
 * moment it hears, whether or not it was ever sealed to.
 */
export function withdrawPushRegistration(id: string): boolean {
	const entry = held(id);
	if (!entry || entry.ownerNode !== localNodeId()) return false;
	clearDevicePush(id);
	write(entry, {
		...entry.value,
		revoked: true,
		seals: {},
		teardown: withdrawnFrom(entry.value),
	});
	// A withdrawal from a room that held no copies has nobody to wait on, so it
	// is already settled and the tombstone is the same op's other half.
	const saved = held(id);
	if (saved) forgetSettled(saved);
	return true;
}

/** Every registration this desk owns for one phone, withdrawn. */
export function withdrawPushRegistrationsForMember(memberNodeId: string): string[] {
	const withdrawn: string[] = [];
	for (const entry of allHeld()) {
		if (entry.ownerNode !== localNodeId()) continue;
		if (entry.value.memberNodeId !== memberNodeId) continue;
		if (withdrawPushRegistration(entry.id)) withdrawn.push(entry.id);
	}
	return withdrawn;
}

/**
 * Unpairs a device: the address leaves the room, then the pairing leaves this
 * desk.
 *
 * The two halves are one door on purpose. `web/devices.ts` cannot reach this
 * module — it is the plaintext home this module reads, and the import would be
 * a cycle — so nothing there can withdraw a registration on its own. A caller
 * that removed the device row directly would delete the plaintext and leave
 * every other desk holding a sealed copy of an address that no longer answers
 * to anyone. Withdrawing first is what makes the deletion travel.
 */
export function unpairPushDevice(deviceId: string): boolean {
	withdrawPushRegistration(deviceId);
	return revokeDevice(deviceId);
}

/** The same door for a phone leaving the plane: every row it left behind. */
export function unpairPushDevicesForMember(memberNodeId: string): number {
	withdrawPushRegistrationsForMember(memberNodeId);
	return revokeDevicesForMember(memberNodeId);
}

/**
 * The desks a withdrawal has to account for: whoever was sealed to at the
 * moment of the op, plus anyone a previous withdrawal is still waiting on.
 */
function withdrawnFrom(value: PushRegistrationClass): PushRegistrationClass["teardown"] {
	const outstanding = value.teardown
		? value.teardown.desks.filter((id) => !value.teardown?.confirmed.includes(id))
		: [];
	const desks = [...new Set([...Object.keys(value.seals), ...outstanding])].sort();
	if (desks.length === 0) return null;
	return { at: Date.now(), desks, confirmed: [] };
}

/**
 * Re-seals this desk's live registrations to the room as it stands now.
 *
 * The admission and exile hook, exactly as `resealCredentials` is: a desk
 * admitted after a phone registered has no box until somebody makes one, and a
 * desk that has left stops being sealed to, which is what makes its remaining
 * copy inert for free. Only a changed recipient set writes — re-sealing on every
 * sweep would mint fresh ephemeral keys and bump the record with nothing to say.
 */
export function resealPushRegistrations(): string[] {
	const wanted = JSON.stringify(sealRecipientIds());
	const tokens = ownTokens();
	const resealed: string[] = [];
	for (const entry of allHeld()) {
		if (entry.ownerNode !== localNodeId()) continue;
		if (entry.value.dead || entry.value.revoked) continue;
		if (JSON.stringify(Object.keys(entry.value.seals).sort()) === wanted) continue;
		const token = tokens.get(entry.id);
		if (!token) continue;
		write(entry, { ...entry.value, seals: sealFor(entry.id, token) });
		resealed.push(entry.id);
	}
	return resealed;
}

/**
 * Drops addresses this desk is no longer entitled to hold, and stale notes.
 *
 * Called after remote ops land. Two cases: a registration whose owner withdrew
 * or pruned it leaves a `web.json` entry that no record justifies any more —
 * which is a live address on a machine the operator believes is clean — and a
 * prune note about a generation the phone has since replaced is an observation
 * about a token that no longer exists. Idempotent, so calling it after every
 * applied batch is free.
 */
export function reconcilePushMaterial(): string[] {
	const dropped: string[] = [];
	for (const row of localPushTokens()) {
		const entry = held(row.deviceId);
		if (entry && !entry.value.dead && !entry.value.revoked && entry.ownerNode === localNodeId()) {
			continue;
		}
		clearDevicePush(row.deviceId);
		dropped.push(row.deviceId);
	}
	for (const entry of allHeld()) {
		const noted = entry.machine.deadGeneration;
		if (noted === undefined || noted === entry.value.generation) continue;
		putLocal("push", entry.id, { machine: {} });
	}
	return dropped;
}

/**
 * Forgets a settled withdrawal outright.
 *
 * A withdrawn provider key keeps its row: the operator entered it, may enter it
 * again, and the list is a thing they read. A withdrawn push registration has
 * no such reader — the pairing behind it is gone and nobody will ever re-open
 * it — so once every desk has confirmed it holds nothing, the tombstone is the
 * completion of the way out rather than the loss of an account of it.
 */
function forgetSettled(entry: Held): void {
	if (!entry.value.revoked || entry.value.teardown) return;
	if (entry.ownerNode !== localNodeId()) return;
	tombstoneLocal("push", entry.id);
	notifyPushChanged();
}

// ---------------------------------------------------------------------------
// Teardown and prune, as facts somebody checked
// ---------------------------------------------------------------------------

/**
 * Of these registration ids, the ones this desk still holds an address for.
 *
 * The answer a peer gets when the owner asks whether its withdrawal landed. A
 * look, not an acknowledgement: this desk reads its own store and says what is
 * actually there. Structural, so nothing is decrypted to answer it, and nothing
 * but ids crosses the wire in either direction.
 */
export function heldPushRegistrationIds(ids: string[]): string[] {
	if (ids.length === 0) return [];
	const tokens = ownTokens();
	return ids.filter((id) => {
		const entry = held(id);
		return entry ? addressableHere(entry, tokens) : false;
	});
}

/** This desk's withdrawals that are still waiting on somebody. */
export function pendingPushTeardowns(): Array<{ id: string; pending: string[] }> {
	const rows: Array<{ id: string; pending: string[] }> = [];
	for (const entry of allHeld()) {
		if (entry.ownerNode !== localNodeId()) continue;
		const teardown = entry.value.teardown;
		if (!teardown) continue;
		const pending = teardown.desks.filter((desk) => !teardown.confirmed.includes(desk));
		if (pending.length > 0) rows.push({ id: entry.id, pending });
	}
	return rows;
}

/**
 * Folds what the room was observed to hold back into this desk's records.
 *
 * `gone` maps a desk to the registration ids it was just seen holding nothing
 * of. A desk that has left the room drops out of the pending set outright — its
 * records went with it, and waiting forever on a machine that is no longer a
 * member would make the surface unusable rather than honest. A withdrawal with
 * nothing outstanding settles, and a settled withdrawal is then forgotten.
 */
export function settlePushTeardowns(gone: Record<string, string[]>): string[] {
	const members = new Set(sealRecipientIds());
	const settled: string[] = [];
	for (const row of pendingPushTeardowns()) {
		const entry = held(row.id);
		const teardown = entry?.value.teardown;
		if (!entry || !teardown) continue;
		const desks = teardown.desks.filter((desk) => members.has(desk));
		const confirmed = new Set(teardown.confirmed.filter((desk) => desks.includes(desk)));
		for (const desk of desks) {
			if (gone[desk]?.includes(row.id)) confirmed.add(desk);
		}
		const outstanding = desks.filter((desk) => !confirmed.has(desk));
		const next: PushRegistrationClass["teardown"] =
			outstanding.length === 0
				? null
				: { at: teardown.at, desks, confirmed: [...confirmed].sort() };
		if (JSON.stringify(next) === JSON.stringify(teardown)) continue;
		write(entry, { ...entry.value, teardown: next });
		settled.push(row.id);
		const after = held(row.id);
		if (after) forgetSettled(after);
	}
	return settled;
}

/** Prunes this desk observed but has not yet seen the owner publish. */
export function pendingPushPrunes(): Array<{ ownerNode: string; id: string; generation: number }> {
	const rows: Array<{ ownerNode: string; id: string; generation: number }> = [];
	for (const entry of allHeld()) {
		if (entry.ownerNode === localNodeId()) continue;
		const noted = entry.machine.deadGeneration;
		if (noted === undefined || noted !== entry.value.generation) continue;
		if (entry.value.dead) continue;
		rows.push({ ownerNode: entry.ownerNode, id: entry.id, generation: noted });
	}
	return rows;
}
