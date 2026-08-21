import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, ensureLayout } from "../paths";

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
};

/** What the settings UI sees: everything but the credential. */
export type WebDeviceInfo = Omit<WebDevice, "token">;

type Pairing = { code: string; expiresAt: number };

type StoreFile = { version: 2; devices: WebDevice[] };

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
				return { version: 2, devices: parsed.devices };
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
	return read().devices.map(({ token: _token, ...info }) => info);
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

export function revokeDevice(id: string): boolean {
	const store = read();
	const next = store.devices.filter((device) => device.id !== id);
	if (next.length === store.devices.length) return false;
	write({ version: 2, devices: next });
	return true;
}
