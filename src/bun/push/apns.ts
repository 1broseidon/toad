import { createPrivateKey, type KeyObject, sign } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { type ClientHttp2Session, connect, constants } from "node:http2";
import { join } from "node:path";
import { PUSH_DIR } from "../paths";
import {
	createCredential,
	listCredentials,
	onCredentialsChanged,
	providerCredential,
	providerCredentialSecret,
	revokeCredential,
	setCredentialSecret,
} from "../store/credentials";
import { localNodeId } from "../store/records";

/**
 * Sending to Apple's Push Notification service, from this desktop.
 *
 * Two things about APNs shape everything here. It speaks only HTTP/2, over a
 * connection it expects you to hold open rather than rebuild per push — so a
 * session is cached per environment and revived when Apple drops it. And it
 * authenticates with a short-lived ES256 JWT rather than a certificate, which
 * must be re-signed every 20–60 minutes; sign it more often than that and
 * Apple answers `TooManyProviderTokenUpdates`.
 *
 * The environment is not a preference. A development build's device token is
 * only valid against sandbox and a TestFlight/App Store build's only against
 * production, so a token carries the environment it was minted in and the
 * sender obeys it. One key signs for both, forever.
 *
 * The signing key used to be a per-desk file, which made replicated push
 * registrations half a feature: every desk would hold an address and only one
 * could post to it. So the key is now an ordinary credential in the sealed
 * vault — one owner, opt-in replication, a box per desk, revocation as a fact —
 * under a provider id in Toad's own reserved namespace, because it signs for
 * Apple and not for a model. Nothing about sealing, teardown or the wire had to
 * be invented for it; `store/credentials.ts` already does all of it.
 *
 * This module is deliberately ignorant of *why* anything is being sent. It
 * takes a token and a payload; `notify.ts` decides what deserves a buzz. That
 * split is what lets the same code run unchanged inside the relay later
 * (docs/push.md) — the relay is this file plus an HTTP front.
 */

/** The reserved provider id the signing key lives under. Never a model provider. */
export const APNS_PROVIDER_ID = "toad.apns";

const LEGACY_CONFIG_FILE = join(PUSH_DIR, "config.json");
const LEGACY_KEY_FILE = join(PUSH_DIR, "key.p8");

/** Apple refuses a token older than an hour; refresh well inside that. */
const TOKEN_TTL_MS = 50 * 60_000;

const HOSTS = {
	sandbox: "https://api.sandbox.push.apple.com",
	production: "https://api.push.apple.com",
} as const;

export type PushEnvironment = keyof typeof HOSTS;

/**
 * What the desktop needs to sign, as one indivisible secret.
 *
 * The key id and the team id are not secret — they are printed beside the key
 * in Apple's console — but they are useless apart from it and it is useless
 * without them. So they travel *inside* the sealed blob rather than as plain
 * fields on the record: a desk then either holds a complete signing identity or
 * holds nothing, and there is no third state where a desk has a key it cannot
 * address or an address it cannot sign for. Encrypting three public characters
 * costs nothing; a desk stuck between the two states would cost a debugging
 * afternoon. The topic rides along for the same reason — it is the bundle id
 * the key is scoped to, and a key pointed at the wrong app is not a key.
 */
type PushKeyMaterial = {
	pem: string;
	/** The 10-character Key ID shown beside the key in Apple's console. */
	keyId: string;
	/** The team the key belongs to. */
	teamId: string;
	/** The receiving app's bundle id, which APNs calls the topic. */
	topic: string;
};

export type PushCredentialStatus = {
	configured: boolean;
	keyId: string | null;
	teamId: string | null;
	topic: string;
	/** Entered here, replicated from the room, or absent. */
	keyFrom: "here" | "room" | null;
	/** Whether the key was opted into replication by the desk that owns it. */
	keyReplicated: boolean;
};

export const DEFAULT_TOPIC = "team.toad.ios";

/** The room's APNs credential as a record: names and booleans, never the key. */
function keyCredential() {
	return providerCredential(APNS_PROVIDER_ID);
}

/** This desk's own APNs credential row, if it entered one. */
function ownKeyCredential() {
	return listCredentials().find(
		(credential) =>
			credential.providerId === APNS_PROVIDER_ID &&
			credential.ownerNode === localNodeId() &&
			!credential.revoked,
	);
}

/**
 * Whether this desk could sign for Apple right now — asked structurally.
 *
 * `canNotify()` runs on every event a peer forwards, and opening the box to
 * answer a boolean would put the signing key through memory on a hot path for
 * a question the record already answers.
 */
