/**
 * Whether a plugin's tools reach the sessions a plugin is *for*.
 *
 * `verify-plugin-tools.ts` proves the shape: one registration, both agent
 * kinds, a proxy whose `initialize` turns "handed over" into "verified". It
 * proves it on the session a human types into. The two sessions a room
 * extension actually exists for are neither of those:
 *
 *  - the turn a teammate answers ANOTHER AGENT in. `message_teammate` and the
 *    fleet's `deliver` both land in `PeerSessions.deliver`, which builds a
 *    session of its own — a persona *view* whose `id` is the thread's session
 *    key, not the teammate's. Every Toad-owned per-teammate endpoint is keyed
 *    by the teammate, so a view that dials as itself dials a door that was
 *    never opened for it. That is the whole bug: the tools are handed over,
 *    the descriptor is right, and the bearer does not match the path.
 *  - the SUBAGENT a teammate hands work to, which inherits its parent's MCP
 *    tools minus the ones the manifest says it may not have. A subagent of a
 *    session that got no plugin tools inherits no plugin tools, so this half
 *    could never be judged until the half above was fixed.
 *
 * THE TEAMMATE IS REAL AND ITS MODEL IS NOT — for the ACP half. A stub ACP
 * agent goes on PATH under the name the `cursor` backend looks for, and it
 * does the one thing no harness here had ever done: it takes the descriptors
 * Toad hands it at `session/new` and really dials them with a stock MCP
 * client, then answers with what it got. That is the seam every plugin proof
 * so far scripted past. The Toad Agent half is real all the way down — a live
 * `PiSession`, its real `McpTools`, and a real subagent run.
 *
 * Nothing here touches the network or the user's data directory.
 *
 * Run: hutch run verify:plugin-attach   (and: bun scripts/verify-plugin-attach.ts)
 */
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

const PLUGIN_ID = "team.toad.fixture";

if (process.argv.includes("--acp-stub")) {
	await runAcpStub();
} else {
	await runParent();
}

/* -------------------------------------------------------------- the teammate */

/**
 * An ACP agent that reports the tools it was actually given.
 *
 * Every other plugin harness stands in for the backend with a stock MCP client
 * the harness itself drives. This one puts the client where a backend keeps
 * it: inside the child, dialling the descriptors it was handed at
 * `session/new`, with no knowledge of Toad beyond the protocol. So "the DM
 * session holds the plugin's tools" is a sentence the agent says, not one the
 * harness infers.
 */
