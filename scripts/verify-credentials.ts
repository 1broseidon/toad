/**
 * Three isolated desks proving that a provider key can be shared without being
 * shared badly — end to end over the real node plane, the real record store and
 * the real seal:
 *
 * - a key entered on A and opted in becomes usable on B and C, byte for byte,
 *   because the record replicates and each desk opens its own box
 * - it STAYS usable on B with desk A killed. This is the whole argument against
 *   proxying: the holder is not a dependency
 * - B's copy is noise to C. C is handed B's ciphertext and its own, and opens
 *   exactly one of them; the plaintext appears in no desk's snapshot
 * - the capability advertisement follows the key, so the matching ladder stops
 *   refusing a rung the desk can now serve
 * - revocation travels as a fact and every desk drops the key at once, without
 *   anyone having opted out
 * - opting out is a teardown, not a flag: with C dark, the withdrawal reports C
 *   as pending and B as confirmed, and completes when C comes back
 * - an OAuth credential never travels, and says why
 *
 * The built-in agent's own reach is stubbed to nothing on every desk
 * (TOAD_CAPS_BUILTIN_STUB), so a provider appearing in an advertisement can only
 * have come from a credential. Everything else — the wire, the seal, the store,
 * the ladder — is real.
 *
 *   bun scripts/verify-credentials.ts
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DeskCapabilityInfo, HarnessResolution, RoomCredential } from "../src/shared/types";

type JsonRecord = Record<string, unknown>;

const CHILD = process.env.TOAD_CRED_CHILD;

/** The provider the room learns to reach, and the key that teaches it. */
const PROVIDER = "stub-provider";
const MODEL = `${PROVIDER}/model-x`;
const KEY = "sk-toad-verify-8f2c41d7b6a94e05";
const SECOND_KEY = "sk-toad-verify-second-1a2b3c4d";

/** No desk has a login of its own; every advertised provider came from a key. */
const BUILTIN_STUB = { authenticated: false, providers: [] as string[], models: [] as string[] };

if (CHILD) {
	await runChild(CHILD);
} else {
	await runParent();
}

