/**
 * Three isolated desks proving that a phone paired with one of them can be
 * reached from any of them — end to end over the real node plane, the real
 * record store and the real seal:
 *
 * - a phone registered on A becomes addressable on B and C, byte for byte,
 *   because the registration replicates and each desk opens its own box
 * - the signing key replicates the same way, because an address you cannot post
 *   to is not reach. Both halves, or the feature is half a feature
 * - B's box is noise to C. C is handed B's ciphertext and its own, and opens
 *   exactly one of them; the token appears in no desk's room-level view
 * - it all STAYS true with desk A killed. This is the whole argument: the
 *   pairing desk is not a mute button
 * - a prune travels. B watches Apple reject the token, stops using it at once,
 *   and — because only the owner may publish a fact — keeps telling A until A
 *   says so to the room, at which point C stops too
 * - a prune names a generation, so a report that crosses paths with the phone's
 *   next launch cannot kill the token that replaced it
 * - unpairing is a teardown, not a flag: with C dark, the withdrawal reports C
 *   as pending and B as confirmed, and completes when C comes back
 *
 * Nothing here contacts Apple. The key is self-signed, so a real send would
 * only ever earn `InvalidProviderToken` — `verify-push.ts` covers that half.
 * What this proves is what the room knows and who can act on it.
 *
 *   bun scripts/verify-push-plane.ts
 */
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RoomCredential } from "../src/shared/types";
import type { PushCredentialStatus } from "../src/bun/push/apns";
import type { PushRegistration, PushTarget } from "../src/bun/store/push";

type JsonRecord = Record<string, unknown>;

const CHILD = process.env.TOAD_PUSH_CHILD;

const FIRST_TOKEN = "a1".repeat(32);
const SECOND_TOKEN = "b2".repeat(32);

if (CHILD) {
	await runChild(CHILD);
} else {
	await runParent();
}

