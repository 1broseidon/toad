/**
 * Two isolated desktops and one outside MCP agent, proving the client seat:
 *
 * - the agent enrolls through desk A by RFC 7591 dynamic client registration,
 *   gated by the one-time code an operator reads off A's screen — no code, no
 *   registration, and the code is spent by the one that succeeded
 * - the registration writes a *member* record, which replicates to desk B
 *   first-hand, exactly as a phone's membership does
 * - the seat walks between desks: B mints the agent an access token without
 *   ever having shown it a code, because the digest of the client secret
 *   replicated and B is in the grant
 * - the discovery documents A publishes are the ones a client acts on, and
 *   the whole surface is HTTPS-only — the plain door refuses it
 * - narrowing the grant on the owner closes B; revoking on the owner closes
 *   both, and every desk learns it
 * - an off-the-shelf MCP client — the SDK's own client-credentials provider
 *   over streamable HTTP — connects to /mcp with what registration handed it,
 *   and is offered exactly the four social tools
 * - what it sees is its grant: the desks it was given and the teammates on
 *   them, and nothing else
 * - what it says is attributed to it. A message lands on the teammate's desk
 *   as the client seat, named, with the desk it connected through — on the
 *   desk it enrolled at and, over the NodeLink, on the other one
 * - a teammate on a desk whose link is down is refused in words naming that
 *   desk, rather than by waiting for a timeout
 *
 *   bun scripts/verify-mcp-seat.ts
 */
import {
	Client,
	ClientCredentialsProvider,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

type JsonRecord = Record<string, unknown>;

const CHILD = process.env.TOAD_SEAT_CHILD;

if (CHILD) {
	await runChild(CHILD);
} else {
	await runParent();
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
	const peers = await import("../src/bun/acp/peers");
	const transcript = await import("../src/bun/store/transcript");
	const web = await import("../src/bun/web/server");

	const handlers: Record<string, (params: unknown) => Promise<unknown>> = {
		ping: async () => true,
	};
	const resolve = (method: string) => handlers[method];

	/**
	 * Every delivery this desk accepts, recorded exactly as the peer machinery
	 * would have received it.
	 *
	 * A real `PeerSessions.deliver` needs a real backend process, which this
	 * harness deliberately does not have — what it is proving is *who the room
	 * thinks is speaking*, and that is settled before any agent is started.
	 * `verify:mcp` covers the other half, where a real teammate answers a
	 * client seat and the marker lands on its tape.
	 */
	const delivered: Array<Record<string, unknown>> = [];
	const recordDelivery = async (input: {
		callerId: string;
		targetId: string;
		message: string;
		outside?: { name: string; node: string; seat?: "client" };
	}) => {
		delivered.push({
			callerId: input.callerId,
			targetId: input.targetId,
			message: input.message,
			outside: input.outside ?? null,
		});
		const target = personas.getPersona(input.targetId);
		if (!target) {
			return { ok: false as const, reason: "not_found" as const, detail: "Teammate not found" };
		}
		return { ok: true as const, from: target.name, reply: `${target.name} heard you` };
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
		/* The same mapping `index.ts` makes, through the same function, so what
		 * this desk records is what a real desk would have been handed. */
		deliver: async ({ fromNode, fromPersona, targetPersonaId, message, fromSeat }) =>
			recordDelivery({
				...peers.inboundFleetCaller({ fromNode, fromPersona, fromSeat }),
				targetId: targetPersonaId,
				message,
			}),
		httpOrigin: () => web.httpOrigin(),
		nodeOrigin: nodeServer.nodeOrigin,
	});
	seatTools.initSeatTools({
		supervisor: { info: () => ({ state: "idle" }) as never },
		peers: { deliver: recordDelivery as never },
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

		await step("the room publishes documents a client can act on", async () => {
			const resource = await getJson(`${secureA}/.well-known/oauth-protected-resource/mcp`);
			if (resource.body.resource !== `${secureA}/mcp`) {
				throw new Error(`protected resource metadata names ${String(resource.body.resource)}`);
			}
			const server = await getJson(`${secureA}/.well-known/oauth-authorization-server`);
			if (server.body.registration_endpoint !== `${secureA}/mcp/register`) {
				throw new Error("authorization server metadata does not name the registration endpoint");
			}
			/* The field is advertised because every MCP client's schema requires
			 * it, and the endpoint behind it exists to say there is no browser
			 * flow — a refusal a client can read, rather than a document it
			 * cannot parse. */
			const authorize = String(server.body.authorization_endpoint ?? "");
			if (authorize !== `${secureA}/mcp/authorize`) {
				throw new Error(`metadata names ${authorize} as the authorization endpoint`);
			}
			const refused = await getJson(authorize);
			if (refused.status !== 400 || refused.body.error !== "unsupported_response_type") {
				throw new Error(
					`the authorization endpoint answered ${refused.status} ${JSON.stringify(refused.body)}`,
				);
			}
			if (!String(refused.body.error_description).includes("enrollment code")) {
				throw new Error("the refusal does not say how an agent actually joins");
			}
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
				if (here.ok !== true || here.reply !== "Boris heard you") {
					throw new Error(`the local call did not carry the reply back: ${JSON.stringify(here)}`);
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
				if (across.ok !== true || across.reply !== "Ada heard you") {
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

		await step("narrowing the grant on the owner closes B", async () => {
			await a.command({ action: "setGrant", clientId, grant: [readyA.identity.id] });
			await eventually(async () => {
				const refused = await token(secureB, clientId, clientSecret);
				if (refused.status !== 401) throw new Error(`B still mints tokens (${refused.status})`);
				return true;
			}, "B refuses an agent it is no longer shared with");
			const stillA = await token(secureA, clientId, clientSecret);
			if (stillA.status !== 200) throw new Error("narrowing to A also closed A");
		});

		await step("only the owning desk may revoke, and every desk learns it", async () => {
			const wrongDesk = await b.command<{ revoked: boolean; error?: string }>({
				action: "revoke",
				clientId,
			});
			if (wrongDesk.revoked) throw new Error("a non-owner desk revoked the seat");

			const owner = await a.command<{ revoked: boolean }>({ action: "revoke", clientId });
			if (!owner.revoked) throw new Error("the owner could not revoke");
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
			"mcp-seat: HTTPS only, open registration refused, one code buys one seat through A, membership replicated to B, B honoured the seat without a code of its own, an off-the-shelf MCP client reached the four social tools scoped to its grant, every message arrived attributed to the agent and the desk it came in through on both desks, a dark desk refused in words, and grant narrowing and owner-only revocation were enforced on both desks",
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

	const childProcess = Bun.spawn([process.execPath, fileURLToPath(import.meta.url)], {
		cwd: join(dataDir, "cwd"),
		env: {
			...globalThis.process.env,
			TOAD_SEAT_CHILD: label,
			/* Both desks share a hostname here, and the desk name is the whole
			 * point of the attribution this harness checks. */
			TOAD_NODE_NAME: `desk-${label}`,
			TOAD_NODE_PORT: String(nodePort),
			TOAD_WEB_PORT: String(webPort),
			TOAD_WEB_HTTPS_PORT: String(webPort + 100),
			TOAD_NODE_CONTROL_PORT: String(controlPort),
			TOAD_DATA_DIR: dataDir,
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
