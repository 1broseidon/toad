import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";
import { OAuthError, OAuthErrorCode, type AuthInfo } from "@modelcontextprotocol/server";
import {
	admitClientMember,
	clientMember,
	listClientMembers,
	type ClientMember,
} from "../node/members";
import { nodeIdentity } from "../node/identity";
import { ensureRoom } from "../node/room";
import { localNodeId } from "../store/records";
import { type OneTimeCode, mintCode, spendCode } from "../one-time-code";
import { ROOT } from "../paths";
import { secureOrigin } from "../web/server";
import { webTlsTrust } from "../web/tls";

/**
 * The client seat: an outside MCP-speaking agent joining the room.
 *
 * This is `oauth.ts` from the other side. There, Toad is a client discovering
 * somebody else's authorization server, registering itself under RFC 7591 and
 * spending PKCE codes. Here, Toad *is* the authorization server, and the thing
 * registering is an agent on another machine that wants a seat in the room.
 * The vocabulary is deliberately identical, because it is the same protocol.
 *
 * What makes it a seat rather than an API key is `node/members.ts`: a
 * registration writes a `member` record, exactly as a phone's join does. One
 * name, one scoped desk grant, one owning desk, one tombstone every desk
 * learns. The desk UI admits, narrows, lists and revokes an agent with the
 * same words it uses for a phone.
 *
 * ENROLLMENT IS A HUMAN ACT. Dynamic client registration on its own is open
 * registration: anything that can reach the port can mint itself an identity.
 * The gate is a short-lived one-time code the operator reads off the desk and
 * hands to the agent — the phone's pairing ceremony, generalized, and carried
 * in the place RFC 7591 §3 already reserves for exactly this (an initial
 * access token on the registration request). One enrollment vocabulary for
 * every kind of member: a desk, a phone, an outside agent.
 *
 * HTTPS ONLY, AND NOT BY ACCIDENT. The motivating case is an agent on another
 * machine, so this rides the pinned TLS door the room already serves phones
 * over; localhost is just another address. A client secret must never cross
 * the plain door, so every route here refuses when `secureOrigin()` is null.
 *
 * TWO DOORS, ONE CEREMONY. The code can arrive two ways, and both end with a
 * human reading it off a desk. An agent with no browser — a script, a
 * server-side worker — carries it as RFC 7591's initial access token on the
 * registration request, and registration is the admission. An agent that
 * speaks the ordinary remote-MCP flow — Claude Desktop, an editor, anything
 * with a browser — registers with no code at all, is sent here to
 * `/mcp/authorize`, and meets a page that asks for it: entering the code IS
 * the approval, and only then does the pending client become a seat. The
 * second door exists because a stock client cannot use the first: it looks for
 * an authorization endpoint, and a server offering only client_credentials
 * fails its discovery before it ever reaches a certificate.
 */

/** The one scope this room understands. What a seat is *for* is the grant. */
export const SEAT_SCOPE = "toad.room";

/** The MCP endpoint's path under the room's TLS origin. */
export const SEAT_PATH = "/mcp";
const REGISTRATION_PATH = "/mcp/register";
const AUTHORIZE_PATH = "/mcp/authorize";
const TOKEN_PATH = "/mcp/token";
const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource/mcp";
const AUTHORIZATION_SERVER_PATH = "/.well-known/oauth-authorization-server";

/**
 * Ten minutes, where a phone's pairing code gets two.
 *
 * The phone's code is on screen with the phone in your hand. This one has to
 * survive the operator walking to another machine, opening an MCP config and
 * starting the agent. Two minutes would fail that honestly-common case, and a
 * code people routinely have to re-mint is a code people stop reading.
 *
 * Overridable only so a harness can watch a code actually go stale instead of
 * sitting out ten minutes for one, the way the NodeLink heartbeat is. An
 * expiring code is a promise this room makes to an operator, so it is proven
 * by the clock rather than by reading the branch. Production never sets it.
 */
const configuredEnrollmentTtlMs = Number(process.env.TOAD_SEAT_ENROLLMENT_TTL_MS);
const ENROLLMENT_TTL_MS =
	Number.isFinite(configuredEnrollmentTtlMs) && configuredEnrollmentTtlMs > 0
		? configuredEnrollmentTtlMs
		: 10 * 60_000;

/** Access tokens are cheap to re-mint and worth nothing tomorrow. */
const ACCESS_TTL_MS = 60 * 60_000;

/** An authorization code is a baton, not a credential: seconds, single use. */
const AUTH_CODE_TTL_MS = 5 * 60_000;

/**
 * A refresh token outlives a desk restart, and that is the whole point of it.
 *
 * The access token above is deliberately in memory — a restart costs one round
 * trip against a secret the client already holds. A refresh token cannot work
 * that way: a stock client that loses it has no recourse but to send its human
 * back to a browser and a fresh code off the desk, which is precisely the
 * "silently stopped working" failure this room keeps fixing elsewhere. So it
 * is written down, hashed, on the desk that issued it. Not replicated: it is
 * this desk's session, the way a phone's is, and a client that moves desks can
 * always fall back to the client secret it still holds.
 */
const REFRESH_TTL_MS = 90 * 24 * 60 * 60_000;
const SEAT_DIR = join(ROOT, "seat");
const REFRESH_FILE = join(SEAT_DIR, "refresh.json");

const CLIENT_ID_PREFIX = "mcp_";

/**
 * One pending enrollment at a time, on this desk, in memory.
 *
 * In memory because a code that survives a restart is a code nobody is
 * watching; one at a time because the desk shows one, and a second code the
 * operator cannot see on screen is a second way in they did not open.
 */
