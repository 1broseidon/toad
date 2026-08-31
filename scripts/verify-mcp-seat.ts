/**
 * Two isolated desktops and one outside MCP agent, proving the client seat:
 *
 * - the agent enrolls through desk A by RFC 7591 dynamic client registration,
 *   gated by the one-time code an operator reads off A's screen — no code, no
 *   registration, no second registration on a spent code, and none on a code
 *   whose ten minutes ran out
 * - the registration writes a *member* record, which replicates to desk B
 *   first-hand, exactly as a phone's membership does
 * - the seat walks between desks: B mints the agent an access token without
 *   ever having shown it a code, because the digest of the client secret
 *   replicated and B is in the grant
 * - the discovery documents A publishes are the ones a client acts on, and
 *   the whole surface is HTTPS-only — the plain door refuses it
 * - an off-the-shelf MCP client — the SDK's own client-credentials provider
 *   over streamable HTTP — connects to /mcp with what registration handed it,
 *   and is offered exactly the four social tools
 * - what it sees is its grant: the desks it was given and the teammates on
 *   them, and nothing else. A desk outside the grant is not offline to this
 *   agent, it is not in the room — invisible to list_desks, absent from
 *   list_teammates, and unaddressable by name
 * - what it says is attributed to it, in the teammate's own tape. A real ACP
 *   teammate answers, and the `peer` event stored beside its conversation
 *   names "Claude Code @ desk-a" and marks the caller a client seat — on the
 *   desk it enrolled at and, over the NodeLink, on the other one
 * - a teammate on a desk whose link is down is refused in words naming that
 *   desk, rather than by waiting for a timeout
 * - narrowing the grant on the owner closes B; revoking on the owner stops a
 *   connected agent mid-session, on the very next tool call, and every desk
 *   learns it
 *
 * THE TEAMMATE IS REAL AND ITS MODEL IS NOT. Each desk gets a stub ACP agent
 * on its PATH under the name the `cursor` backend looks for, so a delivery
 * runs the whole road — `PeerSessions.deliver`, a spawned child, a real
 * `session/prompt`, a real reply, a real transcript append. What the stub does
 * not do is think: it answers with the prompt it was handed, which is how this
 * harness can assert what the room actually *told* the teammate about who was
 * speaking. Nothing here is mocked on Toad's side of the process boundary.
 *
 *   bun scripts/verify-mcp-seat.ts
 */
import {
	Client,
	ClientCredentialsProvider,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

type JsonRecord = Record<string, unknown>;

/** What each desk child is told an enrollment code is worth, in milliseconds. */
const ENROLLMENT_TTL_MS = 5_000;

const CHILD = process.env.TOAD_SEAT_CHILD;

/* The stub agent is dispatched on argv rather than the environment, because a
 * teammate is spawned by a desk child and inherits everything that desk has. */
if (process.argv.includes("--acp-stub")) {
	await runAcpStub();
} else if (CHILD) {
	await runChild(CHILD);
} else {
	await runParent();
}

/* -------------------------------------------------------------- the teammate */

/**
 * An ACP agent that answers with what it was told.
 *
 * The smallest thing on the far side of a real `session/prompt` that still
 * exercises every layer between a client seat and a teammate's tape. It echoes
 * the whole prompt — briefing block and fenced message both — so a check can
 * read the sentence Toad composed about the caller rather than infer it.
 */
async function runAcpStub(): Promise<void> {
	const acp = await import("@agentclientprotocol/sdk");
	await acp
		.agent({ name: "toad-verify-stub" })
		.onRequest("initialize", () => ({
			protocolVersion: acp.PROTOCOL_VERSION,
			agentInfo: { name: "verify stub", version: "1" },
			agentCapabilities: { loadSession: false },
		}))
		.onRequest("session/new", () => ({ sessionId: randomUUID() }))
		.onRequest("session/prompt", async (ctx) => {
			const params = ctx.params as {
				sessionId: string;
				prompt: Array<{ type: string; text?: string }>;
			};
			const heard = params.prompt
				.filter((block) => block.type === "text")
				.map((block) => block.text ?? "")
				.join("\n");
			await ctx.client.notify("session/update", {
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: `heard: ${heard}` },
				},
			});
			return { stopReason: "end_turn" };
		})
		.connect(
			acp.ndJsonStream(
				Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
				/* Through `unknown`: node's `toWeb` is typed `ReadableStream<any>`,
				   whose reader overloads do not line up with the byte stream ACP
				   wants, and the two are the same object at runtime. */
				Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
			),
		);
}

/* ------------------------------------------------------------------ child */

