/**
 * One desk, three doors, and the certificate an agent on the same box should
 * never have had to install.
 *
 * The gap this proves closed: Node ships its own roots and ignores the OS
 * trust store, so every Node-based MCP client — which is most of them — needed
 * `NODE_EXTRA_CA_CERTS` pointed at the room's CA, set in the shell the client
 * is launched from, before it could speak to the room at all. A client running
 * on the *same machine* as the desk was paying that price for confidentiality
 * from a network it never crossed. So the desk opens a second listener bound to
 * 127.0.0.1 alone and serves the whole seat over it in the clear.
 *
 * Every check below runs with **no certificate configured anywhere** — plain
 * `fetch`, Bun's stock CA bundle, no `rejectUnauthorized: false` except where a
 * check is deliberately about the TLS door. The wall is measured first (the
 * https door refuses an untrusting client) so that the loopback door answering
 * the same client means something.
 *
 * What is asserted:
 *
 * - the loopback door serves the seat's whole surface — both discovery
 *   documents, registration, the authorization page, the token endpoint, /mcp
 * - every URL it publishes names its own origin, `http://127.0.0.1:<port>`,
 *   and never the https one. A document that bounced a certificate-less client
 *   onto an address it cannot verify would parse perfectly and undo the entire
 *   feature, so it is asserted rather than read
 * - the audience follows: a token request naming the loopback resource is
 *   honoured on that door and the https resource is refused there
 * - a real off-the-shelf MCP client — the SDK's own client-credentials provider
 *   over streamable HTTP, with a stock `fetch` — connects and lists the tools
 * - the browser door works over loopback too: a public client registers
 *   unapproved, the code entered on the page admits it, and PKCE buys a token
 * - the 0.0.0.0 plain door still refuses every part of the seat. Loopback is a
 *   different boundary; the LAN is not, and that refusal is not relaxed
 * - the loopback listener is loopback-*only*: the same port on this box's LAN
 *   address does not answer
 * - it carries nothing but the seat: the app bundle, /ws and /pair are 404
 * - turning web mode off takes the door with it
 *
 *   bun scripts/verify-seat-loopback.ts
 */
import {
	Client,
	ClientCredentialsProvider,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

type JsonRecord = Record<string, unknown>;

const CHILD = process.env.TOAD_SEAT_LOOPBACK_CHILD;

if (CHILD) {
	await runChild();
} else {
	await runParent();
}

/* ------------------------------------------------------------------- child */

async function runChild(): Promise<void> {
	const webPort = Number(process.env.TOAD_WEB_PORT);
	const controlPort = Number(process.env.TOAD_SEAT_CONTROL_PORT);
	if (!webPort || !controlPort) throw new Error("ports are required");

	/* `web/server` first, and it is not cosmetic: the seat and the web server
	 * import each other, and entering that cycle from `mcp/seat` leaves
	 * `mcp/seat-server`'s module-level bearer gate reading a binding that does
	 * not exist yet. The app enters from the web server; so does this. */
	const web = await import("../src/bun/web/server");
	const identity = await import("../src/bun/node/identity");
	const seat = await import("../src/bun/mcp/seat");

	const handlers: Record<string, (params: unknown) => Promise<unknown>> = {
		ping: async () => true,
	};
	web.startWebMode((method) => handlers[method], webPort);

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
								secureOrigin: web.secureOrigin(),
								loopbackOrigin: web.loopbackOrigin(),
								lanAddress: web.lanAddress(),
								tlsFault: web.webTlsFault(),
							},
						});
					case "enrollment":
						return Response.json({ ok: true, result: seat.createClientEnrollment() });
					case "seats":
						return Response.json({ ok: true, result: seat.listClientSeats() });
					/* The way out, driven rather than read: web mode off closes
					 * the loopback listener with everything else. */
					case "stopWeb":
						web.stopWebMode();
						return Response.json({ ok: true, result: web.loopbackOrigin() });
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

/* ------------------------------------------------------------------ parent */

