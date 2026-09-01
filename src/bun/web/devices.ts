import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { type OneTimeCode, mintCode, spendCode } from "../one-time-code";
import { ROOT, ensureLayout } from "../paths";
import type { PushEnvironment } from "../push/apns";

/**
 * Linked devices for web mode: pairing, tokens, revocation.
 *
 * A device links once by claiming a short-lived one-time code — shown on
 * the desktop as a QR, typed as a fallback — and holds a per-device token
 * from then on. Per-device because revocation has to mean something: cutting
 * one phone loose must not re-key every other device, and a list the user
 * reads ("kitchen iPad, old phone") is only honest if each row is its own
 * credential.
 */

export type WebDevice = {
	id: string;
	name: string;
	token: string;
	createdAt: number;
	lastSeenAt: number;
	/** Set when this credential was granted to a linked desktop, not a phone. */
	fleetPeerId?: string;
	/**
	 * Set when this row belongs to a mobile plane member. The row exists for
	 * push registration and per-device state; the wire itself authenticates by
	 * challenge against the member record, so `token` is never presented and
	 * holds no access.
	 */
	memberNodeId?: string;
	/**
	 * Where to buzz this device, once it has asked iOS for permission — the
	 * owning desk's plaintext half of a replicated registration.
	 *
	 * On the device record rather than in a store of its own because the
	 * pairing *is* the identity (docs/push.md): a phone that was revoked has no
	 * push token by construction, and it sits beside the bearer token that
	 * pairing minted, which is the same secret in the same file. The room's copy
	 * is `store/push.ts` — one box per desk, sealed, never plaintext anywhere but
	 * here. Absent means this device never registered, the pairing is gone, or
	 * Apple has since told some desk the token is dead.
	 */
	push?: { token: string; environment: PushEnvironment };
	/**
	 * Why this phone has no push token, when it tried and could not get one.
	 * Cleared by a successful registration. Without it a phone that cannot
	 * register is invisible: the desktop shows a count that never grows and
	 * has nothing to say about why.
	 */
	pushProblem?: string;
};

/**
 * What the settings UI sees: everything but the credentials.
 *
 * `push` collapses to a boolean deliberately — whether a phone will buzz is
 * worth showing, and the APNs token behind it is no more the UI's business
 * than the wire token is.
 */
export type WebDeviceInfo = Omit<WebDevice, "token" | "push"> & { push: boolean };

type StoreFile = {
	version: 2;
	devices: WebDevice[];
	/** Stable id for this Toad install. Phones use it to update a row after an IP change. */
	instanceId?: string;
};

const WEB_FILE = join(ROOT, "web.json");

/**
 * How long a QR on screen is good for.
 *
 * Overridable only so a harness can watch a code actually go stale rather than
 * sitting out two minutes for one, the same way the seat's enrollment TTL is.
 * Production never sets it.
 */
const configuredPairingTtlMs = Number(process.env.TOAD_PAIRING_TTL_MS);
const PAIRING_TTL_MS =
	Number.isFinite(configuredPairingTtlMs) && configuredPairingTtlMs > 0
		? configuredPairingTtlMs
		: 2 * 60_000;

/** One pending pairing at a time; a new QR replaces the old code. */
let pending: OneTimeCode | null = null;

function read(): StoreFile {
	ensureLayout();
	try {
		if (existsSync(WEB_FILE)) {
			const parsed = JSON.parse(readFileSync(WEB_FILE, "utf8")) as Partial<StoreFile>;
			// A v1 file held one shared token; that model is gone, and the one
			// device that used it re-pairs with a QR in under a minute.
			if (parsed.version === 2 && Array.isArray(parsed.devices)) {
				return {
					version: 2,
					devices: parsed.devices,
					instanceId: typeof parsed.instanceId === "string" ? parsed.instanceId : undefined,
				};
			}
		}
	} catch {}
	return { version: 2, devices: [] };
}