async function runChild(label: string): Promise<void> {
	const nodePort = Number(process.env.TOAD_NODE_PORT);
	const webPort = Number(process.env.TOAD_WEB_PORT);
	const controlPort = Number(process.env.TOAD_NODE_CONTROL_PORT);
	if (!nodePort || !webPort || !controlPort) throw new Error("ports are required");

	const fleet = await import("../src/bun/fleet/fleet");
	const wire = await import("../src/bun/fleet/wire");
	const admission = await import("../src/bun/node/admission");
	const identity = await import("../src/bun/node/identity");
	const members = await import("../src/bun/node/members");
	const nodeServer = await import("../src/bun/node/server");
	const personas = await import("../src/bun/store/personas");
	const records = await import("../src/bun/store/records");
	const seat = await import("../src/bun/mcp/seat");
	const seatTools = await import("../src/bun/mcp/seat-tools");
	const peersModule = await import("../src/bun/acp/peers");
	const supervisorModule = await import("../src/bun/acp/supervisor");
	const transcript = await import("../src/bun/store/transcript");
	const web = await import("../src/bun/web/server");

	const handlers: Record<string, (params: unknown) => Promise<unknown>> = {
		ping: async () => true,
	};
	const resolve = (method: string) => handlers[method];

	/**
	 * The real thing, on both ends.
	 *
	 * `PeerSessions` spawns the teammate's backend, runs the turn and writes the
	 * marker; the backend is the stub agent this file installs on the child's
	 * PATH. So a check downstream can read the `peer` event out of the tape it
	 * was actually appended to, rather than a note this harness took on the way
	 * past. `Supervisor` is here for the same reason: `list_teammates` reports
	 * what it says about a teammate's state.
	 */
	const noop = () => {};
	const supervisor = new supervisorModule.Supervisor({
		transcriptAppended: noop,
		transcriptUpdated: noop,
		streamDelta: noop,
		sessionInfoChanged: noop,
	});
	const peerSessions = new peersModule.PeerSessions({
		peerThreadAppended: noop,
		peerThreadUpdated: noop,
		peerActivityChanged: noop,
		transcriptAppended: noop,
		transcriptUpdated: noop,
	});

	/**
	 * Every delivery this desk accepted, as it arrived — the caller id, and the
	 * outside identity the room synthesized for it.
	 *
	 * Kept beside the real delivery rather than instead of it: the tape proves
	 * what the teammate was told, and this proves what the *wire* handed over,
	 * which is the half that has to survive a NodeLink hop.
	 */
	const delivered: Array<Record<string, unknown>> = [];
	const deliverHere = async (input: {
		callerId: string;
		targetId: string;
		message: string;
		chain?: { id: string; depth: number; path: string[] };
		outside?: { name: string; node: string; seat?: "client" };
	}) => {
		delivered.push({
			callerId: input.callerId,
			targetId: input.targetId,
			message: input.message,
			outside: input.outside ?? null,
		});
		return peerSessions.deliver({
			callerId: input.callerId,
			targetId: input.targetId,
			message: input.message,
			chain: input.chain ?? { id: randomUUID(), depth: 1, path: [] },
			...(input.outside ? { outside: input.outside } : {}),
		});
	};

	fleet.initFleet({
		createTeammate: (draft) => ({ personaId: `${label}-created`, name: draft.name }),
		readTranscript: (personaId, limit) => {
			const persona = personas.getPersona(personaId);
			if (!persona) return null;
			const recent = transcript.recentMessages(personaId, limit);
			return {
				personaId,
				name: persona.name,
				messages: recent.messages.map((event) => ({
					from: event.kind === "user" ? ("user" as const) : ("teammate" as const),
					text: event.text,
					at: event.ts,
				})),
				truncated: recent.truncated,
			};
		},
		readThread: () => null,
		/* No peer thread is read here, so nothing moves. Supplied because
		   `Deps` requires it: a harness that does not compile is a harness
		   that has stopped tracking the contract it is proving. */
		threadRead: () => 0,
		/* The same mapping `index.ts` makes, through the same function, so what
		 * this desk records is what a real desk would have been handed. */
		deliver: async ({ fromNode, fromPersona, targetPersonaId, message, fromSeat }) =>
			deliverHere({
				...peersModule.inboundFleetCaller({ fromNode, fromPersona, fromSeat }),
				targetId: targetPersonaId,
				message,
			}),
		httpOrigin: () => web.httpOrigin(),
		nodeOrigin: nodeServer.nodeOrigin,
	});
	seatTools.initSeatTools({
		supervisor,
		peers: { deliver: deliverHere },
	});
	wire.initPeerWires({
		send: (name, payload) => web.webBroadcast(name, payload),
		publishPersonas: () => {},
		resolve,
	});
	nodeServer.startNodeServer(resolve, nodePort, wire.nodeLinkServerHooks);
	web.startWebMode(resolve, webPort);

	const control = Bun.serve({
		hostname: "127.0.0.1",
		port: controlPort,
		async fetch(request) {
			const input = (await request.json()) as { action?: string; [key: string]: unknown };
			try {
				switch (input.action) {
					case "ready":
						return Response.json({
							ok: true,
							result: {
								identity: identity.nodeIdentity(),
								origin: nodeServer.nodeOrigin(),
								webOrigin: `http://127.0.0.1:${webPort}`,
								secureOrigin: web.secureOrigin(),
							},
						});
					case "invite":
						return Response.json({ ok: true, result: admission.createNodeInvite() });
					case "join": {
						const result = await admission.joinNodeInvite(String(input.origin), String(input.code));
						if (result.ok) await wire.syncPeerWires();
						return Response.json({ ok: true, result });
					}
					case "links":
						return Response.json({ ok: true, result: wire.nodeLinkSnapshot() });
					case "enrollment":
						return Response.json({ ok: true, result: seat.createClientEnrollment() });
					case "pendingEnrollment":
						return Response.json({ ok: true, result: seat.currentClientEnrollment() });
					case "seats":
						return Response.json({ ok: true, result: seat.listClientSeats() });
					case "addTeammate": {
						const persona = personas.createPersona({
							name: String(input.name),
							backendId: "cursor",
							goal: String(input.goal ?? ""),
						});
						transcript.append(persona.id, {
							kind: "user",
							id: `seed:${persona.id}`,
							ts: Date.now(),
							text: String(input.said ?? "hello"),
						});
						return Response.json({
							ok: true,
							result: { personaId: persona.id, name: persona.name },
						});
					}
					case "delivered":
						return Response.json({ ok: true, result: delivered });
					/* The stored tape, as it is on disk — the thing a reader of
					 * that teammate's conversation will actually be shown. */
					case "tape":
						return Response.json({
							ok: true,
							result: transcript.load(String(input.personaId)),
						});
					case "memberRecords":
						return Response.json({
							ok: true,
							result: records.listRecords("member", { includeTombstones: true }),
						});
					case "setGrant": {
						const saved = members.setMemberGrant(
							String(input.clientId),
							(input.grant as string[]) ?? [],
						);
						seat.sweepRevokedClients();
						return Response.json({ ok: true, result: Boolean(saved) });
					}
					case "revoke": {
						let revoked = false;
						let error: string | undefined;
						try {
							revoked = members.revokeMember(String(input.clientId));
						} catch (failure) {
							error = failure instanceof Error ? failure.message : "refused";
						}
						seat.sweepRevokedClients();
						return Response.json({ ok: true, result: { revoked, error } });
					}
					case "stop":
						queueMicrotask(() => {
							web.stopWebMode();
							control.stop(true);
							globalThis.process.exit(0);
						});
						return Response.json({ ok: true, result: true });
					default:
						return Response.json({ ok: false, error: `unknown action ${input.action}` }, { status: 400 });
				}
			} catch (error) {
				return Response.json(
					{ ok: false, error: error instanceof Error ? error.message : String(error) },
					{ status: 500 },
				);
			}
		},
	});
}

/* ----------------------------------------------------------------- parent */