export function pushKeyHere(): boolean {
	migrateLegacyKeyFile();
	return keyCredential() !== undefined;
}

/**
 * The signing identity, decrypted here and now. Never store or log the result.
 *
 * The one place the key is in memory, exactly as `credentialSecret` is for a
 * provider key: the vault on the desk it was entered on, this desk's own sealed
 * box anywhere else.
 */
function pushKey(): PushKeyMaterial | null {
	migrateLegacyKeyFile();
	const blob = providerCredentialSecret(APNS_PROVIDER_ID);
	if (!blob) return null;
	try {
		const parsed = JSON.parse(blob) as Partial<PushKeyMaterial>;
		if (!parsed.pem || !parsed.keyId || !parsed.teamId) return null;
		return {
			pem: parsed.pem,
			keyId: parsed.keyId,
			teamId: parsed.teamId,
			topic: parsed.topic || DEFAULT_TOPIC,
		};
	} catch {
		return null;
	}
}

/**
 * Moves a pre-0.3.6 desk's `.p8` into the vault, once.
 *
 * The old home was `PUSH_DIR/key.p8` plus a config file beside it, which is a
 * per-desk secret in a shape nothing can replicate. Migrating rather than
 * asking for the key again matters because most people no longer have the file
 * — Apple lets you download a `.p8` exactly once. The credential is created
 * machine-local, because opting into replication is a decision the operator
 * makes and inheriting a "yes" nobody gave would be the wrong default for a
 * secret.
 */
let migrated = false;
function migrateLegacyKeyFile(): void {
	if (migrated) return;
	migrated = true;
	if (!existsSync(LEGACY_KEY_FILE) || !existsSync(LEGACY_CONFIG_FILE)) return;
	try {
		const raw = JSON.parse(readFileSync(LEGACY_CONFIG_FILE, "utf8")) as Partial<PushKeyMaterial>;
		const pem = readFileSync(LEGACY_KEY_FILE, "utf8");
		if (!raw.keyId || !raw.teamId || !pem) return;
		if (!ownKeyCredential()) {
			createCredential({
				providerId: APNS_PROVIDER_ID,
				kind: "api_key",
				label: "Apple Push Notification key",
				secret: JSON.stringify({
					pem,
					keyId: raw.keyId,
					teamId: raw.teamId,
					topic: raw.topic || DEFAULT_TOPIC,
				} satisfies PushKeyMaterial),
			});
		}
		rmSync(LEGACY_KEY_FILE, { force: true });
		rmSync(LEGACY_CONFIG_FILE, { force: true });
	} catch {
		/* A key we cannot read is a key we must not delete. It stays on disk for
		 * someone to look at, and the desk reports itself unconfigured — which is
		 * true, and is the state the settings pane already knows how to explain. */
	}
}

/** Whether pushes can be sent at all, for the settings pane to render. */
export function pushCredentials(): PushCredentialStatus {
	const credential = (migrateLegacyKeyFile(), keyCredential());
	const material = credential ? pushKey() : null;
	return {
		configured: material !== null,
		keyId: material?.keyId ?? null,
		teamId: material?.teamId ?? null,
		topic: material?.topic ?? DEFAULT_TOPIC,
		keyFrom: credential ? (credential.ownerNode === localNodeId() ? "here" : "room") : null,
		keyReplicated: credential?.replicate ?? false,
	};
}

/**
 * Store the key and its identifiers.
 *
 * Validated by parsing before it is written: a `.p8` that turns out not to be
 * a private key should fail while someone is looking at a settings pane, not
 * silently at the first notification worth sending.
 *
 * A second install replaces the first *in place* rather than minting a row
 * beside it, so rotating the key on a desk that had shared it keeps it shared.
 * Whoever opted in did so for this key's role, not for its bytes.
 */
export function installPushKey(input: {
	pem: string;
	keyId: string;
	teamId: string;
	topic?: string;
}): { ok: true } | { ok: false; error: string } {
	const keyId = input.keyId.trim();
	const teamId = input.teamId.trim();
	if (!keyId || !teamId) return { ok: false, error: "Key ID and Team ID are both required." };
	try {
		createPrivateKey(input.pem);
	} catch {
		return { ok: false, error: "That file is not a readable private key — expected the .p8 Apple gave you." };
	}
	migrateLegacyKeyFile();
	const secret = JSON.stringify({
		pem: input.pem,
		keyId,
		teamId,
		topic: input.topic?.trim() || DEFAULT_TOPIC,
	} satisfies PushKeyMaterial);
	try {
		const existing = ownKeyCredential();
		if (existing) setCredentialSecret(existing.id, secret);
		else {
			createCredential({
				providerId: APNS_PROVIDER_ID,
				kind: "api_key",
				label: "Apple Push Notification key",
				secret,
			});
		}
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : "The key was refused." };
	}
	cached = null;
	return { ok: true };
}