async function runAcpStub(): Promise<void> {
	const acp = await import("@agentclientprotocol/sdk");
	const { Client, StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client");

	type HttpServer = { type?: string; name?: string; url?: string; headers?: Array<{ name: string; value: string }> };
	const report = new Map<string, string>();

	await acp
		.agent({ name: "toad-plugin-attach-stub" })
		.onRequest("initialize", () => ({
			protocolVersion: acp.PROTOCOL_VERSION,
			agentInfo: { name: "plugin attach stub", version: "1" },
			agentCapabilities: { loadSession: false },
		}))
		.onRequest("session/new", async (ctx) => {
			const params = ctx.params as { mcpServers?: HttpServer[] };
			const sessionId = randomUUID();
			const lines: string[] = [];
			for (const server of params.mcpServers ?? []) {
				if (server.type !== "http" || !server.url) continue;
				const headers = Object.fromEntries((server.headers ?? []).map((h) => [h.name, h.value]));
				try {
					const client = new Client({ name: "plugin-attach-stub", version: "0" });
					await client.connect(
						new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers } }),
					);
					const listed = await client.listTools();
					lines.push(`${server.url} => ${listed.tools.map((tool) => tool.name).sort().join("+") || "(none)"}`);
					await client.close().catch(() => undefined);
				} catch (error) {
					lines.push(`${server.url} => FAILED ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			report.set(sessionId, lines.join(" | ") || "(no http servers)");
			return { sessionId };
		})
		.onRequest("session/prompt", async (ctx) => {
			const params = ctx.params as { sessionId: string };
			await ctx.client.notify("session/update", {
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "agent_message_chunk",
					content: {
						type: "text",
						text: `session ${params.sessionId} dialled: ${report.get(params.sessionId) ?? "(nothing)"}`,
					},
				},
			});
			return { stopReason: "end_turn" };
		})
		.connect(
			acp.ndJsonStream(
				Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
				/* Through `unknown`: node's `toWeb` is typed `ReadableStream<any>`,
				   whose reader overloads do not line up with the byte stream ACP
				   wants, and the two are the same object at runtime. */
				Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
			),
		);
}

/* ----------------------------------------------------------------- the room */

async function runParent(): Promise<void> {
	const dataDir = mkdtempSync(join(tmpdir(), "toad-plugin-attach-"));
	process.env.TOAD_DATA_DIR = dataDir;

	/* The teammate's harness, under the name the `cursor` backend looks for, on
	 * a PATH built here and nowhere else. A shim rather than a symlink because
	 * it has to add the flag that tells this file it is the agent. */
	const bin = join(dataDir, "bin");
	mkdirSync(bin, { recursive: true });
	const stub = join(bin, "cursor-agent");
	writeFileSync(
		stub,
		`#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fileURLToPath(import.meta.url))} --acp-stub\n`,
		"utf8",
	);
	chmodSync(stub, 0o755);
	process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;

	/* Toad's own sidecar stays off this backend: it is a different feature with
	 * its own harness, and a unix socket between this check and the thing it
	 * checks buys nothing. The plugin descriptor rides the deny path anyway,
	 * which is the property `verify-plugin-tools` pins. */
	writeFileSync(
		join(dataDir, "mcp-compat.json"),
		`${JSON.stringify({ version: 1, verifiedAt: Date.now(), backends: { cursor: { attach: false } } })}\n`,
		"utf8",
	);

	const { createPersona } = await import("../src/bun/store/personas");
	const { PeerSessions } = await import("../src/bun/acp/peers");
	const { Supervisor } = await import("../src/bun/acp/supervisor");
	const { threadKey } = await import("../src/bun/paths");
	const host = await import("../src/bun/plugin/host");
	const { pluginProxyToken, pluginProxyUrl, stopPluginProxy } = await import("../src/bun/plugin/proxy");
	const { teammateTools } = await import("../src/bun/agent/tool-ledger");
	const { subagentInheritsPluginTool } = await import("../src/bun/plugin/descriptor");
	const { runSubagent } = await import("../src/bun/pi/subagent");
	type SubagentHost = import("../src/bun/pi/subagent").SubagentHost;
	type ToolDefinition = import("@earendil-works/pi-coding-agent").ToolDefinition;

	let pass = 0;
	let fail = 0;
	const check = (label: string, ok: boolean, detail?: unknown) => {
		console.log(
			ok ? `\x1b[32m  PASS\x1b[0m ${label}` : `\x1b[31m  FAIL\x1b[0m ${label}`,
			detail === undefined ? "" : detail,
		);
		ok ? pass++ : fail++;
	};
	const section = (name: string) => console.log(`\n\x1b[36m${name}\x1b[0m`);

	const fixture = decodeURIComponent(new URL("./plugin-fixture", import.meta.url).pathname);
	const installed = await host.installPlugin({ source: fixture, granted: true });
	if (!installed.ok) {
		console.log(`Cannot continue without the fixture: ${installed.problems.join(" | ")}`);
		process.exit(1);
	}

	const peers = new PeerSessions({
		peerThreadAppended: () => {},
		peerThreadUpdated: () => {},
		peerActivityChanged: () => {},
		transcriptAppended: () => {},
		transcriptUpdated: () => {},
	});
	const supervisor = new Supervisor({
		transcriptAppended: () => {},
		transcriptUpdated: () => {},
		streamDelta: () => {},
		sessionInfoChanged: () => {},
	});

	/** The live peer sessions, reached past one documented private. */
	type LiveSessions = Map<string, { session: unknown }>;
	const livePeers = () => (peers as unknown as { sessions: LiveSessions }).sessions;
	const chain = () => ({ id: randomUUID(), depth: 0, path: [] as string[] });
	const pluginRows = (personaId: string) =>
		(teammateTools(personaId)?.rows ?? []).filter((row) => row.source === "plugin");

	// -------------------------------------------------------------------------
	section("The door a DM session dials");

	const caller = createPersona({ name: "Caller", goal: "g", backendId: "pi" });
	const target = createPersona({ name: "Target", goal: "Answer briefly.", backendId: "cursor" });

	/* The id a peer session runs under, built the way `PeerSessions` builds it.
	 * It is not a uuid, and that is the entire failure: `pluginProxyUrl` percent-
	 * encodes it into the path and the proxy read the path segment raw, so the
	 * token it compared against was minted for a different key and every DM
	 * session was answered 401 — silently, because an MCP server that refuses to
	 * connect is a tool that is simply not there. */
	const peerViewId = `${threadKey(caller.id, target.id)}|${caller.id}->${target.id}`;
	check(
		"a peer session's id is not a plain uuid — it is percent-encoded into the path",
		encodeURIComponent(peerViewId) !== peerViewId,
		peerViewId,
	);

	const doorUrl = pluginProxyUrl(PLUGIN_ID, peerViewId);
	const doorToken = pluginProxyToken(PLUGIN_ID, peerViewId);
	const doorAnswer = await fetch(doorUrl, {
		method: "POST",
		headers: { "content-type": "application/json", Authorization: `Bearer ${doorToken}` },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
	});
	check(
		"the proxy opens for the token it minted, whatever the id looks like",
		doorAnswer.status === 200,
		doorAnswer.status,
	);

	// -------------------------------------------------------------------------
	section("An agent-to-agent DM — a real ACP child on the real peer seam");

	/* The teammate's own session first, because that is the ledger George reads
	 * in Settings and the thing a DM has to agree with. */
	const mainInfo = await supervisor.start(target.id);
	check("the teammate's own session starts", mainInfo.state === "ready", mainInfo.error ?? mainInfo.state);

	const delivered = await peers.deliver({
		callerId: caller.id,
		targetId: target.id,
		message: "Which tools did you get?",
		chain: chain(),
	});
	check("the delivery is answered", delivered.ok, delivered.ok ? "" : `${delivered.reason}: ${delivered.detail}`);
	const answer = delivered.ok ? delivered.reply : "";
	check(
		"the answering turn's session holds the plugin's tools",
		answer.includes("fixture_shout") && answer.includes("fixture_whisper"),
		answer,
	);
	check(
		"and it dialled the TEAMMATE's own endpoint, not one keyed by the thread",
		answer.includes(`/plugin/${PLUGIN_ID}/${target.id}/mcp`),
		answer,
	);
	check(
		"so the teammate's ledger is describing the session the DM reached",
		pluginRows(target.id).length > 0 && pluginRows(target.id).every((row) => row.state === "verified"),
		pluginRows(target.id).map((row) => `${row.name}: ${row.state}`).join(", "),
	);

	const fromFleet = await peers.deliver({
		callerId: `remote:node-abc:${caller.id}`,
		targetId: target.id,
		message: "And you still have them for an outside caller?",
		chain: chain(),
		outside: { name: "Boris", node: "beastie", seat: "client" },
	});
	check(
		"a caller with no persona here — the fleet's own `deliver` — is answered the same way",
		fromFleet.ok && fromFleet.reply.includes("fixture_shout"),
		fromFleet.ok ? fromFleet.reply : `${fromFleet.reason}: ${fromFleet.detail}`,
	);

	// -------------------------------------------------------------------------
	section("Toad Agent: its own session, and the subagent it hands work to");

	const pi = createPersona({ name: "Pi target", goal: "Answer briefly.", backendId: "pi" });
	const piInfo = await supervisor.start(pi.id);
	check("the Toad Agent teammate starts", piInfo.state === "ready", piInfo.error ?? piInfo.state);

	check(
		"its ledger says the plugin's tools attached",
		pluginRows(pi.id).length === 2 && pluginRows(pi.id).every((row) => row.state === "verified"),
		pluginRows(pi.id).map((row) => `${row.name}: ${row.state}`).join(", "),
	);

	/* One documented cast, to the array a subagent is actually constructed with
	 * rather than to a model's account of it. */
	type ReachablePi = { subagentContext(): SubagentHost | undefined };
	const liveMain = (supervisor as unknown as { sessions: Map<string, unknown> }).sessions.get(pi.id);
	const mainContext = (liveMain as unknown as ReachablePi | undefined)?.subagentContext();
	const inheritedNames = (tools: ToolDefinition[] | undefined) =>
		(tools ?? []).map((tool) => tool.name).filter((name) => name.includes("fixture")).sort();
	check(
		"a subagent inherits exactly the plugin tools the manifest says it may",
		inheritedNames(mainContext?.extraTools).length === 1 &&
			inheritedNames(mainContext?.extraTools)[0]!.includes("fixture_shout"),
		inheritedNames(mainContext?.extraTools).join(","),
	);
	check(
		"and that is the manifest speaking, not this harness",
		subagentInheritsPluginTool(PLUGIN_ID, "fixture_shout") &&
			!subagentInheritsPluginTool(PLUGIN_ID, "fixture_whisper"),
	);

	if (!mainContext) {
		check("a real subagent could be given the parent's context", false, "no context");
	} else {
		const ran = await runSubagent(
			mainContext,
			"Call the fixture_shout tool with the text `ping`, then reply with exactly what it returned and nothing else.",
		);
		check(
			"a real subagent calls the plugin tool it inherited",
			ran.ok && ran.report.includes("PING!"),
			ran.ok ? ran.report.slice(0, 160) : ran.detail,
		);
	}

	// -------------------------------------------------------------------------
	section("Toad Agent answering a DM");

	const piCaller = createPersona({ name: "Pi caller", goal: "g", backendId: "cursor" });
	const piDelivered = await peers.deliver({
		callerId: piCaller.id,
		targetId: pi.id,
		message: "Reply with the single word ok.",
		chain: chain(),
	});
	check(
		"the delivery is answered",
		piDelivered.ok,
		piDelivered.ok ? "" : `${piDelivered.reason}: ${piDelivered.detail}`,
	);

	const piPeerKey = `${threadKey(piCaller.id, pi.id)}|${piCaller.id}->${pi.id}`;
	check("the peer session's id is the one this file predicted", livePeers().has(piPeerKey), [...livePeers().keys()].join(" ; "));
	type ReachableMcp = { mcp?: { attachments(): Array<{ serverId: string; attached: boolean; reason: string }> } };
	const piPeer = livePeers().get(piPeerKey)?.session as unknown as (ReachablePi & ReachableMcp) | undefined;
	const piPeerAttachment = piPeer?.mcp?.attachments().find((entry) => entry.serverId === `plugin:${PLUGIN_ID}`);
	check(
		"the DM session really attached to the plugin",
		Boolean(piPeerAttachment?.attached),
		piPeerAttachment?.reason ?? "no attachment recorded",
	);
	check(
		"and a subagent spawned out of that DM inherits the same one tool",
		inheritedNames(piPeer?.subagentContext()?.extraTools).length === 1,
		inheritedNames(piPeer?.subagentContext()?.extraTools).join(","),
	);

	// -------------------------------------------------------------------------
	section("Tools changing under a live thread");

	/* The roster gets a restart when a plugin arrives (`applyToolChange` in
	 * index.ts) precisely so a teammate's tool list is not a lie until someone
	 * happens to restart it. The threads cached in `PeerSessions` used to get
	 * nothing at all — which is how a teammate DM'd about a plugin installed
	 * minutes ago answers out of a session built before it existed. */
	const acpKey = `${threadKey(caller.id, target.id)}|${caller.id}->${target.id}`;
	check("the DM thread's session is cached between deliveries", livePeers().has(acpKey));

	const inFlight = (peers as unknown as { inFlight: Set<string> }).inFlight;
	inFlight.add(acpKey);
	peers.applyToolChange();
	check("a thread mid-answer is not cut off", livePeers().has(acpKey));
	inFlight.delete(acpKey);

	peers.applyToolChange(pi.id);
	check("a change to one teammate leaves another teammate's threads alone", livePeers().has(acpKey));

	/* The line index.ts runs, run here for real: the news is a plugin change
	 * announcement, not a call this harness invents. */
	const { onPluginsChanged } = await import("../src/bun/plugin/host");
	const unsubscribe = onPluginsChanged((_pluginId, change) => {
		if (change !== "state") peers.applyToolChange();
	});
	const removed = await host.uninstallPlugin(PLUGIN_ID);
	check("the plugin uninstalls", removed.removed);
	check(
		"and the announcement drops the cached DM session, deferred turn or not",
		!livePeers().has(acpKey),
		[...livePeers().keys()].join(" ; "),
	);
	unsubscribe();

	const afterRemoval = await peers.deliver({
		callerId: caller.id,
		targetId: target.id,
		message: "And now?",
		chain: chain(),
	});
	check(
		"the next DM is answered by a session built after the change",
		afterRemoval.ok && !afterRemoval.reply.includes("fixture_shout"),
		afterRemoval.ok ? afterRemoval.reply : `${afterRemoval.reason}: ${afterRemoval.detail}`,
	);

	// -------------------------------------------------------------------------
	section("The way out");

	await peers.stopAll();
	await supervisor.stopAll();
	await host.stopAllPlugins();
	stopPluginProxy();

	console.log(`\n${pass} passed, ${fail} failed`);
	process.exit(fail === 0 ? 0 : 1);
}
