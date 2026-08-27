/**
 * Two real web wires proving that the mesh plane converges instead of
 * amplifying. Each child is an isolated desktop process: its own data dir,
 * startWebMode server, fleet pairing state, PeerWire manager, and handler map.
 *
 * The harness deliberately does not import src/bun/index.ts (that boots the
 * app). Its tiny handler map mirrors the mesh-facing part of index.ts:
 * listPeerActivity/listPreviews are merged handlers, while their local-only
 * counterparts return just this node's record.
 *
 *   bun hack/verify-mesh-plane.ts
 *
 * A test-only damper stops rebroadcasting after six peer emissions. It never
 * participates in a passing run; it only keeps old code from consuming the
 * process while the harness reports the amplification it observed.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

type JsonRecord = Record<string, unknown>;
type Push = { push: string; payload: unknown };
type Snapshot = {
	calls: string[];
	peerEmissions: Push[];
	suppressed: number;
};

const CHILD = process.env.TOAD_MESH_CHILD;

if (CHILD) {
	await runChild(CHILD);
} else {
	await runParent();
}

async function runChild(label: string): Promise<void> {
	const appPort = Number(process.env.TOAD_MESH_APP_PORT);
	const controlPort = Number(process.env.TOAD_MESH_CONTROL_PORT);
	if (!appPort || !controlPort) throw new Error("mesh child ports are required");

	const web = await import("../src/bun/web/server");
	const { startWebMode, stopWebMode, webBroadcast } = web;
	const { createPairing, claimPairing, instanceIdentity } = await import("../src/bun/web/devices");
	const fleet = await import("../src/bun/fleet/fleet");
	const { initPeerWires, mergePeerRecords, syncPeerWires } = await import("../src/bun/fleet/wire");

	const localActivity = { [`${label}-persona`]: { state: "working", summary: `${label} activity` } };
	const localPreviews = { [`${label}-persona`]: { text: `${label} preview`, at: 1 } };
	let calls: string[] = [];
	let peerEmissions: Push[] = [];
	let suppressed = 0;

	const broadcast = webBroadcast as (name: string, payload: unknown) => void;
	const broadcastToPeers = (web as {
		peerBroadcast?: (name: string, payload: unknown) => void;
	}).peerBroadcast;
	const emitFromPeer = (name: string, payload: unknown, _audience?: unknown) => {
		peerEmissions.push({ push: name, payload });
		// Old code loops too quickly to inspect safely. Let enough real frames
		// through to prove amplification, then stop this harness node's echo.
		if (peerEmissions.length > 6) {
			suppressed++;
			return;
		}
		broadcast(name, payload);
	};

	const handlers: Record<string, (params: unknown) => Promise<unknown>> = {
		listPersonas: async () => [],
		getSessionInfo: async ({ personaId }: any) => ({ personaId, state: "stopped" }),
		listPeerActivity: async () =>
			mergePeerRecords("listLocalPeerActivity", localActivity),
		listLocalPeerActivity: async () => localActivity,
		listPreviews: async () => mergePeerRecords("listLocalPreviews", localPreviews),
		listLocalPreviews: async () => localPreviews,
	};

	const resolve = (method: string) => {
		calls.push(method);
		const exact = handlers[method];
		if (exact) {
			// A recursive merged RPC is itself the bug. Bound it so the caller
			// returns and the parent can report both aggregation failures.
			const repeats = calls.filter((seen) => seen === method).length;
			if ((method === "listPeerActivity" || method === "listPreviews") && repeats > 2) {
				return async () => {
					throw new Error(`mesh harness stopped recursive ${method}`);
				};
			}
			return exact;
		}
		return undefined;
	};

	startWebMode(resolve, appPort);
	fleet.initFleet({
		createTeammate: (draft) => ({ personaId: `${label}-created`, name: draft.name }),
		readTranscript: () => null,
		readThread: () => null,
		deliver: async () => ({ ok: false, detail: "not exercised" }),
		httpOrigin: () => `http://127.0.0.1:${appPort}`,
	});
	initPeerWires({
		send: emitFromPeer,
		publishPersonas: () => {},
	});

	const control = Bun.serve({
		hostname: "127.0.0.1",
		port: controlPort,
		async fetch(request) {
			if (request.method !== "POST") return new Response("mesh control", { status: 200 });
			const input = (await request.json()) as { action?: string; [key: string]: unknown };
			try {
				switch (input.action) {
					case "ready":
						return Response.json({ ok: true, node: instanceIdentity() });
					case "invite":
						return Response.json({ ok: true, result: fleet.createFleetInvite() });
					case "join":
						return Response.json({
							ok: true,
							result: await fleet.joinFleet({
								origin: String(input.origin),
								code: String(input.code),
							}),
						});
					case "sync":
						await syncPeerWires();
						return Response.json({ ok: true });
					case "pair-human": {
						const device = claimPairing(createPairing(), `${label} observer`);
						return Response.json({ ok: true, result: device });
					}
					case "aggregate": {
						const method = String(input.method);
						const handler = handlers[method];
						if (!handler) throw new Error(`unknown aggregate ${method}`);
						return Response.json({ ok: true, result: await handler({}) });
					}
					case "push":
						broadcast(String(input.name), input.payload);
						// On the split-audience contract local facts are offered to
						// peers explicitly. Before that contract webBroadcast itself
						// included every socket, so a second send is neither needed
						// nor available.
						broadcastToPeers?.(String(input.name), input.payload);
						return Response.json({ ok: true });
					case "snapshot":
						return Response.json({
							ok: true,
							result: { calls, peerEmissions, suppressed } satisfies Snapshot,
						});
					case "reset":
						calls = [];
						peerEmissions = [];
						suppressed = 0;
						return Response.json({ ok: true });
					case "stop":
						setTimeout(() => {
							control.stop(true);
							stopWebMode();
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
	appPort: number;
	controlPort: number;
	dataDir: string;
	process: ReturnType<typeof Bun.spawn>;
	command<T = unknown>(input: JsonRecord): Promise<T>;
};

async function runParent(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "toad-mesh-plane-"));
	const base = 47_000 + Math.floor(Math.random() * 1_000);
	const children: Child[] = [];
	const observers: Array<{ close(): void }> = [];
	const failures: string[] = [];

	try {
		await checkProductionAggregationContract(failures);
		const a = spawnChild("a", base, base + 4, base + 2, join(root, "a"));
		const b = spawnChild("b", base + 1, base + 5, base + 3, join(root, "b"));
		children.push(a, b);

		const [readyA, readyB] = await Promise.all([
			eventually(() => a.command<{ node: { instanceId: string } }>({ action: "ready" }), "node A"),
			eventually(() => b.command<{ node: { instanceId: string } }>({ action: "ready" }), "node B"),
		]);

		const invite = await a.command<{ result: { origin?: string; code?: string; error?: string } }>({
			action: "invite",
		});
		if (!invite.result.origin || !invite.result.code) {
			throw new Error(`node A could not invite: ${invite.result.error ?? "unknown error"}`);
		}
		const joined = await b.command<{ result: { ok: boolean; error?: string } }>({
			action: "join",
			origin: invite.result.origin,
			code: invite.result.code,
		});
		if (!joined.result.ok) throw new Error(`node B could not join: ${joined.result.error}`);

		await Promise.all([
			a.command({ action: "sync" }),
			b.command({ action: "sync" }),
		]);
		await eventually(async () => {
			const [as, bs] = await Promise.all([snapshot(a), snapshot(b)]);
			if (!as.calls.includes("getSessionInfo") || !bs.calls.includes("getSessionInfo")) {
				throw new Error("peer wires are not both up");
			}
			return true;
		}, "bidirectional peer wires");

		const [humanA, humanB] = await Promise.all([pairObserver(a), pairObserver(b)]);
		observers.push(humanA, humanB);

		await checkAggregate(
			a,
			b,
			"listPeerActivity",
			"listLocalPeerActivity",
			`${readyB.node.instanceId}/b-persona`,
			failures,
		);
		await checkAggregate(
			a,
			b,
			"listPreviews",
			"listLocalPreviews",
			`${readyB.node.instanceId}/b-persona`,
			failures,
		);

		await checkPush({
			source: b,
			receiver: a,
			sourceObserver: humanB,
			receiverObserver: humanA,
			name: "peerActivityChanged",
			payload: { "b-persona": { state: "working" } },
			expected: { [`${readyB.node.instanceId}/b-persona`]: { state: "working" } },
			label: "peer activity crosses once",
			failures,
		});
		await checkPush({
			source: b,
			receiver: a,
			sourceObserver: humanB,
			receiverObserver: humanA,
			name: "peerActivityChanged",
			payload: {},
			expected: null,
			label: "empty peer activity is dropped",
			failures,
		});
		await checkPush({
			source: b,
			receiver: a,
			sourceObserver: humanB,
			receiverObserver: humanA,
			name: "peerActivityChanged",
			payload: { "another-node/persona": { state: "working" } },
			expected: null,
			label: "qualified peer activity is dropped",
			failures,
		});
		await checkPush({
			source: b,
			receiver: a,
			sourceObserver: humanB,
			receiverObserver: humanA,
			name: "schedulesChanged",
			payload: [{ id: "job-b", personaId: "b-persona" }],
			expected: [{ id: "job-b", personaId: `${readyB.node.instanceId}/b-persona` }],
			label: "schedules cross once",
			failures,
		});
		await checkPush({
			source: b,
			receiver: a,
			sourceObserver: humanB,
			receiverObserver: humanA,
			name: "schedulesChanged",
			payload: [],
			expected: null,
			label: "empty schedules are dropped",
			failures,
		});
		await checkPush({
			source: b,
			receiver: a,
			sourceObserver: humanB,
			receiverObserver: humanA,
			name: "schedulesChanged",
			payload: [{ id: "remote-job", personaId: "another-node/persona" }],
			expected: null,
			label: "qualified schedules are dropped",
			failures,
		});

		if (failures.length > 0) {
			throw new Error(`mesh plane amplified:\n- ${failures.join("\n- ")}`);
		}
		console.log(
			"two linked web wires converge: pushes cross once, filtered empties vanish, and merged RPCs stay local",
		);
	} finally {
		for (const observer of observers) observer.close();
		await Promise.all(
			children.map(async (child) => {
				try {
					await child.command({ action: "stop" });
				} catch {}
				child.process.kill();
				await child.process.exited;
			}),
		);
		rmSync(root, { recursive: true, force: true });
	}
}

function spawnChild(
	label: string,
	appPort: number,
	controlPort: number,
	httpsPort: number,
	dataDir: string,
): Child {
	const child = Bun.spawn(["bun", fileURLToPath(import.meta.url)], {
		cwd: process.cwd(),
		env: {
			...process.env,
			TOAD_MESH_CHILD: label,
			TOAD_MESH_APP_PORT: String(appPort),
			TOAD_MESH_CONTROL_PORT: String(controlPort),
			TOAD_WEB_HTTPS_PORT: String(httpsPort),
			TOAD_DATA_DIR: dataDir,
		},
		stdout: "inherit",
		stderr: "inherit",
	});
	return {
		label,
		appPort,
		controlPort,
		dataDir,
		process: child,
		async command<T>(input: JsonRecord): Promise<T> {
			const response = await fetch(`http://127.0.0.1:${controlPort}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(input),
				signal: AbortSignal.timeout(5_000),
			});
			const body = (await response.json()) as T & { ok?: boolean; error?: string };
			if (!response.ok || body.ok === false) {
				throw new Error(`${label} control failed: ${body.error ?? response.status}`);
			}
			return body;
		},
	};
}

async function eventually<T>(run: () => Promise<T>, label: string, timeoutMs = 6_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let last: unknown;
	while (Date.now() < deadline) {
		try {
			return await run();
		} catch (error) {
			last = error;
			await Bun.sleep(50);
		}
	}
	throw new Error(`${label} did not become ready: ${last instanceof Error ? last.message : last}`);
}

async function snapshot(child: Child): Promise<Snapshot> {
	const body = await child.command<{ result: Snapshot }>({ action: "snapshot" });
	return body.result;
}

async function checkAggregate(
	caller: Child,
	peer: Child,
	method: "listPeerActivity" | "listPreviews",
	localMethod: "listLocalPeerActivity" | "listLocalPreviews",
	remoteKey: string,
	failures: string[],
): Promise<void> {
	await Promise.all([caller.command({ action: "reset" }), peer.command({ action: "reset" })]);
	const body = await caller.command<{ result: JsonRecord }>({ action: "aggregate", method });
	await Bun.sleep(50);
	const [callerState, peerState] = await Promise.all([snapshot(caller), snapshot(peer)]);
	const recursive = [
		...callerState.calls.filter((called) => called === method).map(() => caller.label),
		...peerState.calls.filter((called) => called === method).map(() => peer.label),
	];
	const localOnly = peerState.calls.filter((called) => called === localMethod);
	if (recursive.length > 0) {
		failures.push(`${method} invoked the merged RPC on peers (${recursive.join(", ")})`);
	}
	if (localOnly.length !== 1 || peerState.calls.length !== 1) {
		failures.push(
			`${method} should call ${localMethod} once, got ${JSON.stringify(peerState.calls)}`,
		);
	}
	if (!(remoteKey in body.result)) {
		failures.push(`${method} omitted qualified peer record ${remoteKey}`);
	}
}

/**
 * index.ts cannot be imported without booting Electrobun. Pin its two call
 * sites here so the stand-in handler map cannot accidentally make old
 * production code look fixed.
 */