type Child = {
	label: string;
	process: ReturnType<typeof Bun.spawn>;
	command<T>(input: JsonRecord): Promise<T>;
};
type Ready = {
	identity: { id: string; name: string };
	origin: string;
	webOrigin: string;
	secureOrigin: string | null;
};
type Enrollment = { code: string; mcpUrl: string | null; registrationEndpoint: string | null };
type SeatRow = { clientId: string; name: string; grant: string[]; ownerNode: string };
type MemberRecord = { id: string; ownerNode: string; deleted: boolean };
type Teammate = { personaId: string; name: string };
type Delivery = {
	callerId: string;
	targetId: string;
	message: string;
	outside: { name: string; node: string; seat?: string } | null;
};
/** A transcript event as it is stored, read back rather than re-derived. */
type TapeEvent = {
	kind: string;
	ts: number;
	text?: string;
	withName?: string;
	withPersonaId?: string;
	role?: string;
	seat?: string;
};

/**
 * The room's certificate is self-signed by design, and a verify run is the one
 * place that knows it and may say so out loud. A function rather than a const
 * because the dispatch at the top of this file runs before any binding below
 * it is initialized.
 */
function insecure(): RequestInit {
	return { tls: { rejectUnauthorized: false } } as RequestInit;
}

async function register(
	endpoint: string,
	code: string | null,
	body: JsonRecord,
): Promise<{ status: number; body: JsonRecord }> {
	const response = await fetch(endpoint, {
		...insecure(),
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(code ? { authorization: `Bearer ${code}` } : {}),
		},
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(10_000),
	});
	return { status: response.status, body: (await response.json()) as JsonRecord };
}

async function token(
	origin: string,
	clientId: string,
	secret: string,
): Promise<{ status: number; body: JsonRecord }> {
	const basic = Buffer.from(
		`${encodeURIComponent(clientId)}:${encodeURIComponent(secret)}`,
	).toString("base64");
	const response = await fetch(`${origin}/mcp/token`, {
		...insecure(),
		method: "POST",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			authorization: `Basic ${basic}`,
		},
		body: new URLSearchParams({ grant_type: "client_credentials" }).toString(),
		signal: AbortSignal.timeout(10_000),
	});
	return { status: response.status, body: (await response.json()) as JsonRecord };
}

async function getJson(url: string): Promise<{ status: number; body: JsonRecord }> {
	const response = await fetch(url, { ...insecure(), signal: AbortSignal.timeout(10_000) });
	return { status: response.status, body: (await response.json()) as JsonRecord };
}

/** The browser door answers HTML, so the page itself is the assertion. */
async function getText(url: string): Promise<{ status: number; body: string }> {
	const response = await fetch(url, { ...insecure(), signal: AbortSignal.timeout(10_000) });
	return { status: response.status, body: await response.text() };
}

/**
 * A real MCP client, connected the way an operator's agent would be.
 *
 * Deliberately the SDK's own `ClientCredentialsProvider` over
 * `StreamableHTTPClientTransport` rather than hand-rolled JSON-RPC: the claim
 * this feature makes is that an off-the-shelf MCP client can join the room
 * with the credential registration handed back, and only the off-the-shelf
 * client can prove it. The custom `fetch` is the self-signed certificate,
 * which the transport also hands to its discovery and token calls.
 */
async function connectSeat(
	origin: string,
	clientId: string,
	clientSecret: string,
): Promise<Client> {
	const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
		authProvider: new ClientCredentialsProvider({
			clientId,
			clientSecret,
			scope: "toad.room",
			expectedIssuer: origin,
		}),
		fetch: ((url: string | URL, init?: RequestInit) =>
			fetch(url, { ...init, ...insecure() })) as never,
	});
	const client = new Client({ name: "verify-mcp-seat", version: "1" });
	await client.connect(transport);
	return client;
}

/** The text a tool result carries, parsed back out of its one content block. */
function toolJson(result: { content?: unknown }): JsonRecord {
	const blocks = (result.content ?? []) as Array<{ type: string; text?: string }>;
	const text = blocks.find((block) => block.type === "text")?.text ?? "";
	/* A quoted transcript arrives inside the same trust fence a teammate gets,
	 * so the payload is one JSON string inside the tag. */
	const fenced = /<toad_transcript_excerpt>([\s\S]*)<\/toad_transcript_excerpt>/.exec(text);
	return JSON.parse(fenced?.[1] ?? text) as JsonRecord;
}