async function runChild(label: string): Promise<void> {
	const nodePort = Number(process.env.TOAD_NODE_PORT);
	const controlPort = Number(process.env.TOAD_CRED_CONTROL_PORT);
	if (!nodePort || !controlPort) throw new Error("node and control ports are required");

	const fleet = await import("../src/bun/fleet/fleet");
	const wire = await import("../src/bun/fleet/wire");
	const capabilities = await import("../src/bun/fleet/capabilities");
	const credentialPlane = await import("../src/bun/fleet/credentials");
	const credentials = await import("../src/bun/store/credentials");
	const records = await import("../src/bun/store/records");
	const seal = await import("../src/bun/node/seal");
	const identity = await import("../src/bun/node/identity");
	const nodeServer = await import("../src/bun/node/server");
	const personas = await import("../src/bun/store/personas");

	const handlers: Record<string, (params: unknown) => Promise<unknown>> = {
		listPersonas: async () => [],
		getSessionInfo: async (params) => ({
			personaId: (params as { personaId?: string })?.personaId ?? "",
			state: "stopped",
		}),
	};
	const resolve = (method: string) => handlers[method];

	fleet.initFleet({
		createTeammate: (draft) => ({ personaId: `${label}-created`, name: draft.name }),
		readTranscript: () => null,
		readThread: () => null,
		deliver: async () => ({ ok: false, detail: "not exercised" }),
		httpOrigin: () => null,
		nodeOrigin: nodeServer.nodeOrigin,
	});
	wire.initPeerWires({ send: () => {}, publishPersonas: () => {}, resolve });
	nodeServer.startNodeServer(resolve, nodePort, wire.nodeLinkServerHooks);
	/* The real event path: a credential landing here re-advertises this desk
	 * without anyone asking it to. Nothing in the harness calls refresh on the
	 * desks that merely receive a key. */
	capabilities.initDeskCapabilities();

	/** The recipient boxes on this desk's copy of a credential record. */
	const boxesOf = (id: string): Record<string, unknown> => {
		const record = records.getRecord("credential", id);
		const seals = record?.replicated.seals;
		return seals && typeof seals === "object" ? (seals as Record<string, unknown>) : {};
	};

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
							result: { identity: identity.nodeIdentity(), origin: nodeServer.nodeOrigin() },
						});
					case "invite":
						return Response.json({ ok: true, result: fleet.createFleetInvite() });
					case "join": {
						const result = await fleet.joinFleet({
							origin: String(input.origin),
							code: String(input.code),
						});
						if (result.ok) await wire.syncPeerWires();
						return Response.json({ ok: true, result });
					}
					case "sync":
						await wire.syncPeerWires();
						return Response.json({ ok: true, result: { synced: true } });
					case "settle":
						await credentialPlane.syncRoomCredentials();
						return Response.json({ ok: true, result: { settled: true } });
					case "peers":
						return Response.json({ ok: true, result: fleet.listFleetPeers() });
					case "links":
						return Response.json({ ok: true, result: wire.nodeLinkSnapshot() });
					case "caps":
						return Response.json({
							ok: true,
							result: capabilities.deskCapabilities(
								input.nodeId ? String(input.nodeId) : undefined,
							),
						});
					case "create-persona": {
						const created = personas.createPersona({
							name: String(input.name),
							backendId: String(input.backendId),
							...(input.modelId ? { modelId: String(input.modelId) } : {}),
						});
						return Response.json({ ok: true, result: created });
					}
					case "resolve":
						return Response.json({
							ok: true,
							result: capabilities.resolveTeammateHarness(
								String(input.personaId),
								String(input.targetNodeId),
							),
						});
					case "cred-create":
						return Response.json({
							ok: true,
							result: credentials.createCredential({
								providerId: String(input.providerId),
								kind: input.kind === "oauth" ? "oauth" : "api_key",
								...(input.label ? { label: String(input.label) } : {}),
								...(input.secret ? { secret: String(input.secret) } : {}),
							}),
						});
					case "cred-list":
						return Response.json({ ok: true, result: credentials.listCredentials() });
					case "cred-replicate": {
						const result = credentials.setCredentialReplication(
							String(input.id),
							input.replicate === true,
						);
						await credentialPlane.syncRoomCredentials();
						return Response.json({ ok: true, result });
					}
					case "cred-revoke": {
						const result = credentials.revokeCredential(String(input.id));
						await credentialPlane.syncRoomCredentials();
						return Response.json({ ok: true, result });
					}
					case "cred-delete":
						credentials.deleteCredential(String(input.id));
						return Response.json({ ok: true, result: { deleted: true } });
					case "cred-secret":
						/* The point of use, on this desk, with this desk's key.
						 * Over 127.0.0.1 with a scratch secret in a scratch data
						 * directory — the only place a harness may ever see one. */
						return Response.json({
							ok: true,
							result: { secret: credentials.credentialSecret(String(input.id)) ?? null },
						});
					case "cred-boxes":
						return Response.json({ ok: true, result: Object.keys(boxesOf(String(input.id))).sort() });
					case "cred-open-box": {
						// Whatever box is addressed to `recipient`, opened with THIS
						// desk's identity. Only the desk it names may succeed.
						const sealed = boxesOf(String(input.id))[String(input.recipient)];
						const opened = seal.isSealedSecret(sealed)
							? (seal.openSealed(sealed, String(input.id)) ?? null)
							: null;
						return Response.json({ ok: true, result: { opened } });
					}
					case "stop":
						setTimeout(() => {
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

type Child = {
	label: string;
	process: ReturnType<typeof Bun.spawn>;
	command<T>(input: JsonRecord): Promise<T>;
};

type Ready = { identity: { id: string; name: string }; origin: string };
type Resolved =
	| { ok: true; resolution: HarnessResolution; desk: DeskCapabilityInfo }
	| { ok: false; error: string };

async function runParent(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "toad-credentials-"));
	const base = 51_800 + Math.floor(Math.random() * 300);
	const dirs = { a: join(root, "a"), b: join(root, "b"), c: join(root, "c") };
	const ports = {
		a: { node: base, control: base + 10 },
		b: { node: base + 1, control: base + 11 },
		c: { node: base + 2, control: base + 12 },
	};
	let a = spawnChild("a", ports.a.node, ports.a.control, dirs.a);
	let b = spawnChild("b", ports.b.node, ports.b.control, dirs.b);
	let c = spawnChild("c", ports.c.node, ports.c.control, dirs.c);
	const live = () => [a, b, c];

	try {
		const [readyA, readyB, readyC] = await Promise.all([
			eventually(() => a.command<Ready>({ action: "ready" }), "node A"),
			eventually(() => b.command<Ready>({ action: "ready" }), "node B"),
			eventually(() => c.command<Ready>({ action: "ready" }), "node C"),
		]);
		const idA = readyA.identity.id;
		const idB = readyB.identity.id;
		const idC = readyC.identity.id;

		for (const leaf of [b, c]) {
			const invite = await a.command<{ origin?: string; code?: string; error?: string }>({
				action: "invite",
			});
			if (!invite.origin || !invite.code) throw new Error(`invite failed: ${invite.error}`);
			const joined = await leaf.command<{ ok: boolean; error?: string }>({
				action: "join",
				origin: invite.origin,
				code: invite.code,
			});
			if (!joined.ok) throw new Error(`${leaf.label} could not join A: ${joined.error}`);
		}
		await eventually(
			async () => {
				await a.command({ action: "sync" });
				for (const [child, others] of [
					[b, [idA, idC]],
					[c, [idA, idB]],
				] as const) {
					const peers = await child.command<Array<{ id: string }>>({ action: "peers" });
					for (const id of others) {
						if (!peers.some((peer) => peer.id === id)) {
							throw new Error(`${child.label} does not know ${id} yet`);
						}
					}
				}
				return true;
			},
			"the star closes into a mesh",
			45_000,
		);

		// A teammate pinned to a model only this provider serves. Nothing on the
		// ladder can run it anywhere until a key for that provider exists.
		const teammate = await a.command<{ id: string }>({
			action: "create-persona",
			name: "Keyed",
			backendId: "pi",
			modelId: MODEL,
		});
		const rungOn = async (child: Child, targetNodeId: string): Promise<HarnessResolution> => {
			const result = await child.command<Resolved>({
				action: "resolve",
				personaId: teammate.id,
				targetNodeId,
			});
			if (!result.ok) throw new Error(`resolve refused: ${result.error}`);
			return result.resolution;
		};
		if ((await rungOn(a, idB)).rung !== "unavailable") {
			throw new Error("desk B matched a provider nothing on it can reach");
		}

		// ---------------------------------------------------------------- opt in
		const key = await a.command<RoomCredential>({
			action: "cred-create",
			providerId: PROVIDER,
			label: "Shared key",
			secret: KEY,
		});
		if (key.replicate) throw new Error("a fresh credential replicated without being asked");

		// The record travels before the key does: the room-level list is a room
		// fact, and every desk can already see the credential exists, whose it is,
		// and that it is not shared.
		await eventually(
			async () => {
				for (const child of [b, c]) {
					const held = (await child.command<RoomCredential[]>({ action: "cred-list" })).find(
						(row) => row.id === key.id,
					);
					if (!held) throw new Error(`${child.label} cannot see the credential yet`);
					if (held.ownerNode !== idA) throw new Error("the owner desk did not survive the wire");
					if (held.usableHere) throw new Error(`${child.label} can use a key nobody shared`);
				}
				return true;
			},
			"an unshared credential is visible to the room and usable by nobody else",
			30_000,
		);

		await a.command({ action: "cred-replicate", id: key.id, replicate: true });

		await eventually(
			async () => {
				for (const child of [b, c]) {
					const secret = await child.command<{ secret: string | null }>({
						action: "cred-secret",
						id: key.id,
					});
					if (secret.secret !== KEY) {
						throw new Error(`${child.label} cannot open the key it was sealed`);
					}
				}
				return true;
			},
			"an opted-in key opens on every desk in the room",
			30_000,
		);

		// -------------------------------------------- one box per desk, not a blob
		const boxes = await b.command<string[]>({ action: "cred-boxes", id: key.id });
		if (JSON.stringify(boxes) !== JSON.stringify([idB, idC].sort())) {
			throw new Error(`the record carries boxes for ${boxes.join(", ")}, not one per recipient`);
		}
		const mine = await c.command<{ opened: string | null }>({
			action: "cred-open-box",
			id: key.id,
			recipient: idC,
		});
		if (mine.opened !== KEY) throw new Error("C could not open the box addressed to C");
		const theirs = await c.command<{ opened: string | null }>({
			action: "cred-open-box",
			id: key.id,
			recipient: idB,
		});
		if (theirs.opened !== null) {
			throw new Error("C opened the box addressed to B — the seal is not per recipient");
		}
		for (const [label, dir] of Object.entries(dirs)) {
			const snapshot = readFileSync(join(dir, "store-snapshot.json"), "utf8");
			// A is the owner and holds plaintext in its own 0600 vault, which is a
			// different file. No desk's replicated record may contain the key.
			if (snapshot.includes(KEY)) {
				throw new Error(`desk ${label} wrote the key in clear into its record snapshot`);
			}
		}

		// ------------------------------------------- the advertisement follows it
		await eventually(
			async () => {
				for (const [child, id] of [
					[a, idB],
					[a, idC],
				] as const) {
					const caps = await child.command<DeskCapabilityInfo | null>({ action: "caps", nodeId: id });
					if (!caps?.capabilities.builtin.providers.includes(PROVIDER)) {
						throw new Error(`${id} does not advertise ${PROVIDER} yet`);
					}
				}
				const resolution = await rungOn(a, idB);
				if (resolution.rung !== "exact") {
					throw new Error(`the ladder still answers ${resolution.rung} for a desk holding the key`);
				}
				return true;
			},
			"a replicated key reaches the advertisement and the ladder serves the rung",
			30_000,
		);

		// ------------------------------------------------- OAuth does not travel
		const login = await a.command<RoomCredential>({
			action: "cred-create",
			providerId: "oauth-provider",
			label: "Desk login",
			kind: "oauth",
		});
		const refusal = await a
			.command({ action: "cred-replicate", id: login.id, replicate: true })
			.then(() => null)
			.catch((error: Error) => error.message);
		if (!refusal || !/OAuth/i.test(refusal)) {
			throw new Error(`an OAuth credential was allowed to replicate: ${refusal ?? "no refusal"}`);
		}
		await eventually(
			async () => {
				const onB = (await b.command<RoomCredential[]>({ action: "cred-list" })).find(
					(row) => row.id === login.id,
				);
				if (!onB) throw new Error("B has not heard about the OAuth credential yet");
				if (onB.usableHere || onB.sealedTo.length > 0) {
					throw new Error("an OAuth credential put material on another desk");
				}
				const secret = await b.command<{ secret: string | null }>({
					action: "cred-secret",
					id: login.id,
				});
				if (secret.secret !== null) throw new Error("an OAuth credential handed out a secret");
				return true;
			},
			"an OAuth credential stays bound to its desk",
			30_000,
		);

		// ------------------------------------ the owner desk dies; the key lives
		a.process.kill();
		await a.process.exited;
		const survived = await b.command<{ secret: string | null }>({
			action: "cred-secret",
			id: key.id,
		});
		if (survived.secret !== KEY) {
			throw new Error("B lost the key when its owner desk went down — this is the whole point");
		}
		a = spawnChild("a", ports.a.node, ports.a.control, dirs.a);
		await eventually(() => a.command<Ready>({ action: "ready" }), "node A restarted", 30_000);
		await eventually(
			async () => {
				await Promise.all(live().map((child) => child.command({ action: "sync" })));
				await linkUp(a, idB);
				await linkUp(b, idA);
				return true;
			},
			"the restarted owner desk re-links",
			60_000,
		);

		// --------------------------------- opting out, with one desk in the dark
		c.process.kill();
		await c.process.exited;
		const withdrawn = await a.command<RoomCredential>({
			action: "cred-replicate",
			id: key.id,
			replicate: false,
		});
		if (withdrawn.replicate) throw new Error("the credential is still opted in");
		await eventually(
			async () => {
				await a.command({ action: "settle" });
				const teardown = (await a.command<RoomCredential[]>({ action: "cred-list" })).find(
					(row) => row.id === key.id,
				)?.teardown;
				if (!teardown) throw new Error("opting out reported no teardown at all");
				if (!teardown.confirmed.includes(idB)) throw new Error("B, which is up, was not confirmed");
				if (!teardown.pending.includes(idC)) {
					throw new Error("a desk that is dark was reported as done");
				}
				return true;
			},
			"opting out confirms the live desk and reports the dark one as pending",
			45_000,
		);
		const goneOnB = await b.command<{ secret: string | null }>({
			action: "cred-secret",
			id: key.id,
		});
		if (goneOnB.secret !== null) throw new Error("B kept the key through a teardown");
		// The pending fact is the room's, not the owner's private note.
		await eventually(
			async () => {
				const onB = (await b.command<RoomCredential[]>({ action: "cred-list" })).find(
					(row) => row.id === key.id,
				);
				if (!onB?.teardown?.pending.includes(idC)) {
					throw new Error("B does not see the outstanding teardown");
				}
				return true;
			},
			"every desk reads the same outstanding teardown",
			30_000,
		);

		// C comes back. It applies the withdrawal, and the owner completes only
		// once it has asked C and heard that C holds nothing.
		c = spawnChild("c", ports.c.node, ports.c.control, dirs.c);
		await eventually(() => c.command<Ready>({ action: "ready" }), "node C restarted", 30_000);
		await eventually(
			async () => {
				await Promise.all(live().map((child) => child.command({ action: "sync" })));
				await a.command({ action: "settle" });
				const onC = (await c.command<RoomCredential[]>({ action: "cred-list" })).find(
					(row) => row.id === key.id,
				);
				if (onC?.usableHere) throw new Error("the returning desk still holds its copy");
				const onA = (await a.command<RoomCredential[]>({ action: "cred-list" })).find(
					(row) => row.id === key.id,
				);
				if (onA?.teardown) {
					throw new Error(`the teardown is still waiting on ${onA.teardown.pending.join(", ")}`);
				}
				return true;
			},
			"the teardown completes when the dark desk returns",
			60_000,
		);

		// ------------------------------------------------- revocation as a fact
		const second = await a.command<RoomCredential>({
			action: "cred-create",
			providerId: PROVIDER,
			label: "Rotated key",
			secret: SECOND_KEY,
		});
		await a.command({ action: "cred-replicate", id: second.id, replicate: true });
		await eventually(
			async () => {
				for (const child of [b, c]) {
					const secret = await child.command<{ secret: string | null }>({
						action: "cred-secret",
						id: second.id,
					});
					if (secret.secret !== SECOND_KEY) throw new Error(`${child.label} has not been sealed yet`);
				}
				return true;
			},
			"the second key reaches the room",
			45_000,
		);

		// Nobody opts out. The fact alone has to kill it, on every desk.
		await a.command({ action: "cred-revoke", id: second.id });
		await eventually(
			async () => {
				for (const child of live()) {
					const secret = await child.command<{ secret: string | null }>({
						action: "cred-secret",
						id: second.id,
					});
					if (secret.secret !== null) {
						throw new Error(`${child.label} still serves a revoked key`);
					}
					const row = (await child.command<RoomCredential[]>({ action: "cred-list" })).find(
						(entry) => entry.id === second.id,
					);
					if (!row?.revoked) throw new Error(`${child.label} has not heard the revocation`);
					if (row.usableHere || row.sealedTo.length > 0) {
						throw new Error(`${child.label} still holds material for a revoked key`);
					}
				}
				return true;
			},
			"revocation travels as a fact and the key dies everywhere",
			45_000,
		);

		console.log(
			"credentials: an opted-in key reaches every desk sealed one box per desk, survives its owner desk dying, teaches the ladder a rung, refuses to travel for OAuth, dies everywhere on revocation, and un-replicating reports the dark desk as pending until it returns",
		);
	} finally {
		await Promise.all(
			live().map((child) => child.command({ action: "stop" }).catch(() => undefined)),
		);
		await Promise.all(live().map((child) => child.process.exited));
		rmSync(root, { recursive: true, force: true });
	}
}

