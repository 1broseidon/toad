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
let origin: string | null = ORIGIN;

mock.module("../web/server", () => ({
	secureOrigin: () => origin,
	// `web/tls.ts` reaches back for this; the mock has to keep it whole.
	lanAddress: () => "192.0.2.10",
}));

const {
	SEAT_SCOPE,
	cancelClientEnrollment,
	createClientEnrollment,
	currentClientEnrollment,
	handleAuthorizeRefusal,
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
});

function registration(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { client_name: "Claude Code @ beastie", grant_types: ["client_credentials"], ...overrides };
}

function enroll(name = "Claude Code @ beastie"): { clientId: string; secret: string } {
	const { code } = createClientEnrollment();
	const answer = handleClientRegistration(`Bearer ${code}`, registration({ client_name: name }), [
		localNodeId(),
	]);
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
	const answer = handleClientToken(`Basic ${basic}`, form);
	return { status: answer.status, body: answer.body as Record<string, unknown> };
}

test("registration needs a live enrollment code, and spends it once", () => {
	const anonymous = handleClientRegistration(null, registration(), [localNodeId()]);
	expect(anonymous.status).toBe(401);

	const { code } = createClientEnrollment();
	const wrong = handleClientRegistration("Bearer 00000000", registration(), [localNodeId()]);
	expect(wrong.status).toBe(401);

	const first = handleClientRegistration(`Bearer ${code}`, registration(), [localNodeId()]);
	expect(first.status).toBe(201);
	admitted.push((first.body as { client_id: string }).client_id);

	// One use: the same code cannot buy a second seat.
	const second = handleClientRegistration(`Bearer ${code}`, registration(), [localNodeId()]);
	expect(second.status).toBe(401);
	expect(currentClientEnrollment()).toBeNull();
});

test("five wrong guesses burn the code the operator is still holding up", () => {
	const { code } = createClientEnrollment();
	for (let attempt = 0; attempt < 5; attempt += 1) {
		expect(handleClientRegistration("Bearer deadbeef", registration(), [localNodeId()]).status).toBe(401);
	}
	expect(currentClientEnrollment()).toBeNull();
	expect(handleClientRegistration(`Bearer ${code}`, registration(), [localNodeId()]).status).toBe(401);
});

test("a bad registration body does not spend the code", () => {
	const { code } = createClientEnrollment();
	const nameless = handleClientRegistration(`Bearer ${code}`, registration({ client_name: "" }), [
		localNodeId(),
	]);
	expect(nameless.status).toBe(400);
	expect(currentClientEnrollment()?.code).toBe(code);

	const redirectFlow = handleClientRegistration(
		`Bearer ${code}`,
		registration({ grant_types: ["authorization_code"] }),
		[localNodeId()],
	);
	expect(redirectFlow.status).toBe(400);
	expect(currentClientEnrollment()?.code).toBe(code);
});

test("the registration answer carries the seat, never a stored secret", () => {
	const { code } = createClientEnrollment();
	const answer = handleClientRegistration(`Bearer ${code}`, registration(), [localNodeId()]);
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
	const wrongGrant = handleClientToken(null, new URLSearchParams({ grant_type: "authorization_code" }));
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

test("no TLS door means no authorization server at all", () => {
	origin = null;
	expect(protectedResourceMetadata()).toBeNull();
	expect(authorizationServerMetadata()).toBeNull();
	expect(handleClientRegistration("Bearer abcd1234", registration(), [localNodeId()]).status).toBe(503);
	expect(handleClientToken(null, new URLSearchParams({ grant_type: "client_credentials" })).status).toBe(503);
});

test("the published metadata is the document a client can actually act on", () => {
	const resource = protectedResourceMetadata() as Record<string, unknown>;
	expect(resource.resource).toBe(`${ORIGIN}/mcp`);
	expect(resource.authorization_servers).toEqual([ORIGIN]);

	const server = authorizationServerMetadata() as Record<string, unknown>;
	expect(server.issuer).toBe(ORIGIN);
	expect(server.registration_endpoint).toBe(`${ORIGIN}/mcp/register`);
	expect(server.grant_types_supported).toEqual(["client_credentials"]);
	expect(server.response_types_supported).toEqual([]);
	/* There is no redirect flow, and RFC 8414 §2 lets a server say so by
	 * omission — but every MCP client's metadata schema requires the field
	 * unconditionally, so omitting it reads as a malformed document rather
	 * than as "no browser flow". The endpoint is real and refuses in words. */
	expect(server.authorization_endpoint).toBe(`${ORIGIN}/mcp/authorize`);
	const refused = handleAuthorizeRefusal();
	expect(refused.status).toBe(400);
	expect((refused.body as { error: string }).error).toBe("unsupported_response_type");
	expect((refused.body as { error_description: string }).error_description).toContain(
		"enrollment code",
	);

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
