/**
 * Three isolated desks proving the persona hop — one teammate, one tape,
 * moving between desks — over the real node plane:
 *
 * - refusals are loud and move nothing: a teammate mid-turn refuses, a desk
 *   whose ladder answers unavailable refuses naming every rung, and a dead
 *   owner refuses as unreachable
 * - a prepare that is never followed by a claim (the crashed hop) leaves the
 *   persona owned and complete on the old desk — harmless repetition
 * - the hop itself: issued from a third desk, driven by the destination. The
 *   destination's tape is byte-identical to the owner's pre-hop truth plus
 *   the appended hop notice; the record flips on every member with the owner
 *   epoch bumped; the old owner's copy moves into its replica store under the
 *   new owner
 * - the new owner's appends land in the next epoch segment and replicate
 *   room-wide — promoted history included, to a desk that never mirrored the
 *   new owner before
 * - hopping back restores the original desk as owner with the epoch bumped
 *   again and the whole tape home
 *
 *   bun scripts/verify-hop.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HopResult, SessionState } from "../src/shared/types";

type JsonRecord = Record<string, unknown>;

const CHILD = process.env.TOAD_HOP_CHILD;

/** Stubbed built-in reach: A and B can run the teammate, C cannot. */
const BUILTIN_STUBS: Record<string, { authenticated: boolean; providers: string[]; models: string[] }> = {
	a: { authenticated: true, providers: ["stub"], models: ["stub/model-a"] },
	b: { authenticated: true, providers: ["stub"], models: ["stub/model-a"] },
	c: { authenticated: false, providers: [], models: [] },
};

if (CHILD) {
	await runChild(CHILD);
} else {
	await runParent();
}

