/**
 * Three isolated desks proving that a teammate can move itself: the hop_desk
 * tool through the real bridge surface, the park that fires when the turn
 * ends, and the continuation that resumes the teammate on the new desk with
 * no human message. (verify-hop.ts proves the move machinery itself; this
 * harness proves the tool → park → idle-fire → auto-resume loop on top.)
 *
 * - list_desks answers for the whole room from one desk: names, platforms,
 *   online, the ladder's verdict per desk, and the caller's own desk marked
 * - refusals are loud and park nothing: an unknown desk name, an ambiguous
 *   prefix, the desk it already lives on, a desk whose ladder answers
 *   unavailable — after each, no pending park exists
 * - the park: hop_desk mid-turn validates and schedules; nothing moves while
 *   the turn runs; the session going idle fires the normal hop with all its
 *   guards, and the destination auto-resumes the teammate — the resumed
 *   context carries both the moved-desks notice and the continuation nudge
 * - a hop_desk back from the destination completes the round trip the same way
 * - a park whose target desk goes dark before the turn ends fails loudly: a
 *   notice lands on the tape and the park is cleared — no retry, no wedge
 *
 *   bun scripts/verify-self-hop.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionState } from "../src/shared/types";

type JsonRecord = Record<string, unknown>;

const CHILD = process.env.TOAD_SELFHOP_CHILD;
const TOKEN = "verify-selfhop-token";

/** Desk names are the tool's interface; "Be" is a deliberately ambiguous
 * prefix over Beacon and Bestie. Alpha and Beacon can run the teammate,
 * Bestie cannot. */