async function runParent(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "toad-seat-"));
	const base = 54_000 + Math.floor(Math.random() * 500);
	const a = spawnChild("a", base, base + 20, base + 40, join(root, "a"));
	const b = spawnChild("b", base + 1, base + 21, base + 41, join(root, "b"));
	const live: Child[] = [a, b];

	try {
		const [readyA, readyB] = await Promise.all([
			eventually(() => a.command<Ready>({ action: "ready" }), "node A ready"),
			eventually(() => b.command<Ready>({ action: "ready" }), "node B ready"),
		]);
		if (!readyA.secureOrigin || !readyB.secureOrigin) {
			throw new Error(
				"no TLS door — the client seat needs one, and openssl is what generates the certificate",
			);
		}
		const secureA = readyA.secureOrigin;
		const secureB = readyB.secureOrigin;

		await step("desks pair and link", async () => {
			const invite = await a.command<{ origin?: string; code?: string; error?: string }>({
				action: "invite",
			});
			if (!invite.origin || !invite.code) throw new Error(`invite failed: ${invite.error}`);
			const joined = await b.command<{ ok: boolean; error?: string }>({
				action: "join",
				origin: invite.origin,
				code: invite.code,
			});
			if (!joined.ok) throw new Error(`join failed: ${joined.error}`);
			await eventually(async () => {
				const [linksA, linksB] = await Promise.all([
					a.command<Array<{ up: boolean }>>({ action: "links" }),
					b.command<Array<{ up: boolean }>>({ action: "links" }),
				]);
				if (!linksA[0]?.up || !linksB[0]?.up) throw new Error("NodeLink not up");
				return true;
			}, "linked");
		});

		await step("one room CA, and it is what a client installs for every desk", async () => {
			const caFile = (label: string) => join(root, label, "web-tls", "ca.pem");
			/* Both desks minted a root before either had heard of the other, so this
			 * room genuinely starts with two and has to converge. The rule is
			 * computed from replicated fields alone — oldest record wins — so no desk
			 * asks another which one to keep, and the loser's owner revokes its own
			 * only once it can open the winner's. */
			const ca = await eventually(async () => {
				const mine = readFileSync(caFile("a"), "utf8");
				if (mine !== readFileSync(caFile("b"), "utf8")) {
					throw new Error("the desks still hold different roots");
				}
				return mine;
			}, "the room converged on one CA");

			/* The claim the whole change rests on: an operator installs one file and
			 * every desk in the room verifies — including the desk that did not mint
			 * it, whose leaf was reissued underneath a live listener. A bare
			 * self-signed leaf could never have passed this for both desks at once. */
			for (const [label, origin] of [
				["A", secureA],
				["B", secureB],
			] as const) {
				const answer = await eventually(
					() =>
						fetch(`${origin}/.well-known/oauth-authorization-server`, {
							tls: { ca },
						} as RequestInit),
					`desk ${label} served a certificate the room's CA verifies`,
				);
				if (!answer.ok) throw new Error(`desk ${label} answered ${answer.status} over a verified door`);
				await answer.text();
			}
		});

		await step("the room publishes documents a client can act on", async () => {
			const resource = await getJson(`${secureA}/.well-known/oauth-protected-resource/mcp`);
			if (resource.body.resource !== `${secureA}/mcp`) {
				throw new Error(`protected resource metadata names ${String(resource.body.resource)}`);
			}
			const server = await getJson(`${secureA}/.well-known/oauth-authorization-server`);
			if (server.body.registration_endpoint !== `${secureA}/mcp/register`) {
				throw new Error("authorization server metadata does not name the registration endpoint");
			}
			/* Both doors are advertised, which is the point: a stock client reads
			 * this document, finds a code flow with PKCE, and takes the browser
			 * route; a headless one ignores it and registers with the code in
			 * hand. A server offering only client_credentials fails a stock
			 * client at discovery, before it ever reaches a certificate. */
			const authorize = String(server.body.authorization_endpoint ?? "");
			if (authorize !== `${secureA}/mcp/authorize`) {
				throw new Error(`metadata names ${authorize} as the authorization endpoint`);
			}
			const grants = (server.body.grant_types_supported ?? []) as string[];
			for (const wanted of ["authorization_code", "refresh_token", "client_credentials"]) {
				if (!grants.includes(wanted)) throw new Error(`metadata omits the ${wanted} grant`);
			}
			const challenges = (server.body.code_challenge_methods_supported ?? []) as string[];
			if (!challenges.includes("S256")) throw new Error("metadata does not require PKCE with S256");
			/* And the endpoint really serves a page, rather than parsing as one
			 * thing and answering as another. */
			const page = await getText(authorize);
			if (page.status !== 400 || !page.body.includes("not registered")) {
				throw new Error(`the authorization endpoint answered ${page.status} for an unknown client`);
			}
		});

		await step("a stock client walks in through the browser door", async () => {
			/* The claim: an agent that speaks ordinary remote MCP — a browser,
			 * a redirect, PKCE — joins without ever seeing the enrollment code
			 * as a bearer token. It registers unapproved, a human types the
			 * code on the page the room served, and that IS the approval. */
			const redirect = "http://127.0.0.1:53999/callback";
			const registered = await register(`${secureA}/mcp/register`, null, {
				client_name: "Stock MCP client",
				grant_types: ["authorization_code", "refresh_token"],
				response_types: ["code"],
				redirect_uris: [redirect],
				token_endpoint_auth_method: "none",
			});
			if (registered.status !== 201) {
				throw new Error(`public registration answered ${registered.status}`);
			}
			const clientId = String(registered.body.client_id);
			const extension = (registered.body.toad ?? {}) as JsonRecord;
			if (extension.pending !== true || (extension.grant as string[]).length !== 0) {
				throw new Error("a registration nobody approved came back holding a grant");
			}
			const seatsBefore = await a.command<Array<{ clientId: string }>>({ action: "seats" });
			if (seatsBefore.some((seat) => seat.clientId === clientId)) {
				throw new Error("an unapproved registration appeared in the room's roster");
			}

			const verifier = randomBytes(32).toString("base64url");
			const challenge = createHash("sha256").update(verifier).digest("base64url");
			const authorizeUrl = `${secureA}/mcp/authorize?${new URLSearchParams({
				client_id: clientId,
				redirect_uri: redirect,
				response_type: "code",
				code_challenge: challenge,
				code_challenge_method: "S256",
				state: "harness",
			})}`;
			const page = await getText(authorizeUrl);
			if (page.status !== 200 || !page.body.includes("Stock MCP client")) {
				throw new Error(`the consent page answered ${page.status}`);
			}
			if (!page.body.includes("Enrollment code")) {
				throw new Error("the consent page does not ask for the code");
			}

			const enrollment = await a.command<Enrollment>({ action: "enrollment" });
			/* Exactly the fields the page's own form posts — the approval is
			 * the same request as the page, with the code filled in. */
			const form = new URLSearchParams({
				client_id: clientId,
				redirect_uri: redirect,
				state: "harness",
				code_challenge: challenge,
				code_challenge_method: "S256",
				response_type: "code",
				code: enrollment.code,
			});
			const approved = await fetch(`${secureA}/mcp/authorize`, {
				...insecure(),
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: form.toString(),
				redirect: "manual",
				signal: AbortSignal.timeout(10_000),
			});
			if (approved.status !== 302) {
				throw new Error(`entering the code answered ${approved.status}, want a redirect`);
			}
			const location = new URL(approved.headers.get("location") ?? "");
			if (location.searchParams.get("state") !== "harness") {
				throw new Error("the redirect lost the client's state");
			}
			const authorizationCode = location.searchParams.get("code") ?? "";

			const tokenAnswer = await fetch(`${secureA}/mcp/token`, {
				...insecure(),
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					grant_type: "authorization_code",
					code: authorizationCode,
					redirect_uri: redirect,
					code_verifier: verifier,
					client_id: clientId,
				}).toString(),
				signal: AbortSignal.timeout(10_000),
			});
			const issued = (await tokenAnswer.json()) as JsonRecord;
			if (tokenAnswer.status !== 200 || !issued.access_token || !issued.refresh_token) {
				throw new Error(`the code did not buy a token: ${tokenAnswer.status}`);
			}

			/* And the token actually opens the room, which is the only proof
			 * that matters — discovery and redirects are means. */
			const listed = await fetch(`${secureA}/mcp`, {
				...insecure(),
				method: "POST",
				headers: {
					authorization: `Bearer ${String(issued.access_token)}`,
					"content-type": "application/json",
					accept: "application/json, text/event-stream",
				},
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
				signal: AbortSignal.timeout(15_000),
			});
			const listedBody = await listed.text();
			if (listed.status !== 200 || !listedBody.includes("message_teammate")) {
				throw new Error(`the browser-door token could not list tools: ${listed.status}`);
			}

			/* An hour from now this is the only thing standing between the
			 * agent and a human walking back to a desk. */
			const refreshed = await fetch(`${secureA}/mcp/token`, {
				...insecure(),
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					grant_type: "refresh_token",
					refresh_token: String(issued.refresh_token),
				}).toString(),
				signal: AbortSignal.timeout(10_000),
			});
			const again = (await refreshed.json()) as JsonRecord;
			if (refreshed.status !== 200 || !again.access_token) {
				throw new Error(`refreshing answered ${refreshed.status}`);
			}
			if (again.access_token === issued.access_token) {
				throw new Error("refreshing handed back the same access token");
			}

			/* This stage borrowed a real seat; the stages after it count seats,
			 * so it gives it back. */
			await a.command({ action: "revoke", clientId });
		});

		await step("the plain door carries none of it", async () => {
			const refused = await register(`${readyA.webOrigin}/mcp/register`, "00000000", {
				client_name: "over plain http",
			});
			if (refused.status !== 403) {
				throw new Error(`plain door answered ${refused.status}, want 403`);
			}
			const wellKnown = await getJson(`${readyA.webOrigin}/.well-known/oauth-authorization-server`);
			if (wellKnown.status !== 403) {
				throw new Error(`plain door published metadata with ${wellKnown.status}`);
			}
		});

		await step("registration without the desk's code is refused", async () => {
			const anonymous = await register(`${secureA}/mcp/register`, null, {
				client_name: "Uninvited",
				grant_types: ["client_credentials"],
			});
			if (anonymous.status !== 401) {
				throw new Error(`open registration answered ${anonymous.status}, want 401`);
			}
			const seats = await a.command<SeatRow[]>({ action: "seats" });
			if (seats.length !== 0) throw new Error("a refused registration still took a seat");
		});

		let clientId = "";
		let clientSecret = "";
		await step("the agent enrolls through A with the code off A's screen", async () => {
			const enrollment = await a.command<Enrollment>({ action: "enrollment" });
			if (!enrollment.registrationEndpoint) throw new Error("A minted no registration endpoint");
			const registered = await register(enrollment.registrationEndpoint, enrollment.code, {
				/* The agent's own name and nothing else: the room appends the desk
				 * it came in through, so a name that already carries one would
				 * arrive on a tape saying it twice. */
				client_name: "Claude Code",
				grant_types: ["client_credentials"],
				token_endpoint_auth_method: "client_secret_basic",
				software_id: "dev.toad.verify",
				software_version: "1",
			});
			if (registered.status !== 201) {
				throw new Error(`registration answered ${registered.status}: ${JSON.stringify(registered.body)}`);
			}
			clientId = String(registered.body.client_id);
			clientSecret = String(registered.body.client_secret);
			const extension = registered.body.toad as { grant: string[]; room: { name: string } };
			if (!extension.grant.includes(readyB.identity.id)) {
				throw new Error("the default grant does not name desk B, as a phone's would");
			}
			if (await a.command<Enrollment | null>({ action: "pendingEnrollment" })) {
				throw new Error("the code survived the registration it authorized");
			}
			const seats = await a.command<SeatRow[]>({ action: "seats" });
			if (seats.length !== 1 || seats[0]!.name !== "Claude Code") {
				throw new Error("A does not list exactly the agent it just admitted");
			}
			if (JSON.stringify(seats).includes(clientSecret)) {
				throw new Error("the seat listing carries the client secret");
			}
		});

		await step("the same code cannot buy a second seat", async () => {
			const enrollment = await a.command<Enrollment>({ action: "enrollment" });
			const first = await register(enrollment.registrationEndpoint as string, enrollment.code, {
				client_name: "First",
				grant_types: ["client_credentials"],
			});
			if (first.status !== 201) throw new Error("a fresh code was refused");
			const replay = await register(enrollment.registrationEndpoint as string, enrollment.code, {
				client_name: "Replay",
				grant_types: ["client_credentials"],
			});
			if (replay.status !== 401) throw new Error(`a spent code answered ${replay.status}`);
			await a.command({ action: "revoke", clientId: String(first.body.client_id) });
		});

		await step("a code the operator left on screen too long stops working", async () => {
			const enrollment = await a.command<Enrollment>({ action: "enrollment" });
			/* The desk children run on a five-second code (see spawnChild), so
			 * this waits out a real expiry rather than asserting the branch that
			 * would have. */
			await Bun.sleep(ENROLLMENT_TTL_MS + 500);
			if (await a.command<Enrollment | null>({ action: "pendingEnrollment" })) {
				throw new Error("the desk still shows a code the room will not honour");
			}
			const late = await register(enrollment.registrationEndpoint as string, enrollment.code, {
				client_name: "Too Late",
				grant_types: ["client_credentials"],
			});
			if (late.status !== 401) throw new Error(`an expired code answered ${late.status}`);
			const seats = await a.command<SeatRow[]>({ action: "seats" });
			if (seats.some((row) => row.name === "Too Late")) {
				throw new Error("an expired code still took a seat");
			}
		});

		await step("the seat replicates to B first-hand", async () => {
			await eventually(async () => {
				const rows = await b.command<MemberRecord[]>({ action: "memberRecords" });
				const mine = rows.find((row) => row.id === clientId);
				if (!mine || mine.deleted) throw new Error("B has no live record for the agent");
				if (mine.ownerNode !== readyA.identity.id) throw new Error("B did not learn A owns it");
				return true;
			}, "seat replicated to B");
		});

		await step("B mints a token without ever having shown a code", async () => {
			const granted = await eventually(async () => {
				const answer = await token(secureB, clientId, clientSecret);
				if (answer.status !== 200) throw new Error(`B answered ${answer.status}`);
				return answer;
			}, "B honours the replicated seat");
			if (granted.body.token_type !== "Bearer" || !granted.body.access_token) {
				throw new Error(`B's token answer is not a bearer grant: ${JSON.stringify(granted.body)}`);
			}
			const forged = await token(secureB, clientId, "0".repeat(64));
			if (forged.status !== 401) throw new Error("B accepted a wrong client secret");
		});

		let boris: Teammate = { personaId: "", name: "" };
		let ada: Teammate = { personaId: "", name: "" };
		await step("each desk has a teammate to talk to", async () => {
			boris = await a.command<Teammate>({
				action: "addTeammate",
				name: "Boris",
				goal: "the iOS build",
				said: "what is left on the iOS build?",
			});
			ada = await b.command<Teammate>({
				action: "addTeammate",
				name: "Ada",
				goal: "the Mac side",
				said: "signing is sorted",
			});
		});

		await step("the endpoint refuses anyone without a seat", async () => {
			const anonymous = await fetch(`${secureA}/mcp`, {
				...insecure(),
				method: "POST",
				headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
				signal: AbortSignal.timeout(10_000),
			});
			if (anonymous.status !== 401) throw new Error(`the endpoint answered ${anonymous.status}`);
			const challenge = anonymous.headers.get("www-authenticate") ?? "";
			if (!challenge.includes("resource_metadata")) {
				throw new Error(`the challenge does not say where to enroll: ${challenge}`);
			}
			const forged = await fetch(`${secureA}/mcp`, {
				...insecure(),
				method: "POST",
				headers: {
					"content-type": "application/json",
					accept: "application/json, text/event-stream",
					authorization: "Bearer not-a-real-token",
				},
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
				signal: AbortSignal.timeout(10_000),
			});
			if (forged.status !== 401) throw new Error(`a forged token answered ${forged.status}`);
			const plain = await fetch(`${readyA.webOrigin}/mcp`, {
				...insecure(),
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
				signal: AbortSignal.timeout(10_000),
			});
			if (plain.status !== 403) throw new Error(`the plain door served MCP with ${plain.status}`);
		});

		await step("an off-the-shelf MCP client connects with what registration gave it", async () => {
			const client = await connectSeat(secureA, clientId, clientSecret);
			try {
				const listed = await client.listTools();
				const names = listed.tools.map((tool) => tool.name).sort();
				const want = ["list_desks", "list_teammates", "message_teammate", "read_transcript"];
				if (JSON.stringify(names) !== JSON.stringify(want)) {
					throw new Error(`the seat is offered ${JSON.stringify(names)}`);
				}
				const bad = await client.callTool({ name: "message_teammate", arguments: { target: "x" } });
				if (!bad.isError) throw new Error("a call missing a required argument was accepted");
			} finally {
				await client.close();
			}
		});

		await step("the roster and the desks a seat sees are its grant, and nothing else", async () => {
			const client = await connectSeat(secureA, clientId, clientSecret);
			try {
				const desks = toolJson(await client.callTool({ name: "list_desks", arguments: {} }));
				const rows = desks.desks as Array<{ nodeId: string; current?: boolean }>;
				if (rows.length !== 2) throw new Error(`a two-desk grant showed ${rows.length} desks`);
				if (!rows.find((row) => row.nodeId === readyA.identity.id)?.current) {
					throw new Error("the desk the agent connected through is not marked");
				}
				const roster = toolJson(await client.callTool({ name: "list_teammates", arguments: {} }));
				const teammates = roster.teammates as Array<{ personaId: string; desk: string }>;
				if (!teammates.some((row) => row.personaId === boris.personaId)) {
					throw new Error("A's own teammate is missing from the roster");
				}
				if (!teammates.some((row) => row.personaId === `${readyB.identity.id}/${ada.personaId}`)) {
					throw new Error("B's teammate is missing from a roster that spans the grant");
				}
				const read = toolJson(
					await client.callTool({ name: "read_transcript", arguments: { target: boris.personaId } }),
				);
				const messages = read.messages as Array<{ text: string }>;
				if (!messages.some((message) => message.text.includes("iOS build"))) {
					throw new Error("read_transcript did not return the teammate's conversation");
				}
			} finally {
				await client.close();
			}
		});

		await step("a message from the seat is attributed to the agent, on either desk", async () => {
			const client = await connectSeat(secureA, clientId, clientSecret);
			try {
				const here = toolJson(
					await client.callTool({
						name: "message_teammate",
						arguments: { target: boris.personaId, message: "how is the iOS build?" },
					}),
				);
				if (here.from !== "Boris") {
					throw new Error(`the local call did not name the answering teammate: ${JSON.stringify(here)}`);
				}
				/* The stub answers with what it was handed, so this is the
				 * sentence Toad actually told the teammate about its caller. */
				const said = String(here.reply);
				if (!said.includes("Claude Code @ desk-a")) {
					throw new Error(`the teammate was not told who was speaking: ${said}`);
				}
				if (!said.includes("an agent outside this Toad room holding a client seat")) {
					throw new Error(`the teammate was briefed as if this were a colleague: ${said}`);
				}
				if (!said.includes("how is the iOS build?")) {
					throw new Error("the message itself did not reach the teammate");
				}

				const onA = (await a.command<Delivery[]>({ action: "delivered" })).at(-1)!;
				if (onA.callerId !== `client:${clientId}`) {
					throw new Error(`A attributed the message to ${onA.callerId}`);
				}
				if (onA.outside?.seat !== "client") throw new Error("A did not mark the caller a client seat");
				if (onA.outside.name !== "Claude Code") {
					throw new Error(`A named the caller ${onA.outside.name}`);
				}
				if (onA.outside.node !== readyA.identity.name) {
					throw new Error(`A said the message came through ${onA.outside.node}`);
				}

				const across = toolJson(
					await client.callTool({
						name: "message_teammate",
						arguments: {
							target: `${readyB.identity.id}/${ada.personaId}`,
							message: "Boris says signing is the blocker",
						},
					}),
				);
				if (across.from !== "Ada" || !String(across.reply).includes("signing is the blocker")) {
					throw new Error(`the cross-desk call did not answer: ${JSON.stringify(across)}`);
				}
				const onB = (await b.command<Delivery[]>({ action: "delivered" })).at(-1)!;
				if (onB.callerId !== `remote:${readyA.identity.id}:client:${clientId}`) {
					throw new Error(`B attributed the message to ${onB.callerId}`);
				}
				if (onB.outside?.seat !== "client") throw new Error("the wire dropped the seat");
				if (onB.outside.name !== "Claude Code") {
					throw new Error(`B named the caller ${onB.outside.name}`);
				}
				/* The desk the agent came in through, not the one answering: that
				 * is the fact the reader of Ada's tape needs. */
				if (onB.outside.node !== readyA.identity.name) {
					throw new Error(`B said the message came through ${onB.outside.node}`);
				}
			} finally {
				await client.close();
			}
		});

		await step("the teammate's own tape says an outside agent spoke", async () => {
			/* The stored event, not the pill drawn from it: what a desk still
			 * holds tomorrow is the only durable answer to "who said this". */
			for (const [desk, who, teammate, callerId, said] of [
				[a, "Boris", boris, `client:${clientId}`, "how is the iOS build?"],
				[
					b,
					"Ada",
					ada,
					`remote:${readyA.identity.id}:client:${clientId}`,
					"Boris says signing is the blocker",
				],
			] as const) {
				const tape = await desk.command<TapeEvent[]>({
					action: "tape",
					personaId: teammate.personaId,
				});
				const marker = tape.filter((event) => event.kind === "peer").at(-1);
				if (!marker) throw new Error(`${who}'s tape has no record of the exchange`);
				/* The desk the agent came in through — the same string on both
				 * desks, because it is a fact about the caller and not about
				 * whoever is answering. */
				if (marker.withName !== `Claude Code @ ${readyA.identity.name}`) {
					throw new Error(`${who}'s tape names the caller ${String(marker.withName)}`);
				}
				if (marker.seat !== "client") {
					throw new Error(`${who}'s tape reads the caller as a teammate, not a client seat`);
				}
				if (marker.role !== "target" || marker.withPersonaId !== callerId) {
					throw new Error(`${who}'s marker is keyed to ${String(marker.withPersonaId)}`);
				}
				/* And never as the operator: the room's own user is the one voice
				 * an outside agent must not be able to borrow. */
				if (tape.some((event) => event.kind === "user" && String(event.text).includes(said))) {
					throw new Error(`${who}'s tape carries the agent's words as the user's`);
				}
			}
			/* The client keeps no conversation anywhere — it is a seat, not a
			 * teammate, so there is no tape for its half of the thread. */
			const clientTape = await a.command<TapeEvent[]>({
				action: "tape",
				personaId: `client:${clientId}`,
			});
			if (clientTape.length > 0) throw new Error("the client seat grew a tape of its own");
		});

		await step("a desk outside the grant is not in the room at all", async () => {
			await a.command({ action: "setGrant", clientId, grant: [readyA.identity.id] });
			await eventually(async () => {
				const refused = await token(secureB, clientId, clientSecret);
				if (refused.status !== 401) throw new Error(`B still mints tokens (${refused.status})`);
				return true;
			}, "B refuses an agent it is no longer shared with");
			const stillA = await token(secureA, clientId, clientSecret);
			if (stillA.status !== 200) throw new Error("narrowing to A also closed A");

			/* Not "offline" and not "forbidden" — absent. A narrowed grant needs
			 * no second mechanism because the tools only ever enumerate it. */
			const client = await connectSeat(secureA, clientId, clientSecret);
			try {
				const desks = (toolJson(await client.callTool({ name: "list_desks", arguments: {} }))
					.desks ?? []) as Array<{ nodeId: string }>;
				if (desks.length !== 1 || desks[0]!.nodeId !== readyA.identity.id) {
					throw new Error(`list_desks still shows ${JSON.stringify(desks.map((d) => d.nodeId))}`);
				}
				const roster = (toolJson(await client.callTool({ name: "list_teammates", arguments: {} }))
					.teammates ?? []) as Array<{ personaId: string }>;
				if (roster.some((row) => row.personaId.startsWith(readyB.identity.id))) {
					throw new Error("a desk outside the grant still lists its teammates");
				}
				const target = `${readyB.identity.id}/${ada.personaId}`;
				for (const name of ["message_teammate", "read_transcript"] as const) {
					const answer = await client.callTool({
						name,
						arguments: name === "message_teammate" ? { target, message: "still there?" } : { target },
					});
					if (!answer.isError) throw new Error(`${name} still reaches a desk outside the grant`);
					const refusal = toolJson(answer);
					if (refusal.reason !== "not_found") {
						throw new Error(`${name} blamed ${String(refusal.reason)} rather than not knowing the desk`);
					}
				}
			} finally {
				await client.close();
			}
		});

		await step("revoking stops a connected agent on its next call", async () => {
			const wrongDesk = await b.command<{ revoked: boolean; error?: string }>({
				action: "revoke",
				clientId,
			});
			if (wrongDesk.revoked) throw new Error("a non-owner desk revoked the seat");

			/* Connected, and holding an access token minted before anyone
			 * touched the membership — the state an operator is actually in when
			 * they click Remove. */
			const client = await connectSeat(secureA, clientId, clientSecret);
			try {
				const before = await client.callTool({ name: "list_desks", arguments: {} });
				if (before.isError) throw new Error("the seat was already broken before revocation");

				const owner = await a.command<{ revoked: boolean }>({ action: "revoke", clientId });
				if (!owner.revoked) throw new Error("the owner could not revoke");

				/* Not at token expiry, not at the next reconnect: now. The token
				 * is still the same string; the seat behind it is gone. */
				let stillServed = false;
				try {
					const after = await client.callTool({ name: "list_desks", arguments: {} });
					stillServed = !after.isError;
				} catch {
					/* The transport itself refusing is the same answer. */
				}
				if (stillServed) throw new Error("a revoked agent was still served on its live connection");
			} finally {
				await client.close().catch(() => undefined);
			}

			for (const [origin, name] of [
				[secureA, "A"],
				[secureB, "B"],
			] as const) {
				const refused = await token(origin, clientId, clientSecret);
				if (refused.status !== 401) throw new Error(`${name} still mints tokens for a revoked agent`);
			}
			await eventually(async () => {
				const rows = await b.command<MemberRecord[]>({ action: "memberRecords" });
				if (!rows.find((row) => row.id === clientId)?.deleted) {
					throw new Error("B did not learn the tombstone");
				}
				return true;
			}, "revocation replicated to B");
			const seats = await a.command<SeatRow[]>({ action: "seats" });
			if (seats.some((row) => row.clientId === clientId)) {
				throw new Error("the desk still lists an agent it removed");
			}
		});

		await step("a teammate on a dark desk refuses in words, not by timing out", async () => {
			/* Only the child this harness spawned, by the handle it captured —
			 * never a name, a path or a port sweep. */
			await b.command({ action: "stop" }).catch(() => undefined);
			await b.process.exited;
			live.splice(live.indexOf(b), 1);

			const enrollment = await a.command<Enrollment>({ action: "enrollment" });
			const registered = await register(enrollment.registrationEndpoint as string, enrollment.code, {
				client_name: "Late Arrival",
				grant_types: ["client_credentials"],
			});
			if (registered.status !== 201) throw new Error("could not enroll a second agent");
			const client = await connectSeat(
				secureA,
				String(registered.body.client_id),
				String(registered.body.client_secret),
			);
			try {
				await eventually(async () => {
					const answer = await client.callTool({
						name: "message_teammate",
						arguments: {
							target: `${readyB.identity.id}/${ada.personaId}`,
							message: "anyone home?",
						},
					});
					if (!answer.isError) throw new Error("a dark desk answered a message");
					const refusal = toolJson(answer);
					if (refusal.reason !== "unreachable") {
						throw new Error(`the refusal blamed ${String(refusal.reason)}`);
					}
					const detail = String(refusal.detail);
					if (!detail.includes("desk-b") || !detail.includes("link")) {
						throw new Error(`the refusal does not name the missing link: ${detail}`);
					}
					return true;
				}, "A notices B is dark and says so");
			} finally {
				await client.close();
			}
		});

		console.log(
			"mcp-seat: HTTPS only under one room CA that both desks converged on and that verifies either door, open registration refused, one code buys one seat through A and is worthless spent or expired, membership replicated to B, B honoured the seat without a code of its own, an off-the-shelf MCP client reached the four social tools scoped to its grant, a real teammate answered on each desk and its stored tape names \"Claude Code @ desk-a\" as an outside agent rather than the operator, a desk outside the grant was invisible and unaddressable, a dark desk refused in words, a stock client with only a browser registered unapproved and became a seat the moment the code was typed on the page, its PKCE code bought a token and a refresh token, and revoking on the owner stopped a connected agent on its next call and reached every desk",
		);
	} finally {
		await Promise.all(live.map((child) => child.command({ action: "stop" }).catch(() => undefined)));
		await Promise.all(live.map((child) => child.process.exited));
		rmSync(root, { recursive: true, force: true });
	}
}

