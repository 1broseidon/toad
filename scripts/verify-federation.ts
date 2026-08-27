/**
 * Two isolated desktops proving Phase 5's headline claims (docs/federation.md
 * §9 SLICE-D, §10 gate 3):
 *
 * - personas created on either desktop converge into both stores, first-hand
 * - a restart shows the whole room from the local store, with nobody to poll
 * - a live rename reaches the peer without any relink; a checkpoint (machine
 *   class) never crosses the wire at all
 * - a delete ships as a tombstone
 * - a dropped and retried link changes nothing twice
 * - an idle mesh sends nothing — there is no damper left to credit
 *
 *   bun scripts/verify-federation.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionInfo } from "../src/shared/types";

type JsonRecord = Record<string, unknown>;

const CHILD = process.env.TOAD_FEDERATION_CHILD;

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
	const controlPort = Number(process.env.TOAD_NODE_CONTROL_PORT);
	if (!nodePort || !controlPort) throw new Error("node and control ports are required");

	const fleet = await import("../src/bun/fleet/fleet");
	const wire = await import("../src/bun/fleet/wire");
	const sync = await import("../src/bun/fleet/sync");
	const metrics = await import("../src/bun/fleet/metrics");
	const admission = await import("../src/bun/node/admission");
	const discovery = await import("../src/bun/node/discovery");
	const identity = await import("../src/bun/node/identity");
	const nodeServer = await import("../src/bun/node/server");
	const personas = await import("../src/bun/store/personas");
	const records = await import("../src/bun/store/records");

	const pushes: Array<{ name: string; payload: unknown }> = [];
	const handlers: Record<string, (params: unknown) => Promise<unknown>> = {
		// onWireUp refreshes session info for every remote teammate right after
		// a link comes up; a resolver missing this method would throw there.
		getSessionInfo: async (params) => {
			const personaId = (params as { personaId?: string })?.personaId ?? "";
			return dummySessionInfo(personaId);
		},
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
	wire.initPeerWires({
		send: (name, payload) => pushes.push({ name, payload }),
		publishPersonas: () => {},
		resolve,
	});
	nodeServer.startNodeServer(resolve, nodePort, wire.nodeLinkServerHooks);
	discovery.startNodeDiscovery(nodePort);

	/** Every first-hand owner this node currently knows about: itself plus
	 *  every linked peer — the only owners whose oplog rows can exist here. */
	function knownOwners(): string[] {
		return [records.localNodeId(), ...fleet.listFleetPeers().map((peer) => peer.id)];
	}

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
						return Response.json({ ok: true, result: admission.createNodeInvite() });
					case "join": {
						const result = await admission.joinNodeInvite(String(input.origin), String(input.code));
						if (result.ok) await wire.syncPeerWires();
						return Response.json({ ok: true, result });
					}
					case "peers":
						return Response.json({ ok: true, result: fleet.listFleetPeers() });
					case "links":
						return Response.json({ ok: true, result: wire.nodeLinkSnapshot() });
					case "syncWires":
						await wire.syncPeerWires();
						return Response.json({ ok: true, result: { synced: true } });
					case "drop-link":
						nodeServer.closeNodePeer(String(input.id));
						return Response.json({ ok: true, result: { dropped: true } });
					case "createPersona": {
						const created = personas.createPersona({
							name: String(input.name),
							...(typeof input.team === "string" ? { team: input.team } : {}),
						});
						return Response.json({ ok: true, result: { id: created.id, name: created.name } });
					}
					case "renamePersona": {
						const updated = personas.updatePersona(String(input.id), { name: String(input.name) });
						return Response.json({ ok: true, result: { id: updated.id, name: updated.name } });
					}
					case "checkpoint": {
						personas.checkpointSession(
							String(input.id),
							String(input.backendId),
							String(input.sessionId),
						);
						return Response.json({ ok: true, result: { checkpointed: true } });
					}
					case "deletePersona":
						personas.deletePersona(String(input.id));
						return Response.json({ ok: true, result: { deleted: true } });
					case "remotePersonas":
						return Response.json({ ok: true, result: wire.remotePersonas() });
					case "fleetRosters":
						return Response.json({ ok: true, result: await fleet.fleetRosters() });
					case "records":
						return Response.json({
							ok: true,
							result: records.listRecords("persona", { includeTombstones: true }),
						});
					case "record":
						return Response.json({
							ok: true,
							result: records.getRecord("persona", String(input.id)) ?? null,
						});
					case "oplogCount": {
						const count = knownOwners().reduce(
							(sum, owner) => sum + records.oplogAfter(owner, 0).length,
							0,
						);
						return Response.json({ ok: true, result: { count } });
					}
					case "syncSnapshot":
						return Response.json({ ok: true, result: sync.syncSnapshot() });
					case "meshSnapshot":
						return Response.json({ ok: true, result: metrics.meshSnapshot() });
					case "meshReset":
						metrics.meshReset();
						return Response.json({ ok: true, result: { reset: true } });
					case "pushes":
						return Response.json({ ok: true, result: [...pushes] });
					case "stop":
						setTimeout(() => {
							discovery.stopNodeDiscovery();
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

/* ----------------------------------------------------------------- parent */

type Child = {
	label: string;
	nodePort: number;
	controlPort: number;
	dataDir: string;
	process: ReturnType<typeof Bun.spawn>;
	command<T>(input: JsonRecord): Promise<T>;
};

type Ready = {
	identity: { id: string; name: string; fingerprint: string };
	origin: string;
};
type Peer = { id: string; name: string; origin: string; addedAt: number; lastSeenAt?: number };
type Link = {
	nodeId: string;
	dialer: boolean;
	up: boolean;
	direction: "incoming" | "outgoing" | null;
};
type Invite = { origin?: string; code?: string; expiresAt?: number; error?: string };
type Joined = { ok: boolean; peer?: { id: string; name: string }; error?: string };
type CreatedPersona = { id: string; name: string };
type RemotePersona = { id: string; node?: { id: string; name: string }; name: string };
type FleetTeammate = { personaId: string; name: string };
type FleetRoster = {
	node: { id: string; name: string };
	teammates: FleetTeammate[];
	online: boolean;
};
type ResourceRow = {
	kind: string;
	id: string;
	ownerNode: string;
	ownerEpoch: number;
	version: number;
	updatedAt: number;
	deleted: boolean;
	replicated: Record<string, unknown>;
};
type MeshSnapshot = { startedAt: number; totals: Record<string, number>; bytes: Record<string, number> };
type Push = { name: string; payload: unknown };

async function runParent(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "toad-federation-"));
	const base = 52_000 + Math.floor(Math.random() * 500);
	const portA = base;
	const controlPortA = base + 10;
	const portB = base + 1;
	const controlPortB = base + 11;
	const dataDirA = join(root, "a");
	const dataDirB = join(root, "b");

	let a = spawnChild("a", portA, controlPortA, dataDirA);
	let b = spawnChild("b", portB, controlPortB, dataDirB);
	let live: Child[] = [a, b];

	try {
		let [readyA, readyB] = await Promise.all([
			eventually(() => a.command<Ready>({ action: "ready" }), "node A ready"),
			eventually(() => b.command<Ready>({ action: "ready" }), "node B ready"),
		]);

		await step("pair over address/token", async () => {
			const invite = await a.command<Invite>({ action: "invite" });
			if (!invite.origin || !invite.code) throw new Error(`invite failed: ${invite.error}`);
			const joined = await b.command<Joined>({ action: "join", origin: invite.origin, code: invite.code });
			if (!joined.ok) throw new Error(`join failed: ${joined.error}`);
			await assertLinked(a, b, readyA, readyB);
		});

		let personaA1 = "";
		let personaA2 = "";
		let personaB1 = "";
		let personaB2 = "";

		await step("G3.1 converge", async () => {
			[personaA1, personaA2] = (
				await Promise.all([
					a.command<CreatedPersona>({ action: "createPersona", name: "A-one", team: "core" }),
					a.command<CreatedPersona>({ action: "createPersona", name: "A-two", team: "core" }),
				])
			).map((p) => p.id);
			[personaB1, personaB2] = (
				await Promise.all([
					b.command<CreatedPersona>({ action: "createPersona", name: "B-one", team: "core" }),
					b.command<CreatedPersona>({ action: "createPersona", name: "B-two", team: "core" }),
				])
			).map((p) => p.id);

			await eventually(async () => {
				const [recordsA, recordsB] = await Promise.all([
					a.command<ResourceRow[]>({ action: "records" }),
					b.command<ResourceRow[]>({ action: "records" }),
				]);
				if (recordsA.length !== 4) throw new Error(`A holds ${recordsA.length} records, want 4`);
				if (recordsB.length !== 4) throw new Error(`B holds ${recordsB.length} records, want 4`);
				return true;
			}, "both stores hold all four records");

			await eventually(async () => {
				const [remoteA, remoteB] = await Promise.all([
					a.command<RemotePersona[]>({ action: "remotePersonas" }),
					b.command<RemotePersona[]>({ action: "remotePersonas" }),
				]);
				const expectedFromB = [
					`${readyB.identity.id}/${personaB1}`,
					`${readyB.identity.id}/${personaB2}`,
				].sort();
				const expectedFromA = [
					`${readyA.identity.id}/${personaA1}`,
					`${readyA.identity.id}/${personaA2}`,
				].sort();
				if (
					remoteA.length !== 2 ||
					!remoteA.every((p) => p.node?.id === readyB.identity.id) ||
					JSON.stringify(remoteA.map((p) => p.id).sort()) !== JSON.stringify(expectedFromB)
				) {
					throw new Error("A's remotePersonas does not answer B's two qualified teammates");
				}
				if (
					remoteB.length !== 2 ||
					!remoteB.every((p) => p.node?.id === readyA.identity.id) ||
					JSON.stringify(remoteB.map((p) => p.id).sort()) !== JSON.stringify(expectedFromA)
				) {
					throw new Error("B's remotePersonas does not answer A's two qualified teammates");
				}
				return true;
			}, "remotePersonas answers two qualified rows with node set");
		});

		await step("G3.2 restart shows the room", async () => {
			await killChild(a);
			live = live.filter((child) => child !== a);

			await killChild(b);
			live = live.filter((child) => child !== b);
			b = spawnChild("b", portB, controlPortB, dataDirB);
			live.push(b);
			await eventually(() => b.command<Ready>({ action: "ready" }), "node B ready after restart");

			await eventually(async () => {
				const remoteB = await b.command<RemotePersona[]>({ action: "remotePersonas" });
				const ids = remoteB.map((p) => p.id).sort();
				const expected = [
					`${readyA.identity.id}/${personaA1}`,
					`${readyA.identity.id}/${personaA2}`,
				].sort();
				if (JSON.stringify(ids) !== JSON.stringify(expected)) {
					throw new Error(
						`B's remotePersonas after restart is ${JSON.stringify(ids)}, want ${JSON.stringify(expected)}`,
					);
				}
				return true;
			}, "restarted B's remotePersonas still answers A's two teammates, A still down");

			await eventually(async () => {
				const rosters = await b.command<FleetRoster[]>({ action: "fleetRosters" });
				const rowA = rosters.find((row) => row.node.id === readyA.identity.id);
				if (!rowA) throw new Error("fleetRosters has no row for A");
				if (rowA.online !== false) throw new Error("fleetRosters must show A offline while it is down");
				if (rowA.teammates.length !== 2) {
					throw new Error(`fleetRosters shows ${rowA.teammates.length} teammates for A, want 2`);
				}
				return true;
			}, "fleetRosters lists A online:false with teammates present, zero HTTP to poll");
		});

		await step("G3.3 live op", async () => {
			a = spawnChild("a", portA, controlPortA, dataDirA);
			live.push(a);
			readyA = await eventually(() => a.command<Ready>({ action: "ready" }), "node A ready after restart");

			await assertLinked(a, b, readyA, readyB);

			const before = await b.command<ResourceRow | null>({ action: "record", id: personaA1 });
			if (!before) throw new Error("B has no record for A's persona before rename");

			await a.command({ action: "renamePersona", id: personaA1, name: "A-one-renamed" });

			await eventually(async () => {
				const after = await b.command<ResourceRow | null>({ action: "record", id: personaA1 });
				if (!after) throw new Error("B lost the record for A's persona");
				if (after.version <= before.version) {
					throw new Error(`B's version is ${after.version}, expected > ${before.version}`);
				}
				if (after.replicated.name !== "A-one-renamed") {
					throw new Error(`B's replicated name is ${String(after.replicated.name)}, want A-one-renamed`);
				}
				return true;
			}, "B's record reaches the bumped version without any relink");

			await Promise.all([
				a.command({ action: "meshReset" }),
				b.command({ action: "meshReset" }),
			]);
			await a.command({
				action: "checkpoint",
				id: personaA1,
				backendId: "verify-backend",
				sessionId: "verify-session-1",
			});
			// A checkpoint touches only the machine class, so it appends no
			// oplog row and rings no doorbell; give a quiet window and then
			// prove nothing shipped rather than proving a race was won.
			await Bun.sleep(1_000);
			const [meshA, meshB] = await Promise.all([
				a.command<MeshSnapshot>({ action: "meshSnapshot" }),
				b.command<MeshSnapshot>({ action: "meshSnapshot" }),
			]);
			if (syncOpsCount(meshA) !== 0) throw new Error("A shipped a sync.ops envelope for a checkpoint");
			if (syncOpsCount(meshB) !== 0) throw new Error("B applied a sync.ops envelope for a checkpoint");
		});

		await step("G3.4 tombstone", async () => {
			await a.command({ action: "deletePersona", id: personaA2 });

			await eventually(async () => {
				const row = await b.command<ResourceRow | null>({ action: "record", id: personaA2 });
				if (!row || row.deleted !== true) throw new Error("B's row for the deleted persona is not a tombstone");
				return true;
			}, "B's row shows deleted:true");

			await eventually(async () => {
				const remoteB = await b.command<RemotePersona[]>({ action: "remotePersonas" });
				if (remoteB.some((p) => p.id === `${readyA.identity.id}/${personaA2}`)) {
					throw new Error("deleted teammate still answers from remotePersonas");
				}
				return true;
			}, "the deleted teammate leaves B's remotePersonas");
		});

		let beforeCount = 0;
		let beforeRecords: ResourceRow[] = [];
		await step("G3.5 dropped and retried changes nothing twice", async () => {
			beforeCount = (await b.command<{ count: number }>({ action: "oplogCount" })).count;
			beforeRecords = (await b.command<ResourceRow[]>({ action: "records" })).sort((x, y) =>
				x.id.localeCompare(y.id),
			);

			await a.command({ action: "drop-link", id: readyB.identity.id });

			await eventually(async () => {
				const [linksA, linksB] = await Promise.all([
					a.command<Link[]>({ action: "links" }),
					b.command<Link[]>({ action: "links" }),
				]);
				if (!linksA[0]?.up || !linksB[0]?.up) throw new Error("NodeLink has not reconnected");
				return true;
			}, "NodeLink reconnect after drop-link");

			await eventually(async () => {
				const sessions = await b.command<Array<{ nodeId: string; live: boolean }>>({
					action: "syncSnapshot",
				});
				const withA = sessions.find((session) => session.nodeId === readyA.identity.id);
				if (!withA?.live) throw new Error("B's ship session with A has not re-opened");
				return true;
			}, "hello/catch-up re-ran after reconnect");
			// The re-sent whole history is a handful of ops; give the drain a
			// moment to finish landing before comparing counts.
			await Bun.sleep(500);

			const afterCount = (await b.command<{ count: number }>({ action: "oplogCount" })).count;
			const afterRecords = (await b.command<ResourceRow[]>({ action: "records" })).sort((x, y) =>
				x.id.localeCompare(y.id),
			);
			if (afterCount !== beforeCount) {
				throw new Error(`B's oplog count moved from ${beforeCount} to ${afterCount}`);
			}
			if (JSON.stringify(afterRecords) !== JSON.stringify(beforeRecords)) {
				throw new Error("B's records changed shape across the drop-and-retry");
			}
		});

		await step("G3.6 idle stays flat", async () => {
			await Promise.all([
				a.command({ action: "meshReset" }),
				b.command({ action: "meshReset" }),
			]);
			await Bun.sleep(10_000);
			const [meshA, meshB, pushesA, pushesB] = await Promise.all([
				a.command<MeshSnapshot>({ action: "meshSnapshot" }),
				b.command<MeshSnapshot>({ action: "meshSnapshot" }),
				a.command<Push[]>({ action: "pushes" }),
				b.command<Push[]>({ action: "pushes" }),
			]);
			if (syncOpsCount(meshA) !== 0) throw new Error("A shipped sync.ops during a quiet window");
			if (syncOpsCount(meshB) !== 0) throw new Error("B applied sync.ops during a quiet window");
			if (pushesA.some((push) => push.name === "personasChanged")) {
				throw new Error("A received a personasChanged push — the damper is gone but so is the case");
			}
			if (pushesB.some((push) => push.name === "personasChanged")) {
				throw new Error("B received a personasChanged push — the damper is gone but so is the case");
			}
		});

		console.log(
			"federation: converge, restart-shows-room, live rename, checkpoint stays private, tombstone, dropped-and-retried idempotent, idle stays flat",
		);
	} finally {
		await Promise.all(live.map((child) => child.command({ action: "stop" }).catch(() => undefined)));
		await Promise.all(live.map((child) => child.process.exited));
		rmSync(root, { recursive: true, force: true });
	}
}