/**
 * Forget the key. Device registrations survive — a new key revives them.
 *
 * Revocation rather than deletion, and deliberately: a key that has been shared
 * with the room must die on every desk that holds a copy, whether or not the
 * operator ever opted out, and that is exactly what `revokeCredential` publishes.
 * The revoked row stays in the credential list saying so — including which desks
 * have not yet been observed dropping their copy — for the same reason every
 * other revoked key's row does.
 */
export function clearPushKey(): void {
	migrateLegacyKeyFile();
	const existing = ownKeyCredential();
	if (existing) revokeCredential(existing.id);
	// A desk that only ever held somebody else's copy has nothing to revoke; the
	// owner's revocation is what removes it, and it arrives as an ordinary op.
	cached = null;
	for (const environment of Object.keys(HOSTS) as PushEnvironment[]) closeSession(environment);
}

let cached: { jwt: string; at: number; keyId: string } | null = null;
let key: { object: KeyObject; source: string } | null = null;

/* The key can now change without this process touching it — a peer's rotation,
 * a peer's revocation, a re-seal after admission. A cached JWT signed by a key
 * the room has replaced is a `403` with nothing to explain it, so the bell that
 * already rings for every credential change drops the cache. */
onCredentialsChanged(() => {
	cached = null;
	key = null;
});

function privateKey(pem: string): KeyObject {
	if (key?.source !== pem) key = { object: createPrivateKey(pem), source: pem };
	return key.object;
}

function base64url(value: Buffer | string): string {
	return Buffer.from(value).toString("base64url");
}

/**
 * The provider token.
 *
 * ES256 signatures must be JOSE's raw `r||s` pair, not the DER envelope
 * `createSign` hands back by default — hence `ieee-p1363`. Getting this wrong
 * produces a signature that verifies nowhere and a flat `403 InvalidProviderToken`
 * with nothing to explain it.
 */
function providerToken(material: PushKeyMaterial): string {
	const now = Date.now();
	if (cached && cached.keyId === material.keyId && now - cached.at < TOKEN_TTL_MS) return cached.jwt;

	const header = base64url(JSON.stringify({ alg: "ES256", kid: material.keyId }));
	const claims = base64url(JSON.stringify({ iss: material.teamId, iat: Math.floor(now / 1000) }));
	const body = `${header}.${claims}`;
	const signature = sign("SHA256", Buffer.from(body), {
		key: privateKey(material.pem),
		dsaEncoding: "ieee-p1363",
	});
	const jwt = `${body}.${base64url(signature)}`;
	cached = { jwt, at: now, keyId: material.keyId };
	return jwt;
}

const sessions = new Map<PushEnvironment, ClientHttp2Session>();

function closeSession(environment: PushEnvironment): void {
	const existing = sessions.get(environment);
	sessions.delete(environment);
	try {
		existing?.close();
	} catch {
		/* Already gone. */
	}
}

/**
 * The long-lived connection to Apple, per environment.
 *
 * Apple drops idle sessions and occasionally asks a provider to reconnect with
 * GOAWAY; neither is an error, so a dead session is simply forgotten and the
 * next push builds a new one.
 */
function session(environment: PushEnvironment): ClientHttp2Session {
	const existing = sessions.get(environment);
	if (existing && !existing.closed && !existing.destroyed) return existing;

	const created = connect(HOSTS[environment]);
	created.on("error", () => sessions.delete(environment));
	created.on("close", () => sessions.delete(environment));
	created.on("goaway", () => sessions.delete(environment));
	created.setTimeout(0);
	created.unref();
	sessions.set(environment, created);
	return created;
}

export type PushPayload = {
	title: string;
	body: string;
	/** Rides back to the app on tap, so the notification opens somewhere. */
	data?: Record<string, string>;
	/** The number on the icon. Zero clears it; absent leaves it alone. */
	badge?: number;
	/** A key iOS coalesces on, so ten pushes from one teammate are one row. */
	threadId?: string;
	/** Apple's dedupe key: a resend with the same id replaces, never stacks. */
	collapseId?: string;
};

