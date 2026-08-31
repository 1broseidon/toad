import { afterEach, expect, mock, test } from "bun:test";

/**
 * The client seat's protocol half, against the real record store.
 *
 * `web/server.ts` is mocked down to `secureOrigin` alone: the module starts a
 * listener and drags the whole wire in with it, and none of that is what these
 * assertions are about. Everything below the origin — the member record, the
 * grant, the tombstone — is the real thing, because that is the part a wrong
 * answer would actually cost something.
 */

const ORIGIN = "https://192.0.2.10:4443";
/* The other door, which a client on this machine reaches with no certificate
   at all. It is the same protocol answered from a different address, so the
   assertions below run the whole ceremony over both. */
const LOOPBACK = "http://127.0.0.1:4682";
let origin: string | null = ORIGIN;
let loopback: string | null = LOOPBACK;

mock.module("../web/server", () => ({
	secureOrigin: () => origin,
	loopbackOrigin: () => loopback,
	// `web/tls.ts` reaches back for this; the mock has to keep it whole.
	lanAddress: () => "192.0.2.10",
}));

const {
	SEAT_SCOPE,
	cancelClientEnrollment,
	createClientEnrollment,
	currentClientEnrollment,
	handleAuthorizePage,
	handleAuthorizeSubmit,
	handleClientRegistration,
	handleClientToken,
	listClientSeats,
	protectedResourceMetadata,
	authorizationServerMetadata,
	seatRouteFor,
	sweepRevokedClients,
	verifyAccessToken,
} = await import("./seat");
const { revokeMember, setMemberGrant, clientMember } = await import("../node/members");
const { localNodeId } = await import("../store/records");

const admitted: string[] = [];

afterEach(() => {
	cancelClientEnrollment();
	while (admitted.length > 0) {
		const id = admitted.pop() as string;
		try {
			revokeMember(id);
		} catch {}
	}
	origin = ORIGIN;
	loopback = LOOPBACK;
});

function registration(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { client_name: "Claude Code @ beastie", grant_types: ["client_credentials"], ...overrides };
}

function enroll(name = "Claude Code @ beastie"): { clientId: string; secret: string } {
	const { code } = createClientEnrollment();
	const answer = handleClientRegistration(
		`Bearer ${code}`,
		registration({ client_name: name }),
		[localNodeId()],
		ORIGIN,
	);
	expect(answer.status).toBe(201);
	const body = answer.body as { client_id: string; client_secret: string };
	admitted.push(body.client_id);
	return { clientId: body.client_id, secret: body.client_secret };
}

function tokenFor(client: { clientId: string; secret: string }, form = new URLSearchParams()): {
	status: number;
	body: Record<string, unknown>;
} {
	form.set("grant_type", "client_credentials");
	const basic = Buffer.from(
		`${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.secret)}`,
	).toString("base64");
	const answer = handleClientToken(`Basic ${basic}`, form, ORIGIN);
	return { status: answer.status, body: answer.body as Record<string, unknown> };
}

test("registration needs a live enrollment code, and spends it once", () => {
	const anonymous = handleClientRegistration(null, registration(), [localNodeId()], ORIGIN);
	expect(anonymous.status).toBe(401);

	const { code } = createClientEnrollment();
	const wrong = handleClientRegistration("Bearer 00000000", registration(), [localNodeId()], ORIGIN);
	expect(wrong.status).toBe(401);

	const first = handleClientRegistration(`Bearer ${code}`, registration(), [localNodeId()], ORIGIN);
	expect(first.status).toBe(201);
	admitted.push((first.body as { client_id: string }).client_id);

	// One use: the same code cannot buy a second seat.
	const second = handleClientRegistration(`Bearer ${code}`, registration(), [localNodeId()], ORIGIN);
	expect(second.status).toBe(401);
	expect(currentClientEnrollment()).toBeNull();
});

test("five wrong guesses burn the code the operator is still holding up", () => {
	const { code } = createClientEnrollment();
	for (let attempt = 0; attempt < 5; attempt += 1) {
		expect(handleClientRegistration("Bearer deadbeef", registration(), [localNodeId()], ORIGIN).status).toBe(401);
	}
	expect(currentClientEnrollment()).toBeNull();
	expect(handleClientRegistration(`Bearer ${code}`, registration(), [localNodeId()], ORIGIN).status).toBe(401);
});

