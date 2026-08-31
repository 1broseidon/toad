/**
 * Every silent absence, named.
 *
 * Tools vanishing without a word is the worst failure this project has
 * shipped. It has happened in three disguises and they share one shape: an
 * absence with an optional explanation that nobody filled in. pi reads a
 * supplied tool list twice, so a Windows allowlist naming five built-ins
 * deleted every tool Toad provides while the system prompt went on promising
 * them. An untested ACP backend got `{attach: false}` with no reason, so its
 * teammate simply had no Toad tools. A server id left in a policy after the
 * server was deleted is dropped deliberately, and silently.
 *
 * So this harness does not test that tools work. It tests that Toad can say
 * where each one is and why — on both agent kinds, for every one of those
 * sites, against the tools that exist today.
 *
 * Nothing here touches the network or the user's data directory.
 *
 * Run: hutch run verify:tool-ledger
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.TOAD_DATA_DIR = mkdtempSync(join(tmpdir(), "toad-ledger-"));

const { createPersona, updatePersona } = await import("../src/bun/store/personas");
const { updateSettings } = await import("../src/bun/store/settings");
const { sidecarVerdict } = await import("../src/bun/mcp/compat");
const { missingPolicyServers } = await import("../src/bun/mcp/servers");
const { builtInTools, droppedByAllowlist } = await import("../src/bun/pi/shell");
const { teammateTools } = await import("../src/bun/agent/tool-ledger");
const { TOAD_TOOLS } = await import("../src/bun/mcp/tools");
const { AcpSession } = await import("../src/bun/acp/session");
const { Supervisor } = await import("../src/bun/acp/supervisor");
const { Bridge } = await import("../src/bun/mcp/bridge");
type ToolLedgerRow = import("../src/shared/types").ToolLedgerRow;
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

const nothing = {
	appendEvent: () => {},
	updateEvent: () => {},
	delta: () => {},
	infoChanged: () => {},
	history: () => [] as TranscriptEvent[],
	sessionCheckpointed: () => {},
};

const rowsFor = (personaId: string): ToolLedgerRow[] => teammateTools(personaId)?.rows ?? [];
const named = (rows: ToolLedgerRow[], name: string) => rows.find((row) => row.name === name);

const echo = decodeURIComponent(new URL("./mcp-echo-server.ts", import.meta.url).pathname);
updateSettings({
	mcpServers: [
		{ id: "echo", type: "stdio", name: "Echo", command: process.execPath, args: [echo] },
		{
			id: "broken",
			type: "stdio",
			name: "Broken",
			command: process.execPath,
			args: ["--this-is-not-a-script"],
		},
	],
});

// ---------------------------------------------------------------------------
section("The rule");

/* Not a style point. Every one of the three shipped bugs was reachable only
 * because a reason was allowed to be missing. */
const everyReason = (rows: ToolLedgerRow[]) => rows.every((row) => row.reason.trim().length > 0);

// ---------------------------------------------------------------------------
section("The compatibility verdict cannot deny in silence");

const untested = sidecarVerdict("a-backend-nobody-has-tested");
check("an untested backend is denied", !untested.attach);
check("and the denial says why, in a sentence", untested.reason.trim().length > 20, untested.reason);
for (const known of ["cursor", "claude-acp", "codex-acp"]) {
	const verdict = sidecarVerdict(known);
	check(`${known} carries a reason for its allow too`, verdict.reason.trim().length > 0, verdict.reason);
}

// ---------------------------------------------------------------------------
section("The Windows allowlist, as an assertion rather than a lost day");

const platform = process.platform;
const pretend = (value: string) =>
	Object.defineProperty(process, "platform", { value, configurable: true });

pretend("win32");
const custom = ["hop_desk", "list_desks", "web_search", "subagent"];
check(
	"the list the session really builds drops nothing",
	droppedByAllowlist(builtInTools(custom), custom).length === 0,
);
check(
	"a list naming only built-ins would delete every Toad tool — and now says which",
	droppedByAllowlist(["read", "bash", "edit", "write"], custom).join(",") === custom.join(","),
);
pretend(platform);

// ---------------------------------------------------------------------------
section("A policy naming a server that no longer exists");

const stale = updatePersona(createPersona({ name: "Stale", goal: "g", backendId: "pi" }).id, {
	mcpPolicy: { mode: "some", serverIds: ["echo", "deleted-last-week"] },
});
check(
	"the dropped id is nameable rather than merely dropped",
	missingPolicyServers(stale).join(",") === "deleted-last-week",
);

