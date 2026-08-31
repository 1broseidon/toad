/**
 * A ring is a fact about a message, not a decoration on one screen — so it has
 * to survive everything the message survives. Two desks on the real node plane
 * prove the whole life of one:
 *
 * - the agent's own hand puts a ring on its latest message, and the tape holds
 *   ONE record for that bubble afterwards, not the bubble plus an annotation
 * - the intent reaches the other desk as bytes: the mirror is byte-identical
 *   to the owner's segment, ring included
 * - and it reaches it as meaning: the replica's parsed view carries the intent,
 *   and so does reading the owner's tape *from* the other desk over the real
 *   peer RPC — the field survives the wire's JSON, not just the file
 * - the way out crosses too: the user clears the ring and the record ends up
 *   with no `ring` key at all — not `null`, which would be a ring the colour
 *   of nothing — on both desks
 * - re-ringing replaces rather than accumulates, on both desks
 * - it survives a restart of the owning desk and the startup compaction that
 *   rewrites the segment underneath the mirror: the mirror is reset, re-shipped
 *   from zero, and agrees byte-for-byte with the rung truth
 *
 * `verify-ring.ts` proves the ring against one desk's store — the closed set,
 * the rate guard, the tool descriptor. This is the other half: that the mark
 * is durable across the plane, which is the only reason scroll-back to last
 * Tuesday's review is worth anything.
 *
 * Nothing here is scripted: the ring is written by the production
 * `ringAgentMessage` / `setMessageRing`, stored by the real transcript store,
 * and shipped by the real replication over a real NodeLink between two child
 * processes on scratch data directories.
 *
 * Run: bun scripts/verify-ring-plane.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TranscriptEvent } from "../src/shared/types";

type JsonRecord = Record<string, unknown>;

const CHILD = process.env.TOAD_RING_PLANE_CHILD;

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
	console.log(
		`${ok ? "[32m  PASS[0m" : "[31m  FAIL[0m"} ${label} ${
			ok || detail === undefined ? "" : JSON.stringify(detail)
		}`,
	);
	if (ok) pass++;
	else fail++;
};
const section = (title: string) => console.log(`\n[36m${title}[0m`);

if (CHILD) {
	await runChild(CHILD);
} else {
	await runParent();
}

async function runChild(label: string): Promise<void> {
	const nodePort = Number(process.env.TOAD_NODE_PORT);
	const controlPort = Number(process.env.TOAD_RING_PLANE_CONTROL_PORT);
	if (!nodePort || !controlPort) throw new Error("node and control ports are required");

	const fleet = await import("../src/bun/fleet/fleet");
	const wire = await import("../src/bun/fleet/wire");
	const replication = await import("../src/bun/fleet/replication");
	const identity = await import("../src/bun/node/identity");
	const nodeServer = await import("../src/bun/node/server");
	const personas = await import("../src/bun/store/personas");
	const replicas = await import("../src/bun/store/replicas");
	const transcript = await import("../src/bun/store/transcript");
	const { ringAgentMessage, setMessageRing } = await import("../src/bun/agent/ring");

	/* What index.ts does at startup, and the reason a restart is interesting:
	 * folding superseded lines rewrites the open segment in place, underneath
	 * every mirror holding it. A ring is written as a superseded line, so this
	 * is the rewrite that has to carry it. */
	for (const persona of personas.listPersonas()) {
		transcript.compact(persona.id);
	}

	const handlers: Record<string, (params: never) => Promise<unknown>> = {
		listPersonas: async () => [],
		getSessionInfo: (async (params: { personaId?: string }) => ({
			personaId: params?.personaId ?? "",
			state: "stopped",
		})) as (params: never) => Promise<unknown>,
		loadTranscript: (async (params: { personaId: string }) =>
			transcript.load(params.personaId)) as (params: never) => Promise<unknown>,
	};
	const resolve = (method: string) =>
		handlers[method] as ((params: unknown) => Promise<unknown>) | undefined;

	fleet.initFleet({
		createTeammate: (draft) => ({ personaId: `${label}-created`, name: draft.name }),
		/* Unused: the remote read this harness makes is `loadTranscript`, which
		 * `routeRemotePersonas` forwards to the owning desk — the same path the
		 * UI takes to read a teammate on another desk. */
		readTranscript: () => null,
		readThread: () => null,
		deliver: async () => ({ ok: false, detail: "not exercised" }),
		/* No thread lives here: this harness moves rings, not messages. */
		threadRead: () => 0,
		httpOrigin: () => null,
		nodeOrigin: nodeServer.nodeOrigin,
	});
	wire.initPeerWires({
		send: () => {},
		publishPersonas: () => {},
		resolve,
	});
	wire.routeRemotePersonas(handlers);
	nodeServer.startNodeServer(resolve, nodePort, wire.nodeLinkServerHooks);

	const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
	const write = (personaId: string) => (event: TranscriptEvent) =>
		transcript.append(personaId, event);

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
					case "create-teammate": {
						const persona = personas.createPersona({ name: String(input.name ?? "Teammate") });
						return Response.json({ ok: true, result: { personaId: persona.id } });
					}
					/** A turn: the user says something, the teammate answers. */
					case "exchange": {
						const personaId = String(input.personaId);
						const asked = {
							kind: "user" as const,
							id: crypto.randomUUID(),
							ts: Date.now(),
							text: String(input.asked ?? ""),
						};
						const said = {
							kind: "agent" as const,
							id: crypto.randomUUID(),
							ts: Date.now() + 1,
							text: String(input.said ?? ""),
						};
						transcript.append(personaId, asked);
						transcript.append(personaId, said);
						return Response.json({ ok: true, result: { asked: asked.id, said: said.id } });
					}
					/** The agent's own hand, through the production decision. */
					case "ring-agent": {
						const personaId = String(input.personaId);
						const result = ringAgentMessage(
							transcript.load(personaId),
							input.intent as never,
							write(personaId),
						);
						return Response.json({ ok: true, result });
					}
					/** The user's hand: set or clear any bubble. */
					case "set-ring": {
						const personaId = String(input.personaId);
						const changed = setMessageRing(
							transcript.load(personaId),
							String(input.eventId),
							(input.intent ?? null) as never,
							write(personaId),
						);
						return Response.json({ ok: true, result: { changed } });
					}
					case "load":
						return Response.json({ ok: true, result: transcript.load(String(input.personaId)) });
					/** The raw lines, so a fold can be told from an accumulation. */
					case "lines": {
						const personaId = String(input.personaId);
						const sizes = transcript.segmentSizes(personaId);
						const lines: string[] = [];
						for (const [epoch, size] of Object.entries(sizes)) {
							const bytes = transcript.readSegmentBytes(personaId, Number(epoch), 0, size);
							for (const line of Buffer.from(bytes).toString("utf8").split("\n")) {
								if (line.trim()) lines.push(line);
							}
						}
						return Response.json({ ok: true, result: lines });
					}
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
					/** What this desk would actually render for a persona it mirrors. */
					case "replica-view":
						return Response.json({
							ok: true,
							result: replication.replicaTranscript(
								String(input.owner),
								String(input.personaId),
								String(input.ownerName ?? "Owner"),
							),
						});
					/** The owner's tape read from here, over the real peer RPC. */
					case "read-remote": {
						const events = await handlers.loadTranscript!({
							personaId: String(input.target),
						} as never);
						return Response.json({ ok: true, result: events });
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
type Rung = { id: string; kind: string; ring?: string; text?: string };

async function runParent(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "toad-ring-plane-"));
	/* A wide random base, because this box may be running a live Toad and other
	 * harnesses at once, and the only safe response to a busy port is to have
	 * picked a different one — never to go looking for who holds it. */
	const base = 51_200 + Math.floor(Math.random() * 780) * 16;
	const children: Child[] = [];

	try {
		const dirA = join(root, "a");
		let a = spawnChild("a", base, base + 10, dirA);
		const b = spawnChild("b", base + 1, base + 11, join(root, "b"));
		children.push(a, b);

		const [readyA] = await Promise.all([
			eventually(() => a.command<Ready>({ action: "ready" }), "node A"),
			eventually(() => b.command<Ready>({ action: "ready" }), "node B"),
		]);
		const aId = readyA.identity.id;

		const { personaId } = await a.command<{ personaId: string }>({
			action: "create-teammate",
			name: "Beacon",
		});

		const invite = await a.command<{ origin?: string; code?: string; error?: string }>({
			action: "invite",
		});
		if (!invite.origin || !invite.code) throw new Error(`invite failed: ${invite.error}`);
		const joined = await b.command<{ ok: boolean; error?: string }>({
			action: "join",
			origin: invite.origin,
			code: invite.code,
		});
		if (!joined.ok) throw new Error(`B could not join A: ${joined.error}`);

		/**
		 * Whether B's mirror is byte-for-byte A's own segments, as an answer
		 * rather than a throw — so the wait for it and the assertion about it
		 * are the same comparison, and a divergence is reported, not just late.
		 */
		const convergedNow = async (): Promise<{ ok: boolean; detail?: unknown }> => {
			const [truth, replica] = await Promise.all([
				a.command<Truth>({ action: "truth", personaId }),
				b.command<Replica>({ action: "replica", owner: aId, personaId }),
			]);
			if (JSON.stringify(replica.cursor) !== JSON.stringify(truth.sizes)) {
				return { ok: false, detail: { cursor: replica.cursor, truth: truth.sizes } };
			}
			for (const [epoch, bytes] of Object.entries(truth.segments)) {
				if (replica.segments[epoch] !== bytes) {
					return { ok: false, detail: { divergedEpoch: epoch } };
				}
			}
			return { ok: true };
		};
		const converged = async (): Promise<void> => {
			const result = await convergedNow();
			if (!result.ok) throw new Error(JSON.stringify(result.detail));
		};

		const ringOnA = async (id: string): Promise<string | undefined> => {
			const events = await a.command<Rung[]>({ action: "load", personaId });
			return events.find((event) => event.id === id)?.ring;
		};
		const ringInMirror = async (id: string): Promise<string | undefined> => {
			const view = await b.command<Rung[] | null>({
				action: "replica-view",
				owner: aId,
				personaId,
				ownerName: "A",
			});
			return (view ?? []).find((event) => event.id === id)?.ring;
		};
		const ringOverWire = async (id: string): Promise<string | undefined> => {
			const events = await b.command<Rung[]>({
				action: "read-remote",
				target: `${aId}/${personaId}`,
			});
			return events.find((event) => event.id === id)?.ring;
		};

		section("The agent rings its own message");
		const turn = await a.command<{ asked: string; said: string }>({
			action: "exchange",
			personaId,
			asked: "how did the migration go?",
			said: "it went through, but two rows needed a manual fix",
		});
		const rang = await a.command<{ text?: string; error?: string }>({
			action: "ring-agent",
			personaId,
			intent: "warning",
		});
		check("the ring is accepted and names the message it landed on", rang.text !== undefined, rang);
		check("the intent is in A's tape", (await ringOnA(turn.said)) === "warning", await ringOnA(turn.said));
		check("the user's own message is untouched", (await ringOnA(turn.asked)) === undefined);

		const events = await a.command<Rung[]>({ action: "load", personaId });
		const bubbles = events.filter((event) => event.id === turn.said);
		check("the tape holds one record for that bubble, not two", bubbles.length === 1, bubbles.length);
		const lines = await a.command<string[]>({ action: "lines", personaId });
		check(
			"…written as a superseded line rather than a second bubble",
			lines.filter((line) => line.includes(turn.said)).length === 2,
			lines.filter((line) => line.includes(turn.said)).length,
		);

		section("It crosses to the other desk");
		await eventually(converged, "B converges on the rung tape", 30_000);
		const crossed = await convergedNow();
		check("B's mirror is byte-identical to A's rung truth", crossed.ok, crossed.detail);
		check("B's replica view carries the intent", (await ringInMirror(turn.said)) === "warning", await ringInMirror(turn.said));
		check(
			"reading A's tape from B over the peer RPC carries the intent",
			(await ringOverWire(turn.said)) === "warning",
			await ringOverWire(turn.said),
		);

		section("Re-ringing replaces rather than accumulates");
		await a.command({ action: "set-ring", personaId, eventId: turn.said, intent: "problem" });
		check("A's tape holds the new intent", (await ringOnA(turn.said)) === "problem", await ringOnA(turn.said));
		const afterReplace = await a.command<Rung[]>({ action: "load", personaId });
		check(
			"and still one record for the bubble",
			afterReplace.filter((event) => event.id === turn.said).length === 1,
		);
		await eventually(converged, "B converges on the replaced intent", 30_000);
		check("B sees the replacement", (await ringInMirror(turn.said)) === "problem", await ringInMirror(turn.said));

		section("The way out crosses too");
		const cleared = await a.command<{ changed: boolean }>({
			action: "set-ring",
			personaId,
			eventId: turn.said,
			intent: null,
		});
		check("clearing changes the record", cleared.changed);
		check("A's tape has no intent", (await ringOnA(turn.said)) === undefined, await ringOnA(turn.said));
		const clearedLines = await a.command<string[]>({ action: "lines", personaId });
		const last = clearedLines.filter((line) => line.includes(turn.said)).at(-1) ?? "";
		check(
			"…and no `ring` key on disk at all, rather than a null one",
			!Object.hasOwn(JSON.parse(last) as object, "ring"),
			last,
		);
		await eventually(converged, "B converges on the cleared bubble", 30_000);
		check("B's mirror shows no ring", (await ringInMirror(turn.said)) === undefined, await ringInMirror(turn.said));
		check("and neither does the wire", (await ringOverWire(turn.said)) === undefined);
		check(
			"clearing an already-clear bubble changes nothing",
			(await a.command<{ changed: boolean }>({
				action: "set-ring",
				personaId,
				eventId: turn.said,
				intent: null,
			})).changed === false,
		);

		section("It survives a restart and the compaction that follows");
		await a.command({ action: "set-ring", personaId, eventId: turn.said, intent: "attention" });
		await eventually(converged, "B converges before the restart", 30_000);
		const beforeRestart = await a.command<Truth>({ action: "truth", personaId });

		await a.command({ action: "stop" });
		await a.process.exited;
		a = spawnChild("a", base, base + 10, dirA);
		children.push(a);
		await eventually(() => a.command<Ready>({ action: "ready" }), "node A restarted");

		check("the intent is still in the tape after a restart", (await ringOnA(turn.said)) === "attention", await ringOnA(turn.said));
		const compacted = await a.command<Truth>({ action: "truth", personaId });
		check(
			"the startup compaction rewrote the segment underneath the mirror",
			JSON.stringify(compacted.sizes) !== JSON.stringify(beforeRestart.sizes),
			{ before: beforeRestart.sizes, after: compacted.sizes },
		);
		const foldedLines = await a.command<string[]>({ action: "lines", personaId });
		check(
			"…folding the bubble's history to a single rung line",
			foldedLines.filter((line) => line.includes(turn.said)).length === 1,
			foldedLines.filter((line) => line.includes(turn.said)).length,
		);

		const reinvite = await a.command<{ origin?: string; code?: string }>({ action: "invite" });
		if (reinvite.origin && reinvite.code) {
			await b.command({ action: "join", origin: reinvite.origin, code: reinvite.code });
		}
		await eventually(converged, "B re-converges on the compacted tape", 40_000);
		const reconverged = await convergedNow();
		check(
			"B's mirror agrees byte-for-byte with the compacted rung truth",
			reconverged.ok,
			reconverged.detail,
		);
		check(
			"and its parsed view still carries the intent",
			(await ringInMirror(turn.said)) === "attention",
			await ringInMirror(turn.said),
		);

		console.log(`\n${fail === 0 ? "[32m" : "[31m"}${pass} passed, ${fail} failed[0m`);
		if (fail > 0) process.exitCode = 1;
	} finally {
		for (const child of children) {
			try {
				child.process.kill();
			} catch {}
		}
		await Promise.all(children.map((child) => child.process.exited));
		rmSync(root, { recursive: true, force: true });
	}
}

function spawnChild(label: string, nodePort: number, controlPort: number, dataDir: string): Child {
	const childProcess = Bun.spawn([process.execPath, fileURLToPath(import.meta.url)], {
		env: {
			...globalThis.process.env,
			TOAD_RING_PLANE_CHILD: label,
			TOAD_NODE_PORT: String(nodePort),
			TOAD_RING_PLANE_CONTROL_PORT: String(controlPort),
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