let enrollment: OneTimeCode | null = null;

/**
 * Live access tokens, per desk, never replicated.
 *
 * The seat replicates; the credential minted against it does not — the same
 * split a phone has, where the membership is a record and the ten-minute
 * session is this desk's own. A desk restart makes every client re-present its
 * client secret, which costs one round trip and removes a whole class of
 * "which desk still honours this string" question.
 */
const accessTokens = new Map<
	string,
	{ clientId: string; scope: string; expiresAt: number }
>();

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

/**
 * A client that has registered but nobody has approved yet.
 *
 * The browser door registers first and asks for the code second, so between
 * those two moments there is a client id with a secret and no seat. It is kept
 * here rather than written to the room, because an unapproved registration is
 * not a member: it holds no grant, appears in no roster, and can mint no
 * token. In memory and short-lived for the same reason the code is — a pending
 * registration that survives a restart is one nobody is watching.
 */
type PendingClient = {
	clientId: string;
	name: string;
	secretHash: string;
	redirectUris: string[];
	software: { id: string; version: string } | null;
	createdAt: number;
};
const pendingClients = new Map<string, PendingClient>();

/** One authorization code: a single-use baton between the page and the token. */
type AuthorizationCode = {
	clientId: string;
	redirectUri: string;
	challenge: string;
	expiresAt: number;
};
const authorizationCodes = new Map<string, AuthorizationCode>();

type RefreshRecord = { clientId: string; expiresAt: number };
let refreshTokens: Map<string, RefreshRecord> | null = null;

function refreshStore(): Map<string, RefreshRecord> {
	if (refreshTokens) return refreshTokens;
	refreshTokens = new Map();
	try {
		const raw = JSON.parse(readFileSync(REFRESH_FILE, "utf8")) as Record<string, RefreshRecord>;
		const now = Date.now();
		for (const [hash, record] of Object.entries(raw)) {
			if (record && typeof record.clientId === "string" && record.expiresAt > now) {
				refreshTokens.set(hash, record);
			}
		}
	} catch {
		/* No file, or one we cannot read. An unreadable refresh store costs a
		 * client one trip through its client secret, which it still holds. */
	}
	return refreshTokens;
}

function writeRefreshStore(): void {
	const store = refreshStore();
	try {
		mkdirSync(SEAT_DIR, { recursive: true, mode: 0o700 });
		chmodSync(SEAT_DIR, 0o700);
		writeFileSync(REFRESH_FILE, `${JSON.stringify(Object.fromEntries(store))}\n`, { mode: 0o600 });
		chmodSync(REFRESH_FILE, 0o600);
	} catch {
		/* Best effort. A refresh token we could not write is one the client
		 * will be told to replace, which is worse than silence but not wrong. */
	}
}

/** Drops expired codes and refresh tokens, and any belonging to a dead seat. */
function sweepGrants(): void {
	const now = Date.now();
	for (const [code, granted] of authorizationCodes) {
		if (granted.expiresAt <= now) authorizationCodes.delete(code);
	}
	for (const [clientId, pending] of pendingClients) {
		if (pending.createdAt + ENROLLMENT_TTL_MS <= now) pendingClients.delete(clientId);
	}
	const store = refreshStore();
	let dropped = false;
	for (const [hash, record] of store) {
		if (record.expiresAt <= now || !clientMember(record.clientId)) {
			store.delete(hash);
			dropped = true;
		}
	}
	if (dropped) writeRefreshStore();
}

/** Every refresh token a seat holds stops working the moment it is revoked. */
function forgetRefreshFor(clientId: string): void {
	const store = refreshStore();
	let dropped = false;
	for (const [hash, record] of store) {
		if (record.clientId === clientId) {
			store.delete(hash);
			dropped = true;
		}
	}
	if (dropped) writeRefreshStore();
}

/** Compares digests without a timing oracle. Same care as `stateMatches`. */
function digestEqual(a: string, b: string): boolean {
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	return left.length === right.length && timingSafeEqual(left, right);
}

function sweepTokens(): void {
	const now = Date.now();
	for (const [token, granted] of accessTokens) {
		if (granted.expiresAt <= now) accessTokens.delete(token);
	}
	if (enrollment && enrollment.expiresAt <= now) enrollment = null;
}

/* ------------------------------------------------------------- the ceremony */

export type ClientEnrollment = {
	code: string;
	expiresAt: number;
	/** The URL the agent is configured with. Null when the TLS door is down. */
	mcpUrl: string | null;
	/** Where the agent registers. Also discoverable; named here to save a hop. */
	registrationEndpoint: string | null;
	/**
	 * The certificate an agent elsewhere on the network must be told to trust —
	 * the room's CA when this desk holds one, this desk's own leaf when it does
	 * not. A phone taps through instead.
	 */
	certPath: string | null;
	/** Its SHA-256, so a human can check what they installed is what we meant. */
	certFingerprint: string | null;
	/**
	 * Whether that file is the room's CA. False means the old, narrower promise:
	 * this desk alone, and only until its address moves.
	 */
	certIsRoomCa: boolean;
};

function enrollmentAnswer(pending: OneTimeCode): ClientEnrollment {
	const origin = secureOrigin();
	const trust = webTlsTrust();
	return {
		code: pending.code,
		expiresAt: pending.expiresAt,
		mcpUrl: origin ? `${origin}${SEAT_PATH}` : null,
		registrationEndpoint: origin ? `${origin}${REGISTRATION_PATH}` : null,
		certPath: trust.path,
		certFingerprint: trust.fingerprint,
		certIsRoomCa: trust.roomCa,
	};
}

