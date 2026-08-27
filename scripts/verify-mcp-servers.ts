/**
 * MCP servers, from app settings through to a teammate's tools.
 *
 * Covers the part that is easy to get wrong and invisible until someone tries
 * it: that a server defined once globally reaches the right teammates, that
 * per-teammate routing actually excludes, and that a tool a model calls really
 * runs. Uses scripts/mcp-echo-server.ts so nothing here touches the network.
 *
 * Run: bun scripts/verify-mcp-servers.ts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.TOAD_DATA_DIR = mkdtempSync(join(tmpdir(), "toad-mcp-"));

const { createPersona, updatePersona } = await import("../src/bun/store/personas");
const { updateSettings } = await import("../src/bun/store/settings");
const { resolveMcpServers } = await import("../src/bun/mcp/servers");
const { Supervisor } = await import("../src/bun/acp/supervisor");
type TranscriptEvent = import("../src/shared/types").TranscriptEvent;

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

const serverScript = decodeURIComponent(new URL("./mcp-echo-server.ts", import.meta.url).pathname);

section("Global registry");
const settings = updateSettings({
	mcpServers: [
		{ id: "echo", type: "stdio", name: "Echo", command: process.execPath, args: [serverScript] },
		{ id: "other", type: "stdio", name: "Other", command: process.execPath, args: [serverScript] },
	],
});
check("servers stored globally", settings.mcpServers.length === 2);

section("Per-teammate routing");
const all = createPersona({ name: "Takes all", goal: "g", backendId: "pi" });
check("a new teammate takes every server", resolveMcpServers(all).length === 2, all.mcpPolicy.mode);

const none = updatePersona(createPersona({ name: "Takes none", goal: "g", backendId: "pi" }).id, {
	mcpPolicy: { mode: "none", serverIds: [] },
});
check("none means none", resolveMcpServers(none).length === 0);

const some = updatePersona(createPersona({ name: "Takes one", goal: "g", backendId: "pi" }).id, {
	mcpPolicy: { mode: "some", serverIds: ["echo"] },
});
check("some means only those", resolveMcpServers(some).map((s) => s.id).join(",") === "echo");

const stale = updatePersona(createPersona({ name: "Stale ref", goal: "g", backendId: "pi" }).id, {
	mcpPolicy: { mode: "some", serverIds: ["echo", "deleted-server"] },
});
check("a deleted server is dropped, not fatal", resolveMcpServers(stale).length === 1);

section("Tools reach the built-in agent");
const events: TranscriptEvent[] = [];
const supervisor = new Supervisor({
	transcriptAppended: ({ event }) => events.push(event),
	transcriptUpdated: () => {},
	streamDelta: () => {},
	sessionInfoChanged: () => {},
});

const info = await supervisor.start(some.id);
check("session started", info.state === "ready", info.error ?? "");

const live = (supervisor as unknown as { sessions: Map<string, unknown> }).sessions.get(some.id) as {
	session?: { agent: { state: { tools: Array<{ name: string }> } } };
};
const toolNames = live?.session?.agent.state.tools.map((tool) => tool.name) ?? [];
check("the MCP tool is active", toolNames.includes("Echo__shout"), toolNames.join(","));
check(
	"only the routed server's tools are present",
	!toolNames.some((name) => name.startsWith("Other__")),
	toolNames.join(","),
);

section("A model actually calls it");
await supervisor.prompt(some.id, "Use the shout tool on the word toad. Reply with just its output.");
while (supervisor.info(some.id).state === "thinking") await Bun.sleep(50);

const toolCalls = events.filter((event) => event.kind === "tool");
check(
	"the tool ran",
	toolCalls.some((event) => event.kind === "tool" && event.title.includes("shout")),
	toolCalls.map((event) => (event.kind === "tool" ? event.title : "")).join(","),
);
const said = events
	.filter((event) => event.kind === "agent")
	.map((event) => (event.kind === "agent" ? event.text : ""))
	.join(" ");
check("its output came back", said.includes("TOAD"), said.slice(0, 120));

await supervisor.stopAll();

console.log(
	fail === 0
		? `\n\x1b[32m${pass} passed, 0 failed\x1b[0m`
		: `\n\x1b[31m${pass} passed, ${fail} failed\x1b[0m`,
);
process.exit(fail === 0 ? 0 : 1);
