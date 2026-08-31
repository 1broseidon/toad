/**
 * Two isolated desktops and one simulated phone proving the Phase 6 gate
 * (the control-plane spec, "Mobile becomes a node"):
 *
 * - the phone joins the plane once, through desk A's pairing code, and the
 *   membership replicates to desk B as a first-hand record
 * - one mobile identity survives gateway failover: the phone authenticates
 *   to B by challenge without ever having scanned B
 * - scanning a second desktop does not create a second membership: B answers
 *   the join with recognition, and both stores hold exactly one member record
 * - the list shows only granted desktops: narrowing the grant on A filters
 *   B's teammates out of A's answers and closes/refuses B's wire
 * - revocation is a tombstone every desk learns: sessions refuse everywhere,
 *   and only the owning desk can re-admit
 *
 *   bun scripts/verify-mobile-join.ts
 */
import { generateKeyPairSync, createHash, createPublicKey, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionInfo } from "../src/shared/types";

type JsonRecord = Record<string, unknown>;

const CHILD = process.env.TOAD_MOBILE_CHILD;

if (CHILD) {
	await runChild(CHILD);
} else {
	await runParent();
}

/* ------------------------------------------------------------------ child */

function dummySessionInfo(personaId: string): SessionInfo {
	return {
		personaId,
		state: "stopped",
		contextRestored: false,
		models: [],
		modes: [],
		configs: [],
		slashCommands: [],
		capabilities: { loadSession: false, resume: false, fork: false, mcpHttp: false, image: false },
	};
}

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
	const devices = await import("../src/bun/web/devices");
	const pushRegistry = await import("../src/bun/store/push");
	const web = await import("../src/bun/web/server");

	const handlers: Record<string, (params: unknown) => Promise<unknown>> = {
		getSessionInfo: async (params) => {
			const personaId = (params as { personaId?: string })?.personaId ?? "";
			return dummySessionInfo(personaId);
		},
		ping: async () => true,
		listPersonas: async () =>
			[...personas.listPersonas(), ...wire.remotePersonas()],
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
					case "createPersona": {
						const created = personas.createPersona({ name: String(input.name) });
						return Response.json({ ok: true, result: { id: created.id, name: created.name } });
					}
					case "pairingCode":
						return Response.json({ ok: true, result: { code: devices.createPairing() } });
					case "members":
						return Response.json({ ok: true, result: members.listMobileMembers() });
					case "memberRecords":
						return Response.json({
							ok: true,
							result: records.listRecords("member", { includeTombstones: true }),
						});
					case "setGrant": {
						const saved = members.setMemberGrant(
							String(input.nodeId),
							(input.grant as string[]) ?? [],
						);
						return Response.json({ ok: true, result: saved });
					}
					case "revokeMember": {
						const revoked = members.revokeMember(String(input.nodeId));
						if (revoked) {
							web.closeMemberSockets(String(input.nodeId));
							pushRegistry.unpairPushDevicesForMember(String(input.nodeId));
						}
						return Response.json({ ok: true, result: { revoked } });
					}
					case "devices":
						return Response.json({ ok: true, result: devices.listDevices() });
					case "stop":
						setTimeout(() => {
							web.stopWebMode();
							nodeServer.stopNodeServer();
							control.stop(true);
							process.exit(0);
						}, 0);
						return Response.json({ ok: true });
					default:
						return Response.json({ ok: false, error: "unknown action" }, { status: 400 });
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

/* ------------------------------------------------------------ fake phone */

/** The phone, out of node:crypto — same keys, same framing, no webview. */
function makePhone() {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const spkiPem = publicKey.export({ type: "spki", format: "pem" }).toString();
	const der = createPublicKey(spkiPem).export({ type: "spki", format: "der" });
	const id = createHash("sha256").update(der).digest("hex").slice(0, 16);
	const node = {
		id,
		name: "Verify Phone",
		publicKey: spkiPem,
		fingerprint: createHash("sha256").update(der).digest("hex"),
		protocol: 1,
		capabilities: ["endpoint", "observer"],
	};
	const signPayload = (kind: string, payload: unknown): string =>
		sign(null, Buffer.from(`toad-node:${kind}:v1\n${JSON.stringify(payload)}`), privateKey).toString(
			"base64url",
		);

	async function post(origin: string, path: string, body: unknown) {
		const res = await fetch(new URL(path, origin), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(10_000),
		});
		return { status: res.status, body: (await res.json()) as JsonRecord };
	}

	return {
		node,
		async join(origin: string, code: string) {
			const at = Date.now();
			const proof = signPayload("mobile-join", { code, id: node.id, at });
			return post(origin, "/node/join", { code, node, at, proof });
		},
		async session(origin: string) {
			const ask = await post(origin, "/node/session", { nodeId: node.id });
			if (ask.status !== 200) return ask;
			const challenge = String(ask.body.challenge);
			const desk = (ask.body.desk as { nodeId: string }).nodeId;
			const proof = signPayload("mobile-session", { challenge, id: node.id, dst: desk });
			return post(origin, "/node/session", { nodeId: node.id, challenge, proof });
		},
		async invoke<T>(origin: string, sessionToken: string, method: string, params: unknown = {}) {
			const url = `${origin.replace(/^http/, "ws")}/ws?session=${encodeURIComponent(sessionToken)}`;
			return new Promise<T>((resolve, reject) => {
				const ws = new WebSocket(url);
				const timer = setTimeout(() => {
					ws.close();
					reject(new Error("desk did not answer"));
				}, 10_000);
				ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }));
				ws.onmessage = (event) => {
					clearTimeout(timer);
					ws.close();
					const frame = JSON.parse(String(event.data)) as {
						ok?: boolean;
						result?: T;
						error?: string;
					};
					if (frame.ok) resolve(frame.result as T);
					else reject(new Error(frame.error ?? "refused"));
				};
				ws.onerror = () => {
					clearTimeout(timer);
					reject(new Error("socket failed"));
				};
			});
		},
		/** A standing socket, for proving a revocation hangs it up. */
		openWire(origin: string, sessionToken: string) {
			const url = `${origin.replace(/^http/, "ws")}/ws?session=${encodeURIComponent(sessionToken)}`;
			const ws = new WebSocket(url);
			const state = { opened: false, closed: false };
			ws.onopen = () => {
				state.opened = true;
			};
			ws.onclose = () => {
				state.closed = true;
			};
			return { ws, state };
		},
	};
}