/**
 * Mints the code the operator reads off the desk.
 *
 * Four bytes of hex, exactly like `createPairing` — the shape of a Toad
 * enrollment code should not depend on what is joining. A fresh call replaces
 * any code still standing, because the desk only ever shows one.
 */
export function createClientEnrollment(): ClientEnrollment {
	enrollment = mintCode(ENROLLMENT_TTL_MS);
	return enrollmentAnswer(enrollment);
}

/** The code still standing, if any. The desk's way to see what it opened. */
export function currentClientEnrollment(): ClientEnrollment | null {
	sweepTokens();
	return enrollment ? enrollmentAnswer(enrollment) : null;
}

/** Closes the window early — the way out for a code shown by mistake. */
export function cancelClientEnrollment(): boolean {
	if (!enrollment) return false;
	enrollment = null;
	return true;
}

/**
 * Spends the code, or refuses. One use, and five wrong guesses burn the slot.
 *
 * The rule itself lives in `../one-time-code`, shared with the phone pairing,
 * because the two are one ceremony: compared as a digest so a wrong code cannot
 * be found by timing, and cleared before the caller does anything with the
 * answer so no path can spend it twice.
 */
function consumeEnrollment(code: string): boolean {
	sweepTokens();
	const spent = spendCode(enrollment, code);
	enrollment = spent.keep;
	return spent.ok;
}

/* --------------------------------------------------------------- discovery */

const DISCOVERY_HEADERS = {
	"content-type": "application/json",
	"cache-control": "no-store",
	"access-control-allow-origin": "*",
	"access-control-allow-methods": "GET, OPTIONS",
	"access-control-allow-headers": "authorization, content-type, mcp-protocol-version",
};

/**
 * RFC 8414 authorization server metadata, written out rather than derived.
 *
 * Hand-built because the SDK's metadata helper builds a document for a server
 * with a redirect flow, and this one has none: `response_types_supported` is
 * empty and the only grant is `client_credentials`.
 *
 * It does publish an `authorization_endpoint`, and that took a reversal. RFC
 * 8414 §2 makes the field optional exactly here — "unless no grant types are
 * supported that use the authorization endpoint" — so leaving it out was the
 * honest document. But every MCP client parses this through a schema that
 * requires it unconditionally, so an honest omission does not read as "no
 * redirect flow"; it reads as a malformed document, and the client fails
 * discovery naming a field rather than naming Toad. The endpoint is therefore
 * real and refuses in words — see `handleAuthorizeRefusal`. Advertising an
 * endpoint that does not exist would be a lie; advertising one that exists and
 * says "this room has no redirect flow, register with the desk's enrollment
 * code" is the truth arriving where a client will actually read it.
 */
export function authorizationServerMetadata(): Record<string, unknown> | null {
	const origin = secureOrigin();
	if (!origin) return null;
	return {
		issuer: origin,
		authorization_endpoint: `${origin}${AUTHORIZE_PATH}`,
		token_endpoint: `${origin}${TOKEN_PATH}`,
		registration_endpoint: `${origin}${REGISTRATION_PATH}`,
		/* Both doors, advertised. A stock client reads this, sees `code`, and
		 * takes the browser route; a headless one ignores it and registers with
		 * the code in hand. Advertising only client_credentials is what made a
		 * stock connector fail at discovery. */
		grant_types_supported: ["authorization_code", "refresh_token", "client_credentials"],
		response_types_supported: ["code"],
		code_challenge_methods_supported: ["S256"],
		token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
		scopes_supported: [SEAT_SCOPE],
	};
}

export function protectedResourceMetadata(): Record<string, unknown> | null {
	const origin = secureOrigin();
	if (!origin) return null;
	const room = ensureRoom();
	return {
		resource: `${origin}${SEAT_PATH}`,
		authorization_servers: [origin],
		scopes_supported: [SEAT_SCOPE],
		bearer_methods_supported: ["header"],
		resource_name: `${room.name} — ${hostname()}`,
	};
}

/* ------------------------------------------------------------------ answers */

type Answer = { status: number; body: unknown; headers?: Record<string, string> };

const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store" };

function oauthError(status: number, code: OAuthErrorCode, description: string): Answer {
	return { status, body: { error: code, error_description: description }, headers: JSON_HEADERS };
}

/** Every route here refuses on the plain door; a client secret is not for it. */
function tlsRequired(): Answer {
	return oauthError(
		503,
		OAuthErrorCode.ServerError,
		"This room has no TLS door. Turn web access on and let Toad generate its certificate.",
	);
}

/* ----------------------------------------------------------- authorization */

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

export type AuthorizeRequest = {
	clientId: string;
	redirectUri: string;
	state: string;
	challenge: string;
	name: string;
	pending: boolean;
};

/**
 * What the browser arrived asking for, or the reason it cannot be honoured.
 *
 * Every refusal here is rendered as a page rather than redirected, because a
 * request whose client or redirect cannot be trusted is exactly the one whose
 * redirect must not be followed (RFC 6749 §4.1.2.1). A wrong code is not a
 * refusal — it is the page again, with fewer guesses left.
 */