test("a bad registration body does not spend the code", () => {
	const { code } = createClientEnrollment();
	const nameless = handleClientRegistration(
		`Bearer ${code}`,
		registration({ client_name: "" }),
		[localNodeId()],
		ORIGIN,
	);
	expect(nameless.status).toBe(400);
	expect(currentClientEnrollment()?.code).toBe(code);

	const redirectFlow = handleClientRegistration(
		`Bearer ${code}`,
		registration({ grant_types: ["authorization_code"] }),
		[localNodeId()],
		ORIGIN,
	);
	expect(redirectFlow.status).toBe(400);
	expect(currentClientEnrollment()?.code).toBe(code);
});

test("the registration answer carries the seat, never a stored secret", () => {
	const { code } = createClientEnrollment();
	const answer = handleClientRegistration(`Bearer ${code}`, registration(), [localNodeId()], ORIGIN);
	const body = answer.body as Record<string, unknown>;
	admitted.push(body.client_id as string);

	expect(String(body.client_id)).toStartWith("mcp_");
	expect(String(body.client_secret)).toHaveLength(64);
	expect(body.client_secret_expires_at).toBe(0);
	expect(body.scope).toBe(SEAT_SCOPE);
	expect((body.toad as { grant: string[] }).grant).toEqual([localNodeId()]);

	const member = clientMember(body.client_id as string);
	expect(member?.name).toBe("Claude Code @ beastie");
	expect(member?.secretHash).not.toBe(body.client_secret);
	expect(JSON.stringify(listClientSeats())).not.toContain(String(body.client_secret));
});

test("client credentials buy a scoped token; a wrong secret buys nothing", () => {
	const client = enroll();
	const granted = tokenFor(client);
	expect(granted.status).toBe(200);
	expect(granted.body.token_type).toBe("Bearer");
	expect(granted.body.scope).toBe(SEAT_SCOPE);

	const forged = tokenFor({ clientId: client.clientId, secret: "0".repeat(64) });
	expect(forged.status).toBe(401);
	expect(forged.body.error).toBe("invalid_client");

	// A guessed client id is refused in exactly the same words as a wrong secret.
	const unknown = tokenFor({ clientId: "mcp_ffffffffffffffff", secret: client.secret });
	expect(unknown.body.error_description).toBe(forged.body.error_description);
});

test("only client_credentials, one scope, and the room's own resource", () => {
	const client = enroll();
	const wrongGrant = handleClientToken(
		null,
		new URLSearchParams({ grant_type: "authorization_code" }),
		ORIGIN,
	);
	expect(wrongGrant.status).toBe(400);

	expect(tokenFor(client, new URLSearchParams({ scope: "admin" })).status).toBe(400);
	expect(tokenFor(client, new URLSearchParams({ resource: "https://elsewhere.test/mcp" })).status).toBe(400);
	expect(tokenFor(client, new URLSearchParams({ resource: `${ORIGIN}/mcp` })).status).toBe(200);
});

test("a verified token names the member, so a message can be attributed to it", async () => {
	const client = enroll("Codex @ mac-mini");
	const token = tokenFor(client).body.access_token as string;
	const auth = await verifyAccessToken(token);
	expect(auth.clientId).toBe(client.clientId);
	expect(auth.scopes).toEqual([SEAT_SCOPE]);
	expect(auth.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1_000));
	expect(auth.extra?.memberName).toBe("Codex @ mac-mini");
	expect(auth.extra?.deskNodeId).toBe(localNodeId());

	await expect(verifyAccessToken("not-a-token")).rejects.toThrow();
});

test("revocation kills the seat's live tokens, not just its next one", async () => {
	const client = enroll();
	const token = tokenFor(client).body.access_token as string;
	expect(await verifyAccessToken(token)).toBeTruthy();

	revokeMember(client.clientId);
	admitted.pop();
	expect(sweepRevokedClients()).toBeGreaterThan(0);
	await expect(verifyAccessToken(token)).rejects.toThrow();
	expect(tokenFor(client).status).toBe(401);
	expect(listClientSeats().some((seat) => seat.clientId === client.clientId)).toBe(false);
});