type Ready = {
	identity: { id: string; name: string };
	secureOrigin: string | null;
	loopbackOrigin: string | null;
	lanAddress: string | null;
	tlsFault: string | null;
};
type Enrollment = {
	code: string;
	mcpUrl: string | null;
	registrationEndpoint: string | null;
	loopbackUrl: string | null;
	loopbackRegistrationEndpoint: string | null;
};
type SeatRow = { clientId: string; name: string; grant: string[] };

/**
 * The room's certificate is self-signed by design. Only the checks that are
 * *about* the TLS door may say so; everything on the loopback door runs with a
 * stock client, because that is the claim.
 */
function insecure(): RequestInit {
	return { tls: { rejectUnauthorized: false } } as RequestInit;
}

async function post(
	url: string,
	init: RequestInit & { headers?: Record<string, string> },
): Promise<{ status: number; body: JsonRecord }> {
	const response = await fetch(url, { method: "POST", signal: AbortSignal.timeout(10_000), ...init });
	let body: JsonRecord = {};
	try {
		body = (await response.json()) as JsonRecord;
	} catch {
		body = {};
	}
	return { status: response.status, body };
}

function registerBody(name: string, extra: JsonRecord = {}): string {
	return JSON.stringify({ client_name: name, grant_types: ["client_credentials"], ...extra });
}

async function getJson(url: string, init: RequestInit = {}): Promise<{ status: number; body: JsonRecord }> {
	const response = await fetch(url, { signal: AbortSignal.timeout(10_000), ...init });
	let body: JsonRecord = {};
	try {
		body = (await response.json()) as JsonRecord;
	} catch {
		body = {};
	}
	return { status: response.status, body };
}

/** Whether a dial failed to connect at all, which is what a bind boundary looks like. */
async function unreachable(url: string): Promise<boolean> {
	try {
		await fetch(url, { signal: AbortSignal.timeout(4_000) });
		return false;
	} catch {
		return true;
	}
}

