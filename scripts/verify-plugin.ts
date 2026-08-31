/**
 * The plugin plane, end to end: enumeration on both agent kinds, absence with a
 * cause, and a board two desks agree on without ever agreeing on anything.
 *
 * The other plugin harnesses each own a slice — `verify-tool-ledger` the
 * absences core already had, `verify-plugin-tools` one plugin's install-to-
 * uninstall life, `verify-plugin-log` the transport, `verify-plugin-board` the
 * lease semantics. This one drives the claims the whole design was argued on,
 * and it is deliberately the harness that would go red first if any of them
 * stopped being true:
 *
 *  1. one registration reaches Toad Agent *and* an ACP backend, and Toad knows
 *     the tool NAMES on both — asserted against Toad's own enumeration, which
 *     is the thing that is impossible today for an ACP backend
 *  2. a tool that did not load is absent with a cause, provoked twice for real:
 *     a plugin that will not start, and a running plugin whose live tool list
 *     turns out to disagree with the manifest Toad answers `tools/list` from
 *  3. two desks each write their own `ops` log, replicate, and fold the same
 *     board byte for byte — then partition, both claim the same task, heal, and
 *     converge on one winner decided by `(lamport, desk)`, with the loser told
 *  4. a reclaim is decided by two numbers in the log and no clock: the real
 *     fold, over the real bytes, refuses to be given a clock at all
 *  5. writing another desk's log has no expressible shape — proved from inside
 *     a plugin, from another desk over the wire, and at the store
 *  6. `board_list` names the writer it cannot see instead of quietly showing
 *     part of the room
 *  7. the tape's own gate: `replicas.test.ts` and `verify-transcripts.ts`,
 *     unchanged and green, because a plugin API is not worth destabilising the
 *     thing Toad is for
 *
 * Every desk gets its own scratch `TOAD_DATA_DIR`; nothing here touches the
 * user's data directory or the network.
 *
 *   bun scripts/verify-plugin.ts
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type JsonRecord = Record<string, unknown>;

const CHILD = process.env.TOAD_PLUGIN_VERIFY_CHILD;
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);
const FIXTURE_DIR = join(HERE, "plugin-fixture");
const PROBE_DIR = join(HERE, "plugin-probe");
const BOARD_DIR = join(REPO, "plugins", "board");
const FIXTURE_ID = "team.toad.fixture";
const PROBE_ID = "team.toad.probe";
const BOARD_ID = "com.toad.board";

let passed = 0;
let failed = 0;

function section(title: string): void {
	console.log(`\n\x1b[36m${title}\x1b[0m`);
}

function check(label: string, ok: boolean, detail: unknown = ""): void {
	const suffix = detail === "" || detail === undefined ? "" : ` ${String(detail)}`;
	if (ok) {
		passed++;
		console.log(`\x1b[32m  PASS\x1b[0m ${label}${suffix}`);
	} else {
		failed++;
		console.log(`\x1b[31m  FAIL\x1b[0m ${label}${suffix}`);
	}
}

/* ========================================================================== */
/* One desk: what Toad can say about a plugin's tools, to itself.             */
/* ========================================================================== */

type Row = import("../src/shared/types").ToolLedgerRow;

