import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
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
import { secureOrigin } from "../web/server";
import { WEB_TLS_CERT_FILE } from "../web/tls";

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
 * CLIENT CREDENTIALS, NOT AN AUTHORIZATION CODE. There is no browser at the
 * far end and no human sitting in front of the agent — the human act already
 * happened, at the desk, when the code was read off the screen. So the grant
 * is `client_credentials`: registration is the admission, and the token
 * endpoint only re-proves possession of what registration handed back. The
 * authorization endpoint this server publishes exists solely to say so — see
 * `authorizationServerMetadata`.
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

/** Guesses before the slot burns. 32 bits of code deserve a floor, not a race. */
const ENROLLMENT_MAX_ATTEMPTS = 5;

/** Access tokens are cheap to re-mint and worth nothing tomorrow. */
const ACCESS_TTL_MS = 60 * 60_000;

const CLIENT_ID_PREFIX = "mcp_";

type Enrollment = { code: string; expiresAt: number; attempts: number };

/**
 * One pending enrollment at a time, on this desk, in memory.
 *
 * In memory because a code that survives a restart is a code nobody is
 * watching; one at a time because the desk shows one, and a second code the
 * operator cannot see on screen is a second way in they did not open.
 */
let enrollment: Enrollment | null = null;

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
	 * The room's self-signed certificate, when there is one on disk. An agent
	 * elsewhere on the network must be told to trust it; a phone taps through.
	 */
	certPath: string | null;
};

function enrollmentAnswer(pending: Enrollment): ClientEnrollment {
	const origin = secureOrigin();
	return {
		code: pending.code,
		expiresAt: pending.expiresAt,
		mcpUrl: origin ? `${origin}${SEAT_PATH}` : null,
		registrationEndpoint: origin ? `${origin}${REGISTRATION_PATH}` : null,
		certPath: existsSync(WEB_TLS_CERT_FILE) ? WEB_TLS_CERT_FILE : null,
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
	enrollment = {
		code: randomBytes(4).toString("hex"),
		expiresAt: Date.now() + ENROLLMENT_TTL_MS,
		attempts: 0,
	};
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
 * Compared as a digest so a wrong code cannot be found by timing, and cleared
 * before the caller does anything with the answer so no path can spend it
 * twice.
 */
function consumeEnrollment(code: string): boolean {
	sweepTokens();
	if (!enrollment) return false;
	if (!digestEqual(sha256(enrollment.code), sha256(code))) {
		enrollment.attempts += 1;
		if (enrollment.attempts >= ENROLLMENT_MAX_ATTEMPTS) enrollment = null;
		return false;
	}
	enrollment = null;
	return true;
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
		grant_types_supported: ["client_credentials"],
		response_types_supported: [],
		token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
		scopes_supported: [SEAT_SCOPE],
	};
}

/**
 * The authorization endpoint, which exists only to refuse.
 *
 * A user agent that lands here has been sent by a client attempting the
 * authorization-code flow. There is nobody at the far end of this room to show
 * a consent screen to — the human act happened at the desk — so the answer is
 * the refusal RFC 6749 §4.1.2.1 asks for when the request cannot be trusted
 * back to a redirect URI: say it here, in the response, and do not redirect.
 */
export function handleAuthorizeRefusal(): Answer {
	return oauthError(
		400,
		OAuthErrorCode.UnsupportedResponseType,
		"This room has no browser flow. An agent joins it by registering with the one-time enrollment code shown on the desk, then using client_credentials at the token endpoint.",
	);
}

/** RFC 9728 protected resource metadata for the MCP endpoint. */
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
	if (!presented) {
		return {
			...oauthError(
				401,
				OAuthErrorCode.InvalidToken,
				"Registration needs the enrollment code from the desk, as a bearer token.",
			),
			headers: { ...JSON_HEADERS, "www-authenticate": 'Bearer realm="toad", error="invalid_token"' },
		};
	}

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
	if (!grants.includes("client_credentials") || grants.some((entry) => entry !== "client_credentials")) {
		return oauthError(
			400,
			OAuthErrorCode.InvalidClientMetadata,
			"This room issues client_credentials only; there is no redirect flow to register for.",
		);
	}
	const method = typeof input.token_endpoint_auth_method === "string" ? input.token_endpoint_auth_method : "client_secret_basic";
	if (method !== "client_secret_basic" && method !== "client_secret_post") {
		return oauthError(
			400,
			OAuthErrorCode.InvalidClientMetadata,
			"token_endpoint_auth_method must be client_secret_basic or client_secret_post.",
		);
	}
	const requested = typeof input.scope === "string" && input.scope.length > 0 ? input.scope.split(/\s+/) : [SEAT_SCOPE];
	if (requested.some((scope) => scope !== SEAT_SCOPE)) {
		return oauthError(400, OAuthErrorCode.InvalidScope, `This room understands one scope: ${SEAT_SCOPE}.`);
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

	const clientId = `${CLIENT_ID_PREFIX}${randomBytes(8).toString("hex")}`;
	const clientSecret = randomBytes(32).toString("hex");
	const software =
		typeof input.software_id === "string" && typeof input.software_version === "string"
			? { id: input.software_id.slice(0, 80), version: input.software_version.slice(0, 40) }
			: null;
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

	if (form.get("grant_type") !== "client_credentials") {
		return oauthError(
			400,
			OAuthErrorCode.UnsupportedGrantType,
			"This room issues client_credentials only.",
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

	const token = randomBytes(32).toString("base64url");
	accessTokens.set(token, {
		clientId: member.clientId,
		scope: SEAT_SCOPE,
		expiresAt: Date.now() + ACCESS_TTL_MS,
	});
	return {
		status: 200,
		headers: JSON_HEADERS,
		body: {
			access_token: token,
			token_type: "Bearer",
			expires_in: Math.floor(ACCESS_TTL_MS / 1_000),
			scope: SEAT_SCOPE,
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
			dropped += 1;
		}
	}
	return dropped;
}

/* ------------------------------------------------------------------ routing */

export type SeatRoute =
	| { kind: "metadata"; document: "resource" | "authorization-server" }
	| { kind: "register" }
	| { kind: "token" }
	/** The advertised redirect flow, which exists to say there is none. */
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