function readAuthorizeRequest(query: URLSearchParams): AuthorizeRequest | { error: string } {
	const clientId = query.get("client_id") ?? "";
	const redirectUri = query.get("redirect_uri") ?? "";
	const pending = pendingClients.get(clientId);
	const member = clientMember(clientId);
	if (!pending && !member) {
		return { error: "That client is not registered with this room. Register first, then come back." };
	}
	if (query.get("response_type") !== "code") {
		return { error: "This room answers response_type=code." };
	}
	const registered = pending ? pending.redirectUris : [];
	if (!redirectUri || (pending && !registered.includes(redirectUri))) {
		return { error: "That redirect_uri was not registered by this client." };
	}
	if (query.get("code_challenge_method") !== "S256" || !query.get("code_challenge")) {
		return { error: "This room requires PKCE with S256." };
	}
	const scope = query.get("scope");
	if (scope && scope.split(/\s+/).some((entry) => entry !== SEAT_SCOPE)) {
		return { error: `This room understands one scope: ${SEAT_SCOPE}.` };
	}
	return {
		clientId,
		redirectUri,
		state: query.get("state") ?? "",
		challenge: query.get("code_challenge") ?? "",
		name: pending?.name ?? member?.name ?? clientId,
		pending: Boolean(pending),
	};
}

/**
 * The consent screen and the code prompt, which are the same page.
 *
 * The human act that admits an agent is reading a code off a desk. In the
 * headless door that code is a bearer token; here it is a field on this page,
 * and typing it IS the approval — there is no second "allow" to click, because
 * a consent button that anyone can press adds ceremony without adding a human.
 * The page names who is asking, which room and desk they would join, and which
 * desks the seat would reach, because approving something unnamed is not
 * consent.
 */
function authorizePage(input: {
	request: AuthorizeRequest;
	desks: string[];
	notice?: string;
}): string {
	const room = ensureRoom();
	const { request, desks, notice } = input;
	const rows = desks.map((desk) => `<li>${escapeHtml(desk)}</li>`).join("");
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Join ${escapeHtml(room.name)}</title>
<style>
:root{color-scheme:light dark}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
 font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
 background:Canvas;color:CanvasText}
main{width:min(30rem,92vw);padding:2rem;border:1px solid color-mix(in oklab,CanvasText 15%,transparent);border-radius:14px}
h1{margin:0 0 .25rem;font-size:1.15rem}
p{margin:.5rem 0;color:color-mix(in oklab,CanvasText 70%,transparent)}
strong{color:CanvasText}
ul{margin:.25rem 0 1rem 1.1rem;padding:0;color:color-mix(in oklab,CanvasText 70%,transparent)}
label{display:block;margin:1.25rem 0 .35rem;font-weight:600}
input{width:100%;box-sizing:border-box;padding:.6rem .7rem;font:inherit;font-family:ui-monospace,monospace;
 letter-spacing:.12em;border:1px solid color-mix(in oklab,CanvasText 30%,transparent);border-radius:8px;
 background:Field;color:FieldText}
button{margin-top:1rem;width:100%;padding:.65rem;font:inherit;font-weight:600;border:0;border-radius:8px;
 background:color-mix(in oklab,CanvasText 88%,transparent);color:Canvas;cursor:pointer}
