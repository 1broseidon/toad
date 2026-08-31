/**
 * Three isolated desks proving that a teammate's history outlives the desk
 * that wrote it, without a mirror ever pretending to be a memory:
 *
 * - a torn delta is invisible: a prefix cut mid-JSON-line lands in a replica
 *   and the record does not exist until the completing bytes arrive — here
 *   shipped by the real cursor exchange, which resumes mid-line from the
 *   held byte offset
 * - a room (A-B, A-C, closed to B-C) converges: B and C hold A's persona
 *   byte-for-byte, catch-up and live deltas alike
 * - A dies (by its captured PID) and reading A's persona from B still
 *   answers, marked as a replica
 * - A restarts and appends more: convergence resumes from the cursors —
 *   exactly the new bytes ship, nothing held is re-shipped, no refusals
 * - A's startup compact rewrites the open epoch under the mirrors: the cursor
 *   fingerprints catch it, every mirror is reset and re-shipped from zero,
 *   and B and C converge to byte-for-byte equality with the compacted segment
 *
 *   bun scripts/verify-transcripts.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

type JsonRecord = Record<string, unknown>;

const CHILD = process.env.TOAD_TRANSCRIPTS_CHILD;

if (CHILD) {
	await runChild(CHILD);
} else {
	await runParent();
}

async function runChild(label: string): Promise<void> {
	const nodePort = Number(process.env.TOAD_NODE_PORT);
	const controlPort = Number(process.env.TOAD_TRANSCRIPTS_CONTROL_PORT);
	if (!nodePort || !controlPort) throw new Error("node and control ports are required");

	const fleet = await import("../src/bun/fleet/fleet");
	const wire = await import("../src/bun/fleet/wire");
	const replication = await import("../src/bun/fleet/replication");
	const metrics = await import("../src/bun/fleet/metrics");
	const identity = await import("../src/bun/node/identity");
	const nodeServer = await import("../src/bun/node/server");
	const personas = await import("../src/bun/store/personas");
	const replicas = await import("../src/bun/store/replicas");
	const transcript = await import("../src/bun/store/transcript");

	/* What index.ts does at startup: fold superseded lines before any wire
	 * exists. A restart over a tape with superseded events rewrites history in
	 * place — exactly the rewrite the cursor fingerprints must catch. */
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
		readTranscript: () => null,
		readThread: () => null,
		/* No peer thread is read here, so nothing moves. Supplied because
		   `Deps` requires it: a harness that does not compile is a harness
		   that has stopped tracking the contract it is proving. */
		threadRead: () => 0,
		deliver: async () => ({ ok: false, detail: "not exercised" }),
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
						const persona = personas.createPersona({ name: String(input.name ?? "Teammate") });
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
					case "append": {
						transcript.append(String(input.personaId), input.event as never);
						return Response.json({ ok: true, result: { appended: true } });
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
					case "replica-messages":
						return Response.json({
							ok: true,
							result: replicas.replicaMessages(String(input.owner), String(input.personaId), 100),
						});
					case "inject-delta":
						return Response.json({
							ok: true,
							result: replication.handleTranscriptDelta(String(input.owner), {
								personaId: String(input.personaId),
								epoch: Number(input.epoch),
								offset: Number(input.offset),
								data: String(input.data),
							}),
						});
					case "read-remote": {
						const events = await handlers.loadTranscript!({
							personaId: String(input.target),
						} as never);
						return Response.json({ ok: true, result: events });
					}
					case "metrics":
						return Response.json({ ok: true, result: metrics.meshSnapshot() });
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
type Link = { nodeId: string; up: boolean };
type Metrics = { totals: Record<string, number>; bytes: Record<string, number> };

async function runParent(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "toad-transcripts-"));
	const base = 50_500 + Math.floor(Math.random() * 300);
	const children: Child[] = [];

	try {
		const dirA = join(root, "a");
		let a = spawnChild("a", base, base + 10, dirA);
		const b = spawnChild("b", base + 1, base + 11, join(root, "b"));
		const c = spawnChild("c", base + 2, base + 12, join(root, "c"));
		children.push(a, b, c);

		const [readyA] = await Promise.all([
			eventually(() => a.command<Ready>({ action: "ready" }), "node A"),
			eventually(() => b.command<Ready>({ action: "ready" }), "node B"),
			eventually(() => c.command<Ready>({ action: "ready" }), "node C"),
		]);
		const aId = readyA.identity.id;

		// A's teammate speaks twice before anyone is even paired.
		const { personaId } = await a.command<{ personaId: string }>({
			action: "create-teammate",
			name: "Chronicle",
		});
		const l1 = await a.command<{ id: string }>({ action: "say", personaId, text: "first line" });
		const l2 = await a.command<{ id: string }>({ action: "say", personaId, text: "second line" });

		// Torn tail: hand B a prefix of A's real segment, cut mid-JSON inside
		// the second line. The first record exists; the cut one must not.
		const truth1 = await a.command<Truth>({ action: "truth", personaId });
		const whole = Buffer.from(truth1.segments["1"]!, "base64");
		const firstNewline = whole.indexOf(0x0a);
		const cut = firstNewline + 1 + 10;
		if (cut >= whole.length) throw new Error("segment too small to cut mid-line");
		const injected = await b.command<{ ok: boolean }>({
			action: "inject-delta",
			owner: aId,
			personaId,
			epoch: 1,
			offset: 0,
			data: whole.subarray(0, cut).toString("base64"),
		});
		if (!injected.ok) throw new Error("torn prefix was refused at offset 0");
		const tornView = await b.command<Array<{ id: string }>>({
			action: "replica-messages",
			owner: aId,
			personaId,
		});
		if (tornView.length !== 1 || tornView[0]!.id !== l1.id) {
			throw new Error(
				`a torn record exists before its completing delta: ${JSON.stringify(tornView.map((event) => event.id))}`,
			);
		}

		// Pair B and C to A; the mesh closes B-C on its own.
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

		const converged = async (holder: Child): Promise<void> => {
			const [truth, replica] = await Promise.all([
				a.command<Truth>({ action: "truth", personaId }),
				holder.command<Replica>({ action: "replica", owner: aId, personaId }),
			]);
			if (JSON.stringify(replica.cursor) !== JSON.stringify(truth.sizes)) {
				throw new Error(
					`${holder.label} cursor ${JSON.stringify(replica.cursor)} != truth ${JSON.stringify(truth.sizes)}`,
				);
			}
			for (const [epoch, bytes] of Object.entries(truth.segments)) {
				if (replica.segments[epoch] !== bytes) {
					throw new Error(`${holder.label} epoch ${epoch} bytes diverge from A's truth`);
				}
			}
		};

		// The cursor exchange completes the torn line from its held offset and
		// ships C everything from zero; both mirrors read byte-for-byte.
		await eventually(async () => converged(b), "B converges after cursor exchange", 30_000);
		await eventually(async () => converged(c), "C converges from zero", 30_000);
		const healedView = await b.command<Array<{ id: string }>>({
			action: "replica-messages",
			owner: aId,
			personaId,
		});
		if (!healedView.some((event) => event.id === l2.id)) {
			throw new Error("the completing delta did not surface the torn record");
		}

		// Live deltas: every append lands on every up wire.
		await a.command({ action: "say", personaId, text: "third line" });
		const l4 = await a.command<{ id: string }>({ action: "say", personaId, text: "fourth line" });
		await eventually(async () => converged(b), "B follows live deltas", 20_000);
		await eventually(async () => converged(c), "C follows live deltas", 20_000);

		// While A is up, the routed read must be A's own answer, not a mirror.
		const liveRead = await b.command<Array<{ kind: string; id: string }>>({
			action: "read-remote",
			target: `${aId}/${personaId}`,
		});
		if (liveRead.some((event) => event.id.startsWith("replica:"))) {
			throw new Error("a reachable desk was answered from the mirror");
		}

		// Snapshot what B holds and has applied, then kill A by the PID
		// captured at spawn. Nothing else on this box is touched.
		const truthBefore = await a.command<Truth>({ action: "truth", personaId });
		const metricsBefore = await b.command<Metrics>({ action: "metrics" });
		a.process.kill(9);
		await a.process.exited;

		await eventually(
			async () => {
				const links = await b.command<Link[]>({ action: "links" });
				if (links.find((link) => link.nodeId === aId)?.up) {
					throw new Error("B still believes A's wire is up");
				}
				return true;
			},
			"B notices A is dark",
			20_000,
		);

		// History outlives the desk: the read answers from the mirror and is
		// marked as one — the leading notice is the honesty flag.
		const darkRead = await b.command<Array<{ kind: string; id: string; text?: string }>>({
			action: "read-remote",
			target: `${aId}/${personaId}`,
		});
		if (darkRead[0]?.kind !== "notice" || !darkRead[0].id.startsWith("replica:")) {
			throw new Error("a replica read did not announce itself as one");
		}
		for (const text of ["first line", "second line", "third line", "fourth line"]) {
			if (!darkRead.some((event) => event.text === text)) {
				throw new Error(`the mirror is missing "${text}"`);
			}
		}
		if (!darkRead.some((event) => event.id === l4.id)) {
			throw new Error("the mirror is missing the newest record");
		}

		// A returns on the same desk and says more. Convergence resumes from
		// the cursors: exactly the new bytes ship, nothing held re-ships, and
		// the mirror refuses nothing.
		a = spawnChild("a", base, base + 10, dirA);
		children.push(a);
		await eventually(() => a.command<Ready>({ action: "ready" }), "node A restarts");
		await a.command({ action: "say", personaId, text: "fifth line" });
		await a.command({ action: "say", personaId, text: "sixth line" });
		await eventually(async () => converged(b), "B resumes after A restarts", 30_000);
		await eventually(async () => converged(c), "C resumes after A restarts", 30_000);

		const truthAfter = await a.command<Truth>({ action: "truth", personaId });
		const metricsAfter = await b.command<Metrics>({ action: "metrics" });
		const appliedBytes =
			(metricsAfter.bytes["replicaApply:transcriptDelta"] ?? 0) -
			(metricsBefore.bytes["replicaApply:transcriptDelta"] ?? 0);
		const newBytes = truthAfter.sizes["1"]! - truthBefore.sizes["1"]!;
		if (appliedBytes !== newBytes) {
			throw new Error(
				`resume shipped ${appliedBytes} bytes to B where only ${newBytes} were new — a held byte was re-shipped or lost`,
			);
		}
		const refusals =
			(metricsAfter.totals["replicaRefuse:transcriptDelta"] ?? 0) -
			(metricsBefore.totals["replicaRefuse:transcriptDelta"] ?? 0);
		if (refusals !== 0) {
			throw new Error(`resume was not clean: B refused ${refusals} delta(s)`);
		}

		// Compaction: a tool card that went pending→completed puts a superseded
		// line on the tape, and the mirrors faithfully hold both lines.
		const toolId = crypto.randomUUID();
		for (const status of ["pending", "completed"]) {
			await a.command({
				action: "append",
				personaId,
				event: { kind: "tool", id: toolId, ts: Date.now(), toolCallId: toolId, title: "run", status },
			});
		}
		await eventually(async () => converged(b), "B holds the superseded line", 20_000);
		await eventually(async () => converged(c), "C holds the superseded line", 20_000);

		// Restart A: its startup compact folds the pending line away, rewriting
		// the open epoch in place. Size comparison alone cannot see this from
		// the mirror's side — the cursor fingerprints must.
		const truthUncompacted = await a.command<Truth>({ action: "truth", personaId });
		const compactBeforeB = await b.command<Metrics>({ action: "metrics" });
		const compactBeforeC = await c.command<Metrics>({ action: "metrics" });
		a.process.kill(9);
		await a.process.exited;
		a = spawnChild("a", base, base + 10, dirA);
		children.push(a);
		await eventually(() => a.command<Ready>({ action: "ready" }), "node A restarts to compact");
		const truthCompacted = await a.command<Truth>({ action: "truth", personaId });
		if (truthCompacted.segments["1"] === truthUncompacted.segments["1"]) {
			throw new Error("startup compact was a no-op; the compaction stage proves nothing");
		}

		// The mirrors converge to byte-for-byte equality with the compacted
		// segment — sizes and content both, via replicaRead against A's file.
		await eventually(async () => converged(b), "B mirrors the compacted history", 30_000);
		await eventually(async () => converged(c), "C mirrors the compacted history", 30_000);

		// And they got there by an owner-instructed reset plus a full re-ship
		// from zero, not by silent divergence or a guessed append.
		for (const [holder, before] of [
			[b, compactBeforeB],
			[c, compactBeforeC],
		] as const) {
			const after = await holder.command<Metrics>({ action: "metrics" });
			const resets =
				(after.totals["replicaReset:transcriptReset"] ?? 0) -
				(before.totals["replicaReset:transcriptReset"] ?? 0);
			if (resets < 1) {
				throw new Error(`${holder.label} converged without a reset — a rewrite was absorbed silently`);
			}
			const reshipped =
				(after.bytes["replicaApply:transcriptDelta"] ?? 0) -
				(before.bytes["replicaApply:transcriptDelta"] ?? 0);
			const expected = truthCompacted.sizes["1"]!;
			if (reshipped !== expected) {
				throw new Error(
					`${holder.label} applied ${reshipped} bytes after the reset where the compacted epoch is ${expected}`,
				);
			}
		}

		console.log(
			"transcripts: torn tails stay invisible until completed, mirrors converge byte-for-byte, a dead desk's history still answers as a replica, a restart resumes from the cursors with nothing re-shipped, and a compaction resets every mirror to the rewritten bytes",
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
			TOAD_TRANSCRIPTS_CHILD: label,
			TOAD_NODE_PORT: String(nodePort),
			TOAD_TRANSCRIPTS_CONTROL_PORT: String(controlPort),
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
				signal: AbortSignal.timeout(5_000),
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