function spawnChild(label: string, nodePort: number, controlPort: number, dataDir: string): Child {
	const childProcess = Bun.spawn([process.execPath, fileURLToPath(import.meta.url)], {
		env: {
			...globalThis.process.env,
			TOAD_CRED_CHILD: label,
			TOAD_NODE_PORT: String(nodePort),
			TOAD_CRED_CONTROL_PORT: String(controlPort),
			TOAD_CAPS_BUILTIN_STUB: JSON.stringify(BUILTIN_STUB),
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
				signal: AbortSignal.timeout(20_000),
			});
			const body = (await response.json()) as { ok: boolean; result?: T; error?: string };
			if (!response.ok || !body.ok) throw new Error(`${label}: ${body.error ?? response.status}`);
			return body.result as T;
		},
	};
}

/** Throws unless this desk holds a live authenticated link to that node id. */
async function linkUp(child: Child, nodeId: string): Promise<void> {
	const links = await child.command<Array<{ nodeId: string; up: boolean }>>({ action: "links" });
	if (!links.find((link) => link.nodeId === nodeId)?.up) {
		throw new Error(`${child.label} has no live link to ${nodeId}`);
	}
}

async function eventually<T>(run: () => Promise<T>, label: string, timeoutMs = 12_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let last: unknown;
	for (;;) {
		try {
			return await run();
		} catch (error) {
			last = error;
			if (Date.now() > deadline) {
				throw new Error(`${label}: ${last instanceof Error ? last.message : String(last)}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	}
}
