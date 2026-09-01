/**
 * Three isolated desks proving capability advertisement and the matching
 * ladder, end to end over the real node plane:
 *
 * - each desk advertises what it can run (platform, harnesses, the built-in
 *   agent's reach) as a first-hand `desk` record, and every member learns
 *   every advertisement through the same sync personas ride
 * - the matching ladder answers on ANY member, about ANY teammate and ANY
 *   destination — every rung exercised: exact, override, default (the room's,
 *   replicated off the room record), and a loud unavailable
 * - the persona-level override and the room default round-trip through the
 *   real store facades, not through hand-written rows
 * - a desk going dark leaves its last-known advertisement readable everywhere,
 *   marked stale, with when it was last heard
 *
 * The built-in agent's reach is stubbed per desk (TOAD_CAPS_BUILTIN_STUB) so
 * the ladder's verdicts are deterministic and no child spends real network
 * auth probes; the harness list and everything on the wire is real.
 *
 *   bun scripts/verify-capabilities.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DeskCapabilityInfo, HarnessResolution } from "../src/shared/types";

type JsonRecord = Record<string, unknown>;

const CHILD = process.env.TOAD_CAPS_CHILD;

/** The stubbed reach of each desk's built-in agent — what makes rungs decidable. */
const BUILTIN_STUBS: Record<string, { authenticated: boolean; providers: string[]; models: string[] }> = {
	a: { authenticated: true, providers: ["stub"], models: ["stub/model-a"] },
	b: { authenticated: true, providers: ["stub"], models: ["stub/model-a", "stub/model-b"] },
	c: { authenticated: false, providers: [], models: [] },
};

if (CHILD) {
	await runChild(CHILD);
} else {
	await runParent();
}

