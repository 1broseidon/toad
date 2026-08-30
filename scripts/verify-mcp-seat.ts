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
 *
 *   bun scripts/verify-mcp-seat.ts
 */
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
	const records = await import("../src/bun/store/records");
	const seat = await import("../src/bun/mcp/seat");
	const web = await import("../src/bun/web/server");

	const handlers: Record<string, (params: unknown) => Promise<unknown>> = {
		ping: async () => true,
	};
	const resolve = (method: string) => handlers[method];

	fleet.initFleet({
		createTeammate: (draft) => ({ personaId: `${label}-created`, name: draft.name }),
		readTranscript: () => null,
		readThread: () => null,
		deliver: async () => ({ ok: false, detail: "not exercised" }),
		httpOrigin: () => web.httpOrigin(),
		nodeOrigin: nodeServer.nodeOrigin,
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

async function runParent(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "toad-seat-"));
	const base = 54_000 + Math.floor(Math.random() * 500);
	const a = spawnChild("a", base, base + 20, base + 40, join(root, "a"));
	const b = spawnChild("b", base + 1, base + 21, base + 41, join(root, "b"));
	const live = [a, b];

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
			if (server.body.authorization_endpoint !== undefined) {
				throw new Error("advertised a redirect flow this room does not implement");
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
				client_name: "Claude Code @ beastie",
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
			if (seats.length !== 1 || seats[0]!.name !== "Claude Code @ beastie") {
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

		console.log(
			"mcp-seat: HTTPS only, open registration refused, one code buys one seat through A, membership replicated to B, B honoured the seat without a code of its own, grant narrowing and owner-only revocation enforced on both desks",
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