async function runChild(label: string): Promise<void> {
	const nodePort = Number(process.env.TOAD_NODE_PORT);
	const controlPort = Number(process.env.TOAD_HOP_CONTROL_PORT);
	if (!nodePort || !controlPort) throw new Error("node and control ports are required");

	const fleet = await import("../src/bun/fleet/fleet");
	const wire = await import("../src/bun/fleet/wire");
	const hop = await import("../src/bun/fleet/hop");
	const capabilities = await import("../src/bun/fleet/capabilities");
	const identity = await import("../src/bun/node/identity");
	const nodeServer = await import("../src/bun/node/server");
	const personas = await import("../src/bun/store/personas");
	const records = await import("../src/bun/store/records");
	const replicas = await import("../src/bun/store/replicas");
	const transcript = await import("../src/bun/store/transcript");

	/* A pretend session per teammate, so the hop's busy rule and stop are
	 * exercised without a real harness: "thinking" refuses, "ready" must be
	 * stopped by the prepare, and the stop is recorded for the parent. */
	const sessionStates = new Map<string, SessionState>();
	const stopped: string[] = [];

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
	wire.initPeerWires({
		send: () => {},
		publishPersonas: () => {},
		resolve,
	});
	hop.initHop({
		state: (personaId) => sessionStates.get(personaId) ?? "stopped",
		stop: async (personaId) => {
			stopped.push(personaId);
			sessionStates.set(personaId, "stopped");
		},
		closeChapter: async () => {},
		publish: () => {},
	});
	nodeServer.startNodeServer(resolve, nodePort, wire.nodeLinkServerHooks);
	await capabilities.refreshDeskCapabilities();

	const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

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
					case "links":
						return Response.json({ ok: true, result: wire.nodeLinkSnapshot() });
					case "create-teammate": {
						const persona = personas.createPersona({
							name: String(input.name ?? "Teammate"),
							backendId: "pi",
							modelId: "stub/model-a",
						});
						return Response.json({ ok: true, result: { personaId: persona.id } });
					}
					case "say": {
						const event = {
							kind: "agent" as const,
							id: crypto.randomUUID(),
							ts: Date.now(),
							text: String(input.text ?? ""),
						};
						transcript.append(String(input.personaId), event);
						return Response.json({ ok: true, result: { id: event.id } });
					}
					case "set-state": {
						sessionStates.set(String(input.personaId), String(input.state) as SessionState);
						return Response.json({ ok: true, result: { set: true } });
					}
					case "stops":
						return Response.json({ ok: true, result: stopped });
					case "take-hop-notice":
						/* The same consume-once read the supervisor's message funnel
						 * uses to lay the notice ahead of the first words heard here. */
						return Response.json({
							ok: true,
							result: personas.takeHopNotice(String(input.personaId)) ?? null,
						});
					case "truth": {
						const personaId = String(input.personaId);
						const sizes = transcript.segmentSizes(personaId);
						const segments: Record<string, string> = {};
						for (const [epoch, size] of Object.entries(sizes)) {
							segments[epoch] = base64(
								transcript.readSegmentBytes(personaId, Number(epoch), 0, size),
							);
						}
						return Response.json({ ok: true, result: { sizes, segments } });
					}
					case "replica": {
						const owner = String(input.owner);
						const personaId = String(input.personaId);
						const cursor = replicas.replicaCursor(owner, personaId);
						const sizes: Record<string, number> = {};
						const segments: Record<string, string> = {};
						for (const [epoch, entry] of Object.entries(cursor)) {
							sizes[epoch] = entry.held;
							segments[epoch] = base64(
								replicas.replicaRead(owner, personaId, Number(epoch), 0, entry.held),
							);
						}
						return Response.json({ ok: true, result: { cursor: sizes, segments } });
					}
					case "record": {
						const record = records.getRecord("persona", String(input.personaId));
						return Response.json({
							ok: true,
							result: record
								? {
										ownerNode: record.ownerNode,
										ownerEpoch: record.ownerEpoch,
										deleted: record.deleted,
									}
								: null,
						});
					}
					case "roster":
						return Response.json({
							ok: true,
							result: personas.listPersonas().map((persona) => persona.id),
						});
					case "hop": {
						const result = await hop.requestHop(String(input.personaId), String(input.toNodeId));
						return Response.json({ ok: true, result });
					}
					case "prepare-only": {
						/* The crashed hop: a destination that prepared and died. */
						const result = await hop.handleHopPrepare(String(input.peerId), {
							personaId: String(input.personaId),
						});
						return Response.json({ ok: true, result });
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
type Truth = { sizes: Record<string, number>; segments: Record<string, string> };
type Replica = { cursor: Record<string, number>; segments: Record<string, string> };
type RecordMeta = { ownerNode: string; ownerEpoch: number; deleted: boolean } | null;

async function runParent(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "toad-hop-"));
	const base = 52_000 + Math.floor(Math.random() * 300);
	const children: Child[] = [];

	try {
		const a = spawnChild("a", base, base + 10, join(root, "a"));
		const b = spawnChild("b", base + 1, base + 11, join(root, "b"));
		const c = spawnChild("c", base + 2, base + 12, join(root, "c"));
		children.push(a, b, c);

		const [readyA, readyB, readyC] = await Promise.all([
			eventually(() => a.command<Ready>({ action: "ready" }), "node A"),
			eventually(() => b.command<Ready>({ action: "ready" }), "node B"),
			eventually(() => c.command<Ready>({ action: "ready" }), "node C"),
		]);
		const aId = readyA.identity.id;
		const bId = readyB.identity.id;
		const cId = readyC.identity.id;

		// A teammate accumulates tape on A before the room even exists.
		const { personaId } = await a.command<{ personaId: string }>({
			action: "create-teammate",
			name: "Rover",
		});
		await a.command({ action: "say", personaId, text: "first line on A" });
		await a.command({ action: "say", personaId, text: "second line on A" });

		// Three desks pair; the mesh closes the third edge on its own.
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

		/** One desk's replica of one owner's persona equals that owner's truth. */
		const mirrors = async (holder: Child, ownerChild: Child, ownerId: string): Promise<void> => {
			const [truth, replica] = await Promise.all([
				ownerChild.command<Truth>({ action: "truth", personaId }),
				holder.command<Replica>({ action: "replica", owner: ownerId, personaId }),
			]);
			if (JSON.stringify(replica.cursor) !== JSON.stringify(truth.sizes)) {
				throw new Error(
					`${holder.label} cursor ${JSON.stringify(replica.cursor)} != ${ownerChild.label} truth ${JSON.stringify(truth.sizes)}`,
				);
			}
			for (const [epoch, bytes] of Object.entries(truth.segments)) {
				if (replica.segments[epoch] !== bytes) {
					throw new Error(`${holder.label} epoch ${epoch} bytes diverge from ${ownerChild.label}`);
				}
			}
		};

		await eventually(() => mirrors(b, a, aId), "B mirrors A before any hop", 30_000);
		await eventually(() => mirrors(c, a, aId), "C mirrors A before any hop", 30_000);

		// The mesh closes B-C on its own; the hop's routing and the claim's
		// resync both need that third edge up before the stages lean on it.
		type Link = { nodeId: string; up: boolean };
		await eventually(
			async () => {
				const [linksB, linksC] = await Promise.all([
					b.command<Link[]>({ action: "links" }),
					c.command<Link[]>({ action: "links" }),
				]);
				if (!linksB.find((link) => link.nodeId === cId)?.up) throw new Error("B-C wire not up on B");
				if (!linksC.find((link) => link.nodeId === bId)?.up) throw new Error("B-C wire not up on C");
				return true;
			},
			"the mesh closes the B-C edge",
			60_000,
		);

		/** The record's (owner, epoch) as one desk sees it. */
		const recordOn = async (child: Child): Promise<RecordMeta> =>
			child.command<RecordMeta>({ action: "record", personaId });

		const assertOwnedEverywhere = async (ownerId: string, epoch: number, label: string) => {
			await eventually(
				async () => {
					for (const child of [a, b, c]) {
						const meta = await recordOn(child);
						if (!meta) throw new Error(`${child.label} has no record of the persona`);
						if (meta.ownerNode !== ownerId || meta.ownerEpoch !== epoch) {
							throw new Error(
								`${child.label} sees owner ${meta.ownerNode}@${meta.ownerEpoch}, expected ${ownerId}@${epoch}`,
							);
						}
					}
					return true;
				},
				label,
				30_000,
			);
		};

		// Every member holds the record before anyone is asked about it.
		await assertOwnedEverywhere(aId, 1, "the persona record reaches every member");

		// -- refusal: the destination's ladder answers unavailable --------------
		const toC = await a.command<HopResult>({ action: "hop", personaId, toNodeId: cId });
		if (toC.ok) throw new Error("a desk whose ladder answers unavailable accepted a hop");
		if (!/exact/.test(toC.error) || !/signed-in|advertis|available/.test(toC.error)) {
			throw new Error(`the unavailable refusal does not name the rungs: ${toC.error}`);
		}
		await assertOwnedEverywhere(aId, 1, "ownership untouched after the ladder refusal");

		// -- refusal: the teammate is mid-turn ----------------------------------
		await a.command({ action: "set-state", personaId, state: "thinking" });
		const whileBusy = await eventually(
			async () => {
				const result = await c.command<HopResult>({ action: "hop", personaId, toNodeId: bId });
				if (result.ok) throw new Error("a busy teammate was hopped");
				if (!/thinking/.test(result.error)) {
					throw new Error(`the busy refusal does not say why: ${result.error}`);
				}
				return result;
			},
			"a mid-turn teammate refuses the hop",
			30_000,
		);
		void whileBusy;
		await a.command({ action: "set-state", personaId, state: "ready" });

		// -- the crashed hop: prepare lands, the claim never comes --------------
		const prepared = await a.command<{ ok: boolean }>({
			action: "prepare-only",
			personaId,
			peerId: bId,
		});
		if (!prepared.ok) throw new Error("prepare refused an idle teammate");
		const stopsA = await a.command<string[]>({ action: "stops" });
		if (!stopsA.includes(personaId)) {
			throw new Error("prepare left an idle-but-live session running");
		}
		await assertOwnedEverywhere(aId, 1, "a prepare without a claim moves nothing");
		const truthAfterCrash = await a.command<Truth>({ action: "truth", personaId });
		if (!truthAfterCrash.sizes["1"]) throw new Error("the crashed hop lost A's tape");

		// -- the hop, issued from C, driven by B --------------------------------
		const preHop = await a.command<Truth>({ action: "truth", personaId });
		const hopped = await c.command<HopResult>({ action: "hop", personaId, toNodeId: bId });
		if (!hopped.ok) throw new Error(`the hop refused: ${hopped.error}`);
		if (hopped.rung !== "exact") throw new Error(`the hop landed on ${hopped.rung}, not exact`);
		if (hopped.from !== aId || hopped.to !== bId || hopped.epoch !== 2) {
			throw new Error(`the hop result is wrong: ${JSON.stringify(hopped)}`);
		}

		await assertOwnedEverywhere(bId, 2, "the record flips to B@2 on every member");

		// B's tape is A's pre-hop truth plus exactly the appended hop notice.
		const truthOnB = await b.command<Truth>({ action: "truth", personaId });
		const before = Buffer.from(preHop.segments["1"]!, "base64").toString("utf8");
		const after = Buffer.from(truthOnB.segments["1"] ?? "", "base64").toString("utf8");
		if (!after.startsWith(before)) {
			throw new Error("B's promoted tape is not byte-identical to A's pre-hop truth");
		}
		const appended = after
			.slice(before.length)
			.split("\n")
			.filter((line) => line.trim());
		const notices = appended.map((line) => JSON.parse(line) as { kind: string; text?: string });
		if (!notices.every((event) => event.kind === "notice" && /Hopped desks/.test(event.text ?? ""))) {
			throw new Error(`unexpected events rode the hop: ${JSON.stringify(appended)}`);
		}
		if (notices.length < 1) throw new Error("the hop left no handoff notice on the tape");

		// The teammate itself is told it moved: the parked notice — what the
		// message funnel lays ahead of the first words heard on B — names both
		// desks, the platform, and the workspace-verify instruction, once.
		const noticeOnB = await b.command<string | null>({ action: "take-hop-notice", personaId });
		if (!noticeOnB) throw new Error("the resumed teammate was not told it moved");
		for (const needle of [
			readyA.identity.name,
			readyB.identity.name,
			process.platform,
			"Verify the workspace",
			"working directory here is",
		]) {
			if (!noticeOnB.includes(needle)) {
				throw new Error(`the moved-desks notice is missing "${needle}": ${noticeOnB}`);
			}
		}
		const consumed = await b.command<string | null>({ action: "take-hop-notice", personaId });
		if (consumed) throw new Error("the moved-desks notice was not consumed exactly once");

		// A's roster no longer lists the teammate; B's does.
		const rosterA = await a.command<string[]>({ action: "roster" });
		if (rosterA.includes(personaId)) throw new Error("A still lists a teammate it demoted");
		const rosterB = await b.command<string[]>({ action: "roster" });
		if (!rosterB.includes(personaId)) throw new Error("B does not list the teammate it claimed");

		// A's copy now lives in A's replica store under B, byte-identical.
		await eventually(async () => {
			const truthA = await a.command<Truth>({ action: "truth", personaId });
			if (Object.keys(truthA.sizes).length !== 0) {
				throw new Error(`A still holds tape segments: ${JSON.stringify(truthA.sizes)}`);
			}
			await mirrors(a, b, bId);
			return true;
		}, "A's copy demotes into its replica store under B", 30_000);

		// New words on B land in the next epoch segment and replicate room-wide —
		// including to C, which never mirrored B's copy of this persona before.
		await b.command({ action: "say", personaId, text: "first line on B" });
		const truthB2 = await b.command<Truth>({ action: "truth", personaId });
		if (!truthB2.sizes["2"]) {
			throw new Error(`B's appends did not open epoch 2: ${JSON.stringify(truthB2.sizes)}`);
		}
		await eventually(() => mirrors(a, b, bId), "A mirrors B's whole tape", 30_000);
		await eventually(() => mirrors(c, b, bId), "C mirrors B's whole tape, promoted history included", 30_000);

		// -- the way back --------------------------------------------------------
		const back = await b.command<HopResult>({ action: "hop", personaId, toNodeId: aId });
		if (!back.ok) throw new Error(`the hop back refused: ${back.error}`);
		if (back.epoch !== 3) throw new Error(`the hop back claimed epoch ${back.epoch}, not 3`);
		await assertOwnedEverywhere(aId, 3, "the round trip flips the record back to A@3");
		const homeTruth = await a.command<Truth>({ action: "truth", personaId });
		if (!homeTruth.sizes["1"] || !homeTruth.sizes["2"]) {
			throw new Error(`the tape did not come home whole: ${JSON.stringify(homeTruth.sizes)}`);
		}
		await a.command({ action: "say", personaId, text: "home again" });
		const homeTruth2 = await a.command<Truth>({ action: "truth", personaId });
		if (!homeTruth2.sizes["3"]) throw new Error("A's appends did not open epoch 3");
		await eventually(() => mirrors(b, a, aId), "B mirrors the returned tape", 30_000);
		await eventually(() => mirrors(c, a, aId), "C mirrors the returned tape", 30_000);

		// -- refusal: the owning desk is dark ------------------------------------
		a.process.kill(9);
		await a.process.exited;
		const darkHop = await eventually(async () => {
			const result = await c.command<HopResult>({ action: "hop", personaId, toNodeId: bId });
			if (result.ok) throw new Error("a hop succeeded while its owner was dark");
			if (!/not reachable/.test(result.error)) {
				throw new Error(`hop while owner dark refused for the wrong reason: ${result.error}`);
			}
			return result;
		}, "a dark owner refuses the hop loudly", 30_000);
		const metaB = await recordOn(b);
		if (metaB?.ownerNode !== aId || metaB.ownerEpoch !== 3) {
			throw new Error("the refused hop disturbed ownership");
		}

		console.log(
			`hop: refusals are loud and move nothing (${JSON.stringify(darkHop.error)}), a crashed prepare leaves the owner whole, the claim flips the record room-wide with the epoch bumped, the tape travels byte-identically plus its handoff notice, the resumed teammate is told it moved and to verify its workspace, the old desk keeps a mirror, and the round trip comes home`,
		);
	} finally {
		await Promise.all(children.map((child) => child.command({ action: "stop" }).catch(() => undefined)));
		await Promise.all(children.map((child) => child.process.exited));
		rmSync(root, { recursive: true, force: true });
	}
}

function spawnChild(label: string, nodePort: number, controlPort: number, dataDir: string): Child {
	const childProcess = Bun.spawn([process.execPath, fileURLToPath(import.meta.url)], {
		env: {
			...globalThis.process.env,
			TOAD_HOP_CHILD: label,
			TOAD_NODE_PORT: String(nodePort),
			TOAD_HOP_CONTROL_PORT: String(controlPort),
			TOAD_CAPS_BUILTIN_STUB: JSON.stringify(BUILTIN_STUBS[label]),
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
				signal: AbortSignal.timeout(150_000),
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