async function runChild(label: string): Promise<void> {
	const nodePort = Number(process.env.TOAD_NODE_PORT);
	const controlPort = Number(process.env.TOAD_CAPS_CONTROL_PORT);
	if (!nodePort || !controlPort) throw new Error("node and control ports are required");

	const fleet = await import("../src/bun/fleet/fleet");
	const wire = await import("../src/bun/fleet/wire");
	const capabilities = await import("../src/bun/fleet/capabilities");
	const room = await import("../src/bun/node/room");
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
	nodeServer.startNodeServer(resolve, nodePort, wire.nodeLinkServerHooks);

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
					case "advertise":
						await capabilities.refreshDeskCapabilities();
						return Response.json({ ok: true, result: capabilities.deskCapabilities() });
					case "caps":
						return Response.json({
							ok: true,
							result: capabilities.deskCapabilities(String(input.nodeId)),
						});
					case "create-persona": {
						// Through the real facade, so the override field's round-trip is
						// the thing proven — not a hand-written row that happens to match.
						const created = personas.createPersona({
							name: String(input.name),
							backendId: String(input.backendId),
							...(input.modelId ? { modelId: String(input.modelId) } : {}),
						});
						let persona = input.override
							? personas.updatePersona(created.id, {
									harnessOverride: input.override as { backendId: string; modelId?: string },
								})
							: created;
						if (Array.isArray(input.plugins)) {
							persona = personas.updatePersona(created.id, {
								plugins: input.plugins as string[],
							});
						}
						return Response.json({ ok: true, result: persona });
					}
					case "set-room-default":
						return Response.json({
							ok: true,
							result: room.setRoomDefaultHarness(
								input.choice as { backendId: string; modelId?: string } | null,
							),
						});
					case "room":
						return Response.json({ ok: true, result: room.currentRoom() });
					case "resolve":
						return Response.json({
							ok: true,
							result: capabilities.resolveTeammateHarness(
								String(input.personaId),
								String(input.targetNodeId),
							),
						});
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
	const root = mkdtempSync(join(tmpdir(), "toad-capabilities-"));
	const base = 51_400 + Math.floor(Math.random() * 300);
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

		// Every desk advertises before the room even exists; the record store is
		// the memory and the later link-up ships it without being asked again.
		for (const child of children) {
			const own = await child.command<DeskCapabilityInfo>({ action: "advertise" });
			if (own.capabilities.platform !== process.platform) {
				throw new Error(`${child.label} advertised platform ${own.capabilities.platform}`);
			}
			if (!own.capabilities.harnesses.some((harness) => harness.id === "pi")) {
				throw new Error(`${child.label} did not advertise the built-in agent`);
			}
		}

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

		// Advertisements converge: every desk reads every other desk's platform,
		// harness list, and stubbed built-in reach — live, not stale.
		const desks = [
			{ child: a, id: readyA.identity.id },
			{ child: b, id: readyB.identity.id },
			{ child: c, id: readyC.identity.id },
		];
		await eventually(
			async () => {
				await a.command({ action: "sync" });
				for (const reader of desks) {
					for (const subject of desks) {
						if (reader.id === subject.id) continue;
						const caps = await reader.child.command<DeskCapabilityInfo | null>({
							action: "caps",
							nodeId: subject.id,
						});
						if (!caps) throw new Error(`${reader.child.label} has no caps for ${subject.child.label}`);
						if (caps.capabilities.platform !== process.platform) {
							throw new Error("advertised platform did not survive the wire");
						}
						const stub = BUILTIN_STUBS[subject.child.label]!;
						if (caps.capabilities.builtin.authenticated !== stub.authenticated) {
							throw new Error(`${subject.child.label}'s builtin auth did not replicate`);
						}
						if (caps.stale || !caps.online) {
							throw new Error(`${subject.child.label} reads stale while its wire is up`);
						}
						if (caps.heardAt <= 0) throw new Error("heardAt missing on a live advertisement");
					}
				}
				return true;
			},
			"every desk holds every other desk's advertisement",
			30_000,
		);

		// A's teammates, each shaped to land on a different rung when asked
		// about desk B. "no-such-harness" is deliberately not a real backend:
		// a harness the destination never advertised is the deterministic miss.
		const exact = await a.command<{ id: string }>({
			action: "create-persona",
			name: "Exact",
			backendId: "pi",
			modelId: "stub/model-b",
		});
		const override = await a.command<{ id: string; harnessOverride?: { backendId: string } }>({
			action: "create-persona",
			name: "Override",
			backendId: "no-such-harness",
			override: { backendId: "pi", modelId: "stub/model-b" },
		});
		if (override.harnessOverride?.backendId !== "pi") {
			throw new Error("the persona-level override did not round-trip through the store");
		}
		const stranded = await a.command<{ id: string }>({
			action: "create-persona",
			name: "Stranded",
			backendId: "no-such-harness",
			override: { backendId: "also-missing" },
		});

		const rungOn = async (
			child: Child,
			personaId: string,
			targetNodeId: string,
		): Promise<HarnessResolution> => {
			const result = await child.command<Resolved>({
				action: "resolve",
				personaId,
				targetNodeId,
			});
			if (!result.ok) throw new Error(`resolve refused: ${result.error}`);
			/* Four now: the three-step harness climb, then the plugins veto —
			 * reported whether or not the teammate needs one, because a line
			 * that only appears when it fails reads as "we did not check". */
			if (result.resolution.rungs.length !== 4) throw new Error("a rung went unreported");
			if (result.resolution.rungs[3]?.rung !== "plugins") {
				throw new Error("the plugins rung is not where the ladder says it is");
			}
			return result.resolution;
		};

		// Exact: B's built-in agent serves the model A's teammate runs today.
		if ((await rungOn(a, exact.id, readyB.identity.id)).rung !== "exact") {
			throw new Error("the exact rung did not match where it should");
		}
		// Override: the current harness is missing on B, the override runs.
		if ((await rungOn(a, override.id, readyB.identity.id)).rung !== "override") {
			throw new Error("the override rung did not match where it should");
		}
		// Unavailable, twice over: nothing on the ladder is configured to run —
		// and C's unauthenticated built-in agent refuses even the exact teammate.
		if ((await rungOn(a, stranded.id, readyB.identity.id)).rung !== "unavailable") {
			throw new Error("an unrunnable teammate did not resolve unavailable");
		}
		const onC = await rungOn(a, exact.id, readyC.identity.id);
		if (onC.rung !== "unavailable") {
			throw new Error("an unauthenticated desk still matched the built-in agent");
		}
		if (!onC.rungs[0]?.reason) throw new Error("the refusal carries no reason");

		/* The plugins rung. A teammate that names a plugin no desk in this room
		 * has installed is unrunnable everywhere, and the refusal has to name the
		 * plugin — moving it anyway is how a teammate arrives where its tools
		 * quietly are not. Nothing about the harness changed: B still serves the
		 * model, and the veto is reported separately from the climb that matched. */
		const needsBoard = await a.command<{ id: string }>({
			action: "create-persona",
			name: "NeedsBoard",
			backendId: "pi",
			modelId: "stub/model-b",
			plugins: ["com.example.board"],
		});
		const boardOnB = await rungOn(a, needsBoard.id, readyB.identity.id);
		if (boardOnB.rung !== "unavailable") {
			throw new Error("a teammate needing a plugin B lacks still resolved runnable");
		}
		if (boardOnB.rungs[0]?.ok !== true) {
			throw new Error("the harness climb was blamed for a missing plugin");
		}
		const pluginRung = boardOnB.rungs.find((rung) => rung.rung === "plugins");
		if (!pluginRung || pluginRung.ok) throw new Error("the plugins rung did not refuse");
		if (!pluginRung.reason.includes("com.example.board")) {
			throw new Error(`the refusal does not name the plugin: ${pluginRung.reason}`);
		}
		/* And a teammate that needs nothing says so, on the same rung, rather
		 * than the rung disappearing when it has no opinion. */
		const quiet = (await rungOn(a, exact.id, readyB.identity.id)).rungs.find(
			(rung) => rung.rung === "plugins",
		);
		if (!quiet?.ok || !quiet.reason.includes("no plugins")) {
			throw new Error("a teammate needing no plugins did not say so");
		}

		// The room default is the last rung, and it is room policy: set once on
		// the founder, learned by every member off the replicated room record.
		await a.command({ action: "set-room-default", choice: { backendId: "pi", modelId: "stub/model-a" } });
		await eventually(
			async () => {
				const roomOnB = await b.command<{ defaultHarness?: { backendId: string } } | null>({
					action: "room",
				});
				if (roomOnB?.defaultHarness?.backendId !== "pi") {
					throw new Error("the room default has not replicated to B yet");
				}
				const resolution = await rungOn(a, stranded.id, readyB.identity.id);
				if (resolution.rung !== "default") {
					throw new Error(`stranded resolves ${resolution.rung}, not default`);
				}
				// Any member answers about anyone: B, which owns none of this,
				// resolves A's teammate against itself from replicated facts alone.
				const answeredByB = await rungOn(b, override.id, readyB.identity.id);
				if (answeredByB.rung !== "override") {
					throw new Error("a non-owning desk could not answer the ladder");
				}
				return true;
			},
			"the room default replicates and completes the ladder on every member",
			30_000,
		);

		// C goes dark. Its advertisement must survive as last-known — readable,
		// marked stale, still dated — not vanish with the wire.
		await c.command({ action: "stop" });
		await c.process.exited;
		await eventually(
			async () => {
				const caps = await a.command<DeskCapabilityInfo | null>({
					action: "caps",
					nodeId: readyC.identity.id,
				});
				if (!caps) throw new Error("the dark desk's advertisement vanished");
				if (!caps.stale || caps.online) throw new Error("a dark desk still reads online");
				if (caps.heardAt <= 0) throw new Error("last-known advertisement lost its date");
				if (caps.capabilities.builtin.authenticated !== false) {
					throw new Error("last-known capabilities do not match what C advertised");
				}
				// And the ladder still answers about it, from the last-known word.
				const resolution = await rungOn(a, exact.id, readyC.identity.id);
				if (resolution.rung !== "unavailable") {
					throw new Error("the ladder stopped answering about a dark desk");
				}
				return true;
			},
			"a desk going dark leaves last-known capabilities, marked stale",
			30_000,
		);

		console.log(
			"capabilities: every desk advertises first-hand, every member answers the ladder about anyone — exact, override, room default, unavailable, and the plugins veto that names what is missing — and a dark desk leaves its last-known word, marked stale",
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
			TOAD_CAPS_CHILD: label,
			TOAD_NODE_PORT: String(nodePort),
			TOAD_CAPS_CONTROL_PORT: String(controlPort),
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
