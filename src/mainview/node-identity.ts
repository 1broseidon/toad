import { deviceName } from "./pair";

/**
 * The phone's one identity on the control plane.
 *
 * An Ed25519 keypair, minted once and kept for the life of the install. The
 * private key never leaves this module; what crosses the wire is the public
 * half (as the same SPKI PEM a desktop's `node.json` holds) and signatures
 * over the payload framing desktops already verify — `toad-node:<kind>:v1`
 * ahead of the JSON, base64url out. One keypair, however many desks: joining
 * a room and walking between its desks are both this key proving itself.
 *
 * Stored through Capacitor Preferences where there is a native shell (it
 * survives the webview clearing its own storage) and localStorage otherwise,
 * exactly as the instance jar is. WebCrypto has shipped Ed25519 since iOS 17;
 * `mobileNodeSupported` is the honest check for the one webview that hasn't.
 */

const KEY = "toad-node-identity";

export type MobileNodeIdentity = {
	id: string;
	name: string;
	publicKey: string;
	fingerprint: string;
	protocol: 1;
	capabilities: ["endpoint", "observer"];
};

type StoredKeys = {
	version: 1;
	id: string;
	/** PKCS8 private key, base64. */
	privateKey: string;
	/** SPKI public key, base64. */
	publicKey: string;
	createdAt: number;
};

type KeyStore = {
	read(key: string): Promise<string | null>;
	write(key: string, value: string): Promise<void>;
};

const webStore: KeyStore = {
	async read(key) {
		try {
			return localStorage.getItem(key);
		} catch {
			return null;
		}
	},
	async write(key, value) {
		try {
			localStorage.setItem(key, value);
		} catch {}
	},
};

async function store(): Promise<KeyStore> {
	if (typeof (window as { Capacitor?: unknown }).Capacitor === "undefined") return webStore;
	try {
		const { Preferences } = await import("@capacitor/preferences");
		return {
			async read(key) {
				const { value } = await Preferences.get({ key });
				return value ?? null;
			},
			async write(key, value) {
				await Preferences.set({ key, value });
			},
		};
	} catch {
		return webStore;
	}
}

function toBase64(bytes: ArrayBuffer): string {
	return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

function fromBase64(text: string): Uint8Array {
	return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

function toBase64Url(bytes: ArrayBuffer): string {
	return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The desktop stores and compares PEM, so the phone speaks PEM too. */
function spkiPem(publicKeyBase64: string): string {
	const lines = publicKeyBase64.match(/.{1,64}/g) ?? [];
	return `-----BEGIN PUBLIC KEY-----\n${lines.join("\n")}\n-----END PUBLIC KEY-----\n`;
}

async function fingerprintOf(spki: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", spki as BufferSource);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Whether this webview can mint and use an Ed25519 key at all. */
export async function mobileNodeSupported(): Promise<boolean> {
	try {
		await crypto.subtle.generateKey("Ed25519", false, ["sign", "verify"]);
		return true;
	} catch {
		return false;
	}
}

let held: StoredKeys | null = null;

async function storedKeys(): Promise<StoredKeys> {
	if (held) return held;
	const keeper = await store();
	const raw = await keeper.read(KEY);
	if (raw) {
		try {
			const parsed = JSON.parse(raw) as Partial<StoredKeys>;
			if (
				parsed.version === 1 &&
				typeof parsed.id === "string" &&
				typeof parsed.privateKey === "string" &&
				typeof parsed.publicKey === "string"
			) {
				held = parsed as StoredKeys;
				return held;
			}
		} catch {}
	}
	const pair = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
	const id = [...crypto.getRandomValues(new Uint8Array(8))]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
	const fresh: StoredKeys = {
		version: 1,
		id,
		privateKey: toBase64(await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
		publicKey: toBase64(await crypto.subtle.exportKey("spki", pair.publicKey)),
		createdAt: Date.now(),
	};
	await keeper.write(KEY, JSON.stringify(fresh));
	held = fresh;
	return fresh;
}

/** The public identity, creating the keypair on first use. */
export async function mobileIdentity(): Promise<MobileNodeIdentity> {
	const keys = await storedKeys();
	const spki = fromBase64(keys.publicKey);
	return {
		id: keys.id,
		name: deviceName(),
		publicKey: spkiPem(keys.publicKey),
		fingerprint: await fingerprintOf(spki),
		protocol: 1,
		capabilities: ["endpoint", "observer"],
	};
}

/**
 * Signs a payload the way desktops verify it: `toad-node:<kind>:v1` over the
 * JSON. Callers construct payload objects in the exact key order the desk
 * rebuilds, because the JSON text is what gets signed.
 */
export async function signMobilePayload(kind: string, payload: unknown): Promise<string> {
	const keys = await storedKeys();
	const privateKey = await crypto.subtle.importKey(
		"pkcs8",
		fromBase64(keys.privateKey) as BufferSource,
		"Ed25519",
		false,
		["sign"],
	);
	const bytes = new TextEncoder().encode(`toad-node:${kind}:v1\n${JSON.stringify(payload)}`);
	return toBase64Url(await crypto.subtle.sign("Ed25519", privateKey, bytes));
}