export type PushResult =
	/** Apple accepted it. Delivery is still not promised — see docs/push.md. */
	| { ok: true }
	/** Apple knows this token is dead. The caller must forget it. */
	| { ok: false; gone: true; reason: string }
	| { ok: false; gone: false; reason: string };

const REQUEST_TIMEOUT_MS = 10_000;

/** `410 Unregistered` and this pair are Apple saying the token is finished. */
const DEAD_TOKEN_REASONS = new Set(["BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered"]);

/**
 * Send one notification.
 *
 * Never throws: a desktop that cannot reach Apple should drop a buzz, not
 * fail a turn. Every failure comes back as a reason worth logging, and the
 * `gone` ones come back distinguishable, because that is the entire feedback
 * loop for pruning dead tokens (docs/push.md).
 */
export async function sendPush(
	deviceToken: string,
	environment: PushEnvironment,
	payload: PushPayload,
): Promise<PushResult> {
	const material = pushKey();
	if (!material) return { ok: false, gone: false, reason: "NoCredentials" };

	let jwt: string;
	try {
		jwt = providerToken(material);
	} catch (error) {
		return { ok: false, gone: false, reason: `KeyUnreadable: ${String(error)}` };
	}

	const aps: Record<string, unknown> = {
		alert: { title: payload.title, body: payload.body },
		/* The buzz doubles as a wake: with UIBackgroundModes remote-notification
		 * the app gets a moment of background runtime to warm up, so opening
		 * from the banner lands on a fresher screen. Best-effort — iOS grants
		 * or withholds these at its own judgement. */
		"content-available": 1,
		sound: "default",
	};
	if (payload.badge !== undefined) aps.badge = payload.badge;
	if (payload.threadId) aps["thread-id"] = payload.threadId;
	const body = JSON.stringify({ aps, ...(payload.data ?? {}) });

	const headers: Record<string, string> = {
		[constants.HTTP2_HEADER_METHOD]: "POST",
		[constants.HTTP2_HEADER_PATH]: `/3/device/${deviceToken}`,
		authorization: `bearer ${jwt}`,
		"apns-topic": material.topic,
		"apns-push-type": "alert",
		"apns-priority": "10",
		"apns-expiration": String(Math.floor(Date.now() / 1000) + 3600),
	};
	if (payload.collapseId) headers["apns-collapse-id"] = payload.collapseId.slice(0, 64);

	return new Promise<PushResult>((resolve) => {
		let settled = false;
		const finish = (result: PushResult) => {
			if (settled) return;
			settled = true;
			resolve(result);
		};

		let request: ReturnType<ClientHttp2Session["request"]>;
		try {
			request = session(environment).request(headers);
		} catch (error) {
			closeSession(environment);
			finish({ ok: false, gone: false, reason: `Unreachable: ${String(error)}` });
			return;
		}

		request.setTimeout(REQUEST_TIMEOUT_MS, () => {
			request.close();
			finish({ ok: false, gone: false, reason: "Timeout" });
		});
		request.on("error", (error) => {
			closeSession(environment);
			finish({ ok: false, gone: false, reason: `Transport: ${error.message}` });
		});

		let status = 0;
		let response = "";
		request.on("response", (received) => {
			status = Number(received[constants.HTTP2_HEADER_STATUS] ?? 0);
		});
		request.on("data", (chunk: Buffer) => {
			response += chunk.toString();
		});
		request.on("end", () => {
			if (status === 200) return finish({ ok: true });
			let reason = `HTTP ${status}`;
			try {
				const parsed = JSON.parse(response) as { reason?: string };
				if (parsed.reason) reason = parsed.reason;
			} catch {
				/* Apple answers text on some 5xx; the status is the message then. */
			}
			// A token minted against the other environment reads as dead here.
			// It is not lost — the phone re-registers with the right one on
			// its next launch, because APNs hands it a fresh token every time.
			const gone = status === 410 || DEAD_TOKEN_REASONS.has(reason);
			// Apple asking for a fresh JWT is a cache problem, not a key problem.
			if (reason === "ExpiredProviderToken" || reason === "InvalidProviderToken") cached = null;
			finish({ ok: false, gone, reason });
		});

		request.end(body);
	});
}

/** Drop every open connection to Apple. For shutdown and for tests. */
export function closePushSessions(): void {
	for (const environment of Object.keys(HOSTS) as PushEnvironment[]) closeSession(environment);
}
