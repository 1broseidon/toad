import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
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
	/**
	 * Where to buzz this device, once it has asked iOS for permission.
	 *
	 * On the device record rather than in a store of its own because the
	 * pairing *is* the identity (docs/push.md): a phone that was revoked has
	 * no push token by construction, and there is no second list to forget to
	 * clean up. Absent means this device never registered, or Apple has since
	 * told us the token is dead.
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

type Pairing = { code: string; expiresAt: number };

type StoreFile = {
	version: 2;
	devices: WebDevice[];
	/** Stable id for this Toad install. Phones use it to update a row after an IP change. */
	instanceId?: string;
};

const WEB_FILE = join(ROOT, "web.json");
const PAIRING_TTL_MS = 2 * 60_000;

/** One pending pairing at a time; a new QR replaces the old code. */
let pending: Pairing | null = null;

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

export function listDevices(): WebDeviceInfo[] {
	return read().devices.map(({ token: _token, push, ...info }) => ({ ...info, push: Boolean(push) }));
}

/**
 * Mints the one-time code the QR carries. Short enough to type from the
 * desktop screen when there is no camera to scan with.
 */
export function createPairing(): string {
	const code = randomBytes(4).toString("hex");
	pending = { code, expiresAt: Date.now() + PAIRING_TTL_MS };
	return code;
}

/** Claims the pending code: one device, once, within the TTL. */
export function claimPairing(code: string, name: string): WebDevice | null {
	if (!pending || pending.code !== code || Date.now() > pending.expiresAt) return null;
	pending = null;
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

export function deviceByToken(token: string): WebDevice | null {
	if (!token) return null;
	return read().devices.find((device) => device.token === token) ?? null;
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
 * Forget a push token Apple has told us is dead.
 *
 * Keyed by the APNs token rather than the device id because that is what the
 * `410` comes back against, and because the pairing itself is untouched: the
 * phone is still linked, still authorized, still syncing. It has simply
 * stopped being reachable by notification until it registers again.
 */
export function clearDevicePush(token: string): boolean {
	const store = read();
	const device = store.devices.find((entry) => entry.push?.token === token);
	if (!device) return false;
	device.push = undefined;
	write(store);
	return true;
}

/** Every device worth buzzing, for the notifier to fan out to. */
export function pushTargets(): { id: string; token: string; environment: PushEnvironment }[] {
	return read()
		.devices.filter((device) => device.push)
		.map((device) => ({
			id: device.id,
			token: (device.push as NonNullable<WebDevice["push"]>).token,
			environment: (device.push as NonNullable<WebDevice["push"]>).environment,
		}));
}

export function revokeDevice(id: string): boolean {
	const store = read();
	const next = store.devices.filter((device) => device.id !== id);
	if (next.length === store.devices.length) return false;
	write({ ...store, devices: next });
	return true;
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