async function checkProductionAggregationContract(failures: string[]): Promise<void> {
	const source = await Bun.file(
		fileURLToPath(new URL("../src/bun/index.ts", import.meta.url)),
	).text();
	for (const [merged, local] of [
		["listPeerActivity", "listLocalPeerActivity"],
		["listPreviews", "listLocalPreviews"],
	] as const) {
		if (!source.includes(`${local}:`)) {
			failures.push(`index.ts does not expose the local-only ${local} handler`);
		}
		if (!source.includes(`mergePeerRecords("${local}"`)) {
			failures.push(`${merged} does not aggregate through ${local}`);
		}
	}
}

type Observer = {
	messages: Push[];
	clear(): void;
	close(): void;
};

async function pairObserver(child: Child): Promise<Observer> {
	const paired = await child.command<{ result: { token?: string } }>({ action: "pair-human" });
	if (!paired.result.token) throw new Error(`${child.label} did not mint observer token`);
	const ws = new WebSocket(
		`ws://127.0.0.1:${child.appPort}/ws?token=${encodeURIComponent(paired.result.token)}`,
	);
	const messages: Push[] = [];
	ws.onmessage = (event) => {
		const frame = JSON.parse(String(event.data)) as Push;
		if (typeof frame.push === "string") messages.push(frame);
	};
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${child.label} observer socket timed out`)), 3_000);
		ws.onopen = () => {
			clearTimeout(timer);
			resolve();
		};
		ws.onerror = () => {
			clearTimeout(timer);
			reject(new Error(`${child.label} observer socket failed`));
		};
	});
	return {
		messages,
		clear: () => {
			messages.length = 0;
		},
		close: () => ws.close(),
	};
}

async function checkPush(input: {
	source: Child;
	receiver: Child;
	sourceObserver: Observer;
	receiverObserver: Observer;
	name: string;
	payload: unknown;
	expected: unknown | null;
	label: string;
	failures: string[];
}): Promise<void> {
	const {
		source,
		receiver,
		sourceObserver,
		receiverObserver,
		name,
		payload,
		expected,
		label,
		failures,
	} = input;
	await Promise.all([source.command({ action: "reset" }), receiver.command({ action: "reset" })]);
	sourceObserver.clear();
	receiverObserver.clear();
	await source.command({ action: "push", name, payload });
	await Bun.sleep(250);
	const [sourceState, receiverState] = await Promise.all([snapshot(source), snapshot(receiver)]);
	const sourceFrames = sourceObserver.messages.filter((frame) => frame.push === name);
	const receiverFrames = receiverObserver.messages.filter((frame) => frame.push === name);

	if (expected === null) {
		if (receiverFrames.length !== 0 || receiverState.peerEmissions.length !== 0) {
			failures.push(
				`${label}: receiver emitted ${receiverState.peerEmissions.length} and its human saw ${receiverFrames.length}`,
			);
		}
	} else {
		if (receiverFrames.length !== 1 || JSON.stringify(receiverFrames[0]?.payload) !== JSON.stringify(expected)) {
			failures.push(`${label}: receiver human saw ${JSON.stringify(receiverFrames)}`);
		}
		if (receiverState.peerEmissions.length !== 1) {
			failures.push(`${label}: receiver emitted ${receiverState.peerEmissions.length} times`);
		}
	}
	if (sourceFrames.length !== 1) {
		failures.push(`${label}: source human saw ${sourceFrames.length} frames (expected its one local push)`);
	}
	if (sourceState.peerEmissions.length !== 0) {
		failures.push(`${label}: source received its own push back ${sourceState.peerEmissions.length} times`);
	}
	if (sourceState.suppressed + receiverState.suppressed > 0) {
		failures.push(`${label}: harness damper had to suppress an active echo`);
	}
}