function write(store: StoreFile): void {
	ensureLayout();
	writeFileSync(WEB_FILE, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

/** Human web clients for Settings. Fleet credentials belong to the Nodes surface. */
export function listDevices(): WebDeviceInfo[] {
	return read()
		.devices.filter((device) => !device.fleetPeerId)
		.map(({ token: _token, push, ...info }) => ({ ...info, push: Boolean(push) }));
}

/**
 * Mints the one-time code the QR carries. Short enough to type from the
 * desktop screen when there is no camera to scan with.
 */
export function createPairing(): string {
	pending = mintCode(PAIRING_TTL_MS);
	return pending.code;
}

/**
 * Spends the pending code without minting anything. The legacy claim and the
 * mobile join both authenticate by possession of this one code; only what
 * they mint afterwards differs — so they share one guess budget, which is the
 * only way five guesses means five guesses.
 *
 * The discipline is the seat enrollment's, in `../one-time-code`: compared as a
 * digest so a wrong code cannot be found by timing, and burned after five wrong
 * guesses rather than left standing for the whole window. A pairing code is the
 * door that is meant to become remotely reachable, so it gets the posture that
 * still holds when it does.
 */
export function consumePairing(code: string): boolean {
	const spent = spendCode(pending, code);
	pending = spent.keep;
	return spent.ok;
}

/** Claims the pending code: one device, once, within the TTL. */
export function claimPairing(code: string, name: string): WebDevice | null {
	if (!consumePairing(code)) return null;
	const device: WebDevice = {
		id: randomBytes(8).toString("hex"),
		name: name.slice(0, 80) || "Unnamed device",
		token: randomBytes(24).toString("hex"),
		createdAt: Date.now(),
		lastSeenAt: Date.now(),
	};
	const store = read();
	store.devices.push(device);
	write(store);
	return device;
}

/**
 * A linked desktop's standing credential to this one's wire — minted once per
 * peer and reused, so opening the remote window twice does not grow the
 * device list. Fleet peers already hold bearer access to /fleet/rpc; this
 * widens that same user-approved trust to the full wire, which is what
 * "interact with that teammate over there" actually needs.
 */
export function deviceForPeer(peerId: string, peerName: string): WebDevice {
	const store = read();
	const existing = store.devices.find((device) => device.fleetPeerId === peerId);
	if (existing) {
		existing.lastSeenAt = Date.now();
		write(store);
		return existing;
	}
	const device: WebDevice = {
		id: randomBytes(8).toString("hex"),
		name: `${peerName.slice(0, 60)} (desktop)`,
		token: randomBytes(24).toString("hex"),
		createdAt: Date.now(),
		lastSeenAt: Date.now(),
		fleetPeerId: peerId,
	};
	store.devices.push(device);
	write(store);
	return device;
}

/**
 * The device row behind a mobile member's session — minted on first
 * authenticated connect and reused, so reconnecting never grows the list.
 * The token is filled but never honoured as a credential: `deviceByToken`
 * refuses member rows, because their identity lives in the member record.
 */
export function deviceForMember(memberNodeId: string, name: string): WebDevice {
	const store = read();
	const existing = store.devices.find((device) => device.memberNodeId === memberNodeId);
	if (existing) {
		existing.lastSeenAt = Date.now();
		if (name && existing.name !== name) existing.name = name.slice(0, 80);
		write(store);
		return existing;
	}
	const device: WebDevice = {
		id: randomBytes(8).toString("hex"),
		name: name.slice(0, 80) || "Phone",
		token: randomBytes(24).toString("hex"),
		createdAt: Date.now(),
		lastSeenAt: Date.now(),
		memberNodeId,
	};
	store.devices.push(device);
	write(store);
	return device;
}

/**
 * Removes the device rows a revoked member leaves behind, push token and all.
 *
 * The same caveat as `revokeDevice`: the room's copy of the address is
 * `unpairPushDevicesForMember`'s job, and it calls this once that has travelled.
 */
export function revokeDevicesForMember(memberNodeId: string): number {
	const store = read();
	const devices = store.devices.filter((device) => device.memberNodeId !== memberNodeId);
	const removed = store.devices.length - devices.length;
	if (removed > 0) write({ ...store, devices });
	return removed;
}

export function deviceByToken(token: string): WebDevice | null {
	if (!token) return null;
	// A member row's token is bookkeeping, not a credential — its wire
	// authenticates by challenge, and honouring the token here would quietly
	// hand a revoked-then-readmitted phone its old standing access back.
	return read().devices.find((device) => device.token === token && !device.memberNodeId) ?? null;
}

export function touchDevice(id: string): void {
	const store = read();
	const device = store.devices.find((entry) => entry.id === id);
	if (!device) return;
	device.lastSeenAt = Date.now();
	write(store);
}

/**
 * Remember where to buzz this device.
 *
 * Called by the phone itself over the paired wire, on every launch — APNs
 * mints a fresh token whenever it feels like it, and a stale one is a
 * notification that silently goes nowhere. Writing on every launch rather
 * than once at install is what keeps that from happening.
 */
export function setDevicePush(id: string, token: string, environment: PushEnvironment): boolean {
	const store = read();
	const device = store.devices.find((entry) => entry.id === id);
	if (!device) return false;
	if (device.push?.token === token && device.push.environment === environment && !device.pushProblem) {
		return true;
	}
	device.push = { token, environment };
	device.pushProblem = undefined;
	write(store);
	return true;
}

/** Remember why a phone could not register, so the pane can say so. */
export function setDevicePushProblem(id: string, reason: string): boolean {
	const store = read();
	const device = store.devices.find((entry) => entry.id === id);
	if (!device) return false;
	device.pushProblem = reason.slice(0, 120);
	write(store);
	return true;
}

/** Every phone that tried to register and could not, for the settings pane. */
export function pushProblems(): { name: string; reason: string }[] {
	return read()
		.devices.filter((device) => !device.push && device.pushProblem)
		.map((device) => ({ name: device.name, reason: device.pushProblem as string }));
}

/**
 * Forget a push token, by the device it belongs to.
 *
 * The pairing itself is untouched: the phone is still linked, still authorized,
 * still syncing. It has simply stopped being reachable by notification until it
 * registers again.
 *
 * Keyed by device id rather than by the token, because the token is no longer
 * this file's name for anything — `store/push.ts` owns the registration as a
 * replicated record keyed by device id, and a prune that arrives from another
 * desk names the record, not the bytes. The token is still the only thing that
 * comes back from Apple's `410`, so `push/notify.ts` carries the registration
 * id alongside it and prunes by that.
 */
export function clearDevicePush(deviceId: string): boolean {
	const store = read();
	const device = store.devices.find((entry) => entry.id === deviceId);
	if (!device?.push) return false;
	device.push = undefined;
	write(store);
	return true;
}

/**
 * What a device row says about itself, with no credential in it.
 *
 * The half of a pairing a replicated push registration needs to be legible on a
 * desk that has never seen this phone: what the operator calls it, and which
 * plane member it is. Deliberately not the whole row — nothing that authorizes
 * anything leaves this file except through the token accessors below.
 */
export function deviceIdentity(id: string): { name: string; memberNodeId: string | null } | null {
	const device = read().devices.find((entry) => entry.id === id);
	return device ? { name: device.name, memberNodeId: device.memberNodeId ?? null } : null;
}

/**
 * Every push token this desk holds in plaintext, by the device row that owns it.
 *
 * The owner-side half of a replicated registration: `store/push.ts` seals a copy
 * for every other desk and keeps *this* copy exactly where pairing already put
 * it, beside the per-device bearer token in the same file. One plaintext home,
 * not two, and unpairing still deletes it in one place.
 */
export function localPushTokens(): {
	deviceId: string;
	name: string;
	memberNodeId: string | null;
	token: string;
	environment: PushEnvironment;
}[] {
	return read()
		.devices.filter((device) => device.push)
		.map((device) => ({
			deviceId: device.id,
			name: device.name,
			memberNodeId: device.memberNodeId ?? null,
			token: (device.push as NonNullable<WebDevice["push"]>).token,
			environment: (device.push as NonNullable<WebDevice["push"]>).environment,
		}));
}

/**
 * Removes a pairing row and nothing else.
 *
 * Almost always the wrong door: a phone's push address is a replicated record
 * now, and deleting the row here deletes this desk's plaintext while leaving
 * every other desk sealed to an address nobody answers to. Reach for
 * `store/push.ts`'s `unpairPushDevice`, which withdraws the address from the
 * room first. This stays exported for rows that never had one.
 */
export function revokeDevice(id: string): boolean {
	const store = read();
	const next = store.devices.filter((device) => device.id !== id);
	if (next.length === store.devices.length) return false;
	write({ ...store, devices: next });
	return true;
}

/** Removes transport credentials owned by a fleet peer, never human devices. */
export function revokeDevicesForPeer(peerId: string): number {
	const store = read();
	const devices = store.devices.filter((device) => device.fleetPeerId !== peerId);
	const removed = store.devices.length - devices.length;
	if (removed > 0) write({ ...store, devices });
	return removed;
}

/**
 * The identity a native client stores so a re-pair after DHCP moves
 * updates the same row instead of minting a duplicate.
 *
 * `instanceId` is minted once per install and kept in web.json. Extra
 * fields are ignored by older readers, so this is not a store version bump.
 */
export function instanceIdentity(): { instanceId: string; hostName: string } {
	const store = read();
	if (!store.instanceId) {
		store.instanceId = randomBytes(8).toString("hex");
		write(store);
	}
	return { instanceId: store.instanceId, hostName: hostname() };
}