function spawnChild(
	label: string,
	nodePort: number,
	webPort: number,
	controlPort: number,
	dataDir: string,
): Child {
	/* `startWebMode` refuses without a built mainview, and the client seat has
	 * nothing to do with the SPA. Each child gets a placeholder bundle in its
	 * own scratch cwd rather than this harness depending on a `vite build` —
	 * a build under a running dev instance is the one thing this tree asks you
	 * never to do. */
	const views = join(dataDir, "cwd", "dist");
	mkdirSync(views, { recursive: true });
	writeFileSync(join(views, "index.html"), "<!doctype html><title>verify</title>\n", "utf8");

	/* The teammate's harness, under the name the `cursor` backend looks for on
	 * PATH — so `resolveLaunch` finds this and the session code takes the same
	 * road it does in the app. A shim script rather than a symlink because it
	 * has to add the flag that tells this file it is being run as the agent.
	 *
	 * The desk children live and die with this run, and each one's PATH is
	 * built here, so nothing outside the harness can pick this up. */
	const bin = join(dataDir, "bin");
	mkdirSync(bin, { recursive: true });
	const stub = join(bin, "cursor-agent");
	writeFileSync(
		stub,
		`#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fileURLToPath(import.meta.url))} --acp-stub\n`,
		"utf8",
	);
	chmodSync(stub, 0o755);
	/* And the sidecar stays off it: Toad's own MCP server is a different
	 * feature with a different harness, and attaching it here would put a unix
	 * socket between this check and the thing it is checking. */
	writeFileSync(
		join(dataDir, "mcp-compat.json"),
		`${JSON.stringify({ version: 1, verifiedAt: Date.now(), backends: { cursor: { attach: false } } })}\n`,
		"utf8",
	);

	const childProcess = Bun.spawn([process.execPath, fileURLToPath(import.meta.url)], {
		cwd: join(dataDir, "cwd"),
		env: {
			...globalThis.process.env,
			PATH: `${bin}:${globalThis.process.env.PATH ?? ""}`,
			TOAD_SEAT_CHILD: label,
			/* Both desks share a hostname here, and the desk name is the whole
			 * point of the attribution this harness checks. */
			TOAD_NODE_NAME: `desk-${label}`,
			TOAD_NODE_PORT: String(nodePort),
			TOAD_WEB_PORT: String(webPort),
			TOAD_WEB_HTTPS_PORT: String(webPort + 100),
			/* The seat's loopback door, off its fixed default so two harness desks
			   do not fight over one port — and never over a live desk's. The
			   loopback door has its own harness; this one is about the TLS one. */
			TOAD_WEB_LOOPBACK_PORT: String(webPort + 200),
			TOAD_NODE_CONTROL_PORT: String(controlPort),
			TOAD_DATA_DIR: dataDir,
			/* Five seconds, so the expiry check watches a real clock run out
			 * rather than reading the branch that would have. Long enough that
			 * every other step here registers well inside its code's life. */
			TOAD_SEAT_ENROLLMENT_TTL_MS: String(ENROLLMENT_TTL_MS),
		},
		stdout: "inherit",
		stderr: "inherit",
	});
	return {
		label,
		process: childProcess,
		async command<T>(input: JsonRecord): Promise<T> {
			const response = await fetch(`http://127.0.0.1:${controlPort}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(input),
				signal: AbortSignal.timeout(15_000),
			});
			const body = (await response.json()) as { ok: boolean; result?: T; error?: string };
			if (!response.ok || !body.ok) throw new Error(`${label}: ${body.error ?? response.status}`);
			return body.result as T;
		},
	};
}

async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (error) {
		throw new Error(`[${name}] ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function eventually<T>(run: () => Promise<T>, label: string, timeoutMs = 12_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let last: unknown;
	while (Date.now() < deadline) {
		try {
			return await run();
		} catch (error) {
			last = error;
			await Bun.sleep(150);
		}
	}
	throw new Error(`${label}: ${last instanceof Error ? last.message : String(last)}`);
}