function syncOpsCount(mesh: MeshSnapshot): number {
	return (mesh.totals["syncShip:sync.ops"] ?? 0) + (mesh.totals["syncApply:sync.ops"] ?? 0);
}

async function killChild(child: Child): Promise<void> {
	await child.command({ action: "stop" }).catch(() => undefined);
	await child.process.exited;
}

async function assertLinked(a: Child, b: Child, readyA: Ready, readyB: Ready): Promise<void> {
	await eventually(async () => {
		const [peersA, peersB, linksA, linksB] = await Promise.all([
			a.command<Peer[]>({ action: "peers" }),
			b.command<Peer[]>({ action: "peers" }),
			a.command<Link[]>({ action: "links" }),
			b.command<Link[]>({ action: "links" }),
		]);
		if (!peersA.some((peer) => peer.id === readyB.identity.id)) throw new Error("A has not linked B");
		if (!peersB.some((peer) => peer.id === readyA.identity.id)) throw new Error("B has not linked A");
		if (linksA.length !== 1 || linksB.length !== 1 || !linksA[0]!.up || !linksB[0]!.up) {
			throw new Error("logical NodeLinks are not both ready");
		}
		return true;
	}, "paired and linked");
}

function spawnChild(label: string, nodePort: number, controlPort: number, dataDir: string): Child {
	const childProcess = Bun.spawn([process.execPath, fileURLToPath(import.meta.url)], {
		env: {
			...globalThis.process.env,
			TOAD_FEDERATION_CHILD: label,
			TOAD_NODE_PORT: String(nodePort),
			TOAD_NODE_CONTROL_PORT: String(controlPort),
			TOAD_DATA_DIR: dataDir,
		},
		stdout: "inherit",
		stderr: "inherit",
	});
	return {
		label,
		nodePort,
		controlPort,
		dataDir,
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