test("narrowing the grant off this desk closes it, exactly as it does for a phone", async () => {
	const client = enroll();
	const token = tokenFor(client).body.access_token as string;

	setMemberGrant(client.clientId, ["some-other-desk"]);
	sweepRevokedClients();
	await expect(verifyAccessToken(token)).rejects.toThrow();
	expect(tokenFor(client).status).toBe(401);

	// The seat is still a member of the room — it just cannot reach this desk.
	expect(listClientSeats().some((seat) => seat.clientId === client.clientId)).toBe(true);
});

/**
 * The property the loopback door lives or dies on.
 *
 * Every URL in a discovery document is built from the door that served it, so
 * a client which reached 127.0.0.1 is never handed an https address it would
 * then have to verify a certificate for. That bounce is the whole failure the
 * loopback door removes, and it would come back silently — the document would
 * still parse — so it is asserted rather than read.
 */
test("each door names itself, and never the other one", () => {
	for (const door of [ORIGIN, LOOPBACK]) {
		const resource = protectedResourceMetadata(door);
		expect(resource.resource).toBe(`${door}/mcp`);
		expect(resource.authorization_servers).toEqual([door]);

		const server = authorizationServerMetadata(door);
		expect(server.issuer).toBe(door);
		expect(server.authorization_endpoint).toBe(`${door}/mcp/authorize`);
		expect(server.token_endpoint).toBe(`${door}/mcp/token`);
		expect(server.registration_endpoint).toBe(`${door}/mcp/register`);
		expect(JSON.stringify(server) + JSON.stringify(resource)).not.toContain(
			door === ORIGIN ? LOOPBACK : ORIGIN,
		);
	}
});

/** A seat is one member however it came in, and the loopback door is a door. */
test("an agent enrolls over loopback with no certificate anywhere in it", () => {
	const { code } = createClientEnrollment();
	const answer = handleClientRegistration(
		`Bearer ${code}`,
		registration({ client_name: "Claude Code @ this box" }),
		[localNodeId()],
		LOOPBACK,
	);
	expect(answer.status).toBe(201);
	const body = answer.body as { client_id: string; client_secret: string; toad: { mcp_url: string } };
	admitted.push(body.client_id);
	expect(body.toad.mcp_url).toBe(`${LOOPBACK}/mcp`);

	const basic = Buffer.from(
		`${encodeURIComponent(body.client_id)}:${encodeURIComponent(body.client_secret)}`,
	).toString("base64");
	/* The audience the loopback client learned is the audience its token
	   request names, and this desk honours it — while the https door's
	   resource, which this client never saw, is refused. */
	const granted = handleClientToken(
		`Basic ${basic}`,
		new URLSearchParams({ grant_type: "client_credentials", resource: `${LOOPBACK}/mcp` }),
		LOOPBACK,
	);
	expect(granted.status).toBe(200);
	const crossed = handleClientToken(
		`Basic ${basic}`,
		new URLSearchParams({ grant_type: "client_credentials", resource: `${ORIGIN}/mcp` }),
		LOOPBACK,
	);
	expect(crossed.status).toBe(400);
});

test("the enrollment panel is handed both doors, and each independently", () => {
	const both = createClientEnrollment();
	expect(both.mcpUrl).toBe(`${ORIGIN}/mcp`);
	expect(both.loopbackUrl).toBe(`${LOOPBACK}/mcp`);
	expect(both.loopbackRegistrationEndpoint).toBe(`${LOOPBACK}/mcp/register`);

	/* A desk with no certificate still admits an agent running beside it —
	   which is the case a room without openssl lands in. */
	origin = null;
	const localOnly = createClientEnrollment();
	expect(localOnly.mcpUrl).toBeNull();
	expect(localOnly.registrationEndpoint).toBeNull();
	expect(localOnly.loopbackUrl).toBe(`${LOOPBACK}/mcp`);

	// And a desk whose loopback port was taken says so by absence, not by lying.
	origin = ORIGIN;
	loopback = null;
	const remoteOnly = createClientEnrollment();
	expect(remoteOnly.loopbackUrl).toBeNull();
	expect(remoteOnly.mcpUrl).toBe(`${ORIGIN}/mcp`);
});