async function runChild(label: string): Promise<void> {
	const nodePort = Number(process.env.TOAD_NODE_PORT);
	const controlPort = Number(process.env.TOAD_PUSH_CONTROL_PORT);
	if (!nodePort || !controlPort) throw new Error("node and control ports are required");

	const fleet = await import("../src/bun/fleet/fleet");
	const wire = await import("../src/bun/fleet/wire");
	const pushPlane = await import("../src/bun/fleet/push");
	const credentialPlane = await import("../src/bun/fleet/credentials");
	const push = await import("../src/bun/store/push");
	const credentials = await import("../src/bun/store/credentials");
	const records = await import("../src/bun/store/records");
	const seal = await import("../src/bun/node/seal");
	const identity = await import("../src/bun/node/identity");
	const nodeServer = await import("../src/bun/node/server");
	const devices = await import("../src/bun/web/devices");
	const apns = await import("../src/bun/push/apns");

	const handlers: Record<string, (params: unknown) => Promise<unknown>> = {
		listPersonas: async () => [],
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

	/** The recipient boxes on this desk's copy of a registration record. */
	const boxesOf = (id: string): Record<string, unknown> => {
		const record = records.getRecord("push", id);
		const seals = record?.replicated.seals;
		return seals && typeof seals === "object" ? (seals as Record<string, unknown>) : {};
	};

	/** This desk's own APNs credential row, whoever owns it. */
	const keyRow = (): RoomCredential | undefined =>
		credentials.listCredentials().find((row) => row.providerId === apns.APNS_PROVIDER_ID);

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
						await Promise.all([pushPlane.syncRoomPush(), credentialPlane.syncRoomCredentials()]);
						return Response.json({ ok: true, result: { settled: true } });
					case "peers":
						return Response.json({ ok: true, result: fleet.listFleetPeers() });
					case "links":
						return Response.json({ ok: true, result: wire.nodeLinkSnapshot() });

					// ------------------------------------------------ the signing key
					case "key-install": {
						const result = apns.installPushKey({
							pem: String(input.pem),
							keyId: "ABCD123456",
							teamId: "TEAM123456",
						});
						return Response.json({ ok: true, result });
					}
					case "key-replicate": {
						const row = keyRow();
						if (!row) throw new Error("no APNs credential to replicate");
						credentials.setCredentialReplication(row.id, input.replicate === true);
						await credentialPlane.syncRoomCredentials();
						return Response.json({ ok: true, result: { id: row.id } });
					}
					case "key-status":
						return Response.json({ ok: true, result: apns.pushCredentials() });

					// ----------------------------------------------- the registration
					case "push-pair": {
						const code = devices.createPairing();
						const device = devices.claimPairing(code, String(input.name ?? "verify-phone"));
						if (!device) throw new Error("pairing should claim");
						return Response.json({ ok: true, result: { deviceId: device.id } });
					}
					case "push-register": {
						const registration = push.registerPushDevice({
							deviceId: String(input.deviceId),
							token: String(input.token),
							environment: "sandbox",
						});
						await pushPlane.syncRoomPush();
						return Response.json({ ok: true, result: registration });
					}
					case "push-list":
						return Response.json({ ok: true, result: push.listPushRegistrations() });
					case "push-fanout":
						return Response.json({ ok: true, result: push.pushFanout() });
					case "push-boxes":
						return Response.json({
							ok: true,
							result: Object.keys(boxesOf(String(input.id))).sort(),
						});
					case "push-open-box": {
						// Whatever box is addressed to `recipient`, opened with THIS
						// desk's identity. Only the desk it names may succeed.
						const sealed = boxesOf(String(input.id))[String(input.recipient)];
						const opened = seal.isSealedSecret(sealed)
							? (seal.openSealed(sealed, String(input.id)) ?? null)
							: null;
						return Response.json({ ok: true, result: { opened } });
					}
					case "push-dead": {
						const pruned = push.reportPushTokenDead(
							String(input.id),
							typeof input.generation === "number" ? input.generation : undefined,
						);
						await pushPlane.syncRoomPush();
						return Response.json({ ok: true, result: { pruned } });
					}
					case "push-unpair": {
						const removed = push.unpairPushDevice(String(input.id));
						await pushPlane.syncRoomPush();
						return Response.json({ ok: true, result: { removed } });
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

async function runParent(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "toad-push-plane-"));
	const base = 52_400 + Math.floor(Math.random() * 300);
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

	const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
	const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;

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
				await Promise.all(live().map((child) => child.command({ action: "sync" })));
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

		// --------------------------------------------- both halves reach the room
		const installed = await a.command<{ ok: boolean; error?: string }>({
			action: "key-install",
			pem,
		});
		if (!installed.ok) throw new Error(`the signing key should install: ${installed.error}`);
		const keyOnA = await a.command<PushCredentialStatus>({ action: "key-status" });
		if (!keyOnA.configured || keyOnA.keyFrom !== "here") {
			throw new Error("the desk the key was typed on should say so");
		}
		if (keyOnA.keyReplicated) throw new Error("a fresh signing key must not replicate unasked");

		const pairing = await a.command<{ deviceId: string }>({ action: "push-pair" });
		const registration = await a.command<PushRegistration>({
			action: "push-register",
			deviceId: pairing.deviceId,
			token: FIRST_TOKEN,
		});
		if (registration.ownerNode !== idA) throw new Error("the pairing desk should own the record");

		// An address without a key is half a feature, so prove the halves are
		// independent: the registration lands everywhere before the key does, and
		// a desk holding only the address cannot yet send.
		await eventually(
			async () => {
				await Promise.all(live().map((child) => child.command({ action: "sync" })));
				for (const child of [b, c]) {
					const rows = await child.command<PushRegistration[]>({ action: "push-list" });
					const row = rows.find((entry) => entry.id === registration.id);
					if (!row) throw new Error(`${child.label} cannot see the registration yet`);
					if (row.ownerNode !== idA) throw new Error("the owner desk did not survive the wire");
					if (!row.addressableHere) throw new Error(`${child.label} was not sealed an address`);
					if (JSON.stringify(row).includes(FIRST_TOKEN)) {
						throw new Error(`${child.label}'s room-level view carries the raw token`);
					}
					const status = await child.command<PushCredentialStatus>({ action: "key-status" });
					if (status.configured) throw new Error(`${child.label} signs with a key nobody shared`);
				}
				return true;
			},
			"the address reaches every desk, and a desk with no key still cannot send",
			45_000,
		);

		await a.command({ action: "key-replicate", replicate: true });
		await eventually(
			async () => {
				await Promise.all(live().map((child) => child.command({ action: "sync" })));
				for (const child of [b, c]) {
					const status = await child.command<PushCredentialStatus>({ action: "key-status" });
					if (!status.configured) throw new Error(`${child.label} has not been sealed the key`);
					if (status.keyFrom !== "room") throw new Error("a shared key should say where it came from");
					if (status.keyId !== "ABCD123456" || status.teamId !== "TEAM123456") {
						throw new Error("the key id and team id must travel with the key, or it is unusable");
					}
				}
				return true;
			},
			"the signing key reaches every desk, identifiers and all",
			45_000,
		);

		// ---------------------------------------------- one box per desk, exactly
		const boxes = await b.command<string[]>({ action: "push-boxes", id: registration.id });
		if (JSON.stringify(boxes) !== JSON.stringify([idB, idC].sort())) {
			throw new Error(`the record should carry a box per recipient desk, got ${boxes.join(", ")}`);
		}
		const cOwnBox = await c.command<{ opened: string | null }>({
			action: "push-open-box",
			id: registration.id,
			recipient: idC,
		});
		if (cOwnBox.opened !== FIRST_TOKEN) throw new Error("C could not open the box addressed to it");
		const cOnBsBox = await c.command<{ opened: string | null }>({
			action: "push-open-box",
			id: registration.id,
			recipient: idB,
		});
		if (cOnBsBox.opened !== null) throw new Error("C opened a box sealed to B — sealing is per desk");

		// ----------------------------- the owner desk dies; the phone stays reachable
		a.process.kill();
		await a.process.exited;
		const reachOnB = await b.command<PushTarget[]>({ action: "push-fanout" });
		if (reachOnB.length !== 1 || reachOnB[0]?.token !== FIRST_TOKEN) {
			throw new Error("B lost the phone when its pairing desk went down — this is the whole point");
		}
		if (!(await b.command<PushCredentialStatus>({ action: "key-status" })).configured) {
			throw new Error("B lost the signing key when the desk that typed it went down");
		}

		// A prune observed while the owner is dark stops the desk that saw it and
		// nobody else. That is the honest state, not a desk forgetting for the room.
		await b.command({ action: "push-dead", id: registration.id, generation: registration.generation });
		if ((await b.command<PushTarget[]>({ action: "push-fanout" })).length !== 0) {
			throw new Error("B kept posting to an address Apple told it was dead");
		}
		const onCWhileDark = await c.command<PushRegistration[]>({ action: "push-list" });
		if (onCWhileDark.find((row) => row.id === registration.id)?.addressableHere !== true) {
			throw new Error("C dropped an address on B's say-so; only the owner publishes a fact");
		}

		// ------------------------------------- the owner returns and the prune travels
		a = spawnChild("a", ports.a.node, ports.a.control, dirs.a);
		await eventually(() => a.command<Ready>({ action: "ready" }), "node A restarted", 30_000);
		await eventually(
			async () => {
				await Promise.all(live().map((child) => child.command({ action: "sync" })));
				await Promise.all(live().map((child) => child.command({ action: "settle" })));
				for (const child of live()) {
					const row = (await child.command<PushRegistration[]>({ action: "push-list" })).find(
						(entry) => entry.id === registration.id,
					);
					if (!row?.dead) throw new Error(`${child.label} has not heard the prune`);
					if (row.addressableHere) throw new Error(`${child.label} still holds a dead address`);
				}
				return true;
			},
			"a prune observed on one desk becomes a fact the whole room honours",
			60_000,
		);

		// --------------------------------- the phone relaunches with a fresh token
		const reborn = await a.command<PushRegistration>({
			action: "push-register",
			deviceId: pairing.deviceId,
			token: SECOND_TOKEN,
		});
		if (reborn.generation <= registration.generation) {
			throw new Error("a different token must be a new generation");
		}
		await eventually(
			async () => {
				await Promise.all(live().map((child) => child.command({ action: "sync" })));
				for (const child of [b, c]) {
					const fanout = await child.command<PushTarget[]>({ action: "push-fanout" });
					if (fanout[0]?.token !== SECOND_TOKEN) {
						throw new Error(`${child.label} is still holding the replaced token`);
					}
					if (fanout.length !== 1) throw new Error("one phone should be one fan-out target");
				}
				return true;
			},
			"the room converges on the token the phone actually has",
			45_000,
		);

		// A late report about the token that was replaced must not kill the new one.
		await b.command({
			action: "push-dead",
			id: registration.id,
			generation: registration.generation,
		});
		if ((await b.command<PushTarget[]>({ action: "push-fanout" }))[0]?.token !== SECOND_TOKEN) {
			throw new Error("a stale prune killed the token that replaced it");
		}

		// ------------------------------- unpairing, with one desk in the dark
		c.process.kill();
		await c.process.exited;
		await a.command({ action: "push-unpair", id: registration.id });
		await eventually(
			async () => {
				await a.command({ action: "settle" });
				const row = (await a.command<PushRegistration[]>({ action: "push-list" })).find(
					(entry) => entry.id === registration.id,
				);
				if (!row?.teardown) throw new Error("unpairing reported no teardown at all");
				if (!row.teardown.confirmed.includes(idB)) throw new Error("B, which is up, was not confirmed");
				if (!row.teardown.pending.includes(idC)) {
					throw new Error("a desk that is dark was reported as done");
				}
				return true;
			},
			"unpairing confirms the live desk and reports the dark one as pending",
			45_000,
		);
		if ((await b.command<PushTarget[]>({ action: "push-fanout" })).length !== 0) {
			throw new Error("B kept the address of an unpaired phone");
		}

		// C comes back, applies the withdrawal, and the owner completes only once
		// it has asked C and heard that C holds nothing.
		c = spawnChild("c", ports.c.node, ports.c.control, dirs.c);
		await eventually(() => c.command<Ready>({ action: "ready" }), "node C restarted", 30_000);
		await eventually(
			async () => {
				await Promise.all(live().map((child) => child.command({ action: "sync" })));
				await Promise.all(live().map((child) => child.command({ action: "settle" })));
				if ((await c.command<PushTarget[]>({ action: "push-fanout" })).length !== 0) {
					throw new Error("the returning desk still holds its copy");
				}
				const onA = (await a.command<PushRegistration[]>({ action: "push-list" })).find(
					(entry) => entry.id === registration.id,
				);
				if (onA) throw new Error("a settled withdrawal should leave nothing behind");
				return true;
			},
			"the withdrawal completes when the dark desk returns",
			60_000,
		);

		console.log(
			"push plane: a phone registered on one desk is addressable from every desk, the signing key travels sealed beside it with its identifiers, both survive the pairing desk dying, a prune observed anywhere becomes a fact the owner publishes and the room honours, a stale prune cannot kill the token that replaced it, and unpairing reports the dark desk as pending until it returns",
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
			TOAD_PUSH_CHILD: label,
			TOAD_NODE_PORT: String(nodePort),
			TOAD_PUSH_CONTROL_PORT: String(controlPort),
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