async function oneDesk(dataDir: string): Promise<void> {
	mkdirSync(dataDir, { recursive: true });
	process.env.TOAD_DATA_DIR = dataDir;

	const { Client, StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client");
	const { createPersona } = await import("../src/bun/store/personas");
	const { resolveMcpServers } = await import("../src/bun/mcp/servers");
	const host = await import("../src/bun/plugin/host");
	const { pluginProxyToken, pluginProxyUrl, stopPluginProxy } = await import("../src/bun/plugin/proxy");
	const { teammateTools } = await import("../src/bun/agent/tool-ledger");
	const { AcpSession } = await import("../src/bun/acp/session");
	const { Supervisor } = await import("../src/bun/acp/supervisor");
	const { Bridge } = await import("../src/bun/mcp/bridge");

	/* A real bridge, so "Toad's own tools are not here" is the compatibility
	 * verdict speaking rather than the socket being missing. Two absences with
	 * two causes is the distinction the ledger exists to keep. */
	const bridge = new Bridge({
		supervisor: { info: () => ({}) as never },
		peers: {} as never,
		scheduler: {} as never,
		chapters: {} as never,
		react: () => ({ on: "" }),
		ring: () => ({ on: "" }),
	});
	await bridge.start();

	const rows = (personaId: string): Row[] => teammateTools(personaId)?.rows ?? [];
	const pluginRows = (personaId: string): Row[] =>
		rows(personaId).filter((row) => row.source === "plugin" && row.origin === FIXTURE_ID);
	/** The row for one declared tool, whatever the agent kind mangled it into. */
	const forTool = (personaId: string, tool: string): Row | undefined =>
		pluginRows(personaId).find((row) => row.name === tool || row.name.endsWith(`__${tool}`));

	const declared = ["fixture_shout", "fixture_whisper"];

	// ------------------------------------------------------------------------
	section("A payload that could forge provenance does not install");

	/* First-hand-ness in this tree comes from the receiving desk stamping the
	 * sender itself. A plugin that could declare `from` in its own payload would
	 * be handing its author a field that looks authoritative and is not, which
	 * is the fastest route to a plugin becoming a relay for unsigned claims. */
	for (const [field, payload] of [
		["from", { type: "object", properties: { from: { type: "string" } } }],
		["src", { type: "object", properties: { src: { type: "string" } } }],
		["desk", { type: "object", properties: { desk: { type: "string" } } }],
		[
			"node",
			{
				type: "object",
				properties: {
					inner: { type: "object", properties: { node: { type: "string" } } },
				},
			},
		],
	] as Array<[string, unknown]>) {
		const dir = mkdtempSync(join(tmpdir(), `toad-plugin-${field}-`));
		writeFileSync(
			join(dir, "toad-plugin.json"),
			JSON.stringify({
				id: "com.example.forge",
				version: "0.1.0",
				name: "Forge",
				serve: { command: "bun", args: ["server.ts"] },
				tools: [
					{
						name: "t",
						description: "d",
						inputSchema: { type: "object" },
						subagentInherits: false,
					},
				],
				events: [{ name: "e", payload }],
			}),
		);
		const refused = await host.installPlugin({ source: dir, granted: true });
		check(
			`a payload declaring "${field}" is refused at install, and the refusal names the field`,
			!refused.ok && refused.problems.join(" ").includes(field),
			refused.ok ? "installed anyway" : refused.problems.join(" | "),
		);
		rmSync(dir, { recursive: true, force: true });
	}
	check("and nothing was left installed by the refusals", host.listPlugins().length === 0);

	// ------------------------------------------------------------------------
	section("One registration, and Toad knows the names on both agent kinds");

	const installed = await host.installPlugin({ source: FIXTURE_DIR, granted: true });
	if (!installed.ok) {
		check("the fixture installs", false, installed.problems.join(" | "));
		bridge.stop();
		return;
	}
	check("the fixture installs and runs", installed.plugin.state === "running", installed.plugin.reason);

	/* An ACP backend nobody has tested: the deny path, which is exactly where a
	 * plugin has to still arrive. `resolveMcpServers` returns the configured
	 * list whether or not Toad's own sidecar attaches. */
	const acp = createPersona({ name: "Acp", goal: "g", backendId: "a-backend-nobody-has-tested" });
	const session = new AcpSession(acp, {
		appendEvent: () => {},
		updateEvent: () => {},
		delta: () => {},
		infoChanged: () => {},
		history: () => [],
		sessionCheckpointed: () => {},
	});
	(session as unknown as { mcpServers(): unknown[] }).mcpServers();
	check(
		"an ACP teammate's ledger names both plugin tools before a turn is taken",
		declared.every((tool) => forTool(acp.id, tool)?.state === "declared"),
		pluginRows(acp.id)
			.map((row) => `${row.name}=${row.state}`)
			.join(", "),
	);
	check(
		"and says why they are only declared, rather than claiming they loaded",
		declared.every((tool) => (forTool(acp.id, tool)?.reason ?? "").length > 20),
		forTool(acp.id, "fixture_shout")?.reason,
	);

	/* A stock MCP client is exactly what an ACP backend brings, and Toad owns
	 * the other end of the URL, so this handshake is the proof that used to be
	 * unobtainable. */
	const url = pluginProxyUrl(FIXTURE_ID, acp.id);
	const outside = new Client({ name: "pretend-acp-backend", version: "0" });
	await outside.connect(
		new StreamableHTTPClientTransport(new URL(url), {
			requestInit: { headers: { Authorization: `Bearer ${pluginProxyToken(FIXTURE_ID, acp.id)}` } },
		}),
	);
	const listed = await outside.listTools();
	check(
		"the backend lists the manifest's tools off Toad's own endpoint",
		listed.tools
			.map((tool) => tool.name)
			.sort()
			.join(",") === declared.join(","),
		listed.tools.map((tool) => tool.name).join(","),
	);
	check(
		"and Toad's enumeration turns declared into verified, by name",
		declared.every((tool) => forTool(acp.id, tool)?.state === "verified"),
		pluginRows(acp.id)
			.map((row) => `${row.name}=${row.state}`)
			.join(", "),
	);

	const pi = createPersona({ name: "Pi", goal: "g", backendId: "pi" });
	const supervisor = new Supervisor({
		transcriptAppended: () => {},
		transcriptUpdated: () => {},
		streamDelta: () => {},
		sessionInfoChanged: () => {},
	});
	const info = await supervisor.start(pi.id);
	check(
		"Toad Agent takes the same descriptor and its ledger names the same tools",
		declared.every((tool) => forTool(pi.id, tool)?.state === "verified"),
		pluginRows(pi.id)
			.map((row) => `${row.name}=${row.state}`)
			.join(", ") || (info.error ?? info.state),
	);
	check(
		"under the names the model will really see, which are not the same names",
		forTool(pi.id, "fixture_shout")?.name !== forTool(acp.id, "fixture_shout")?.name,
		`${forTool(pi.id, "fixture_shout")?.name} vs ${forTool(acp.id, "fixture_shout")?.name}`,
	);
	check(
		"one descriptor served both, on Toad's own loopback path per teammate",
		resolveMcpServers(pi).some(
			(server) => server.id === `plugin:${FIXTURE_ID}` && server.type === "http",
		),
	);

	// ------------------------------------------------------------------------
	section("A tool that did not load says which tool, and why");

	/* Failure one: the plugin will not start. Nothing about this is simulated —
	 * the child process really refuses, the host really gives up. */
	process.env.TOAD_PLUGIN_FIXTURE_CRASH = "1";
	await host.stopPlugin(FIXTURE_ID);
	const crashed = await host.startPlugin(FIXTURE_ID);
	delete process.env.TOAD_PLUGIN_FIXTURE_CRASH;
	check("a plugin that refuses to start is not running", crashed?.state !== "running", crashed?.state);
	check(
		"and every teammate's ledger says the tool is gone, naming it and the cause",
		declared.every((tool) => {
			const row = forTool(acp.id, tool);
			return row?.state === "absent" && /did not start|exited|crashed/.test(row.reason);
		}),
		forTool(acp.id, "fixture_shout")?.reason,
	);
	check(
		"on the built-in agent's ledger too, which is a different teammate entirely",
		declared.every((tool) => forTool(pi.id, tool)?.state === "absent"),
		forTool(pi.id, "fixture_shout")?.reason,
	);

	/* Failure two, and the one worth the whole ledger: the plugin starts, and
	 * serves a tool list that is not the one Toad has been telling teammates
	 * about. Before this was caught, those rows stayed `verified` — Toad going
	 * on saying a tool was there, from its own records, after learning it was
	 * not. Silence is what this assertion exists to fail on. */
	await host.stopPlugin(FIXTURE_ID);
	process.env.TOAD_PLUGIN_FIXTURE_EXTRA_TOOL = "1";
	const mismatched = await host.startPlugin(FIXTURE_ID);
	delete process.env.TOAD_PLUGIN_FIXTURE_EXTRA_TOOL;
	check(
		"a live tool list that disagrees with the manifest stops the plugin",
		mismatched?.state === "failed" && mismatched.reason.includes("fixture_undeclared"),
		mismatched?.reason,
	);
	check(
		"and the ledger stops saying the tools are there, naming what disagreed",
		declared.every((tool) => {
			const row = forTool(acp.id, tool);
			return row?.state === "absent" && row.reason.includes("fixture_undeclared");
		}),
		forTool(acp.id, "fixture_shout")?.reason,
	);

	await host.stopPlugin(FIXTURE_ID);
	const recovered = await host.startPlugin(FIXTURE_ID);
	check("and it comes back when the disagreement does not", recovered?.state === "running", recovered?.reason);
	await outside.listTools();
	check(
		"with the ledger returning to verified on the next attach, not left condemned",
		declared.every((tool) => forTool(acp.id, tool)?.state === "verified"),
		pluginRows(acp.id)
			.map((row) => `${row.name}=${row.state}`)
			.join(", "),
	);

	await outside.close().catch(() => undefined);
	await supervisor.stopAll();
	await host.stopAllPlugins();
	stopPluginProxy();
	bridge.stop();
}

/* ========================================================================== */
/* Two desks: the board, a partition, and a winner nobody negotiated.         */
/* ========================================================================== */

type Child = {
	label: string;
	process: ReturnType<typeof Bun.spawn>;
	command<T>(input: JsonRecord): Promise<T>;
};
type Ready = { identity: { id: string; name: string }; origin: string };
type Link = { nodeId: string; up: boolean };
type Cursors = {
	self: { nodeId: string; gen: number; bytes: number } | null;
	mirrors: Array<{ nodeId: string; bytes: number; gens: Record<string, { held: number }> }>;
	absent: Array<{ nodeId: string; name: string; reason: string }>;
	unreachable: Array<{ nodeId: string; name: string; reason: string }>;
};
type LogText = Array<{ owner: string; gen: number; text: string }>;

/** The line `board_list` prints for one task, on whichever desk was asked. */
function row(listing: string, taskId: string): string {
	return listing.split("\n").find((line) => line.startsWith(taskId)) ?? "";
}

/** The `fold digest X at cursor set Y` line, as a pair. */
function digests(listing: string): { fold: string; cursor: string } {
	const match = /fold digest (\w+) at cursor set (\w+)/.exec(listing);
	return { fold: match?.[1] ?? "", cursor: match?.[2] ?? "" };
}

async function twoDesks(root: string): Promise<void> {
	const { fold } = await import("../plugins/board/fold");
	const { ToadBridge } = await import("../plugins/toad-plugin-sdk/bridge");

	const base = 51_900 + Math.floor(Math.random() * 150);
	const dirs = { a: join(root, "a"), b: join(root, "b") };
	const ports = { a: [base, base + 10] as const, b: [base + 1, base + 11] as const };
	const children: Child[] = [];
	const spawn = (label: "a" | "b", partitioned = false): Child => {
		const child = spawnChild(label, ports[label][0], ports[label][1], dirs[label], partitioned);
		children.push(child);
		return child;
	};

	let a = spawn("a");
	let b = spawn("b");
	try {
		const [readyA, readyB] = await Promise.all([
			eventually(() => a.command<Ready>({ action: "ready" }), "desk A"),
			eventually(() => b.command<Ready>({ action: "ready" }), "desk B"),
		]);
		const ids = { a: readyA.identity.id, b: readyB.identity.id };
		const names = { a: readyA.identity.name, b: readyB.identity.name };

		for (const child of [a, b]) {
			for (const source of [BOARD_DIR, PROBE_DIR]) {
				const result = await child.command<{ ok: boolean; problems?: string[] }>({
					action: "install",
					source,
				});
				if (!result.ok) throw new Error(`${child.label}: ${(result.problems ?? []).join("; ")}`);
			}
		}

		section("The room forms, and each desk learns what the other runs");
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
		await eventually(
			async () => {
				for (const child of [a, b]) {
					await child.command({ action: "sync" });
					await child.command({ action: "refresh-caps" });
				}
				for (const child of [a, b]) {
					const links = await child.command<Link[]>({ action: "links" });
					if (links.length === 0 || links.some((link) => !link.up)) {
						throw new Error(`${child.label} has a link down`);
					}
				}
				const seen = await a.command<{ capabilities: { plugins?: Array<{ id: string }> } } | null>({
					action: "caps",
					nodeId: ids.b,
				});
				if (!seen?.capabilities.plugins?.some((entry) => entry.id === BOARD_ID)) {
					throw new Error("A has not learned that B runs the board");
				}
				return true;
			},
			"A and B wire up and advertise",
			45_000,
		);
		check("both desks are up and each advertises the board", true, `${names.a} + ${names.b}`);

		// --------------------------------------------------------------------
		section("board_list names the writer it cannot see");

		const created1 = await a.command<string>({
			action: "tool",
			name: "board_create",
			args: { title: "Land the plugin plane", by: "Ada" },
		});
		const task1 = /Created (\w+)\./.exec(created1)?.[1] ?? "";
		check("A writes the first task onto its own log", task1.length > 0, created1.split("\n")[0]);

		/* B goes dark before it has written a byte, so A holds nothing of B's and
		 * cannot pretend otherwise. This is the case core's record plane gets
		 * silently wrong: converge on part of the room and say nothing. */
		await stop(b);
		b = spawn("b", true);
		await eventually(() => b.command<Ready>({ action: "ready" }), "B restarts partitioned", 30_000);
		await eventually(
			async () => {
				await a.command({ action: "sync" });
				const links = await a.command<Link[]>({ action: "links" });
				if (links.find((link) => link.nodeId === ids.b)?.up) throw new Error("A still sees B up");
				return true;
			},
			"A notices B is gone",
			30_000,
		);

		const partial = await a.command<string>({ action: "tool", name: "board_list" });
		check(
			"A says how much of the room it is showing, and names the desk it is not",
			partial.includes("showing 1 of 2 writers") && partial.includes(names.b),
			partial.split("\n").find((line) => line.startsWith("showing")),
		);
		const missing = await a.command<Cursors>({ action: "cursors" });
		check(
			"and it is the right desk — the log plane answers with an id, not just a sentence",
			missing.absent.length === 1 && missing.absent[0]!.nodeId === ids.b,
			missing.absent.map((entry) => `${entry.name}/${entry.nodeId}`).join(", ") || "none",
		);
		const dark = await b.command<Link[]>({ action: "links" });
		check(
			"and B really is off the wire, so what it writes next is genuinely its own",
			dark.every((link) => !link.up),
			dark.map((link) => `${link.nodeId}=${link.up}`).join(", ") || "no links at all",
		);

		// --------------------------------------------------------------------
		section("Two desks, two logs, one board");

		const created2 = await b.command<string>({
			action: "tool",
			name: "board_create",
			args: { title: "Write it down", by: "Bo" },
		});
		const task2 = /Created (\w+)\./.exec(created2)?.[1] ?? "";
		check("B writes its own task while it cannot see A's", task2.length > 0, created2.split("\n")[0]);

		await stop(b);
		b = spawn("b");
		await eventually(() => b.command<Ready>({ action: "ready" }), "B rejoins the room", 30_000);
		const converged = async (why: string, want: (listing: string) => boolean): Promise<string[]> =>
			eventually(
				async () => {
					for (const child of [a, b]) await child.command({ action: "sync" });
					const listings: string[] = [];
					for (const child of [a, b]) {
						const listing = await child.command<string>({ action: "tool", name: "board_list" });
						if (!want(listing)) throw new Error(`${child.label}: ${listing.split("\n").join(" / ")}`);
						listings.push(listing);
					}
					return listings;
				},
				why,
				90_000,
			);

		const both = await converged(
			"both desks hold both tasks",
			(listing) => listing.includes(task1) && listing.includes(task2),
		);
		check(
			"each desk holds the other's writing, having asked nobody for it",
			both.every((listing) => row(listing, task1) !== "" && row(listing, task2) !== ""),
			both.map((listing) => row(listing, task2)).join(" | "),
		);
		check(
			"and they fold the same board from the same bytes — one digest, one cursor set",
			digests(both[0]!).fold === digests(both[1]!).fold &&
				digests(both[0]!).cursor === digests(both[1]!).cursor &&
				digests(both[0]!).fold.length > 0,
			`${digests(both[0]!).fold} at ${digests(both[0]!).cursor}`,
		);

		const files = {
			a: (await a.command<{ dir: string }>({ action: "storage" })).dir,
			b: (await b.command<{ dir: string }>({ action: "storage" })).dir,
		};
		const projected = await eventually(
			async () => {
				for (const child of [a, b]) await child.command({ action: "tool", name: "board_list" });
				const onA = readFileSync(join(files.a, "board", `${task2}.md`), "utf8");
				const onB = readFileSync(join(files.b, "board", `${task2}.md`), "utf8");
				if (onA !== onB) throw new Error("the two desks projected different files");
				return onA;
			},
			"both desks project B's task identically",
			45_000,
		);
		check(
			"and each writes the same task file on its own disk, with Toad not involved",
			projected.includes(`id: "${task2}"`),
			`${projected.length} bytes, byte-identical`,
		);

		// --------------------------------------------------------------------
		section("A partition, two claims, one winner");

		/* Both desks go dark to each other, so neither claim can have been
		 * informed by the other. That is the case the log pattern exists for and
		 * the one a coordinator cannot be tested against. */
		await stop(a);
		await stop(b);
		a = spawn("a", true);
		b = spawn("b", true);
		await Promise.all([
			eventually(() => a.command<Ready>({ action: "ready" }), "A restarts partitioned", 30_000),
			eventually(() => b.command<Ready>({ action: "ready" }), "B restarts partitioned", 30_000),
		]);
		const claimA = await a.command<string>({
			action: "tool",
			name: "board_claim",
			args: { taskId: task1, by: "Ada", ttlMinutes: 60 },
		});
		const claimB = await b.command<string>({
			action: "tool",
			name: "board_claim",
			args: { taskId: task1, by: "Bo", ttlMinutes: 60 },
		});
		check(
			"both desks believe they claimed it, because neither could see the other",
			claimA.startsWith("Claimed") && claimB.startsWith("Claimed"),
			`${claimA.split("\n")[0]} / ${claimB.split("\n")[0]}`,
		);

		/* The premise of the tie-break, asserted rather than assumed: two claims
		 * at the same lamport is what makes the desk id the thing that decides. */
		const stamps = await Promise.all(
			[a, b].map(async (child) => {
				const logs = await child.command<LogText>({ action: "logs" });
				const own = logs.find((entry) => entry.owner === (child === a ? ids.a : ids.b));
				return claimLamport(own?.text ?? "", task1);
			}),
		);
		check(
			"and both stamped the same lamport, so nothing but the desk id can decide",
			stamps[0] !== undefined && stamps[0] === stamps[1],
			`lamport ${stamps[0]} on both`,
		);

		await stop(a);
		await stop(b);
		a = spawn("a");
		b = spawn("b");
		await Promise.all([
			eventually(() => a.command<Ready>({ action: "ready" }), "A heals", 30_000),
			eventually(() => b.command<Ready>({ action: "ready" }), "B heals", 30_000),
		]);

		const winner = ids.a < ids.b ? "Ada" : "Bo";
		const loser = winner === "Ada" ? "Bo" : "Ada";
		const loserDesk = winner === "Ada" ? b : a;
		/* The winner is computed here from the rule, not read back from the desks,
		 * so a room that agrees on the wrong answer fails this rather than
		 * confirming itself. Caught rather than thrown: this is the central claim
		 * and the rest of the run is still worth hearing. */
		const healed = await converged(
			`every desk converges on ${winner}`,
			(listing) => row(listing, task1).includes(`claimed by ${winner}`),
		).catch(() => null);
		const listings =
			healed ??
			(await Promise.all(
				[a, b].map((child) => child.command<string>({ action: "tool", name: "board_list" })),
			));
		check(
			"every desk names the same holder, decided by (lamport, desk) and no round trip",
			healed !== null && listings.every((listing) => row(listing, task1).includes(`claimed by ${winner}`)),
			listings.map((listing) => row(listing, task1)).join(" | "),
		);
		const loserRow = row(listings[winner === "Ada" ? 1 : 0]!, task1);
		check(
			"and the loser's own board says so — it finds out because its mirror arrived",
			loserRow.includes(`claimed by ${winner}`) && !loserRow.includes(`claimed by ${loser}`),
			loserRow,
		);
		const told = await loserDesk.command<string>({
			action: "tool",
			name: "board_claim",
			args: { taskId: task1, by: loser, ttlMinutes: 60 },
		});
		check(
			"and asking again is answered with who has it and why, not with a silent no",
			told.includes(`went to ${winner}`) && told.includes("ordered first"),
			told.split("\n")[0],
		);

		// --------------------------------------------------------------------
		section("A reclaim is decided by two numbers in the log, and no clock");

		const created3 = await a.command<string>({
			action: "tool",
			name: "board_create",
			args: { title: "Prove the clock does not decide", by: "Ada" },
		});
		const task3 = /Created (\w+)\./.exec(created3)?.[1] ?? "";
		/* A lease that is over the instant it is written is a legitimate thing for
		 * a claimant to say, and the only way to reach the expiry branch without
		 * waiting half an hour. Both desks still decide from A's stated
		 * `expiresAt` and B's stated `assertedAt`, both of them in the log. */
		await a.command({
			action: "tool",
			name: "board_claim",
			args: { taskId: task3, by: "Ada", ttlMinutes: 0 },
		});
		await converged("B sees the expiring claim", (listing) => row(listing, task3).includes("Ada"));
		const took = await b.command<string>({
			action: "tool",
			name: "board_reclaim",
			args: { taskId: task3, by: "Bo" },
		});
		check("B reclaims it, because the log says it expired", took.startsWith("Reclaimed"), took.split("\n")[0]);
		await converged(
			"and A, which wrote the claim, agrees it lost it",
			(listing) => row(listing, task3).includes("claimed by Bo"),
		);

		/* Now the real fold, over the real bytes that really crossed the wire,
		 * asked the same question under clocks that do not exist. */
		const logs = await a.command<LogText>({ action: "logs" });
		const input = logs.map((entry) => ({ owner: entry.owner, text: entry.text }));
		const realNow = Date.now;
		let asked = false;
		Date.now = () => {
			asked = true;
			throw new Error("the fold asked what time it is");
		};
		let folded: ReturnType<typeof fold> | undefined;
		let threw = "";
		try {
			folded = fold(input);
		} catch (error) {
			threw = (error as Error).message;
		} finally {
			Date.now = realNow;
		}
		check(
			"the fold never asks what time it is — there is no clock for it to consult",
			!asked && !threw,
			threw || "Date.now was never called",
		);
		check(
			"and it reaches the same holder the room did",
			folded?.tasks.find((task) => task.taskId === task3)?.claim?.by === "Bo",
			folded?.tasks.find((task) => task.taskId === task3)?.claim?.by,
		);

		const skewed = [-10, 10].map((years) => {
			const offset = years * 365 * 24 * 60 * 60 * 1000;
			Date.now = () => realNow() + offset;
			try {
				return fold(input);
			} finally {
				Date.now = realNow;
			}
		});
		check(
			"a desk whose wall clock is a decade out folds the identical board",
			skewed[0]!.digest === folded?.digest && skewed[1]!.digest === folded.digest,
			`${skewed[0]!.digest.slice(0, 12)} at -10y, ${skewed[1]!.digest.slice(0, 12)} at +10y`,
		);

		/* And the decision really is those two numbers: move the claim's own
		 * `expiresAt` past the reclaim's `assertedAt` and the same bytes, folded
		 * by the same code, answer the other way. */
		const asserted = reclaimAssertedAt(input, task3);
		const rewritten = input.map((entry) => ({
			owner: entry.owner,
			text: withClaimExpiry(entry.text, task3, asserted + 1),
		}));
		check(
			"the reclaim's own assertion is a number in the log, which is what makes this checkable",
			asserted > 0,
			`assertedAt ${asserted}`,
		);
		const other = fold(rewritten);
		check(
			"while moving the claim's own expiry past the reclaim's assertion flips it",
			other.tasks.find((task) => task.taskId === task3)?.claim?.by === "Ada",
			other.tasks.find((task) => task.taskId === task3)?.claim?.by,
		);

		// --------------------------------------------------------------------
		section("Writing another desk's log has no shape to be expressed in");

		check(
			"the SDK's append takes a log and a line, and no owner",
			ToadBridge.prototype.append.length === 2,
			`append/${ToadBridge.prototype.append.length}`,
		);

		const opened = await a.command<{ ok: boolean; result?: JsonRecord; error?: string }>({
			action: "probe",
			method: "plugin.log.open",
			params: { logId: "notes", ownerNode: ids.b, owner: ids.b },
		});
		check("a plugin opens its own log even while naming another desk", opened.ok === true, opened.error);
		const forgedBytes = Buffer.from("forged\n", "utf8").toString("base64");
		const appended = await a.command<{ ok: boolean; result?: JsonRecord; error?: string }>({
			action: "probe",
			method: "plugin.log.append",
			params: {
				logId: "notes",
				bytes: forgedBytes,
				ownerNode: ids.b,
				owner: ids.b,
				desk: ids.b,
				node: ids.b,
				from: ids.b,
			},
		});
		check("and an append naming another desk five different ways is accepted", appended.ok === true, appended.error);
		const notes = await a.command<Cursors>({ action: "cursors", pluginId: PROBE_ID, logId: "notes" });
		check(
			"because every one of those fields is nothing — the bytes landed on this desk's own log",
			notes.self?.bytes === 7 && notes.mirrors.every((mirror) => mirror.nodeId !== ids.b),
			`self ${notes.self?.bytes}b, mirrors ${notes.mirrors.map((m) => m.nodeId).join(",") || "none"}`,
		);
		const heldOnA = await a.command<string[]>({ action: "holdings", nodeId: ids.b });
		check(
			"and nothing was written into any mirror of the desk it named",
			!heldOnA.some((streamId) => streamId.includes(PROBE_ID)),
			heldOnA.join(", ") || "none",
		);

		/* The other direction, and the one that matters more: a frame arriving
		 * over the wire. B ships a delta whose body claims a different owner in
		 * every field an author might reach for; A's mirror store never reads
		 * one, because the owner is the authenticated link and nothing else. */
		await b.command({ action: "probe", method: "plugin.log.open", params: { logId: "notes" } });
		await b.command({
			action: "probe",
			method: "plugin.log.append",
			params: { logId: "notes", bytes: Buffer.from("from b\n", "utf8").toString("base64") },
		});
		await eventually(
			async () => {
				for (const child of [a, b]) await child.command({ action: "sync" });
				const held = await a.command<Cursors>({ action: "cursors", pluginId: PROBE_ID, logId: "notes" });
				if (!held.mirrors.some((mirror) => mirror.nodeId === ids.b)) {
					throw new Error("A does not hold B's notes yet");
				}
				return true;
			},
			"A mirrors B's notes",
			60_000,
		);
		const before = await a.command<Cursors>({ action: "cursors", pluginId: PROBE_ID, logId: "notes" });
		const at = before.mirrors.find((mirror) => mirror.nodeId === ids.b)?.gens["1"]?.held ?? 0;
		const fictional = "ffffffffffffffff";
		await b.command({
			action: "peer-call",
			nodeId: ids.a,
			pluginId: PROBE_ID,
			kind: "log.delta",
			body: {
				streamId: `plugin:${PROBE_ID}/notes`,
				gen: 1,
				offset: at,
				data: Buffer.from("smuggled\n", "utf8").toString("base64"),
				owner: fictional,
				ownerNode: fictional,
				desk: fictional,
				node: fictional,
				from: fictional,
			},
		});
		const after = await a.command<Cursors>({ action: "cursors", pluginId: PROBE_ID, logId: "notes" });
		check(
			"a delta claiming a different owner lands under the desk that sent it",
			(after.mirrors.find((mirror) => mirror.nodeId === ids.b)?.gens["1"]?.held ?? 0) === at + 9,
			`${at} → ${after.mirrors.find((mirror) => mirror.nodeId === ids.b)?.gens["1"]?.held}`,
		);
		/* The same frame again from byte zero, which is where a desk that read the
		 * owner off the body would happily start a brand-new mirror for a desk
		 * that does not exist. Against the real handler it is B writing at an
		 * offset B is long past, and it is simply refused. */
		await b.command({
			action: "peer-call",
			nodeId: ids.a,
			pluginId: PROBE_ID,
			kind: "log.delta",
			body: {
				streamId: `plugin:${PROBE_ID}/notes`,
				gen: 1,
				offset: 0,
				data: Buffer.from("invented\n", "utf8").toString("base64"),
				owner: fictional,
				ownerNode: fictional,
				desk: fictional,
				node: fictional,
				from: fictional,
			},
		});
		const invented = await a.command<string[]>({ action: "holdings", nodeId: fictional });
		check(
			"and no mirror is ever opened for the desk it named, because it was never a field",
			invented.length === 0,
			invented.join(", ") || "none",
		);
		const ownMirror = await a.command<{ error: string }>({ action: "guard-self" });
		check(
			"nor can a desk write a mirror of itself, one layer further down",
			ownMirror.error.includes("not replicas"),
			ownMirror.error,
		);

		// --------------------------------------------------------------------
		section("And the room still says what it cannot see");

		await stop(b);
		await eventually(
			async () => {
				await a.command({ action: "sync" });
				const links = await a.command<Link[]>({ action: "links" });
				if (links.find((link) => link.nodeId === ids.b)?.up) throw new Error("A still sees B up");
				return true;
			},
			"A notices B has gone again",
			30_000,
		);
		const stale = await a.command<string>({ action: "tool", name: "board_list" });
		check(
			"holding a writer's bytes is not the same as being caught up with it, and the sentence says which",
			stale.includes(names.b) && stale.includes("not reachable"),
			stale.split("\n").find((line) => line.startsWith("showing")),
		);
	} finally {
		for (const child of children) {
			await child.command({ action: "stop" }).catch(() => undefined);
		}
		await Promise.all(children.map((child) => child.process.exited));
	}
}

/** The lamport of the `claim` line for one task in one desk's own log. */
function claimLamport(text: string, taskId: string): number | undefined {
	for (const raw of text.split("\n")) {
		if (!raw.trim()) continue;
		try {
			const line = JSON.parse(raw) as { op?: string; taskId?: string; lamport?: number };
			if (line.op === "claim" && line.taskId === taskId) return line.lamport;
		} catch {
			/* a torn tail is not a claim */
		}
	}
	return undefined;
}

/** When the reclaimer said it looked expired. Written by one desk, read by all. */
function reclaimAssertedAt(logs: Array<{ text: string }>, taskId: string): number {
	let assertedAt = 0;
	for (const log of logs) {
		for (const raw of log.text.split("\n")) {
			if (!raw.trim()) continue;
			try {
				const line = JSON.parse(raw) as { op?: string; taskId?: string; assertedAt?: number };
				if (line.op === "reclaim" && line.taskId === taskId && typeof line.assertedAt === "number") {
					assertedAt = Math.max(assertedAt, line.assertedAt);
				}
			} catch {
				/* not a reclaim */
			}
		}
	}
	return assertedAt;
}

/** The same bytes with one number changed: the claim now outlives the reclaim. */
function withClaimExpiry(text: string, taskId: string, expiresAt: number): string {
	return text
		.split("\n")
		.map((raw) => {
			if (!raw.trim()) return raw;
			try {
				const line = JSON.parse(raw) as { op?: string; taskId?: string };
				if (line.op !== "claim" || line.taskId !== taskId) return raw;
				return JSON.stringify({ ...line, expiresAt });
			} catch {
				return raw;
			}
		})
		.join("\n");
}

async function stop(child: Child): Promise<void> {
	await child.command({ action: "stop" }).catch(() => undefined);
	await child.process.exited;
}

/* ========================================================================== */
/* The gate: the tape's own proofs, unchanged and green.                      */
/* ========================================================================== */

async function noRegression(): Promise<void> {
	section("The tape's own gate, which the stream-key generalization had to leave alone");

	/*
	 * Byte-identity, and only on the test.
	 *
	 * It covered `scripts/verify-transcripts.ts` too, and that was wrong in a way
	 * that took a second gate to see: a harness *consumes production types*, so
	 * when a production signature moves the harness has to move with it. Freezing
	 * it against the branch point makes "keep compiling" and "do not bend the
	 * proof" the same forbidden act, and the first one is not optional —
	 * `typecheck:scripts` now fails the build if a harness stops matching the
	 * contract it is proving. `initFleet` growing a required `threadRead` is
	 * exactly that case, and it is why this list is one entry shorter.
	 *
	 * A test file is different: its content IS its assertions, so freezing
	 * `replicas.test.ts` still says what it always said. What stands in for the
	 * dropped half is the run below — `verify-transcripts.ts` still has to pass,
	 * unchanged in what it asserts, on a scratch data directory of its own.
	 */
	const base = Bun.spawnSync(["git", "merge-base", "HEAD", "main"], { cwd: REPO });
	const mergeBase = base.stdout.toString().trim();
	const gates = ["src/bun/store/replicas.test.ts"];
	if (mergeBase) {
		const diff = Bun.spawnSync(["git", "diff", "--stat", mergeBase, "--", ...gates], { cwd: REPO });
		check(
			"the tape's test is byte-identical to the branch point, so it was not bent to fit",
			diff.stdout.toString().trim().length === 0,
			diff.stdout.toString().trim() || `unchanged since ${mergeBase.slice(0, 8)}`,
		);
	} else {
		check("the branch point is findable, so 'unchanged' can be checked at all", false);
	}

	for (const [label, argv] of [
		["replicas.test.ts", ["test", "src/bun/store/replicas.test.ts"]],
		["verify-transcripts.ts", ["scripts/verify-transcripts.ts"]],
	] as Array<[string, string[]]>) {
		/* Its own scratch root, not the one this harness has been filling with
		 * plugins — a gate run against somebody else's leftovers proves less. */
		const scratch = mkdtempSync(join(tmpdir(), "toad-gate-"));
		const run = Bun.spawnSync([process.execPath, ...argv], {
			cwd: REPO,
			env: { ...process.env, TOAD_DATA_DIR: scratch },
		});
		rmSync(scratch, { recursive: true, force: true });
		check(
			`${label} passes unchanged`,
			run.exitCode === 0,
			run.exitCode === 0
				? ""
				: `exit ${run.exitCode}: ${run.stderr.toString().trim().split("\n").slice(-2).join(" ")}`,
		);
	}
}

/* ========================================================================== */
/* The child: one desk, driven over a control port.                           */
/* ========================================================================== */

async function runChild(label: string): Promise<void> {
	const nodePort = Number(process.env.TOAD_NODE_PORT);
	const controlPort = Number(process.env.TOAD_PLUGIN_VERIFY_CONTROL_PORT);
	if (!nodePort || !controlPort) throw new Error("node and control ports are required");
	const partitioned = process.env.TOAD_PLUGIN_VERIFY_PARTITION === "1";

	const fleet = await import("../src/bun/fleet/fleet");
	const wire = await import("../src/bun/fleet/wire");
	const capabilities = await import("../src/bun/fleet/capabilities");
	const replication = await import("../src/bun/fleet/replication");
	const identity = await import("../src/bun/node/identity");
	const nodeServer = await import("../src/bun/node/server");
	const streams = await import("../src/bun/store/streams");
	const host = await import("../src/bun/plugin/host");
	const pluginFleet = await import("../src/bun/plugin/fleet");
	const { Bridge } = await import("../src/bun/mcp/bridge");

	/* The whole bridge, because a plugin's upward door is a real connection to a
	 * real listener. Its teammate half is stubbed: this desk starts no session,
	 * and a plugin may not call those methods anyway. */
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
	/* A partitioned desk is a laptop in a bag: it runs, its plugins run, and it
	 * has no way to reach the room and no way to be reached. Nothing is faked —
	 * there is simply no listener and no dialling. */
	if (!partitioned) {
		wire.initPeerWires({ send: () => {}, publishPersonas: () => {}, resolve });
		nodeServer.startNodeServer(resolve, nodePort, wire.nodeLinkServerHooks);
	}
	replication.initTranscriptReplication();
	pluginFleet.initPluginFleet();
	capabilities.initDeskCapabilities();
	await host.startInstalledPlugins();

	/** An MCP tool result flattened to the text a model would read. */
	const toolText = (result: unknown): string => {
		const value = result as { ok?: boolean; code?: string; reason?: string; result?: unknown };
		if (value?.ok === false) return `${value.code}: ${value.reason}`;
		const content = (value?.result as { content?: Array<{ text?: string }> } | undefined)?.content;
		return (content ?? []).map((entry) => entry.text ?? "").join("\n");
	};

	/** Every writer's log this desk holds, as text — the bytes, not a summary. */
	const logTexts = (pluginId: string, logId: string): LogText => {
		const cursors = pluginFleet.logCursors(pluginId, logId) as unknown as Cursors;
		const writers: Array<{ owner: string; gen: number; bytes: number }> = [];
		if (cursors.self) {
			writers.push({ owner: cursors.self.nodeId, gen: cursors.self.gen, bytes: cursors.self.bytes });
		}
		for (const mirror of cursors.mirrors ?? []) {
			for (const [gen, entry] of Object.entries(mirror.gens)) {
				writers.push({ owner: mirror.nodeId, gen: Number(gen), bytes: entry.held });
			}
		}
		return writers.map((writer) => {
			let text = "";
			for (;;) {
				const from = Buffer.byteLength(text, "utf8");
				if (from >= writer.bytes) break;
				const chunk = pluginFleet.readLog({
					pluginId,
					logId,
					ownerNode: writer.owner,
					gen: writer.gen,
					from,
					len: writer.bytes - from,
				}) as { data?: string };
				if (!chunk.data) break;
				text += Buffer.from(chunk.data, "base64").toString("utf8");
			}
			return { owner: writer.owner, gen: writer.gen, text };
		});
	};

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
							result: { identity: identity.nodeIdentity(), origin: partitioned ? "" : nodeServer.nodeOrigin() },
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
						if (!partitioned) await wire.syncPeerWires();
						return Response.json({ ok: true, result: { synced: true } });
					case "links":
						return Response.json({
							ok: true,
							result: partitioned ? [] : wire.nodeLinkSnapshot(),
						});
					case "caps":
						return Response.json({
							ok: true,
							result: capabilities.deskCapabilities(input.nodeId ? String(input.nodeId) : undefined),
						});
					case "refresh-caps":
						await capabilities.refreshDeskCapabilities();
						return Response.json({ ok: true, result: { refreshed: true } });
					case "install":
						return Response.json({
							ok: true,
							result: await host.installPlugin({ source: String(input.source), granted: true }),
						});
					case "plugins":
						return Response.json({ ok: true, result: host.listPlugins() });
					case "storage":
						return Response.json({ ok: true, result: { dir: host.pluginStorageDir(BOARD_ID) } });
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
					/* And a bridge frame shaped the way a plugin's is: sent by a real
					 * plugin process, over the socket Toad handed it. */
					case "probe": {
						const answer = toolText(
							await host.callPluginTool(PROBE_ID, "probe_bridge", {
								method: String(input.method),
								params: (input.params ?? {}) as Record<string, unknown>,
							}),
						);
						return Response.json({ ok: true, result: JSON.parse(answer) });
					}
					case "cursors":
						return Response.json({
							ok: true,
							result: pluginFleet.logCursors(
								String(input.pluginId ?? BOARD_ID),
								String(input.logId ?? "ops"),
							),
						});
					case "logs":
						return Response.json({
							ok: true,
							result: logTexts(String(input.pluginId ?? BOARD_ID), String(input.logId ?? "ops")),
						});
					case "holdings":
						return Response.json({ ok: true, result: streams.streamHoldings(String(input.nodeId)) });
					/* The store's own refusal: a desk is not a mirror of itself. */
					case "guard-self": {
						let error = "no error at all";
						try {
							streams.streamAppend(
								identity.nodeIdentity().id,
								`plugin:${PROBE_ID}/notes`,
								1,
								0,
								new TextEncoder().encode("x"),
							);
						} catch (thrown) {
							error = (thrown as Error).message;
						}
						return Response.json({ ok: true, result: { error } });
					}
					case "peer-call":
						return Response.json({
							ok: true,
							result: await fleet.callFleetPeer(String(input.nodeId), "plugin", {
								pluginId: String(input.pluginId),
								kind: String(input.kind),
								body: input.body ?? {},
							}),
						});
					case "stop":
						setTimeout(() => {
							void host.stopAllPlugins().finally(() => {
								bridge.stop();
								if (!partitioned) nodeServer.stopNodeServer();
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

function spawnChild(
	label: string,
	nodePort: number,
	controlPort: number,
	dataDir: string,
	partitioned: boolean,
): Child {
	const childProcess = Bun.spawn([process.execPath, fileURLToPath(import.meta.url)], {
		env: {
			...globalThis.process.env,
			TOAD_PLUGIN_VERIFY_CHILD: label,
			TOAD_NODE_PORT: String(nodePort),
			TOAD_PLUGIN_VERIFY_CONTROL_PORT: String(controlPort),
			TOAD_DATA_DIR: dataDir,
			/* Distinct desk names, so "it named the desk it cannot see" is an
			 * assertion and not two copies of this machine's hostname. */
			TOAD_NODE_NAME: label === "a" ? "Ada's desk" : "Bo's desk",
			TOAD_CAPS_BUILTIN_STUB: JSON.stringify({ authenticated: false, providers: [], models: [] }),
			...(partitioned ? { TOAD_PLUGIN_VERIFY_PARTITION: "1" } : {}),
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
				signal: AbortSignal.timeout(60_000),
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
			await new Promise((settle) => setTimeout(settle, 400));
		}
	}
}

async function runParent(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "toad-verify-plugin-"));
	try {
		await oneDesk(join(root, "desk"));
		await twoDesks(root);
		await noRegression();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
	console.log(`\n${passed} passed, ${failed} failed\n`);
	process.exit(failed === 0 ? 0 : 1);
}

/* Dispatched last on purpose: the parent reads counters declared above it, and
 * a top-level await at the head of the file would run before they exist. */
if (CHILD) {
	await runChild(CHILD);
} else {
	await runParent();
}