.notice{margin-top:1rem;padding:.6rem .7rem;border-radius:8px;
 background:color-mix(in oklab,#c2410c 18%,transparent);color:CanvasText}
.foot{margin-top:1.25rem;font-size:.8rem}
</style></head><body><main>
<h1>${escapeHtml(request.name)} wants to join ${escapeHtml(room.name)}</h1>
<p>It would connect through <strong>${escapeHtml(nodeIdentity().name)}</strong> as an outside agent —
not as you, and not as one of your teammates. It could reach the teammates on:</p>
<ul>${rows}</ul>
<form method="post" action="${escapeHtml(AUTHORIZE_PATH)}">
<input type="hidden" name="client_id" value="${escapeHtml(request.clientId)}">
<input type="hidden" name="redirect_uri" value="${escapeHtml(request.redirectUri)}">
<input type="hidden" name="state" value="${escapeHtml(request.state)}">
<input type="hidden" name="code_challenge" value="${escapeHtml(request.challenge)}">
<input type="hidden" name="code_challenge_method" value="S256">
<input type="hidden" name="response_type" value="code">
<label for="code">Enrollment code from the desk</label>
<input id="code" name="code" autocomplete="off" autocapitalize="off" spellcheck="false"
 autofocus placeholder="8 characters">
${notice ? `<div class="notice">${escapeHtml(notice)}</div>` : ""}
<button type="submit">Approve and join</button>
</form>
<p class="foot">Settings &rsaquo; Room &rsaquo; Agents on ${escapeHtml(nodeIdentity().name)} shows the code,
and is where you can narrow or revoke this seat afterwards.</p>
</main></body></html>`;
}

function htmlAnswer(status: number, html: string): Answer {
	return { status, headers: { "content-type": "text/html; charset=utf-8" }, body: html };
}

function refusalPage(message: string): string {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Cannot join</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
font:15px/1.5 ui-sans-serif,system-ui,sans-serif;background:Canvas;color:CanvasText}
main{width:min(30rem,92vw);padding:2rem}</style></head>
<body><main><h1 style="font-size:1.1rem;margin:0 0 .5rem">This request cannot be approved</h1>
<p style="color:color-mix(in oklab,CanvasText 70%,transparent)">${escapeHtml(message)}</p></main></body></html>`;
}

/** The page a client's browser lands on. GET only; it changes nothing. */
export function handleAuthorizePage(query: URLSearchParams, desks: string[]): Answer {
	if (!secureOrigin()) return htmlAnswer(503, refusalPage("This room has no TLS door."));
	sweepGrants();
	const request = readAuthorizeRequest(query);
	if ("error" in request) return htmlAnswer(400, refusalPage(request.error));
	return htmlAnswer(200, authorizePage({ request, desks }));
}

/**
 * The code, entered. This is where an agent becomes a member.
 *
 * A pending client is admitted here and nowhere else, so a registration nobody
 * approved leaves no trace in the room. The authorization code minted after it
 * is bound to this client, this redirect and this PKCE challenge, and lives
 * five minutes: it is a baton, not a credential.
 */
export function handleAuthorizeSubmit(
	form: URLSearchParams,
	desks: string[],
): Answer {
	const origin = secureOrigin();
	if (!origin) return htmlAnswer(503, refusalPage("This room has no TLS door."));
	sweepGrants();
	const request = readAuthorizeRequest(form);
	if ("error" in request) return htmlAnswer(400, refusalPage(request.error));

	const code = (form.get("code") ?? "").trim();
	if (!consumeEnrollment(code)) {
		return htmlAnswer(
			401,
			authorizePage({
				request,
				desks,
				notice: "That code is wrong, expired, or already spent. Show a new one on the desk.",
			}),
		);
	}

	let member = clientMember(request.clientId);
	if (!member) {
		const pending = pendingClients.get(request.clientId);
		if (!pending) return htmlAnswer(400, refusalPage("That registration expired. Register again."));
		const outcome = admitClientMember({
			clientId: pending.clientId,
			name: pending.name,
			secretHash: pending.secretHash,
			scope: SEAT_SCOPE,
			grant: desks,
			software: pending.software,
		});
		if (!outcome.ok) return htmlAnswer(500, refusalPage("The room refused that registration."));
		pendingClients.delete(pending.clientId);
		member = outcome.member;
	}

	const authorizationCode = randomBytes(32).toString("base64url");
	authorizationCodes.set(authorizationCode, {
		clientId: member.clientId,
		redirectUri: request.redirectUri,
		challenge: request.challenge,
		expiresAt: Date.now() + AUTH_CODE_TTL_MS,
	});
	const target = new URL(request.redirectUri);
	target.searchParams.set("code", authorizationCode);
	if (request.state) target.searchParams.set("state", request.state);
	return { status: 302, headers: { location: target.toString() }, body: null };
}

/* ----------------------------------------------------------- registration */

/**
 * RFC 7591 dynamic client registration, gated by the enrollment code.
 *
 * The code arrives as the initial access token — `Authorization: Bearer` on
 * the registration request, which is the slot RFC 7591 §3 defines for exactly
 * this and which any HTTP client can fill. Checked before the body is read so
 * a malformed registration cannot burn a code the operator is still holding
 * up on screen, and the grant it confers is the phone's: this desk plus every
 * desk linked to it, narrowed afterwards in Settings.
 */
export function handleClientRegistration(
	authorization: string | null,
	body: unknown,
	grant: string[],
): Answer {
	const origin = secureOrigin();
	if (!origin) return tlsRequired();

	const presented = /^Bearer\s+(.+)$/i.exec(authorization ?? "")?.[1]?.trim() ?? "";
	const input = (body ?? {}) as Record<string, unknown>;
	const name = String(input.client_name ?? "").trim().slice(0, 80);
	if (!name) {
		return oauthError(
			400,
			OAuthErrorCode.InvalidClientMetadata,
			"client_name is required — it is the name this agent appears under in the room.",
		);
	}
	const grants = Array.isArray(input.grant_types) ? input.grant_types.map(String) : ["client_credentials"];
	const known = new Set(["authorization_code", "refresh_token", "client_credentials"]);
	const unknownGrant = grants.find((entry) => !known.has(entry));
	if (unknownGrant) {
		return oauthError(
			400,
			OAuthErrorCode.InvalidClientMetadata,
			`This room does not issue ${unknownGrant}.`,
		);
	}
	/* Which door this registration is walking through. A code in hand is the
	 * headless one and admits on the spot; a redirect flow is the browser one
	 * and admits nothing until somebody enters the code on the page. */
	const wantsCode = grants.includes("authorization_code");
	if (!presented && !wantsCode) {
		return {
			...oauthError(
				401,
				OAuthErrorCode.InvalidToken,
				"Registration needs the enrollment code from the desk, as a bearer token — or register for the authorization_code flow and enter it in the browser.",
			),
			headers: { ...JSON_HEADERS, "www-authenticate": 'Bearer realm="toad", error="invalid_token"' },
		};
	}
	const method = typeof input.token_endpoint_auth_method === "string" ? input.token_endpoint_auth_method : "client_secret_basic";
	if (method !== "client_secret_basic" && method !== "client_secret_post" && method !== "none") {
		return oauthError(
			400,
			OAuthErrorCode.InvalidClientMetadata,
			"token_endpoint_auth_method must be client_secret_basic, client_secret_post, or none.",
		);
	}
	const redirectUris = Array.isArray(input.redirect_uris) ? input.redirect_uris.map(String) : [];
	if (wantsCode && redirectUris.length === 0) {
		return oauthError(
			400,
			OAuthErrorCode.InvalidClientMetadata,
			"The authorization_code flow needs at least one redirect_uri to send the browser back to.",
		);
	}
	for (const uri of redirectUris) {
		/* Loopback and a private scheme are what real MCP clients use; anything
		 * else would let a registration point the approval at a stranger. */
		const ok = /^https:\/\//i.test(uri)
			? /^https:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(uri)
			: /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(uri) || /^[a-z][a-z0-9+.-]*:\/\//i.test(uri);
		if (!ok) {
			return oauthError(
				400,
				OAuthErrorCode.InvalidClientMetadata,
				`redirect_uri ${uri} is not a loopback address or a private scheme.`,
			);
		}
	}
	const requested = typeof input.scope === "string" && input.scope.length > 0 ? input.scope.split(/\s+/) : [SEAT_SCOPE];
	if (requested.some((scope) => scope !== SEAT_SCOPE)) {
		return oauthError(400, OAuthErrorCode.InvalidScope, `This room understands one scope: ${SEAT_SCOPE}.`);
	}

	const clientIdEarly = `${CLIENT_ID_PREFIX}${randomBytes(8).toString("hex")}`;
	const secretEarly = randomBytes(32).toString("hex");
	const softwareEarly =
		typeof input.software_id === "string" && typeof input.software_version === "string"
			? { id: input.software_id.slice(0, 80), version: input.software_version.slice(0, 40) }
			: null;

	/* The browser door. Nothing is admitted here: the client gets an identity
	 * it cannot yet spend, and the room learns nothing about it until a human
	 * enters the code on the authorization page. */
	if (!presented && wantsCode) {
		sweepGrants();
		pendingClients.set(clientIdEarly, {
			clientId: clientIdEarly,
			name,
			secretHash: sha256(secretEarly),
			redirectUris,
			software: softwareEarly,
			createdAt: Date.now(),
		});
		const room = ensureRoom();
		return {
			status: 201,
			headers: JSON_HEADERS,
			body: {
				client_id: clientIdEarly,
				client_secret: secretEarly,
				client_id_issued_at: Math.floor(Date.now() / 1_000),
				client_secret_expires_at: 0,
				client_name: name,
				grant_types: ["authorization_code", "refresh_token"],
				response_types: ["code"],
				redirect_uris: redirectUris,
				token_endpoint_auth_method: method,
				scope: SEAT_SCOPE,
				...(softwareEarly ? { software_id: softwareEarly.id, software_version: softwareEarly.version } : {}),
				toad: {
					room: { id: room.id, name: room.name },
					desk: { nodeId: localNodeId(), name: nodeIdentity().name },
					/* No grant yet, and saying so is the point: this client is
					 * registered and unapproved until somebody at the desk reads
					 * a code onto the authorization page. */
					grant: [],
					pending: true,
					authorization_endpoint: `${origin}${AUTHORIZE_PATH}`,
					mcp_url: `${origin}${SEAT_PATH}`,
					token_endpoint: `${origin}${TOKEN_PATH}`,
				},
			},
		};
	}

	// Last, so nothing above can spend it.
	if (!consumeEnrollment(presented)) {
		return {
			...oauthError(
				401,
				OAuthErrorCode.InvalidToken,
				"That enrollment code is wrong, expired, or already spent. Show a new one on the desk.",
			),
			headers: { ...JSON_HEADERS, "www-authenticate": 'Bearer realm="toad", error="invalid_token"' },
		};
	}

	const clientId = clientIdEarly;
	const clientSecret = secretEarly;
	const software = softwareEarly;
	const outcome = admitClientMember({
		clientId,
		name,
		secretHash: sha256(clientSecret),
		scope: SEAT_SCOPE,
		grant,
		software,
	});
	if (!outcome.ok) {
		return oauthError(
			500,
			OAuthErrorCode.ServerError,
			"The room refused that registration. Show a new enrollment code and try again.",
		);
	}

	const room = ensureRoom();
	return {
		status: 201,
		headers: JSON_HEADERS,
		body: {
			client_id: outcome.member.clientId,
			client_secret: clientSecret,
			client_id_issued_at: Math.floor(outcome.member.admittedAt / 1_000),
			/* Zero is RFC 7591 for "does not expire". The seat is what ends, and
			 * it ends by revocation on the desk, not by a clock nobody watches. */
			client_secret_expires_at: 0,
			client_name: outcome.member.name,
			grant_types: ["client_credentials"],
			response_types: [],
			token_endpoint_auth_method: method,
			scope: SEAT_SCOPE,
			...(software ? { software_id: software.id, software_version: software.version } : {}),
			/* An extension block, so the agent's operator sees what it just
			 * joined in the same breath it gets its credential — the terminal's
			 * version of the "you are in <room>" a phone lands on. */
			toad: {
				room: { id: room.id, name: room.name },
				desk: { nodeId: localNodeId(), name: nodeIdentity().name },
				grant: outcome.member.grant,
				mcp_url: `${origin}${SEAT_PATH}`,
				token_endpoint: `${origin}${TOKEN_PATH}`,
			},
		},
	};
}

/* ------------------------------------------------------------------ tokens */

function presentedClient(
	authorization: string | null,
	form: URLSearchParams,
): { clientId: string; secret: string } | null {
	const basic = /^Basic\s+(.+)$/i.exec(authorization ?? "")?.[1]?.trim();
	if (basic) {
		try {
			const decoded = Buffer.from(basic, "base64").toString("utf8");
			const cut = decoded.indexOf(":");
			if (cut === -1) return null;
			return {
				clientId: decodeURIComponent(decoded.slice(0, cut)),
				secret: decodeURIComponent(decoded.slice(cut + 1)),
			};
		} catch {
			return null;
		}
	}
	const clientId = form.get("client_id") ?? "";
	const secret = form.get("client_secret") ?? "";
	return clientId && secret ? { clientId, secret } : null;
}

const INVALID_CLIENT_HEADERS = { ...JSON_HEADERS, "www-authenticate": 'Basic realm="toad"' };

/**
 * The client credentials grant.
 *
 * Answerable on any desk the seat's grant names, not only the one that
 * admitted it — the record replicated, and a digest is verifiable everywhere.
 * That is the phone's "one identity walks between desks" property, kept.
 *
 * The grant is re-read here rather than trusted from registration time, so a
 * grant narrowed on the owning desk takes effect at this desk's next token
 * request, and a revocation refuses immediately.
 */
export function handleClientToken(authorization: string | null, form: URLSearchParams): Answer {
	const origin = secureOrigin();
	if (!origin) return tlsRequired();
	sweepTokens();

	sweepGrants();
	const grantType = form.get("grant_type");
	if (grantType !== "client_credentials" && grantType !== "authorization_code" && grantType !== "refresh_token") {
		return oauthError(
			400,
			OAuthErrorCode.UnsupportedGrantType,
			"This room issues authorization_code, refresh_token and client_credentials.",
		);
	}
	const resource = form.get("resource");
	if (resource && resource.replace(/#.*$/, "") !== `${origin}${SEAT_PATH}`) {
		return oauthError(400, OAuthErrorCode.InvalidTarget, "That resource is not served by this room.");
	}
	const requested = form.get("scope");
	if (requested && requested.split(/\s+/).some((scope) => scope !== SEAT_SCOPE)) {
		return oauthError(400, OAuthErrorCode.InvalidScope, `This room understands one scope: ${SEAT_SCOPE}.`);
	}

	/**
	 * The authorization code, redeemed.
	 *
	 * PKCE is checked rather than the client secret, because a client that took
	 * the browser door may be public (`token_endpoint_auth_method: none`) and
	 * the verifier is what proves it is the same client that started the flow.
	 * The code is deleted before anything else can fail, so a replay finds
	 * nothing whatever happens next.
	 */
	if (grantType === "authorization_code") {
		const code = form.get("code") ?? "";
		const granted = authorizationCodes.get(code);
		authorizationCodes.delete(code);
		if (!granted || granted.expiresAt <= Date.now()) {
			return oauthError(400, OAuthErrorCode.InvalidGrant, "That authorization code is not valid.");
		}
		if (granted.redirectUri !== (form.get("redirect_uri") ?? granted.redirectUri)) {
			return oauthError(400, OAuthErrorCode.InvalidGrant, "That redirect_uri is not the one the code was issued for.");
		}
		const verifier = form.get("code_verifier") ?? "";
		const computed = createHash("sha256").update(verifier).digest("base64url");
		if (!verifier || !digestEqual(computed, granted.challenge)) {
			return oauthError(400, OAuthErrorCode.InvalidGrant, "That code_verifier does not match the challenge.");
		}
		const member = clientMember(granted.clientId);
		if (!member || !member.grant.includes(localNodeId())) {
			return oauthError(400, OAuthErrorCode.InvalidGrant, "That seat is no longer served by this desk.");
		}
		return issueTokens(member, true);
	}

	/** A refresh token, spent once and replaced — a stolen one dies on first use. */
	if (grantType === "refresh_token") {
		const offered = form.get("refresh_token") ?? "";
		const store = refreshStore();
		const record = offered ? store.get(sha256(offered)) : undefined;
		if (record) {
			store.delete(sha256(offered));
			writeRefreshStore();
		}
		if (!record || record.expiresAt <= Date.now()) {
			return oauthError(400, OAuthErrorCode.InvalidGrant, "That refresh token is not valid here.");
		}
		const member = clientMember(record.clientId);
		if (!member || !member.grant.includes(localNodeId())) {
			return oauthError(400, OAuthErrorCode.InvalidGrant, "That seat is no longer served by this desk.");
		}
		return issueTokens(member, true);
	}

	const presented = presentedClient(authorization, form);
	if (!presented) {
		return {
			...oauthError(401, OAuthErrorCode.InvalidClient, "Client authentication is required."),
			headers: INVALID_CLIENT_HEADERS,
		};
	}
	const member = clientMember(presented.clientId);
	/* One refusal for "no such client", "wrong secret", and "revoked", so a
	 * stranger with a guessed id learns nothing from the difference. */
	if (!member || !digestEqual(member.secretHash, sha256(presented.secret))) {
		return {
			...oauthError(401, OAuthErrorCode.InvalidClient, "That client id or secret is not valid here."),
			headers: INVALID_CLIENT_HEADERS,
		};
	}
	if (!member.grant.includes(localNodeId())) {
		return {
			...oauthError(401, OAuthErrorCode.InvalidClient, "This desk is not shared with that agent."),
			headers: INVALID_CLIENT_HEADERS,
		};
	}

	return issueTokens(member, false);
}

/**
 * One access token, and a refresh token when the flow that earned it has one.
 *
 * Client credentials get no refresh token on purpose: the client already holds
 * a secret that mints tokens forever, and a second long-lived string to keep
 * safe buys nothing. The browser door gets one because its client may be
 * public, and because sending a human back to a desk for a fresh code every
 * hour is exactly the silent stoppage this room keeps designing away.
 */
function issueTokens(member: ClientMember, withRefresh: boolean): Answer {
	const token = randomBytes(32).toString("base64url");
	accessTokens.set(token, {
		clientId: member.clientId,
		scope: SEAT_SCOPE,
		expiresAt: Date.now() + ACCESS_TTL_MS,
	});
	let refresh: string | null = null;
	if (withRefresh) {
		refresh = randomBytes(32).toString("base64url");
		refreshStore().set(sha256(refresh), {
			clientId: member.clientId,
			expiresAt: Date.now() + REFRESH_TTL_MS,
		});
		writeRefreshStore();
	}
	return {
		status: 200,
		headers: JSON_HEADERS,
		body: {
			access_token: token,
			token_type: "Bearer",
			expires_in: Math.floor(ACCESS_TTL_MS / 1_000),
			scope: SEAT_SCOPE,
			...(refresh ? { refresh_token: refresh } : {}),
		},
	};
}

/**
 * The resource server's half: an access token back to the seat behind it.
 *
 * Shaped as the MCP server SDK's `OAuthTokenVerifier` so the MCP endpoint can
 * hand it straight to `requireBearerAuth`. `extra` carries what attribution
 * needs — the member id, its display name, and the desk it came in through —
 * so a message from an outside agent can be written into a tape as itself and
 * never as the operator.
 */
export async function verifyAccessToken(token: string): Promise<AuthInfo> {
	sweepTokens();
	const granted = accessTokens.get(token);
	const member = granted ? clientMember(granted.clientId) : null;
	if (!granted || !member || !member.grant.includes(localNodeId())) {
		accessTokens.delete(token);
		throw new OAuthError(OAuthErrorCode.InvalidToken, "That access token is not valid here.");
	}
	return {
		token,
		clientId: member.clientId,
		scopes: granted.scope.split(/\s+/).filter(Boolean),
		expiresAt: Math.floor(granted.expiresAt / 1_000),
		extra: {
			memberId: member.clientId,
			memberName: member.name,
			deskNodeId: localNodeId(),
			/* The name the room addresses this desk by, which is what a
			 * teammate's tape will show beside the agent's own name. Not
			 * `hostname()`: two desks can share a host, and the room's name for
			 * a desk is the one an operator recognises. */
			deskName: nodeIdentity().name,
		},
	};
}

/** The verifier as one object, for `requireBearerAuth({ verifier })`. */
export const clientTokenVerifier = { verifyAccessToken };

/**
 * The seat behind a live access token, or null.
 *
 * The direct read for callers inside the process that already hold a verified
 * token and want the member rather than an `AuthInfo` — the tool layer asking
 * "who is this, and which desks may they reach".
 */
export function clientForToken(token: string): ClientMember | null {
	sweepTokens();
	const granted = accessTokens.get(token);
	if (!granted) return null;
	const member = clientMember(granted.clientId);
	return member && member.grant.includes(localNodeId()) ? member : null;
}

/**
 * Drops tokens whose seat this desk no longer serves.
 *
 * The membership hook calls this in the same breath a tombstone or a narrowed
 * grant lands, so a removed agent goes dark now rather than at token expiry —
 * the same promise the web server keeps for a revoked phone's sockets.
 */
export function sweepRevokedClients(): number {
	sweepTokens();
	let dropped = 0;
	for (const [token, granted] of accessTokens) {
		const member = clientMember(granted.clientId);
		if (!member || !member.grant.includes(localNodeId())) {
			accessTokens.delete(token);
			/* The long-lived half goes with it. A revoked seat that could still
			 * refresh its way back in would be a revocation in name only. */
			forgetRefreshFor(granted.clientId);
			dropped += 1;
		}
	}
	sweepGrants();
	return dropped;
}

/* ------------------------------------------------------------------ routing */

export type SeatRoute =
	| { kind: "metadata"; document: "resource" | "authorization-server" }
	| { kind: "register" }
	| { kind: "token" }
	/** The browser door: a consent page that asks for the enrollment code. */
	| { kind: "authorize" }
	/** The MCP endpoint itself — the resource everything else describes. */
	| { kind: "endpoint" };

/**
 * Which client-seat route a path names, if any.
 *
 * A lookup rather than a handler so the web server keeps one place where the
 * TLS door, CORS and method checks live — this module answers what a request
 * means, `web/server.ts` answers where it is allowed to arrive.
 */
export function seatRouteFor(pathname: string): SeatRoute | null {
	switch (pathname) {
		case PROTECTED_RESOURCE_PATH:
			return { kind: "metadata", document: "resource" };
		case AUTHORIZATION_SERVER_PATH:
			return { kind: "metadata", document: "authorization-server" };
		case REGISTRATION_PATH:
			return { kind: "register" };
		case TOKEN_PATH:
			return { kind: "token" };
		case AUTHORIZE_PATH:
			return { kind: "authorize" };
		case SEAT_PATH:
			return { kind: "endpoint" };
		default:
			return null;
	}
}

/** A discovery document as an HTTP answer, or a 503 when the TLS door is down. */
export function seatMetadataResponse(document: "resource" | "authorization-server"): Response {
	const body =
		document === "resource" ? protectedResourceMetadata() : authorizationServerMetadata();
	if (!body) {
		const refusal = tlsRequired();
		return Response.json(refusal.body, { status: refusal.status, headers: DISCOVERY_HEADERS });
	}
	return Response.json(body, { headers: DISCOVERY_HEADERS });
}

/* -------------------------------------------------------------- the listing */

export type ClientSeatInfo = {
	clientId: string;
	name: string;
	grant: string[];
	admittedAt: number;
	ownerNode: string;
	software: { id: string; version: string } | null;
	/** Whether this desk is currently honouring a token for it. */
	connected: boolean;
};

/**
 * Every client seat in the room, as the settings pane reads them.
 *
 * Deliberately the same shape of answer `listMobileMembers` feeds the Phones
 * list: a name, a grant, the desk that owns the row. No credential leaves this
 * module — not the secret, which was never stored, and not its digest.
 */
export function listClientSeats(): ClientSeatInfo[] {
	sweepTokens();
	const live = new Set([...accessTokens.values()].map((granted) => granted.clientId));
	return listClientMembers().map((member) => ({
		clientId: member.clientId,
		name: member.name,
		grant: member.grant,
		admittedAt: member.admittedAt,
		ownerNode: member.ownerNode,
		software: member.software,
		connected: live.has(member.clientId),
	}));
}
