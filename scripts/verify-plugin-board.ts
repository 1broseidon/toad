/**
 * The board's lease semantics and its brainfile projection, on two real desks.
 *
 * `scripts/verify-plugin-log.ts` proves the plane underneath — that an owned
 * log reaches every desk, that a dark desk converges, that uninstall takes the
 * mirrors with it. `plugins/board/*.test.ts` proves the algorithm, completely
 * and in a millisecond. What neither covers is the middle: the operations
 * plan-10 calls a lease, exercised across the wire with real processes, and the
 * files task-15 says must exist on each desk's own disk.
 *
 * What it proves, in order:
 *
 *  - a claim is released by the desk that holds it, and by no other desk — a
 *    refusal that names the holder rather than failing silently
 *  - a task another desk holds cannot be completed out from under it
 *  - a reclaim of a live claim is refused, and both desks agree it was
 *  - a reclaim of an expired claim is accepted, and both desks agree it was —
 *    the decision made from two numbers in the log and no desk's clock
 *  - `board_progress` renews the claim, and the renewal crossing the wire
 *    changes the *other* desk's answer to the same reclaim
 *  - each desk writes its own brainfile-shaped markdown, with its own
 *    filesystem, and the task files are byte-identical on both while the local
 *    index is not — which is what makes the projection unable to become a
 *    coordination path
 *  - the fold digest travels with the cursor set it was computed from, so a
 *    desk that is merely behind is not reported as a desk folding wrongly
 *
 *   bun scripts/verify-plugin-board.ts
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type JsonRecord = Record<string, unknown>;

const CHILD = process.env.TOAD_PLUGIN_BOARD_CHILD;
const BOARD_DIR = join(dirname(dirname(fileURLToPath(import.meta.url))), "plugins", "board");
const BOARD_ID = "com.toad.board";

async function runChild(label: string): Promise<void> {
	const nodePort = Number(process.env.TOAD_NODE_PORT);
	const controlPort = Number(process.env.TOAD_PLUGIN_BOARD_CONTROL_PORT);
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

	const handlers: Record<string, (params: never) => Promise<unknown>> = { listPersonas: async () => [] };
	const resolve = (method: string) => handlers[method] as ((params: unknown) => Promise<unknown>) | undefined;

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
	wire.initPeerWires({ send: () => {}, publishPersonas: () => {}, resolve });
	nodeServer.startNodeServer(resolve, nodePort, wire.nodeLinkServerHooks);
	replication.initTranscriptReplication();
	pluginFleet.initPluginFleet();
	capabilities.initDeskCapabilities();
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
						await wire.syncPeerWires();
						return Response.json({ ok: true, result: { synced: true } });
					case "links":
						return Response.json({ ok: true, result: wire.nodeLinkSnapshot() });
					case "install":
						return Response.json({
							ok: true,
							result: await host.installPlugin({ source: BOARD_DIR, granted: true }),
						});
					case "reach":
						return Response.json({
							ok: true,
							result: host.listPlugins().find((entry) => entry.id === BOARD_ID)?.reach ?? [],
						});
					/* A tool call shaped the way a model's is: through the host's own
					 * MCP client to the plugin's own server, not through a back door. */
					case "tool":
						return Response.json({
							ok: true,
							result: toolText(
								await host.callPluginTool(
									BOARD_ID,
									String(input.name),
									(input.args ?? {}) as Record<string, unknown>,
								),
							),
						});
					case "cursors":
						return Response.json({
							ok: true,
							result: pluginFleet.logCursors(BOARD_ID, "ops"),
						});
					/* Where the plugin's own filesystem is. The parent reads the files
					 * off the disk the plugin wrote them to, because "Toad is not
					 * involved" is the claim under test and asking Toad for them would
					 * be the one way to fail to check it. */
					case "storage":
						return Response.json({ ok: true, result: { dir: host.pluginStorageDir(BOARD_ID) } });
					case "stop":
						setTimeout(() => {
							void host.stopAllPlugins().finally(() => {
								bridge.stop();
								nodeServer.stopNodeServer();
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
type Cursors = { mirrors: Array<{ nodeId: string; bytes: number }> };
type Reach = Array<{ action: string; target: string; allowed: boolean; reason: string }>;

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

/** The row `board_list` prints for one task, on whichever desk was asked. */
function row(listing: string, taskId: string): string {
	return listing.split("\n").find((line) => line.startsWith(taskId)) ?? "";
}

async function runParent(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "toad-plugin-board-"));
	const base = 51_700 + Math.floor(Math.random() * 200);
	const children: Child[] = [];

	try {
		const a = spawnChild("a", base, base + 10, join(root, "a"));
		const b = spawnChild("b", base + 1, base + 11, join(root, "b"));
		children.push(a, b);
		const [readyA, readyB] = await Promise.all([
			eventually(() => a.command<Ready>({ action: "ready" }), "desk A"),
			eventually(() => b.command<Ready>({ action: "ready" }), "desk B"),
		]);
		const ids = { a: readyA.identity.id, b: readyB.identity.id };

		section("The board holds two grants and the page can say so");
		for (const child of children) {
			const installed = await child.command<{ ok: boolean; problems?: string[]; plugin?: { state: string } }>(
				{ action: "install" },
			);
			if (!installed.ok) throw new Error(`${child.label}: ${(installed.problems ?? []).join("; ")}`);
		}
		const reach = await a.command<Reach>({ action: "reach" });
		const refused = (action: string) => reach.find((entry) => entry.action === action);
		check(
			"the board's reach is the log and events, and it is written down",
			refused("fleet.log")?.allowed === true && refused("fleet.events")?.allowed === true,
			reach
				.filter((entry) => entry.allowed)
				.map((entry) => `${entry.action}${entry.target ? `:${entry.target}` : ""}`)
				.join(", "),
		);
		check(
			"and it holds no RPC and no blobs, as a stated no rather than a missing line",
			refused("fleet.rpc.call")?.allowed === false && refused("fleet.blobs")?.allowed === false,
			`${refused("fleet.rpc.call")?.reason}; ${refused("fleet.blobs")?.reason}`,
		);
		check(
			"nor the room's desk list, which the completeness sentence never needed",
			refused("room.desks")?.allowed === false && refused("room.teammates")?.allowed === false,
			refused("room.desks")?.reason ?? "",
		);

		section("A runner may pick work up; taking it off another desk is supervisory");
		/* Read through the same decision function the gate uses, on the manifest
		 * this repository actually ships. The flag has no default precisely so
		 * that this is a stated policy, and a policy nothing checks is a policy
		 * one careless edit away from being the opposite. */
		const { readManifest } = await import("../src/bun/plugin/manifest");
		const { pluginMay } = await import("../src/bun/plugin/permission");
		const read = readManifest(BOARD_DIR);
		check("the shipped board manifest reads", read.ok, read.ok ? "" : read.problems.join(" | "));
		if (read.ok) {
			const inherits = (tool: string) =>
				pluginMay(
					{ pluginId: BOARD_ID, manifest: read.manifest, state: "running" },
					"tool.subagentInherit",
					tool,
				).allowed;
			check(
				"a runner subagent claims, reports and finishes — the loop the board exists for",
				inherits("board_claim") && inherits("board_progress") && inherits("board_complete"),
				["board_claim", "board_progress", "board_complete"].map((t) => `${t}=${inherits(t)}`).join(" "),
			);
			check(
				"and does not create, release or reclaim: the supervisory three stay with the teammate",
				!inherits("board_create") && !inherits("board_release") && !inherits("board_reclaim"),
				["board_create", "board_release", "board_reclaim"].map((t) => `${t}=${inherits(t)}`).join(" "),
			);
			check("reading the board needs no supervision", inherits("board_list"));
		}

		section("The room forms");
		const invite = await a.command<{ origin?: string; code?: string; error?: string }>({ action: "invite" });
		if (!invite.origin || !invite.code) throw new Error(`invite failed: ${invite.error}`);
		const joined = await b.command<{ ok: boolean; error?: string }>({
			action: "join",
			origin: invite.origin,
			code: invite.code,
		});
		if (!joined.ok) throw new Error(`B could not join A: ${joined.error}`);
		await eventually(
			async () => {
				for (const child of children) await child.command({ action: "sync" });
				for (const child of children) {
					const links = await child.command<Link[]>({ action: "links" });
					if (links.length === 0 || links.some((link) => !link.up)) {
						throw new Error(`${child.label} has a link down`);
					}
				}
				return true;
			},
			"A and B wire up",
			45_000,
		);

		/** Waits until every desk's board says the same thing about one task. */
		const converged = async (taskId: string, want: string, why: string) =>
			eventually(
				async () => {
					for (const child of children) await child.command({ action: "sync" });
					const rows: string[] = [];
					for (const child of children) {
						const listing = await child.command<string>({ action: "tool", name: "board_list" });
						const line = row(listing, taskId);
						rows.push(`${child.label}: ${line}`);
						if (!line.includes(want)) throw new Error(rows.join(" | "));
					}
					return rows;
				},
				why,
				60_000,
			);

		section("A claim is a lease, and the desk holding it is the only one who may put it down");
		const created = await a.command<string>({
			action: "tool",
			name: "board_create",
			args: { title: "Land the SDK", by: "Ada" },
		});
		const taskId = /Created (\w+)\./.exec(created)?.[1] ?? "";
		check("A creates a task", taskId.length > 0, created.split("\n")[0] ?? "");

		const claimed = await a.command<string>({
			action: "tool",
			name: "board_claim",
			args: { taskId, by: "Ada", ttlMinutes: 60 },
		});
		check("A claims it", claimed.startsWith("Claimed"), claimed.split("\n")[0] ?? "");
		await converged(taskId, "Ada", "B sees A's claim");

		const stolenRelease = await b.command<string>({
			action: "tool",
			name: "board_release",
			args: { taskId, by: "Bo" },
		});
		check(
			"B cannot release a claim it does not hold, and is told whose it is",
			stolenRelease.includes("held by Ada") && stolenRelease.includes(ids.a),
			stolenRelease.split("\n")[0] ?? "",
		);
		const stolenComplete = await b.command<string>({
			action: "tool",
			name: "board_complete",
			args: { taskId, by: "Bo" },
		});
		check(
			"nor close work another desk is in the middle of",
			stolenComplete.includes("held by Ada"),
			stolenComplete.split("\n")[0] ?? "",
		);

		const liveReclaim = await b.command<string>({
			action: "tool",
			name: "board_reclaim",
			args: { taskId, by: "Bo" },
		});
		check(
			"a reclaim of a live claim is refused, and the refusal is in the log for everyone",
			liveReclaim.includes("stays with Ada"),
			liveReclaim.split("\n")[0] ?? "",
		);
		await converged(taskId, "Ada", "and A agrees the reclaim did not take");

		const released = await a.command<string>({ action: "tool", name: "board_release", args: { taskId, by: "Ada" } });
		check("A releases its own claim", released.startsWith("Released"), released.split("\n")[0] ?? "");
		await converged(taskId, "open", "and the room sees the task open again");

		section("A reclaim is decided by two numbers in the log");
		/* A states a lease that is over the instant it is written. That is a
		 * legitimate thing for a claimant to say, and it is the only way to reach
		 * the expiry branch without waiting half an hour — the point being that
		 * every desk decides from A's stated `expiresAt` and B's stated
		 * `assertedAt`, never from what either desk's clock says now. */
		const short = await a.command<string>({
			action: "tool",
			name: "board_claim",
			args: { taskId, by: "Ada", ttlMinutes: 0 },
		});
		check("A claims again with a lease that is already over", short.startsWith("Claimed"));
		await converged(taskId, "Ada", "B sees the short claim");

		const tookOver = await b.command<string>({ action: "tool", name: "board_reclaim", args: { taskId, by: "Bo" } });
		check(
			"B reclaims it, because the log says it expired",
			tookOver.startsWith("Reclaimed"),
			tookOver.split("\n")[0] ?? "",
		);
		await converged(taskId, "Bo", "and A, who wrote the claim, agrees it lost it");

		section("Progress renews a claim, and the renewal crosses the wire");
		const second = await a.command<string>({
			action: "tool",
			name: "board_create",
			args: { title: "Write the docs", by: "Ada" },
		});
		const renewId = /Created (\w+)\./.exec(second)?.[1] ?? "";
		await a.command({ action: "tool", name: "board_claim", args: { taskId: renewId, by: "Ada", ttlMinutes: 0 } });
		await converged(renewId, "Ada", "B sees the expiring claim");
		const noted = await a.command<string>({
			action: "tool",
			name: "board_progress",
			args: { taskId: renewId, by: "Ada", note: "half a page", ttlMinutes: 60 },
		});
		check("A writes progress on its own claim", noted.startsWith("Noted"), noted.split("\n")[0] ?? "");
		await converged(renewId, "Ada", "B sees the renewal");
		const refusedReclaim = await b.command<string>({
			action: "tool",
			name: "board_reclaim",
			args: { taskId: renewId, by: "Bo" },
		});
		check(
			"and the same reclaim that would have won before it now loses",
			refusedReclaim.includes("stays with Ada"),
			refusedReclaim.split("\n")[0] ?? "",
		);
		const strangerNote = await b.command<string>({
			action: "tool",
			name: "board_progress",
			args: { taskId: renewId, by: "Bo", note: "mine now" },
		});
		check(
			"a desk that does not hold the claim cannot write progress on it either",
			strangerNote.includes("claimant's to write"),
			strangerNote.split("\n")[0] ?? "",
		);

		section("Each desk writes its own markdown, and Toad never sees it");
		const dirs = {
			a: (await a.command<{ dir: string }>({ action: "storage" })).dir,
			b: (await b.command<{ dir: string }>({ action: "storage" })).dir,
		};
		const files = await eventually(
			async () => {
				for (const child of children) await child.command({ action: "tool", name: "board_list" });
				const onA = readFileSync(join(dirs.a, "board", `${renewId}.md`), "utf8");
				const onB = readFileSync(join(dirs.b, "board", `${renewId}.md`), "utf8");
				if (onA !== onB) throw new Error("the two desks' task files differ");
				return { onA, onB };
			},
			"both desks project the same task file",
			45_000,
		);
		check("a desk writes one brainfile-shaped file per task, on its own disk", files.onA.includes(`id: "${renewId}"`));
		check(
			"and the two desks' task files are byte-identical, so nobody need ask the other",
			files.onA === files.onB,
			`${files.onA.length} bytes`,
		);
		check(
			"carrying brainfile's own field names",
			files.onA.includes('status: "claimed"') &&
				files.onA.includes('assignee: "Ada"') &&
				files.onA.includes('progress: "half a page"') &&
				files.onA.includes('column: "in-progress"'),
			files.onA.split("\n").find((line) => line.startsWith("status:")) ?? "",
		);
		const indexA = readFileSync(join(dirs.a, "board.md"), "utf8");
		const indexB = readFileSync(join(dirs.b, "board.md"), "utf8");
		check(
			"while the one file that is this desk's own view differs, and says which it is",
			indexA !== indexB && indexA.includes("identical on every desk; this file is not"),
			`${indexA.length} vs ${indexB.length} bytes`,
		);
		check(
			"every task in the fold has a file, and no file outlives the fold",
			readdirSync(join(dirs.a, "board")).length === 2,
			readdirSync(join(dirs.a, "board")).join(", "),
		);

		section("A digest travels with the cursor set that makes it judgeable");
		const agreed = await eventually(
			async () => {
				for (const child of children) await child.command({ action: "sync" });
				const listing = await a.command<string>({ action: "tool", name: "board_list" });
				if (!listing.includes("desk(s) folded the same cursor set and agree")) throw new Error(listing);
				return listing;
			},
			"A and B report the same fold at the same cursor set",
			60_000,
		);
		check(
			"two converged desks agree, and the agreement is a thing the tool says",
			agreed.includes("1 desk(s) folded the same cursor set and agree"),
			agreed.split("\n").find((line) => line.includes("cursor set and agree")) ?? "",
		);
		check(
			"and no desk is accused of folding wrongly for being behind",
			!agreed.includes("fold disagreement"),
			agreed.split("\n").find((line) => line.startsWith("fold digest")) ?? "",
		);

		const held = await a.command<Cursors>({ action: "cursors" });
		check(
			"the whole thing ran on one mirrored log per desk, and nothing else",
			held.mirrors.some((entry) => entry.nodeId === ids.b),
			held.mirrors.map((entry) => `${entry.nodeId}:${entry.bytes}b`).join(", ") || "none",
		);

		console.log(`\n${passed} passed, ${failed} failed\n`);
		if (failed > 0) process.exitCode = 1;
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
			TOAD_PLUGIN_BOARD_CHILD: label,
			TOAD_NODE_PORT: String(nodePort),
			TOAD_PLUGIN_BOARD_CONTROL_PORT: String(controlPort),
			TOAD_DATA_DIR: dataDir,
			TOAD_CAPS_BUILTIN_STUB: JSON.stringify({ authenticated: false, providers: [], models: [] }),
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
