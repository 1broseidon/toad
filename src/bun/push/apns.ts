import { createPrivateKey, type KeyObject, sign } from "node:crypto";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { type ClientHttp2Session, connect, constants } from "node:http2";
import { join } from "node:path";
import { PUSH_DIR, ensureLayout } from "../paths";

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
 * This module is deliberately ignorant of *why* anything is being sent. It
 * takes a token and a payload; `notify.ts` decides what deserves a buzz. That
 * split is what lets the same code run unchanged inside the relay later
 * (docs/push.md) — the relay is this file plus an HTTP front.
 */

const CONFIG_FILE = join(PUSH_DIR, "config.json");
const KEY_FILE = join(PUSH_DIR, "key.p8");

/** Apple refuses a token older than an hour; refresh well inside that. */
const TOKEN_TTL_MS = 50 * 60_000;

const HOSTS = {
	sandbox: "https://api.sandbox.push.apple.com",
	production: "https://api.push.apple.com",
} as const;

export type PushEnvironment = keyof typeof HOSTS;

/** What the desktop needs to sign. The `.p8` itself is never in here. */
type PushConfig = {
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
};

export const DEFAULT_TOPIC = "team.toad.ios";

function readConfig(): PushConfig | null {
	if (!existsSync(CONFIG_FILE)) return null;
	try {
		const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as Partial<PushConfig>;
		if (!raw.keyId || !raw.teamId) return null;
		return { keyId: raw.keyId, teamId: raw.teamId, topic: raw.topic || DEFAULT_TOPIC };
	} catch {
		return null;
	}
}

/** Whether pushes can be sent at all, for the settings pane to render. */
export function pushCredentials(): PushCredentialStatus {
	const config = readConfig();
	const hasKey = existsSync(KEY_FILE);
	return {
		configured: Boolean(config && hasKey),
		keyId: config?.keyId ?? null,
		teamId: config?.teamId ?? null,
		topic: config?.topic ?? DEFAULT_TOPIC,
	};
}

/**
 * Store the key and its identifiers.
 *
 * Validated by parsing before it is written: a `.p8` that turns out not to be
 * a private key should fail while someone is looking at a settings pane, not
 * silently at the first notification worth sending.
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
	ensureLayout();
	writeFileSync(KEY_FILE, input.pem, { mode: 0o600 });
	try {
		chmodSync(KEY_FILE, 0o600);
	} catch {
		/* Windows; the directory ACL is the protection there. */
	}
	const config: PushConfig = { keyId, teamId, topic: input.topic?.trim() || DEFAULT_TOPIC };
	writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, "\t")}\n`);
	cached = null;
	return { ok: true };
}

/** Forget the key. Device registrations survive — a new key revives them. */
export function clearPushKey(): void {
	rmSync(KEY_FILE, { force: true });
	rmSync(CONFIG_FILE, { force: true });
	cached = null;
	for (const environment of Object.keys(HOSTS) as PushEnvironment[]) closeSession(environment);
}

let cached: { jwt: string; at: number; keyId: string } | null = null;
let key: { object: KeyObject; source: string } | null = null;

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
function providerToken(config: PushConfig): string {
	const now = Date.now();
	if (cached && cached.keyId === config.keyId && now - cached.at < TOKEN_TTL_MS) return cached.jwt;

	const pem = readFileSync(KEY_FILE, "utf8");
	const header = base64url(JSON.stringify({ alg: "ES256", kid: config.keyId }));
	const claims = base64url(JSON.stringify({ iss: config.teamId, iat: Math.floor(now / 1000) }));
	const body = `${header}.${claims}`;
	const signature = sign("SHA256", Buffer.from(body), {
		key: privateKey(pem),
		dsaEncoding: "ieee-p1363",
	});
	const jwt = `${body}.${base64url(signature)}`;
	cached = { jwt, at: now, keyId: config.keyId };
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
	const config = readConfig();
	if (!config || !existsSync(KEY_FILE)) return { ok: false, gone: false, reason: "NoCredentials" };

	let jwt: string;
	try {
		jwt = providerToken(config);
	} catch (error) {
		return { ok: false, gone: false, reason: `KeyUnreadable: ${String(error)}` };
	}

	const aps: Record<string, unknown> = {
		alert: { title: payload.title, body: payload.body },
		sound: "default",
	};
	if (payload.badge !== undefined) aps.badge = payload.badge;
	if (payload.threadId) aps["thread-id"] = payload.threadId;
	const body = JSON.stringify({ aps, ...(payload.data ?? {}) });

	const headers: Record<string, string> = {
		[constants.HTTP2_HEADER_METHOD]: "POST",
		[constants.HTTP2_HEADER_PATH]: `/3/device/${deviceToken}`,
		authorization: `bearer ${jwt}`,
		"apns-topic": config.topic,
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