/* ----------------------------------------------------------------- parent */

type Child = {
	label: string;
	process: ReturnType<typeof Bun.spawn>;
	command<T>(input: JsonRecord): Promise<T>;
};
type Ready = { identity: { id: string; name: string }; origin: string; webOrigin: string };
type MemberRow = { nodeId: string; grant: string[]; ownerNode: string; fingerprint: string };
type MemberRecord = { id: string; ownerNode: string; deleted: boolean };
type PersonaRow = { id: string; name: string };

async function runParent(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "toad-mobile-"));
	const base = 53_000 + Math.floor(Math.random() * 500);
	const a = spawnChild("a", base, base + 20, base + 40, join(root, "a"));
	const b = spawnChild("b", base + 1, base + 21, base + 41, join(root, "b"));
	const live = [a, b];
	const phone = makePhone();

	try {
		const [readyA, readyB] = await Promise.all([
			eventually(() => a.command<Ready>({ action: "ready" }), "node A ready"),
			eventually(() => b.command<Ready>({ action: "ready" }), "node B ready"),
		]);

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

		let personaA = "";
		let personaB = "";
		let joinedRoomId = "";
		await step("each desk owns a teammate", async () => {
			personaA = (await a.command<PersonaRow>({ action: "createPersona", name: "A-agent" })).id;
			personaB = (await b.command<PersonaRow>({ action: "createPersona", name: "B-agent" })).id;
		});

		await step("phone joins the plane through A", async () => {
			const { code } = await a.command<{ code: string }>({ action: "pairingCode" });
			const joined = await phone.join(readyA.webOrigin, code);
			if (joined.status !== 200 || joined.body.ok !== true) {
				throw new Error(`join answered ${joined.status}: ${JSON.stringify(joined.body)}`);
			}
			const desktops = joined.body.desktops as Array<{ nodeId: string }>;
			if (desktops.length !== 2) {
				throw new Error(`join granted ${desktops.length} desks, want both`);
			}
			const room = joined.body.room as { id?: string; name?: string } | undefined;
			if (!room?.id || room.name !== "Toad Room") {
				throw new Error(`join named no room: ${JSON.stringify(joined.body.room)}`);
			}
			joinedRoomId = room.id;
			const rows = await a.command<MemberRow[]>({ action: "members" });
			if (rows.length !== 1 || rows[0]!.nodeId !== phone.node.id) {
				throw new Error("A does not hold exactly the phone's member record");
			}
			if (!rows[0]!.grant.includes(readyB.identity.id)) {
				throw new Error("default grant does not name desk B");
			}
		});

		await step("membership replicates to B first-hand", async () => {
			await eventually(async () => {
				const rows = await b.command<MemberRow[]>({ action: "members" });
				if (rows.length !== 1) throw new Error(`B holds ${rows.length} member rows`);
				if (rows[0]!.ownerNode !== readyA.identity.id) {
					throw new Error("B's copy is not owned by A");
				}
				return true;
			}, "member record on B");
		});

		let sessionB = "";
		await step("gate: one identity survives failover — challenge auth on B, never scanned", async () => {
			const minted = await phone.session(readyB.webOrigin);
			if (minted.status !== 200 || minted.body.ok !== true) {
				throw new Error(`B refused the session: ${JSON.stringify(minted.body)}`);
			}
			sessionB = String(minted.body.token);
			// The room replicated with the membership: B names the same room A
			// founded, so the phone files both desks under one context.
			const roomB = minted.body.room as { id?: string } | undefined;
			if (roomB?.id !== joinedRoomId) {
				throw new Error(`B answers room ${String(roomB?.id)}, want ${joinedRoomId}`);
			}
			const room = await phone.invoke<PersonaRow[]>(readyB.webOrigin, sessionB, "listPersonas");
			const ids = room.map((p) => p.id).sort();
			const expected = [personaB, `${readyA.identity.id}/${personaA}`].sort();
			if (JSON.stringify(ids) !== JSON.stringify(expected)) {
				throw new Error(`B's room for the phone is ${JSON.stringify(ids)}, want ${JSON.stringify(expected)}`);
			}
			const rows = await b.command<Array<{ name: string }>>({ action: "devices" });
			if (!rows.some((row) => row.name === phone.node.name)) {
				throw new Error("B minted no device row for the member (push would be dark)");
			}
		});

		await step("gate: scanning a second desk mints nothing", async () => {
			const { code } = await b.command<{ code: string }>({ action: "pairingCode" });
			const again = await phone.join(readyB.webOrigin, code);
			if (again.status !== 200 || again.body.existing !== true) {
				throw new Error(`B's join should recognise, got ${JSON.stringify(again.body)}`);
			}
			for (const child of [a, b]) {
				const rows = await child.command<MemberRecord[]>({ action: "memberRecords" });
				if (rows.length !== 1) throw new Error(`${child.label} holds ${rows.length} member records`);
				if (rows[0]!.ownerNode !== readyA.identity.id) {
					throw new Error(`${child.label}'s member record is owned by ${rows[0]!.ownerNode}, want A`);
				}
			}
		});

		await step("gate: the list shows only granted desktops", async () => {
			// A narrows the grant to itself. The phone's wire on B dies as the
			// record lands there; a fresh session on B refuses; A's answers no
			// longer contain B's teammates.
			const wireB = phone.openWire(readyB.webOrigin, (await (async () => {
				const minted = await phone.session(readyB.webOrigin);
				return String(minted.body.token);
			})()));
			await eventually(async () => {
				if (!wireB.state.opened) throw new Error("standing wire to B never opened");
				return true;
			}, "standing wire to B open");

			await a.command({ action: "setGrant", nodeId: phone.node.id, grant: [readyA.identity.id] });

			await eventually(async () => {
				if (!wireB.state.closed) throw new Error("B has not hung up the narrowed phone");
				return true;
			}, "B hangs up the standing wire");

			const refused = await phone.session(readyB.webOrigin);
			if (refused.status === 200) throw new Error("B still mints sessions outside the grant");
			if (refused.body.reason !== "not-granted") {
				throw new Error(`B refused with ${String(refused.body.reason)}, want not-granted`);
			}

			const mintedA = await phone.session(readyA.webOrigin);
			if (mintedA.status !== 200) throw new Error("A refused the still-granted phone");
			const room = await phone.invoke<PersonaRow[]>(
				readyA.webOrigin,
				String(mintedA.body.token),
				"listPersonas",
			);
			const ids = room.map((p) => p.id);
			if (ids.length !== 1 || ids[0] !== personaA) {
				throw new Error(`A's filtered room is ${JSON.stringify(ids)}, want only ${personaA}`);
			}
		});

		await step("gate: revocation is a tombstone every desk learns", async () => {
			await a.command({ action: "revokeMember", nodeId: phone.node.id });
			await eventually(async () => {
				const rows = await b.command<MemberRecord[]>({ action: "memberRecords" });
				if (rows.length !== 1 || rows[0]!.deleted !== true) {
					throw new Error("B has not learned the tombstone");
				}
				return true;
			}, "tombstone on B");

			for (const [origin, name] of [
				[readyA.webOrigin, "A"],
				[readyB.webOrigin, "B"],
			] as const) {
				const refused = await phone.session(origin);
				if (refused.status === 200) throw new Error(`${name} still authenticates a revoked phone`);
			}

			// Rejoining is an explicit re-admission on the owner, nowhere else.
			const codeB = await b.command<{ code: string }>({ action: "pairingCode" });
			const onB = await phone.join(readyB.webOrigin, codeB.code);
			if (onB.status === 200 && onB.body.ok === true) {
				throw new Error("a non-owner desk re-admitted a revoked phone");
			}
			const codeA = await a.command<{ code: string }>({ action: "pairingCode" });
			const onA = await phone.join(readyA.webOrigin, codeA.code);
			if (onA.status !== 200 || onA.body.ok !== true) {
				throw new Error(`the owner could not re-admit: ${JSON.stringify(onA.body)}`);
			}
			const minted = await phone.session(readyA.webOrigin);
			if (minted.status !== 200) throw new Error("re-admitted phone cannot open a session");
		});

		console.log(
			"mobile-join: joined once through A, replicated to B, failover auth on B, second scan recognised, grant filtered and enforced live, revocation learned everywhere, owner-only re-admission",
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
	const childProcess = Bun.spawn([process.execPath, fileURLToPath(import.meta.url)], {
		env: {
			...globalThis.process.env,
			TOAD_MOBILE_CHILD: label,
			TOAD_NODE_PORT: String(nodePort),
			TOAD_WEB_PORT: String(webPort),
			TOAD_WEB_HTTPS_PORT: String(webPort + 100),
			/* The seat's loopback door, off its fixed default so two harness desks
			   do not fight over one port — and never over a live desk's. */
			TOAD_WEB_LOOPBACK_PORT: String(webPort + 200),
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