const NAMES: Record<string, string> = { a: "Alpha", b: "Beacon", c: "Bestie" };
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
	const controlPort = Number(process.env.TOAD_SELFHOP_CONTROL_PORT);
	if (!nodePort || !controlPort) throw new Error("node and control ports are required");

	const fleet = await import("../src/bun/fleet/fleet");
	const wire = await import("../src/bun/fleet/wire");
	const hop = await import("../src/bun/fleet/hop");
	const selfHop = await import("../src/bun/fleet/self-hop");
	const capabilities = await import("../src/bun/fleet/capabilities");
	const identity = await import("../src/bun/node/identity");
	const nodeServer = await import("../src/bun/node/server");
	const personas = await import("../src/bun/store/personas");
	const records = await import("../src/bun/store/records");
	const transcript = await import("../src/bun/store/transcript");
	const bridgeModule = await import("../src/bun/mcp/bridge");

	/* A pretend session per teammate, exactly as verify-hop stubs it — plus the
	 * index.ts wiring under test here: every state change is observed by the
	 * parked self-hop, the way sessionInfoChanged broadcasts are. */
	const sessionStates = new Map<string, SessionState>();
	const stopped: string[] = [];
	/* What the destination resumed the teammate with. The stub mirrors the
	 * wakeTeammate → supervisor funnel contract: the parked hop notice is
	 * consumed once and laid ahead of the prompt's wire text. */
	const resumes = new Map<string, { text: string; wire: string }>();

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
	hop.initHop({
		state: (personaId) => sessionStates.get(personaId) ?? "stopped",
		stop: async (personaId) => {
			stopped.push(personaId);
			sessionStates.set(personaId, "stopped");
		},
		closeChapter: async () => {},
		publish: () => {},
		resume: async (personaId, text) => {
			const moved = personas.takeHopNotice(personaId);
			resumes.set(personaId, { text, wire: moved ? `${moved}\n\n${text}` : text });
		},
	});
	selfHop.initSelfHop({
		hop: (personaId, toNodeId) => hop.requestHop(personaId, toNodeId, { self: true }),
		notice: (personaId, text) => {
			transcript.append(personaId, {
				kind: "notice",
				id: crypto.randomUUID(),
				ts: Date.now(),
				level: "warn",
				text,
			});
		},
	});
	nodeServer.startNodeServer(resolve, nodePort, wire.nodeLinkServerHooks);
	await capabilities.refreshDeskCapabilities();

	/* The real bridge — the same dispatch both agent kinds reach: Toad Agent
	 * in-process through invokeBridge, an ACP child over the unix socket. */
	const bridge = new bridgeModule.Bridge({
		supervisor: {
			info: (personaId: string) => ({
				personaId,
				state: sessionStates.get(personaId) ?? "stopped",
			}),
		},
		peers: {
			deliver: async () => ({ ok: false, reason: "internal", detail: "not exercised" }),
			activeDelivery: () => undefined,
		},
		scheduler: {
			list: () => [],
			schedule: () => {
				throw new Error("not exercised");
			},
			loop: () => {
				throw new Error("not exercised");
			},
			cancel: () => false,
		},
		chapters: {
			search: () => ({ hits: [], truncated: false }),
			list: () => [],
			resume: () => ({ ok: false, reason: "not exercised", detail: "not exercised" }),
			startFresh: async () => ({}),
		},
		react: () => ({ error: "not exercised" }),
	} as never);
	if (!(await bridge.start())) throw new Error(`${label}: the bridge did not start`);

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
						transcript.append(String(input.personaId), {
							kind: "agent",
							id: crypto.randomUUID(),
							ts: Date.now(),
							text: String(input.text ?? ""),
						});
						return Response.json({ ok: true, result: { said: true } });
					}
					case "arm-tool":
						/* The scope a real session registers when it starts. */
						bridgeModule.registerBridgeScope(TOKEN, {
							kind: "human",
							personaId: String(input.personaId),
						});
						return Response.json({ ok: true, result: { armed: true } });
					case "tool": {
						/* The teammate-facing tool surface, driven for real. */
						try {
							const result = await bridgeModule.invokeBridge(
								TOKEN,
								String(input.method),
								(input.params ?? {}) as Record<string, unknown>,
							);
							return Response.json({ ok: true, result: { ok: true, result } });
						} catch (error) {
							return Response.json({
								ok: true,
								result: {
									ok: false,
									code: (error as { code?: string }).code ?? "internal",
									detail: error instanceof Error ? error.message : String(error),
								},
							});
						}
					}
					case "set-state": {
						/* The supervisor's sessionInfoChanged seam: state moves,
						 * and the parked self-hop observes the move. */
						const personaId = String(input.personaId);
						const state = String(input.state) as SessionState;
						sessionStates.set(personaId, state);
						selfHop.observeSessionForSelfHop({ personaId, state });
						return Response.json({ ok: true, result: { set: true } });
					}
					case "park":
						return Response.json({
							ok: true,
							result: selfHop.pendingSelfHop(String(input.personaId)) ?? null,
						});
					case "resumed":
						return Response.json({
							ok: true,
							result: resumes.get(String(input.personaId)) ?? null,
						});
					case "take-hop-notice":
						return Response.json({
							ok: true,
							result: personas.takeHopNotice(String(input.personaId)) ?? null,
						});
					case "notices":
						return Response.json({
							ok: true,
							result: transcript
								.load(String(input.personaId))
								.filter((event) => event.kind === "notice")
								.map((event) => (event as { text: string }).text),
						});
					case "record": {
						const record = records.getRecord("persona", String(input.personaId));
						return Response.json({
							ok: true,
							result: record
								? { ownerNode: record.ownerNode, ownerEpoch: record.ownerEpoch }
								: null,
						});
					}
					case "stop":
						setTimeout(() => {
							bridge.stop();
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
type ToolAnswer =
	| { ok: true; result: JsonRecord }
	| { ok: false; code: string; detail: string };
type Park = { toNodeId: string; toName: string; parkedAt: number } | null;
type RecordMeta = { ownerNode: string; ownerEpoch: number } | null;

async function runParent(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "toad-selfhop-"));
	const base = 53_400 + Math.floor(Math.random() * 300);
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
		if (readyA.identity.name !== "Alpha") {
			throw new Error(`node A is named ${readyA.identity.name}, not Alpha`);
		}
		void readyC;

		const { personaId } = await a.command<{ personaId: string }>({
			action: "create-teammate",
			name: "Rover",
		});
		await a.command({ action: "say", personaId, text: "mid-errand on Alpha" });

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

		const recordOn = async (child: Child): Promise<RecordMeta> =>
			child.command<RecordMeta>({ action: "record", personaId });
		const parkOn = async (child: Child): Promise<Park> =>
			child.command<Park>({ action: "park", personaId });
		const tool = async (child: Child, method: string, params?: JsonRecord): Promise<ToolAnswer> =>
			child.command<ToolAnswer>({ action: "tool", method, params: params ?? {} });

		// The room must know the teammate and both mirrors must be warm before
		// any hop is asked for — same preconditions the hop itself waits on.
		await eventually(
			async () => {
				for (const child of [a, b, c]) {
					const meta = await recordOn(child);
					if (meta?.ownerNode !== aId) throw new Error(`${child.label} does not see A as owner`);
				}
				return true;
			},
			"the persona record reaches every member",
			30_000,
		);

		await a.command({ action: "arm-tool", personaId });

		// -- list_desks: the whole room from one desk ---------------------------
		const listed = await tool(a, "list_desks");
		if (!listed.ok) throw new Error(`list_desks refused: ${listed.detail}`);
		const desks = listed.result.desks as Array<{
			name: string;
			online: boolean;
			current?: boolean;
			runs: { rung: string; reasons?: string[] };
		}>;
		if (desks.length !== 3) throw new Error(`list_desks saw ${desks.length} desks, not 3`);
		const byName = new Map(desks.map((desk) => [desk.name, desk]));
		const alpha = byName.get("Alpha");
		const beacon = byName.get("Beacon");
		const bestie = byName.get("Bestie");
		if (!alpha || !beacon || !bestie) {
			throw new Error(`list_desks names are wrong: ${desks.map((desk) => desk.name).join(", ")}`);
		}
		if (!alpha.current) throw new Error("the desk the teammate lives on is not marked current");
		if (beacon.current || bestie.current) throw new Error("a foreign desk is marked current");
		if (!beacon.online) throw new Error("Beacon should be online");
		if (beacon.runs.rung !== "exact") {
			throw new Error(`Beacon's ladder answer is ${beacon.runs.rung}, not exact`);
		}
		if (bestie.runs.rung !== "unavailable" || (bestie.runs.reasons?.length ?? 0) < 3) {
			throw new Error(`Bestie should be unavailable with every rung's reason: ${JSON.stringify(bestie.runs)}`);
		}
		if (listed.result.pendingMove) throw new Error("a fresh teammate has a pending move");

		// -- refusals park nothing ----------------------------------------------
		const expectRefusal = async (
			desk: string,
			code: string,
			pattern: RegExp,
			label: string,
		): Promise<void> => {
			const answer = await tool(a, "hop_desk", { desk });
			if (answer.ok) throw new Error(`${label}: the refusal did not refuse`);
			if (answer.code !== code) {
				throw new Error(`${label}: refused as ${answer.code}, expected ${code}: ${answer.detail}`);
			}
			if (!pattern.test(answer.detail)) {
				throw new Error(`${label}: the refusal is not loud enough: ${answer.detail}`);
			}
			if (await parkOn(a)) throw new Error(`${label}: a failed validation left a park behind`);
		};
		await expectRefusal("Zebra", "not_found", /Alpha.*Beacon.*Bestie|Beacon.*Bestie/, "unknown desk");
		await expectRefusal("Be", "bad_params", /ambiguous.*Beacon.*Bestie/, "ambiguous prefix");
		await expectRefusal("Alpha", "bad_params", /already live/, "own desk");
		await expectRefusal(
			"Bestie",
			"bad_params",
			/exact.*(signed-in|advertis|available)/,
			"ladder-unavailable desk",
		);

		// -- the park: validated now, fired on idle, resumed on arrival ---------
		await a.command({ action: "set-state", personaId, state: "thinking" });
		const parked = await tool(a, "hop_desk", { desk: "beacon" });
		if (!parked.ok) throw new Error(`hop_desk refused a valid park: ${parked.detail}`);
		if (parked.result.parked !== true || parked.result.desk !== "Beacon") {
			throw new Error(`the park answer is wrong: ${JSON.stringify(parked.result)}`);
		}
		if (!/when this turn ends/.test(String(parked.result.note))) {
			throw new Error(`the park answer does not say when it happens: ${parked.result.note}`);
		}
		const held = await parkOn(a);
		if (held?.toName !== "Beacon") throw new Error("the park did not land");
		const still = await recordOn(a);
		if (still?.ownerNode !== aId) throw new Error("a park moved something before the turn ended");

		// The turn ends; the park fires the normal hop; the destination resumes
		// the teammate with no human message.
		await a.command({ action: "set-state", personaId, state: "ready" });
		await eventually(
			async () => {
				const meta = await recordOn(b);
				if (meta?.ownerNode !== bId || meta.ownerEpoch !== 2) {
					throw new Error(`B sees ${meta?.ownerNode}@${meta?.ownerEpoch}, expected ${bId}@2`);
				}
				return true;
			},
			"the parked hop fires on idle and the record flips to Beacon",
			60_000,
		);
		if (await parkOn(a)) throw new Error("a fired park was not cleared");

		const resumed = await eventually(
			async () => {
				const result = await b.command<{ text: string; wire: string } | null>({
					action: "resumed",
					personaId,
				});
				if (!result) throw new Error("Beacon has not resumed the teammate");
				return result;
			},
			"the destination auto-resumes the self-moved teammate",
			30_000,
		);
		if (!/Hopped desks/.test(resumed.wire) || !/"Alpha"/.test(resumed.wire)) {
			throw new Error(`the resumed context is missing the moved notice: ${resumed.wire}`);
		}
		if (!/self-hop/.test(resumed.text) || !/continue/.test(resumed.text)) {
			throw new Error(`the resumed context is missing the continuation nudge: ${resumed.text}`);
		}
		const leftover = await b.command<string | null>({ action: "take-hop-notice", personaId });
		if (leftover) throw new Error("the resume did not consume the hop notice");

		// -- the round trip ------------------------------------------------------
		await b.command({ action: "arm-tool", personaId });
		await b.command({ action: "set-state", personaId, state: "thinking" });
		const backPark = await tool(b, "hop_desk", { desk: "Alpha" });
		if (!backPark.ok) throw new Error(`the hop back refused to park: ${backPark.detail}`);
		await b.command({ action: "set-state", personaId, state: "ready" });
		await eventually(
			async () => {
				const meta = await recordOn(a);
				if (meta?.ownerNode !== aId || meta.ownerEpoch !== 3) {
					throw new Error(`A sees ${meta?.ownerNode}@${meta?.ownerEpoch}, expected ${aId}@3`);
				}
				return true;
			},
			"the round trip comes home to Alpha",
			60_000,
		);
		if (await parkOn(b)) throw new Error("the return park was not cleared");
		const resumedHome = await eventually(
			async () => {
				const result = await a.command<{ text: string; wire: string } | null>({
					action: "resumed",
					personaId,
				});
				if (!result) throw new Error("Alpha has not resumed the teammate");
				return result;
			},
			"the home desk auto-resumes the returning teammate",
			30_000,
		);
		if (!/Hopped desks/.test(resumedHome.wire) || !/self-hop/.test(resumedHome.text)) {
			throw new Error(`the return resume is incomplete: ${JSON.stringify(resumedHome)}`);
		}

		// -- a park whose target goes dark ---------------------------------------
		const darkPark = await tool(a, "hop_desk", { desk: "Beacon" });
		if (!darkPark.ok) throw new Error(`the dark-desk park refused early: ${darkPark.detail}`);
		b.process.kill(9);
		await b.process.exited;
		type Link = { nodeId: string; up: boolean };
		await eventually(
			async () => {
				const links = await a.command<Link[]>({ action: "links" });
				if (links.find((link) => link.nodeId === bId)?.up) throw new Error("A still sees B up");
				return true;
			},
			"Alpha notices Beacon went dark",
			60_000,
		);
		await a.command({ action: "set-state", personaId, state: "ready" });
		await eventually(
			async () => {
				if (await parkOn(a)) throw new Error("the failed park is still pending");
				const notices = await a.command<string[]>({ action: "notices", personaId });
				const failure = notices.find((text) => /did not happen/.test(text));
				if (!failure) throw new Error("no failure notice landed on the tape");
				if (!/Beacon/.test(failure) || !/cleared/.test(failure)) {
					throw new Error(`the failure notice is not loud enough: ${failure}`);
				}
				return true;
			},
			"a dark target fails the park loudly onto the tape and clears it",
			60_000,
		);
		const homeStill = await recordOn(a);
		if (homeStill?.ownerNode !== aId || homeStill.ownerEpoch !== 3) {
			throw new Error("the failed park disturbed ownership");
		}

		console.log(
			"self-hop: list_desks answers for the whole room from one desk with the home desk marked, refusals (unknown, ambiguous, own desk, ladder-unavailable) are loud and park nothing, a mid-turn hop_desk parks and fires the real hop on idle, the destination auto-resumes the teammate with the moved notice and the continuation nudge and no human message, the round trip comes home the same way, and a target gone dark fails onto the tape with the park cleared",
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
			TOAD_SELFHOP_CHILD: label,
			TOAD_NODE_PORT: String(nodePort),
			TOAD_SELFHOP_CONTROL_PORT: String(controlPort),
			TOAD_NODE_NAME: NAMES[label],
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