test("the published metadata is the document a client can actually act on", () => {
	const resource = protectedResourceMetadata(ORIGIN);
	expect(resource.resource).toBe(`${ORIGIN}/mcp`);
	expect(resource.authorization_servers).toEqual([ORIGIN]);

	const server = authorizationServerMetadata(ORIGIN);
	expect(server.issuer).toBe(ORIGIN);
	expect(server.registration_endpoint).toBe(`${ORIGIN}/mcp/register`);
	/* Both doors are advertised. A stock client reads this document, finds a
	 * code flow with PKCE, and takes the browser route; a headless one ignores
	 * it and registers with the code already in hand. Advertising only
	 * client_credentials is what made a stock connector fail at discovery. */
	expect(server.grant_types_supported).toEqual([
		"authorization_code",
		"refresh_token",
		"client_credentials",
	]);
	expect(server.response_types_supported).toEqual(["code"]);
	expect(server.code_challenge_methods_supported).toEqual(["S256"]);
	expect(server.authorization_endpoint).toBe(`${ORIGIN}/mcp/authorize`);

	expect(seatRouteFor("/.well-known/oauth-protected-resource/mcp")).toEqual({
		kind: "metadata",
		document: "resource",
	});
	expect(seatRouteFor("/mcp/token")).toEqual({ kind: "token" });
	expect(seatRouteFor("/mcp/authorize")).toEqual({ kind: "authorize" });
	/* The endpoint the whole document describes routes here too, so one lookup
	 * answers for every path the client seat owns. */
	expect(seatRouteFor("/mcp")).toEqual({ kind: "endpoint" });
	expect(seatRouteFor("/pair")).toBeNull();
});

test("the listing says whether this desk is holding a token for a seat", () => {
	const client = enroll();
	const seatOf = (id: string) => listClientSeats().find((row) => row.clientId === id);
	expect(seatOf(client.clientId)?.connected).toBe(false);
	tokenFor(client);
	expect(seatOf(client.clientId)?.connected).toBe(true);
});


/* ------------------------------------------------------- the browser door */

import { createHash, randomBytes } from "node:crypto";

const REDIRECT = "http://127.0.0.1:53100/callback";

