/**
 * Three desks, one plugin, one log each — the plugin API's fleet half, proved
 * against real processes and a real wire.
 *
 * Every desk runs the board plugin as a supervised child speaking MCP over
 * stdio for its tools and the Toad bridge for the room. Nothing here stubs the
 * plane: the logs replicate over authenticated NodeLinks through the same
 * engine transcript replication uses, the tools are called the way a model
 * calls them, and the refusals come from the one decision function.
 *
 * What it proves, in order:
 *
 *  - a log a plugin was not granted is refused by name, before any wire
 *  - an owned log's lines reach every desk in the room, byte for byte
 *  - a desk that was dark for a concurrent claim converges on the same winner
 *    when its mirror arrives, with no coordinator and nothing rolled back
 *  - `board_list` reports its own completeness: while a writer is unreachable
 *    it says so and names the desk, instead of quietly showing part of the room
 *  - a fold digest travels as an event and a disagreement is visible
 *  - an event emitted at a dark desk is reported missed, not delivered
 *  - uninstall deletes this desk's own logs and every mirror of that plugin's,
 *    and reports which desks' mirrors it dropped
 *
 *   bun scripts/verify-plugin-log.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type JsonRecord = Record<string, unknown>;

const CHILD = process.env.TOAD_PLUGIN_LOG_CHILD;
const BOARD_DIR = join(dirname(dirname(fileURLToPath(import.meta.url))), "plugins", "board");
const BOARD_ID = "com.toad.board";

async function runChild(label: string): Promise<void> {
	const nodePort = Number(process.env.TOAD_NODE_PORT);
	const controlPort = Number(process.env.TOAD_PLUGIN_LOG_CONTROL_PORT);
	if (!nodePort || !controlPort) throw new Error("node and control ports are required");

	const fleet = await import("../src/bun/fleet/fleet");
	const wire = await import("../src/bun/fleet/wire");
	const capabilities = await import("../src/bun/fleet/capabilities");
	const replication = await import("../src/bun/fleet/replication");
	const identity = await import("../src/bun/node/identity");
	const nodeServer = await import("../src/bun/node/server");
	const host = await import("../src/bun/plugin/host");
	const pluginFleet = await import("../src/bun/plugin/fleet");
	const { Bridge } = await import("../src/bun/mcp/bridge");

	/* The whole bridge, because the plugin's upward door is a real connection to
	 * a real listener. Its teammate half is stubbed: this harness never starts a
	 * session, and a plugin may not call those methods anyway. */
	const bridge = new Bridge({
		/* A whole `SessionInfo`, because a partial one is a lie the compiler
		   used to let through: nothing here starts a session, so every list is
		   empty and the state is the truth. */
		supervisor: {
			info: (personaId) => ({
				personaId,
				state: "stopped" as const,
				contextRestored: false,
				models: [],
				modes: [],
				configs: [],
				slashCommands: [],
				capabilities: { loadSession: false, resume: false, fork: false, mcpHttp: false, image: false },
			}),
		},
		peers: {
			deliver: async () => ({ ok: false as const, reason: "not_found" as const, detail: "not exercised" }),
			activeDelivery: () => undefined,
			markRead: () => 0,
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
			resume: () => ({ ok: false as const, reason: "not_found", detail: "not exercised" }),
			startFresh: async () => ({}),
		},
		react: () => ({ error: "not exercised" }),
		ring: () => ({ error: "not exercised" }),
	});
	if (!(await bridge.start())) throw new Error(`${label} could not own its bridge socket`);

	const handlers: Record<string, (params: never) => Promise<unknown>> = {
		listPersonas: async () => [],
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
	/* `TOAD_PLUGIN_LOG_ISOLATED` is a laptop in a bag: the desk runs, its plugin
	 * runs, and it has no way to reach the room and no way to be reached. That
	 * is what makes the concurrent claim genuinely concurrent instead of a race
	 * against a dial — the desk writes a line nobody could have shown it. */
	const isolated = process.env.TOAD_PLUGIN_LOG_ISOLATED === "1";
	if (isolated) {
		replication.initTranscriptReplication();
	} else {
		wire.initPeerWires({ send: () => {}, publishPersonas: () => {}, resolve });
		nodeServer.startNodeServer(resolve, nodePort, wire.nodeLinkServerHooks);
		replication.initTranscriptReplication();
	}
	pluginFleet.initPluginFleet();
	capabilities.initDeskCapabilities();
	/* What the desk does at boot: plugins are per desk, so a restarted desk
	 * brings back what it had installed before anyone asks it to. */
	await host.startInstalledPlugins();

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
						if (!isolated) await wire.syncPeerWires();
						return Response.json({ ok: true, result: { synced: true } });
					case "links":
						return Response.json({ ok: true, result: wire.nodeLinkSnapshot() });
					case "install": {
						const result = await host.installPlugin({ source: BOARD_DIR, granted: true });
						return Response.json({ ok: true, result });
					}
					case "uninstall":
						return Response.json({ ok: true, result: await host.uninstallPlugin(BOARD_ID) });
					case "plugins":
						return Response.json({ ok: true, result: host.listPlugins() });
					case "caps":
						return Response.json({
							ok: true,
							result: capabilities.deskCapabilities(
								input.nodeId ? String(input.nodeId) : undefined,
							),
						});
					case "refresh-caps":
						await capabilities.refreshDeskCapabilities();
						return Response.json({ ok: true, result: { refreshed: true } });
					/* A tool call shaped the way a model's is: through the host's own
					 * MCP client to the plugin's own server, not through a back door. */
					case "tool": {
						const result = await host.callPluginTool(
							BOARD_ID,
							String(input.name),
							(input.args ?? {}) as Record<string, unknown>,
						);
						return Response.json({ ok: true, result: toolText(result) });
					}
					case "cursors":
						return Response.json({
							ok: true,
							result: pluginFleet.logCursors(BOARD_ID, String(input.logId ?? "ops")),
						});
					case "append-raw":
						return Response.json({
							ok: true,
							result: pluginFleet.appendLog(
								BOARD_ID,
								String(input.logId),
								new TextEncoder().encode(String(input.line)),
							),
						});
					case "emit":
						return Response.json({
							ok: true,
							result: pluginFleet.emitEvent({
								pluginId: BOARD_ID,
								name: String(input.name),
								payload: (input.payload ?? {}) as Record<string, unknown>,
							}),
						});
					case "stop":
						setTimeout(() => {
							void host.stopAllPlugins().finally(() => {
								bridge.stop();
								if (!isolated) nodeServer.stopNodeServer();
								control.stop(true);
								process.exit(0);
							});
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

/** An MCP tool result flattened to the text a model would read. */
function toolText(result: unknown): string {
	const value = result as { ok?: boolean; code?: string; reason?: string; result?: unknown };
	if (value?.ok === false) return `${value.code}: ${value.reason}`;
	const content = (value?.result as { content?: Array<{ text?: string }> } | undefined)?.content;
	return (content ?? []).map((entry) => entry.text ?? "").join("\n");
}

type Child = {
	label: string;
	process: ReturnType<typeof Bun.spawn>;
	command<T>(input: JsonRecord): Promise<T>;
};
type Ready = { identity: { id: string; name: string }; origin: string };
type Link = { nodeId: string; up: boolean };
type Cursors = {
	self: { nodeId: string; gen: number; bytes: number } | null;
	mirrors: Array<{ nodeId: string; bytes: number }>;
	absent: Array<{ nodeId: string; name: string; reason: string }>;
};

let passed = 0;
let failed = 0;

function section(title: string): void {
	console.log(`\n\x1b[36m${title}\x1b[0m`);
}

function check(label: string, ok: boolean, detail = ""): void {
	if (ok) {
		passed++;
		console.log(`\x1b[32m  PASS\x1b[0m ${label}${detail ? ` ${detail}` : ""}`);
	} else {
		failed++;
		console.log(`\x1b[31m  FAIL\x1b[0m ${label}${detail ? ` ${detail}` : ""}`);
	}
}

async function runParent(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "toad-plugin-log-"));
	const base = 51_300 + Math.floor(Math.random() * 300);
	const children: Child[] = [];

	try {
		const a = spawnChild("a", base, base + 10, join(root, "a"));
		const b = spawnChild("b", base + 1, base + 11, join(root, "b"));
		const c = spawnChild("c", base + 2, base + 12, join(root, "c"));
		children.push(a, b, c);

		const [readyA, readyB, readyC] = await Promise.all([
			eventually(() => a.command<Ready>({ action: "ready" }), "desk A"),
			eventually(() => b.command<Ready>({ action: "ready" }), "desk B"),
			eventually(() => c.command<Ready>({ action: "ready" }), "desk C"),
		]);
		const ids = { a: readyA.identity.id, b: readyB.identity.id, c: readyC.identity.id };

		section("Every desk runs the same plugin, as its own supervised process");
		for (const child of children) {
			const installed = await child.command<{ ok: boolean; problems?: string[]; plugin?: { state: string } }>(
				{ action: "install" },
			);
			check(
				`${child.label} installed the board`,
				installed.ok && installed.plugin?.state === "running",
				installed.ok ? "" : (installed.problems ?? []).join("; "),
			);
		}

		section("A grant is the whole policy, and it refuses by name");
		const ungranted = await a.command<{ allowed?: boolean; code?: string; reason?: string }>({
			action: "append-raw",
			logId: "not-declared",
			line: "{}",
		});
		check(
			"a log the manifest never declared is refused before any wire",
			ungranted.allowed === false && ungranted.code === "not_granted",
			ungranted.reason ?? "",
		);
		check(
			"and the refusal names the log rather than merely saying no",
			(ungranted.reason ?? "").includes("not-declared"),
			ungranted.reason ?? "",
		);

		section("The room forms and every desk advertises its plugins");
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
		/* Every desk dials on its own sweep; asking them all to sync once the
		 * invites are in is how a three-desk room forms in seconds rather than in
		 * whatever the backoff happens to be. */
		await eventually(
			async () => {
				for (const child of children) {
					await child.command({ action: "sync" });
					await child.command({ action: "refresh-caps" });
				}
				for (const child of children) {
					const links = await child.command<Link[]>({ action: "links" });
					const down = links.filter((link) => !link.up).map((link) => link.nodeId);
					if (down.length > 0) throw new Error(`${child.label} has ${down.length} link(s) down`);
				}
				const seen = await a.command<{
					capabilities: { format?: number; plugins?: Array<{ id: string }> };
				} | null>({ action: "caps", nodeId: ids.b });
				if (seen?.capabilities.format !== 1) throw new Error("B has not advertised a format yet");
				if (!seen.capabilities.plugins?.some((entry) => entry.id === BOARD_ID)) {
					throw new Error("B's advertisement does not carry the board yet");
				}
				return true;
			},
			"A learns B runs the board",
			30_000,
		);
		check("a desk's advertisement carries its plugins, with a format marker", true);

		section("An owned log reaches every desk in the room");
		const created = await a.command<string>({
			action: "tool",
			name: "board_create",
			args: { title: "Ship the plugin plane" },
		});
		const taskId = /Created (\w+)\./.exec(created)?.[1] ?? "";
		check("A's teammate creates a task through the plugin's own tool", taskId.length > 0, created.split("\n")[0] ?? "");

		for (const holder of [b, c]) {
			await eventually(
				async () => {
					const cursors = await holder.command<Cursors>({ action: "cursors" });
					const mirror = cursors.mirrors.find((entry) => entry.nodeId === ids.a);
					if (!mirror || mirror.bytes === 0) throw new Error("A's ops have not arrived");
					return true;
				},
				`${holder.label} mirrors A's log`,
				60_000,
			);
			const listed = await holder.command<string>({ action: "tool", name: "board_list" });
			check(
				`${holder.label} sees the task A wrote, without A being asked`,
				listed.includes(taskId),
				listed.split("\n")[0] ?? "",
			);
		}

		section("A dark desk claims, and the room agrees anyway");
		/* C is taken off the wire before either claim, so neither claimant can
		 * possibly have seen the other: both stamp the same lamport and the
		 * tie-break is the only thing that decides. That is the case the log
		 * pattern exists for, and it is unreachable with a coordinator. */
		await c.command({ action: "stop" });
		await c.process.exited;
		await eventually(
			async () => {
				const links = await b.command<Link[]>({ action: "links" });
				if (links.find((link) => link.nodeId === ids.c)?.up) {
					throw new Error("B still believes C's wire is up");
				}
				return true;
			},
			"B notices C is dark",
			30_000,
		);

		const listedDark = await b.command<string>({ action: "tool", name: "board_list" });
		check(
			"board_list says how much of the room it can see, and names the desk it cannot",
			listedDark.includes("showing 2 of 3 writers") && listedDark.includes(readyC.identity.name),
			listedDark.split("\n").find((line) => line.startsWith("showing")) ?? "",
		);

		const emitted = await b.command<{ delivered: string[]; missed: string[] }>({
			action: "emit",
			name: "foldDigest",
		});
		check(
			"an event at a dark desk is reported missed, not delivered",
			emitted.missed.includes(ids.c) && emitted.delivered.includes(ids.a),
			`delivered ${emitted.delivered.length}, missed ${emitted.missed.length}`,
		);

		const claimB = await b.command<string>({
			action: "tool",
			name: "board_claim",
			args: { taskId, by: "Bo" },
		});
		check("B claims the task", claimB.startsWith("Claimed"), claimB.split("\n")[0] ?? "");

		/* C comes back on its own desk with its own data, and with no wire at all
		 * — so what it writes next cannot have been informed by B's claim. */
		const dark = spawnChild("c", base + 2, base + 12, join(root, "c"), { isolated: true });
		children.push(dark);
		await eventually(() => dark.command<Ready>({ action: "ready" }), "desk C restarts dark", 30_000);
		const restarted = await dark.command<Array<{ id: string; state: string }>>({ action: "plugins" });
		check(
			"a restarted desk brings its plugins back up on its own",
			restarted.find((entry) => entry.id === BOARD_ID)?.state === "running",
			restarted.map((entry) => `${entry.id}=${entry.state}`).join(", "),
		);
		const sameGen = await dark.command<Cursors>({ action: "cursors" });
		check(
			"and writes the same generation it did before, because its bytes are still there",
			sameGen.self?.gen === 1,
			`gen ${sameGen.self?.gen}`,
		);
		// The premise, checked rather than assumed.
		const stillDark = await dark.command<Link[]>({ action: "links" });
		check(
			"and is off the wire entirely, so what it writes next is genuinely concurrent",
			stillDark.every((link) => !link.up),
			stillDark.map((link) => `${link.nodeId}=${link.up}`).join(", "),
		);
		const claimC = await dark.command<string>({
			action: "tool",
			name: "board_claim",
			args: { taskId, by: "Cy" },
		});
		check(
			"C, still dark to the claim, believes it holds the task",
			claimC.includes("Cy"),
			claimC.split("\n")[0] ?? "",
		);

		/* And now it rejoins the room, on the same port and the same data. */
		await dark.command({ action: "stop" });
		await dark.process.exited;
		const c2 = spawnChild("c", base + 2, base + 12, join(root, "c"));
		children.push(c2);
		await eventually(() => c2.command<Ready>({ action: "ready" }), "desk C rejoins", 30_000);

		const winner = ids.b < ids.c ? "Bo" : "Cy";
		const loser = winner === "Bo" ? "Cy" : "Bo";
		await eventually(
			async () => {
				for (const child of [a, b, c2]) await child.command({ action: "sync" });
				for (const child of [a, b, c2]) {
					const listed = await child.command<string>({ action: "tool", name: "board_list" });
					const row = listed.split("\n").find((line) => line.startsWith(taskId)) ?? "";
					if (!row.includes(winner)) {
						throw new Error(`${child.label} still says ${row}`);
					}
				}
				return true;
			},
			"every desk converges on one winner",
			60_000,
		);
		check(
			`all three desks name the same winner, decided by the log and not by a round trip`,
			true,
			`${winner} beat ${loser}`,
		);

		section("A fold nobody else agrees with is a thing you can look at");
		/* The whole event path, end to end and with a visible consequence: B
		 * emits a digest that cannot be right, it crosses the wire as a push, the
		 * receiving desk stamps `from` off the authenticated link, the bridge
		 * pushes it down the plugin's own connection, and A's next `board_list`
		 * says the two desks folded the same bytes differently. A wrong fold is
		 * the one failure that would otherwise rot invisibly. */
		await b.command({
			action: "emit",
			name: "foldDigest",
			payload: { digest: "0000000000000000000000000000000000000000000000000000000000000000", tasks: 99 },
		});
		const disagreement = await eventually(
			async () => {
				const listed = await a.command<string>({ action: "tool", name: "board_list" });
				if (!listed.includes("fold disagreement")) throw new Error(listed);
				return listed;
			},
			"A sees B's impossible digest",
			20_000,
		);
		check(
			"an event crosses the wire, reaches the plugin, and changes what a tool says",
			disagreement.includes("000000000000"),
			disagreement.split("\n").find((line) => line.startsWith("fold disagreement")) ?? "",
		);

		section("The way out takes the mirrors with it");
		const before = await a.command<Cursors>({ action: "cursors" });
		check(
			"A holds mirrors of the other desks' logs before the uninstall",
			before.mirrors.length >= 1,
			`${before.mirrors.length} mirror(s)`,
		);
		const report = await a.command<{
			removed: boolean;
			logs: { owned: string[]; mirrors: string[]; confirmed: string[]; unconfirmed: string[] };
			pending: string[];
		}>({ action: "uninstall" });
		check("A uninstalls the board", report.removed);
		check(
			"and reports the logs it deleted, by name rather than as a promise",
			report.logs.owned.some((streamId) => streamId.endsWith("/ops")),
			report.logs.owned.join(", "),
		);
		check(
			"and which desks' mirrors went with them",
			report.logs.mirrors.length === before.mirrors.length,
			report.logs.mirrors.join(", ") || "none",
		);
		check(
			"and which desks confirmed dropping their mirror of A's own log, by name",
			report.logs.confirmed.length === 2 && report.logs.unconfirmed.length === 0,
			`${report.logs.confirmed.length} confirmed, ${report.logs.unconfirmed.length} not heard from`,
		);
		const holderAfter = await b.command<Cursors>({ action: "cursors" });
		check(
			"and B really did drop it, rather than being told it would",
			!holderAfter.mirrors.some((entry) => entry.nodeId === ids.a),
			holderAfter.mirrors.map((entry) => entry.nodeId).join(", ") || "none",
		);
		check("with nothing left unfinished", report.pending.length === 0, report.pending.join("; "));
		const remaining = await a.command<Array<{ id: string }>>({ action: "plugins" });
		check("and it is gone from the plugin list", !remaining.some((entry) => entry.id === BOARD_ID));

		console.log(
			`\n${passed} passed, ${failed} failed\n`,
		);
		if (failed > 0) process.exitCode = 1;
	} finally {
		await Promise.all(children.map((child) => child.command({ action: "stop" }).catch(() => undefined)));
		await Promise.all(children.map((child) => child.process.exited));
		rmSync(root, { recursive: true, force: true });
	}
}

function spawnChild(
	label: string,
	nodePort: number,
	controlPort: number,
	dataDir: string,
	options?: { isolated?: boolean },
): Child {
	const childProcess = Bun.spawn([process.execPath, fileURLToPath(import.meta.url)], {
		env: {
			...globalThis.process.env,
			TOAD_PLUGIN_LOG_CHILD: label,
			TOAD_NODE_PORT: String(nodePort),
			TOAD_PLUGIN_LOG_CONTROL_PORT: String(controlPort),
			TOAD_DATA_DIR: dataDir,
			TOAD_CAPS_BUILTIN_STUB: JSON.stringify({ authenticated: false, providers: [], models: [] }),
			...(options?.isolated ? { TOAD_PLUGIN_LOG_ISOLATED: "1" } : {}),
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
				signal: AbortSignal.timeout(30_000),
			});
			const body = (await response.json()) as { ok: boolean; result?: T; error?: string };
			if (!response.ok || !body.ok) throw new Error(`${label}: ${body.error ?? response.status}`);
			return body.result as T;
		},
	};
}

async function eventually<T>(run: () => Promise<T>, label: string, timeoutMs = 15_000): Promise<T> {
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
			await new Promise((resolve) => setTimeout(resolve, 400));
		}
	}
}

/* Dispatched last on purpose: `runParent` reads the counters declared below its
 * own definition, and a top-level await at the head of the file runs before a
 * `let` in the middle of it has been initialized. */
if (CHILD) {
	await runChild(CHILD);
} else {
	await runParent();
}