// ---------------------------------------------------------------------------
section("An ACP teammate's ledger");

/* A real bridge, so "no Toad tools" is the compatibility verdict speaking and
 * not the socket being absent. Two absences, two reasons — which is the point. */
const bridge = new Bridge({
	supervisor: { info: () => ({}) as never },
	peers: {} as never,
	scheduler: {} as never,
	chapters: {} as never,
	react: () => ({ on: "" }),
});
const bridgeUp = await bridge.start();
check("the harness owns the bridge socket", bridgeUp);

const acp = updatePersona(
	createPersona({ name: "ACP", goal: "g", backendId: "a-backend-nobody-has-tested" }).id,
	{ mcpPolicy: { mode: "some", serverIds: ["echo", "deleted-last-week"] } },
);
const acpSession = new AcpSession(acp, nothing);
(acpSession as unknown as { mcpServers(): unknown[] }).mcpServers();
const acpRows = rowsFor(acp.id);

check("a ledger exists before a single turn is taken", acpRows.length > 0);
check("every row carries a reason", everyReason(acpRows), acpRows.length);
check(
	"every Toad tool is listed as absent, with the verdict as the cause",
	TOAD_TOOLS.every((tool) => {
		const row = named(acpRows, tool.name);
		return row?.state === "absent" && row.reason.includes("compatibility list");
	}),
	named(acpRows, "hop_desk")?.reason,
);
check(
	"a configured MCP server is `declared` — Toad handed it over and cannot see further",
	named(acpRows, "echo")?.state === "declared",
	named(acpRows, "echo")?.reason,
);
check(
	"the deleted server id is absent and named",
	named(acpRows, "deleted-last-week")?.state === "absent" &&
		(named(acpRows, "deleted-last-week")?.reason ?? "").includes("no longer exists"),
	named(acpRows, "deleted-last-week")?.reason,
);
check(
	"the computer is absent because it is off, not because nobody looked",
	named(acpRows, "computer")?.state === "absent",
	named(acpRows, "computer")?.reason,
);
check(
	"web search is absent with the honest ACP reason",
	named(acpRows, "web_search")?.state === "absent",
	named(acpRows, "web_search")?.reason,
);
check(
	"the backend's own tools are declared, not silently claimed",
	acpRows.some((row) => row.state === "declared" && row.name.includes("backend's own")),
);

// ---------------------------------------------------------------------------
section("A Toad Agent teammate's ledger");

const pi = updatePersona(createPersona({ name: "Pi", goal: "g", backendId: "pi" }).id, {
	mcpPolicy: { mode: "some", serverIds: ["echo", "broken", "deleted-last-week"] },
	webSearchPolicy: { mode: "none", providers: [] },
});
const supervisor = new Supervisor({
	transcriptAppended: () => {},
	transcriptUpdated: () => {},
	streamDelta: () => {},
	sessionInfoChanged: () => {},
});
const info = await supervisor.start(pi.id);
const piRows = rowsFor(pi.id);
check("the session produced a ledger", piRows.length > 0, info.error ?? info.state);
check("every row carries a reason", everyReason(piRows), piRows.length);
check(
	"a built-in of the runtime is verified",
	named(piRows, "read")?.state === "verified",
	named(piRows, "read")?.reason,
);
check(
	"a Toad tool Toad supplied itself is verified, not merely intended",
	named(piRows, "hop_desk")?.state === "verified",
	named(piRows, "hop_desk")?.reason,
);
check(
	"a working MCP server's tool is verified under its mangled name",
	named(piRows, "Echo__shout")?.state === "verified",
	named(piRows, "Echo__shout")?.reason,
);
check(
	"a server that would not start is absent, naming the server and the error",
	named(piRows, "broken")?.state === "absent" &&
		(named(piRows, "broken")?.reason ?? "").includes("Broken"),
	named(piRows, "broken")?.reason,
);
check(
	"the deleted server id is absent and named here too",
	named(piRows, "deleted-last-week")?.state === "absent",
	named(piRows, "deleted-last-week")?.reason,
);
check(
	"web search set to none is a stated absence",
	named(piRows, "web_search")?.state === "absent" &&
		(named(piRows, "web_search")?.reason ?? "").includes("`none`"),
	named(piRows, "web_search")?.reason,
);
check(
	"the subagent runner is verified",
	named(piRows, "subagent")?.state === "verified",
	named(piRows, "subagent")?.reason,
);

await supervisor.stopAll();
check(
	"and the ledger outlives the session, because that is when the question gets asked",
	rowsFor(pi.id).length > 0,
);

bridge.stop();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