function verifierPair(): { verifier: string; challenge: string } {
	const verifier = randomBytes(32).toString("base64url");
	return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

function registerPublic(): { clientId: string; secret: string } {
	const answer = handleClientRegistration(
		null,
		{
			client_name: "Claude Desktop",
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			redirect_uris: [REDIRECT],
			token_endpoint_auth_method: "none",
		},
		[localNodeId()],
	);
	expect(answer.status).toBe(201);
	const body = answer.body as { client_id: string; client_secret: string; toad: { pending: boolean; grant: string[] } };
	/* Registered and unapproved: an identity that can be spent nowhere until a
	 * human enters the code, which is the whole difference from the headless
	 * door where registration IS the admission. */
	expect(body.toad.pending).toBe(true);
	expect(body.toad.grant).toEqual([]);
	expect(clientMember(body.client_id)).toBeNull();
	return { clientId: body.client_id, secret: body.client_secret };
}

function query(clientId: string, challenge: string): URLSearchParams {
	return new URLSearchParams({
		client_id: clientId,
		redirect_uri: REDIRECT,
		response_type: "code",
		code_challenge: challenge,
		code_challenge_method: "S256",
		state: "xyz",
	});
}

test("a browser client registers unapproved, and the code on the page is the approval", () => {
	const { clientId } = registerPublic();
	const { verifier, challenge } = verifierPair();

	const page = handleAuthorizePage(query(clientId, challenge), [localNodeId()], ORIGIN);
	expect(page.status).toBe(200);
	expect(String(page.body)).toContain("Claude Desktop");
	expect(String(page.body)).toContain("Enrollment code");

	// A wrong code is the page again, not a redirect: nothing was approved.
	const wrong = handleAuthorizeSubmit(
		new URLSearchParams({ ...Object.fromEntries(query(clientId, challenge)), code: "00000000" }),
		[localNodeId()],
	);
	expect(wrong.status).toBe(401);
	expect(clientMember(clientId)).toBeNull();

	const { code } = createClientEnrollment();
	const approved = handleAuthorizeSubmit(
		new URLSearchParams({ ...Object.fromEntries(query(clientId, challenge)), code }),
		[localNodeId()],
	);
	expect(approved.status).toBe(302);
	admitted.push(clientId);
	const location = new URL(approved.headers?.location as string);
	expect(location.origin + location.pathname).toBe(REDIRECT);
	expect(location.searchParams.get("state")).toBe("xyz");
	const authorizationCode = location.searchParams.get("code") as string;
	expect(clientMember(clientId)?.name).toBe("Claude Desktop");

	// PKCE is what proves the client, since a public client has no secret.
	const wrongVerifier = handleClientToken(
		null,
		new URLSearchParams({
			grant_type: "authorization_code",
			code: authorizationCode,
			redirect_uri: REDIRECT,
			code_verifier: randomBytes(32).toString("base64url"),
		}),
		ORIGIN,
	);
	expect(wrongVerifier.status).toBe(400);

	// ...and that spent code is gone whatever happened next.
	const replay = handleClientToken(
		null,
		new URLSearchParams({
			grant_type: "authorization_code",
			code: authorizationCode,
			redirect_uri: REDIRECT,
			code_verifier: verifier,
		}),
		ORIGIN,
	);
	expect(replay.status).toBe(400);
});

test("the code buys a token and a refresh token, and refreshing rotates it", () => {
	const { clientId } = registerPublic();
	const { verifier, challenge } = verifierPair();
	const { code } = createClientEnrollment();
	const approved = handleAuthorizeSubmit(
		new URLSearchParams({ ...Object.fromEntries(query(clientId, challenge)), code }),
		[localNodeId()],
	);
	admitted.push(clientId);
	const authorizationCode = new URL(approved.headers?.location as string).searchParams.get("code") as string;

	const first = handleClientToken(
		null,
		new URLSearchParams({
			grant_type: "authorization_code",
			code: authorizationCode,
			redirect_uri: REDIRECT,
			code_verifier: verifier,
		}),
		ORIGIN,
	);
	expect(first.status).toBe(200);
	const issued = first.body as { access_token: string; refresh_token: string; expires_in: number };
	expect(issued.refresh_token).toBeTruthy();

	const refreshed = handleClientToken(
		null,
		new URLSearchParams({ grant_type: "refresh_token", refresh_token: issued.refresh_token }),
		ORIGIN,
	);
	expect(refreshed.status).toBe(200);
	const again = refreshed.body as { access_token: string; refresh_token: string };
	expect(again.access_token).not.toBe(issued.access_token);

	/* Spent once and replaced: a refresh token that outlived its use is one a
	 * thief could keep spending. */
	const reused = handleClientToken(
		null,
		new URLSearchParams({ grant_type: "refresh_token", refresh_token: issued.refresh_token }),
		ORIGIN,
	);
	expect(reused.status).toBe(400);

	// Revoking the seat kills the long-lived half too.
	revokeMember(clientId);
	sweepRevokedClients();
	const afterRevoke = handleClientToken(
		null,
		new URLSearchParams({ grant_type: "refresh_token", refresh_token: again.refresh_token }),
		ORIGIN,
	);
	expect(afterRevoke.status).toBe(400);
});

test("the page refuses a redirect the client never registered", () => {
	const { clientId } = registerPublic();
	const { challenge } = verifierPair();
	const stolen = query(clientId, challenge);
	stolen.set("redirect_uri", "http://127.0.0.1:9/evil");
	const answer = handleAuthorizePage(stolen, [localNodeId()]);
	expect(answer.status).toBe(400);
	expect(String(answer.body)).toContain("redirect_uri");
});
