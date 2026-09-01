/**
 * A plugin, from install to uninstall, reaching both kinds of agent.
 *
 * The claim under test is the one the whole design rests on: Toad stands
 * between the plugin and the agent, so a plugin's tools are *enumerable* —
 * present or absent with a named cause — on the built-in agent and on an ACP
 * backend alike. The built-in agent is the easy half, because Toad builds its
 * tool array itself. The hard half is ACP, where Toad hands over a descriptor
 * and the backend spawns MCP servers on its own: what makes that verifiable is
 * that the descriptor points at a Toad-owned endpoint, so an `initialize`
 * arriving there is proof rather than intention. This harness plays that part
 * with a stock MCP client, because a stock MCP client is exactly what an ACP
 * backend brings.
 *
 * Nothing here touches the network or the user's data directory.
 *
 * Run: hutch run verify:plugin-tools
 */
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.TOAD_DATA_DIR = mkdtempSync(join(tmpdir(), "toad-plugin-"));

const { Client, StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client");
const { createPersona } = await import("../src/bun/store/personas");
const { resolveMcpServers } = await import("../src/bun/mcp/servers");
const { sidecarVerdict } = await import("../src/bun/mcp/compat");
const host = await import("../src/bun/plugin/host");
const { pluginProxyToken, pluginProxyUrl, stopPluginProxy } = await import("../src/bun/plugin/proxy");
const { teammateTools } = await import("../src/bun/agent/tool-ledger");
const { McpTools } = await import("../src/bun/pi/mcp");
const { AcpSession } = await import("../src/bun/acp/session");
const { Bridge } = await import("../src/bun/mcp/bridge");
type Persona = import("../src/shared/types").Persona;

/* A real bridge on this scratch data directory, so "Toad's own tools were not
 * attached" is the compatibility verdict speaking rather than the bridge being
 * absent — two different absences with two different reasons, which is exactly
 * the distinction the ledger exists to keep. */
const bridge = new Bridge({
	supervisor: { info: () => ({}) as never },
	peers: {} as never,
	scheduler: {} as never,
	chapters: {} as never,
	react: () => ({ on: "" }),
	ring: () => ({ on: "" }),
});
const bridgeUp = await bridge.start();

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
const PLUGIN_ID = "team.toad.fixture";

// ---------------------------------------------------------------------------
section("The manifest is authoritative");

/* A plugin that serves a tool nobody agreed to is not a slightly different
 * plugin: Toad answers `tools/list` from the manifest, so it would be telling
 * every teammate on the desk about a tool list that is not the real one. */
process.env.TOAD_PLUGIN_FIXTURE_EXTRA_TOOL = "1";
const refused = await host.installPlugin({ source: fixture, granted: true });
check(
	"a live tools/list that disagrees with the manifest refuses the install",
	!refused.ok && refused.problems.join(" ").includes("fixture_undeclared"),
	refused.ok ? "installed anyway" : refused.problems.join(" | "),
);
check("nothing was left installed after the refusal", host.listPlugins().length === 0);
delete process.env.TOAD_PLUGIN_FIXTURE_EXTRA_TOOL;

const ungranted = await host.installPlugin({ source: fixture, granted: false });
check(
	"an install without the person's yes does nothing",
	!ungranted.ok && host.listPlugins().length === 0,
);

const broken = mkdtempSync(join(tmpdir(), "toad-plugin-bad-"));
writeFileSync(
	join(broken, "toad-plugin.json"),
	JSON.stringify({
		id: "com.example.bad",
		version: "0.1.0",
		name: "Bad",
		serve: { command: "bun", args: [] },
		tools: [{ name: "t", description: "d", inputSchema: { type: "object" } }],
	}),
);
const badManifest = await host.installPlugin({ source: broken, granted: true });
check(
	"a tool with no subagentInherits refuses at validation, before anything spawns",
	!badManifest.ok && badManifest.problems.join(" ").includes("subagentInherits"),
	badManifest.ok ? "installed" : badManifest.problems.join(" | "),
);

// ---------------------------------------------------------------------------
section("Install");

const installed = await host.installPlugin({ source: fixture, granted: true });
check("the fixture installs", installed.ok, installed.ok ? "" : installed.problems.join(" | "));
if (!installed.ok) {
	console.log("\nCannot continue without an installed plugin.");
	process.exit(1);
}
check("it is running", installed.plugin.state === "running", installed.plugin.reason);
check(
	"its state carries a reason, always",
	installed.plugin.reason.length > 0,
	installed.plugin.reason,
);
check(
	"its declared tools are on the record before anything asks",
	installed.plugin.tools.map((tool) => tool.name).join(",") === "fixture_shout,fixture_whisper",
);
check(
	"what it may reach is answered rung by rung, matched or not",
	installed.plugin.reach.some((row) => row.action === "room.desks" && row.allowed) &&
		installed.plugin.reach.some((row) => row.action === "fleet.blobs" && !row.allowed) &&
		installed.plugin.reach.every((row) => row.reason.length > 0),
);

const persona = createPersona({ name: "Plugin user", goal: "g", backendId: "pi" });

// ---------------------------------------------------------------------------
section("One registration, both agent kinds");

const servers = resolveMcpServers(persona);
const descriptor = servers.find((server) => server.id === `plugin:${PLUGIN_ID}`);
check("the teammate's server list carries the plugin", Boolean(descriptor));
check(
	"as an http descriptor on Toad's own loopback endpoint, one path per teammate",
	descriptor?.type === "http" &&
		descriptor.url.startsWith("http://127.0.0.1:") &&
		descriptor.url.includes(`/plugin/${PLUGIN_ID}/${persona.id}/mcp`),
	descriptor?.type === "http" ? descriptor.url : "",
);

/* The reason interposition was chosen over handing the plugin straight to the
 * backend: `resolveMcpServers` reaches an ACP backend whether or not Toad's own
 * sidecar attaches, so a plugin reaches every backend rather than the three on
 * the tested list. */
const unknownBackend = sidecarVerdict("some-backend-nobody-tested");
check(
	"an untested ACP backend is denied Toad's own tools — with a reason, never in silence",
	!unknownBackend.attach && unknownBackend.reason.length > 0,
	unknownBackend.reason,
);
const acpPersona: Persona = { ...persona, backendId: "some-backend-nobody-tested" };
const acpSession = new AcpSession(acpPersona, {
	appendEvent: () => {},
	updateEvent: () => {},
	delta: () => {},
	infoChanged: () => {},
	history: () => [],
	sessionCheckpointed: () => {},
});
const acpDescriptors = (
	acpSession as unknown as { mcpServers(): Array<{ name?: string; url?: string }> }
).mcpServers();
check(
	"and the plugin still reaches it, on the same deny path",
	acpDescriptors.some((entry) => typeof entry.url === "string" && entry.url.includes(`/plugin/${PLUGIN_ID}/`)),
	acpDescriptors.map((entry) => entry.name).join(","),
);

const acpLedger = teammateTools(acpPersona.id);
check(
	"the ACP ledger says Toad's own tools are absent, and names the cause",
	(acpLedger?.rows ?? []).some(
		(row) =>
			row.source === "toad" &&
			row.state === "absent" &&
			row.reason.includes(bridgeUp ? "compatibility" : "bridge socket"),
	),
	acpLedger?.rows.find((row) => row.source === "toad")?.reason,
);
check(
	"and says the plugin's tools were handed over — declared, not claimed loaded",
	(acpLedger?.rows ?? []).some(
		(row) => row.source === "plugin" && row.name === "fixture_shout" && row.state === "declared",
	),
);

// ---------------------------------------------------------------------------
section("A stock MCP client on the teammate's path — what an ACP backend is");

const url = pluginProxyUrl(PLUGIN_ID, acpPersona.id);
const token = pluginProxyToken(PLUGIN_ID, acpPersona.id);

const unauthorized = await fetch(url, {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
});
check("the path refuses without the bearer token", unauthorized.status === 401);

const outside = new Client({ name: "pretend-acp-backend", version: "0" });
await outside.connect(
	new StreamableHTTPClientTransport(new URL(url), {
		requestInit: { headers: { Authorization: `Bearer ${token}` } },
	}),
);
const outsideTools = await outside.listTools();
check(
	"it lists the manifest's tools",
	outsideTools.tools.map((tool) => tool.name).sort().join(",") === "fixture_shout,fixture_whisper",
	outsideTools.tools.map((tool) => tool.name).join(","),
);

/* This is the whole reason for the design. Toad handed a descriptor over and
 * could not see what happened next; now it can, because it is the server. */
const promoted = teammateTools(acpPersona.id);
check(
	"and the ledger turns declared into verified — the initialize is the proof",
	(promoted?.rows ?? []).some(
		(row) => row.source === "plugin" && row.name === "fixture_shout" && row.state === "verified",
	),
	promoted?.rows.find((row) => row.name === "fixture_shout")?.reason,
);

const shouted = (await outside.callTool({
	name: "fixture_shout",
	arguments: { text: "hello" },
})) as { content?: Array<{ text?: string }> };
check(
	"a tool a model really calls runs in the plugin's own process",
	shouted.content?.[0]?.text === "HELLO!",
	JSON.stringify(shouted.content),
);

const undeclared = (await outside.callTool({ name: "rm_rf", arguments: {} })) as {
	isError?: boolean;
	content?: Array<{ text?: string }>;
};
check(
	"a tool the manifest never declared is refused by name",
	undeclared.isError === true && (undeclared.content?.[0]?.text ?? "").includes("not_declared"),
	undeclared.content?.[0]?.text,
);

// ---------------------------------------------------------------------------
section("The built-in agent takes the same descriptor");

const piTools = await McpTools.connect(resolveMcpServers(persona), () => {});
const attachment = piTools
	.attachments()
	.find((entry) => entry.serverId === `plugin:${PLUGIN_ID}`);
check("Toad Agent connects to the same endpoint", Boolean(attachment?.attached), attachment?.reason);
const mangled = attachment?.tools.find((tool) => tool.toolName === "fixture_shout")?.name;
check("and the tool is in its array", Boolean(mangled), attachment?.tools.map((t) => t.name).join(","));

const definition = piTools.tools().find((tool) => tool.name === mangled);
const ran = definition
	? /* Five arguments because pi's `execute` takes five; the last three are the
	     harness having nothing to say about a cancellation, an update channel or
	     a session it never opened. */
		((await definition.execute(
			"call-1",
			{ text: "hi" },
			new AbortController().signal,
			undefined,
			{} as never,
		)) as {
			content?: Array<{ text?: string }>;
		})
	: undefined;
check("and calling it reaches the plugin", ran?.content?.[0]?.text === "HI!", JSON.stringify(ran?.content));
await piTools.close();

// ---------------------------------------------------------------------------
section("A stopped plugin names the tool it took away");

await host.stopPlugin(PLUGIN_ID);
const downList = await outside.listTools();
check(
	"the tool list survives the process being down — the manifest answers it",
	downList.tools.length === 2,
	downList.tools.map((tool) => tool.name).join(","),
);
const down = (await outside.callTool({ name: "fixture_shout", arguments: { text: "hi" } })) as {
	isError?: boolean;
	content?: Array<{ text?: string }>;
};
check(
	"calling it comes back plugin_down, naming the tool, instead of silence",
	down.isError === true &&
		(down.content?.[0]?.text ?? "").includes("plugin_down") &&
		(down.content?.[0]?.text ?? "").includes("fixture_shout"),
	down.content?.[0]?.text,
);

/* Every plugin row, not some: a live tools/list served off the manifest while
 * the process is down must not read back as good news. Attaching and working
 * are different facts and the ledger keeps them apart. */
const afterStop = teammateTools(acpPersona.id);
const stoppedRows = (afterStop?.rows ?? []).filter((row) => row.source === "plugin");
check(
	"and every teammate's ledger says so, without being asked",
	stoppedRows.length > 0 &&
		stoppedRows.every((row) => row.state === "absent" && row.reason.includes("stopped")),
	stoppedRows.map((row) => `${row.name}: ${row.state} — ${row.reason}`).join(" | "),
);

await host.startPlugin(PLUGIN_ID);
check("it starts again", host.listPlugins()[0]?.state === "running");

// ---------------------------------------------------------------------------
section("Subagent inheritance is declared, never defaulted");

const { subagentInheritsPluginTool } = await import("../src/bun/plugin/descriptor");
check("a tool declared true is inherited", subagentInheritsPluginTool(PLUGIN_ID, "fixture_shout"));
check("a tool declared false is not", !subagentInheritsPluginTool(PLUGIN_ID, "fixture_whisper"));

// ---------------------------------------------------------------------------
section("The way out");

await outside.close().catch(() => undefined);
const report = await host.uninstallPlugin(PLUGIN_ID);
check("uninstall removes it", report.removed);
check(
	"and reports which teammates lost tools, by name rather than as a promise",
	report.teammates.length > 0,
	report.teammates.join(","),
);
check("with nothing left unfinished", report.pending.length === 0, report.pending.join("; "));
check("the descriptor is gone from every teammate's server list",
	!resolveMcpServers(persona).some((server) => server.id === `plugin:${PLUGIN_ID}`));
check("and it is gone from the plugin list", host.listPlugins().length === 0);
check(
	"the record on disk is gone too, so a restart does not resurrect it",
	!readFileSync(join(process.env.TOAD_DATA_DIR!, "plugins.json"), "utf8").includes(PLUGIN_ID),
);

const gone = teammateTools(acpPersona.id);
check(
	"and the ledger says it was uninstalled rather than dropping the row",
	(gone?.rows ?? []).some(
		(row) => row.source === "plugin" && row.state === "absent" && row.reason.includes("uninstalled"),
	),
	gone?.rows.find((row) => row.source === "plugin")?.reason,
);

await host.stopAllPlugins();
stopPluginProxy();
bridge.stop();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