async function runParent(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "toad-seat-loopback-"));
	const base = 55_200 + Math.floor(Math.random() * 300);
	const webPort = base;
	const httpsPort = base + 1;
	const loopbackPort = base + 2;
	const controlPort = base + 3;
	const child = spawnChild({ root, webPort, httpsPort, loopbackPort, controlPort });
	let checks = 0;
	const check = (ok: boolean, message: string) => {
		checks += 1;
		if (!ok) throw new Error(message);
	};

	try {
		const ready = await eventually(
			() => child.command<Ready>({ action: "ready" }),
			"the desk comes up",
		);
		const secure = ready.secureOrigin;
		const loopback = ready.loopbackOrigin;
		if (!secure) {
			throw new Error(
				`no TLS door (${ready.tlsFault ?? "no reason given"}) — this run compares two doors and needs both`,
			);
		}
		if (!loopback) throw new Error("the desk came up with no loopback door");
		check(loopback === `http://127.0.0.1:${loopbackPort}`, `loopback origin is ${loopback}`);

		await step("the wall this door exists to remove is really there", async () => {
			/* A stock client — no room CA installed, no NODE_EXTRA_CA_CERTS —
			 * cannot open the TLS door at all. Everything after this runs as
			 * that same client, so this is what makes the rest mean something. */
			check(
				await unreachable(`${secure}/.well-known/oauth-authorization-server`),
				"an untrusting client reached the https door — this box trusts the room CA, so the rest proves nothing",
			);
			const trusting = await getJson(
				`${secure}/.well-known/oauth-authorization-server`,
				insecure(),
			);
			check(trusting.status === 200, `the https door itself is broken (${trusting.status})`);
		});

		await step("the loopback door publishes its own origin and never the other one", async () => {
			for (const path of [
				"/.well-known/oauth-authorization-server",
				"/.well-known/oauth-protected-resource/mcp",
			]) {
				const document = await getJson(`${loopback}${path}`);
				check(document.status === 200, `${path} answered ${document.status} on loopback`);
				const text = JSON.stringify(document.body);
				check(!text.includes(secure), `${path} handed a loopback client the https origin: ${text}`);
				check(!text.includes("https://"), `${path} named an https address on loopback: ${text}`);
			}
			const server = (await getJson(`${loopback}/.well-known/oauth-authorization-server`)).body;
			check(server.issuer === loopback, `issuer is ${String(server.issuer)}`);
			check(
				server.authorization_endpoint === `${loopback}/mcp/authorize`,
				`authorization_endpoint is ${String(server.authorization_endpoint)}`,
			);
			check(
				server.token_endpoint === `${loopback}/mcp/token`,
				`token_endpoint is ${String(server.token_endpoint)}`,
			);
			check(
				server.registration_endpoint === `${loopback}/mcp/register`,
				`registration_endpoint is ${String(server.registration_endpoint)}`,
			);
			const resource = (await getJson(`${loopback}/.well-known/oauth-protected-resource/mcp`)).body;
			check(resource.resource === `${loopback}/mcp`, `resource is ${String(resource.resource)}`);
			check(
				JSON.stringify(resource.authorization_servers) === JSON.stringify([loopback]),
				`authorization_servers is ${JSON.stringify(resource.authorization_servers)}`,
			);

			/* And the https door is untouched by any of it: it still names
			 * itself, which is the rule `docs/client-seat.md` already made. */
			const remote = (
				await getJson(`${secure}/.well-known/oauth-authorization-server`, insecure())
			).body;
			check(remote.issuer === secure, `the https door's issuer moved to ${String(remote.issuer)}`);
			check(
				!JSON.stringify(remote).includes("127.0.0.1"),
				"the https door published the loopback address",
			);
		});

		const enrollment = await child.command<Enrollment>({ action: "enrollment" });
		await step("the desk hands the operator both addresses", async () => {
			check(enrollment.mcpUrl === `${secure}/mcp`, `mcpUrl is ${String(enrollment.mcpUrl)}`);
			check(
				enrollment.loopbackUrl === `${loopback}/mcp`,
				`loopbackUrl is ${String(enrollment.loopbackUrl)}`,
			);
			check(
				enrollment.loopbackRegistrationEndpoint === `${loopback}/mcp/register`,
				`loopback registration endpoint is ${String(enrollment.loopbackRegistrationEndpoint)}`,
			);
		});

		const headless = await step("an agent on this box enrolls with no certificate at all", async () => {
			const answer = await post(enrollment.loopbackRegistrationEndpoint as string, {
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${enrollment.code}`,
				},
				body: registerBody("Claude Code @ this box"),
			});
			check(answer.status === 201, `loopback registration answered ${answer.status}`);
			const toad = answer.body.toad as { mcp_url: string; token_endpoint: string; grant: string[] };
			check(toad.mcp_url === `${loopback}/mcp`, `the seat was told to use ${toad.mcp_url}`);
			check(
				toad.token_endpoint === `${loopback}/mcp/token`,
				`the seat was told to mint at ${toad.token_endpoint}`,
			);
			const seats = await child.command<SeatRow[]>({ action: "seats" });
			check(
				seats.some((row) => row.clientId === answer.body.client_id),
				"the loopback registration left no member record",
			);
			return {
				clientId: String(answer.body.client_id),
				secret: String(answer.body.client_secret),
			};
		});

		await step("the audience a loopback client learned is the one this door honours", async () => {
			const basic = Buffer.from(
				`${encodeURIComponent(headless.clientId)}:${encodeURIComponent(headless.secret)}`,
			).toString("base64");
			const mint = (resource: string) =>
				post(`${loopback}/mcp/token`, {
					headers: {
						"content-type": "application/x-www-form-urlencoded",
						authorization: `Basic ${basic}`,
					},
					body: new URLSearchParams({ grant_type: "client_credentials", resource }).toString(),
				});
			const own = await mint(`${loopback}/mcp`);
			check(own.status === 200, `the loopback token endpoint answered ${own.status}`);
			check(typeof own.body.access_token === "string", "no access token came back");
			const crossed = await mint(`${secure}/mcp`);
			check(
				crossed.status === 400,
				`the loopback door minted a token for the https resource (${crossed.status})`,
			);
		});

		await step("a stock MCP client connects over loopback and finds the seat's tools", async () => {
			/* No custom `fetch`, deliberately: the transport's discovery, token
			 * and MCP calls all run on Bun's stock CA bundle, which is exactly
			 * the client that could not reach the https door above. */
			const transport = new StreamableHTTPClientTransport(new URL(`${loopback}/mcp`), {
				authProvider: new ClientCredentialsProvider({
					clientId: headless.clientId,
					clientSecret: headless.secret,
					scope: "toad.room",
					expectedIssuer: loopback,
				}),
			});
			const client = new Client({ name: "verify-seat-loopback", version: "1" });
			await client.connect(transport);
			try {
				const listed = await client.listTools();
				const names = listed.tools.map((tool) => tool.name).sort();
				check(
					JSON.stringify(names) ===
						JSON.stringify(["list_desks", "list_teammates", "message_teammate", "read_transcript"]),
					`the seat offered ${JSON.stringify(names)}`,
				);
			} finally {
				await client.close();
			}
		});

		await step("the browser door works on loopback too", async () => {
			const redirect = "http://127.0.0.1:59999/callback";
			const registered = await post(`${loopback}/mcp/register`, {
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					client_name: "A local connector",
					grant_types: ["authorization_code", "refresh_token"],
					response_types: ["code"],
					redirect_uris: [redirect],
					token_endpoint_auth_method: "none",
				}),
			});
			check(registered.status === 201, `public registration answered ${registered.status}`);
			const clientId = String(registered.body.client_id);
			check(
				(registered.body.toad as { pending: boolean }).pending === true,
				"a registration nobody approved was not marked pending",
			);

			const verifier = randomBytes(32).toString("base64url");
			const challenge = createHash("sha256").update(verifier).digest("base64url");
			const query = new URLSearchParams({
				client_id: clientId,
				redirect_uri: redirect,
				response_type: "code",
				code_challenge: challenge,
				code_challenge_method: "S256",
				state: "xyz",
			});
			const page = await fetch(`${loopback}/mcp/authorize?${query.toString()}`, {
				signal: AbortSignal.timeout(10_000),
			});
			const html = await page.text();
			check(page.status === 200, `the authorization page answered ${page.status} on loopback`);
			check(
				html.includes("A local connector") && html.includes("Enrollment code from the desk"),
				"the authorization page is not the consent screen",
			);

			const fresh = await child.command<Enrollment>({ action: "enrollment" });
			const approved = await fetch(`${loopback}/mcp/authorize`, {
				method: "POST",
				redirect: "manual",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({ ...Object.fromEntries(query), code: fresh.code }).toString(),
				signal: AbortSignal.timeout(10_000),
			});
			check(approved.status === 302, `entering the code answered ${approved.status}`);
			const location = new URL(approved.headers.get("location") as string);
			check(location.searchParams.get("state") === "xyz", "the state did not come back");
			const authorizationCode = location.searchParams.get("code") as string;

			const issued = await post(`${loopback}/mcp/token`, {
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					grant_type: "authorization_code",
					code: authorizationCode,
					redirect_uri: redirect,
					code_verifier: verifier,
				}).toString(),
			});
			check(issued.status === 200, `the PKCE exchange answered ${issued.status}`);
			check(typeof issued.body.refresh_token === "string", "the browser door issued no refresh token");
		});

		await step("the plain LAN door still carries none of it", async () => {
			const lan = `http://127.0.0.1:${webPort}`;
			for (const path of [
				"/.well-known/oauth-authorization-server",
				"/.well-known/oauth-protected-resource/mcp",
			]) {
				const document = await getJson(`${lan}${path}`);
				check(document.status === 403, `the plain door published ${path} with ${document.status}`);
			}
			const refusedRegister = await post(`${lan}/mcp/register`, {
				headers: { "content-type": "application/json", authorization: "Bearer 00000000" },
				body: registerBody("a stranger on the LAN"),
			});
			check(
				refusedRegister.status === 403,
				`the plain door answered registration with ${refusedRegister.status}`,
			);
			const refusedToken = await post(`${lan}/mcp/token`, {
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({ grant_type: "client_credentials" }).toString(),
			});
			check(
				refusedToken.status === 403,
				`the plain door answered the token endpoint with ${refusedToken.status}`,
			);
			const refusedMcp = await post(`${lan}/mcp`, {
				headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
			});
			check(refusedMcp.status === 403, `the plain door served MCP with ${refusedMcp.status}`);
		});

		await step("the loopback door is bound to loopback, and nothing else", async () => {
			if (ready.lanAddress) {
				check(
					await unreachable(`http://${ready.lanAddress}:${loopbackPort}/mcp/register`),
					`the loopback port answered on ${ready.lanAddress} — it is not loopback-only`,
				);
			} else {
				console.log(
					"verify-seat-loopback: this box has no routable IPv4, so the off-loopback dial was skipped",
				);
			}
		});

		await step("it serves the seat and not the room", async () => {
			for (const path of ["/", "/index.html", "/ws", "/pair", "/fleet/rpc", "/node/join"]) {
				const response = await fetch(`${loopback}${path}`, { signal: AbortSignal.timeout(5_000) });
				check(response.status === 404, `the loopback door served ${path} with ${response.status}`);
			}
		});

		await step("turning web access off takes the door with it", async () => {
			const after = await child.command<string | null>({ action: "stopWeb" });
			check(after === null, `the desk still claims a loopback origin after stopping: ${after}`);
			check(
				await unreachable(`${loopback}/.well-known/oauth-authorization-server`),
				"the loopback door kept answering after web mode was turned off",
			);
		});

		console.log(
			`seat-loopback: ${checks} checks — an agent on this machine registered, minted a token and listed the seat's four tools over http://127.0.0.1 with no certificate, no trust store and no NODE_EXTRA_CA_CERTS, against a desk whose https door that same client could not open at all; every document that door serves names its own origin and never the https one, the audience follows it, the browser door and PKCE work on it, the 0.0.0.0 plain door still refuses every part of the seat, the loopback port does not answer on this box's LAN address, it carries nothing but the seat, and web mode off closes it`,
		);
	} finally {
		await child.command({ action: "stop" }).catch(() => undefined);
		await child.process.exited;
		rmSync(root, { recursive: true, force: true });
	}
}

type Child = { process: ReturnType<typeof Bun.spawn>; command<T>(input: JsonRecord): Promise<T> };

function spawnChild(input: {
	root: string;
	webPort: number;
	httpsPort: number;
	loopbackPort: number;
	controlPort: number;
}): Child {
	/* `startWebMode` refuses without a built mainview, and the client seat has
	 * nothing to do with the SPA. A placeholder bundle in the child's own
	 * scratch cwd rather than a dependency on `vite build` — a build under a
	 * running dev instance is the one thing this tree asks you never to do. */
	const views = join(input.root, "cwd", "dist");
	mkdirSync(views, { recursive: true });
	writeFileSync(join(views, "index.html"), "<!doctype html><title>verify</title>\n", "utf8");

	const childProcess = Bun.spawn([process.execPath, fileURLToPath(import.meta.url)], {
		cwd: join(input.root, "cwd"),
		env: {
			...globalThis.process.env,
			TOAD_SEAT_LOOPBACK_CHILD: "1",
			TOAD_NODE_NAME: "desk-local",
			TOAD_WEB_PORT: String(input.webPort),
			TOAD_WEB_HTTPS_PORT: String(input.httpsPort),
			TOAD_WEB_LOOPBACK_PORT: String(input.loopbackPort),
			TOAD_SEAT_CONTROL_PORT: String(input.controlPort),
			TOAD_DATA_DIR: input.root,
		},
		stdout: "inherit",
		stderr: "inherit",
	});
	return {
		process: childProcess,
		async command<T>(command: JsonRecord): Promise<T> {
			const response = await fetch(`http://127.0.0.1:${input.controlPort}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(command),
				signal: AbortSignal.timeout(15_000),
			});
			const body = (await response.json()) as { ok: boolean; result?: T; error?: string };
			if (!response.ok || !body.ok) throw new Error(body.error ?? String(response.status));
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

async function eventually<T>(run: () => Promise<T>, label: string, timeoutMs = 15_000): Promise<T> {
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
