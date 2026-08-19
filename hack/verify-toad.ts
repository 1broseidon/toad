/**
 * Drives Toad's real main-process code end to end, without the window.
 *
 * Isolated under a temporary HOME so it never touches your actual teammates.
 *
 * Run: bun hack/verify-toad.ts [backendId]   — defaults to cursor
 */
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandboxHome = mkdtempSync(join(tmpdir(), "toad-home-"));
process.env.TOAD_DATA_DIR = sandboxHome;

// Imported after HOME is set, because the paths module resolves at load time.
const { checkpointSession, createPersona, updatePersona, getPersona } = await import(
	"../src/bun/store/personas"
);
const settings = await import("../src/bun/store/settings");
const transcript = await import("../src/bun/store/transcript");
const { Supervisor } = await import("../src/bun/acp/supervisor");
const { DEFAULT_BACKEND_ID, listBackends } = await import("../src/bun/acp/registry");
type TranscriptEvent = import("../src/shared/types").TranscriptEvent;
type SessionInfo = import("../src/shared/types").SessionInfo;

const backendId = process.argv[2] ?? "cursor";
console.log(`\x1b[1mbackend: ${backendId}\x1b[0m`);

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

const events: TranscriptEvent[] = [];
let latestInfo: SessionInfo | null = null;

const skip = (label: string, why: string) => console.log(`\x1b[33m  SKIP\x1b[0m ${label}`, why);

/**
 * The app's send RPC acknowledges once a message is queued; turn progress then
 * arrives over events. The headless verifier has no UI event loop to wait on,
 * so follow the same session state stream before asserting turn results.
 */
async function waitForTurn(personaId: string, timeoutMs = 120_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (supervisor.info(personaId).state !== "thinking") return;
		await Bun.sleep(25);
	}
	throw new Error(`Timed out waiting for ${personaId}'s turn to finish`);
}

section("MCP sidecar static checks");
const mcpCheck = Bun.spawnSync([
	process.execPath,
	decodeURIComponent(new URL("./verify-mcp-sidecar.ts", import.meta.url).pathname),
	"--check-only",
]);
check(
	"MCP sidecar storage guards",
	mcpCheck.exitCode === 0,
	new TextDecoder().decode(mcpCheck.stdout).trim(),
);

const supervisor = new Supervisor({
	transcriptAppended: ({ personaId, event }) => {
		events.push(event);
		/* Backends that ask before writing would otherwise wait forever out here,
		 * where there is no one to click the button. Answering allow keeps the run
		 * comparable across backends that ask and backends that do not. */
		if (event.kind === "permission" && event.decision === undefined) {
			const allow =
				event.options.find((o) => o.kind?.startsWith("allow")) ?? event.options[0];
			if (allow) supervisor.answerPermission(personaId, event.requestId, allow.optionId);
		}
	},
	transcriptUpdated: ({ event }) => {
		const index = events.findIndex((e) => e.id === event.id);
		if (index === -1) events.push(event);
		else events[index] = event;
	},
	streamDelta: () => {},
	sessionInfoChanged: (info) => {
		latestInfo = info;
	},
});

// -- backend catalog --------------------------------------------------------

section("Backend catalog");
const backends = await listBackends(true);
check("catalog is non-empty", backends.length > 0, `${backends.length} backends`);
check(
	"the product default is first",
	backends[0]?.id === DEFAULT_BACKEND_ID,
	backends[0]?.id,
);
const chosen = backends.find((b) => b.id === backendId);
check(`${backendId} is in the catalog`, Boolean(chosen), chosen?.name);
check(
	`${backendId} is available here`,
	chosen?.available === true,
	chosen?.available ? chosen.launch?.cmd : chosen?.unavailableReason,
);
check(
	"registry entries were merged in",
	backends.some((b) => b.source === "registry"),
	`${backends.filter((b) => b.source === "registry").length} from registry`,
);

// -- app settings and remembered state --------------------------------------

section("App settings");
check(
	"a first run has the product default backend",
	settings.getSettings().defaultBackendId === DEFAULT_BACKEND_ID,
	settings.getSettings().defaultBackendId,
);
check(
	"a changed default is written and read back",
	settings.updateSettings({ defaultBackendId: backendId }).defaultBackendId === backendId &&
		settings.getSettings().defaultBackendId === backendId,
);
check("no window is remembered before one is seen", settings.getWindowFrame() === undefined);
const frame = { x: 40, y: 60, width: 1000, height: 720 };
settings.setWindowFrame(frame);
check(
	"the window frame survives a round trip",
	JSON.stringify(settings.getWindowFrame()) === JSON.stringify(frame),
);
settings.setLastPersonaId("who-was-open");
check("the open conversation is remembered", settings.getLastPersonaId() === "who-was-open");
check(
	"preferences and remembered state share one file without clobbering",
	settings.getSettings().defaultBackendId === backendId &&
		settings.getWindowFrame()?.width === 1000,
);
settings.setLastPersonaId(undefined);
check("closing the last conversation clears it", settings.getLastPersonaId() === undefined);

// -- persona + identity -----------------------------------------------------

section("Persona and identity");
const persona = createPersona({
	name: "Archivist",
	goal: "You are terse. Always answer in one short sentence.",
	backendId,
});
check("persona records the backend", getPersona(persona.id)?.backendId === backendId);
check("persona created", Boolean(persona.id));
check("workspace is inside the app directory", persona.cwd.startsWith(sandboxHome));

const agentsFile = join(persona.cwd, "AGENTS.md");
check("AGENTS.md was materialised", existsSync(agentsFile));
const agentsBody = existsSync(agentsFile) ? readFileSync(agentsFile, "utf8") : "";
check("AGENTS.md carries the goal", agentsBody.includes("one short sentence"));
check("AGENTS.md is marked as managed", agentsBody.includes("managed by Toad"));

// A hand-written AGENTS.md must never be clobbered.
await Bun.write(agentsFile, "# Mine\nDo not touch.\n");
updatePersona(persona.id, { goal: "changed" });
check(
	"a hand-written AGENTS.md survives an update",
	readFileSync(agentsFile, "utf8").includes("Do not touch"),
);
await Bun.write(agentsFile, `<!-- managed by Toad -->\n# ${persona.name}\n\nbe terse\n`);

// -- session ----------------------------------------------------------------

section("Session start");
const started = await supervisor.start(persona.id);
if (started.state !== "ready") {
	console.log(`\x1b[31m  error:\x1b[0m ${started.error ?? "(none reported)"}`);
	for (const event of events.filter((e) => e.kind === "notice")) {
		console.log(`\x1b[31m  notice:\x1b[0m ${event.text}`);
	}
}
check("session reached ready", started.state === "ready", started.state);
check("a session id was issued", Boolean(started.sessionId));
// Backends split disposition differently: some expose models, some modes, some
// both. What matters is that at least one axis came through.
check(
	"disposition was advertised",
	started.models.length > 0 || started.modes.length > 0,
	`${started.models.length} model(s), ${started.modes.length} mode(s): ${started.modes.map((m) => m.id).join(",")}`,
);
check(
	"restore capability detection completed",
	typeof started.capabilities.loadSession === "boolean" &&
		typeof started.capabilities.resume === "boolean",
);
check("first run is not marked as restored", started.contextRestored === false);
check(
	"an unused session id was not checkpointed",
	getPersona(persona.id)?.sessionCheckpoints.length === 0,
);

// -- disposition ------------------------------------------------------------

if (started.state !== "ready") {
	console.log("\n\x1b[31mAborting: the session never became ready.\x1b[0m");
	await supervisor.stopAll();
	process.exit(1);
}

section("Disposition");
const targetModel = started.models.find((m) => m.id !== started.currentModelId);
if (targetModel) {
	await supervisor.setModel(persona.id, targetModel.id);
	check("model switched", latestInfo?.currentModelId === targetModel.id, targetModel.name);
	check("model persisted on the persona", getPersona(persona.id)?.modelId === targetModel.id);
} else {
	skip("model switching", `${backendId} offers no second model`);
}

const targetMode = started.modes.find((m) => m.id !== started.currentModeId);
if (targetMode) {
	await supervisor.setMode(persona.id, targetMode.id);
	check("mode switched", latestInfo?.currentModeId === targetMode.id, targetMode.id);
} else {
	skip("mode switching", `${backendId} offers no second mode`);
}

/*
 * The turn below writes a file. Which mode permits that, and whether the
 * backend asks first, differs per backend and none of it is machine-readable,
 * so the choice is pinned here rather than guessed.
 *
 * Codex is deliberately left in a mode that asks. Cursor runs unrestricted and
 * Claude is set to accept edits, so without this nothing would exercise the
 * permission round trip, which is the one path where a stall means the agent
 * waits forever.
 */
const TURN_MODE: Record<string, string> = {
	cursor: "agent",
	"claude-acp": "acceptEdits",
	"codex-acp": "read-only",
};
const turnMode = started.modes.find((m) => m.id === TURN_MODE[backendId]);
if (turnMode) await supervisor.setMode(persona.id, turnMode.id);

// -- a real turn ------------------------------------------------------------

section("Turn");
await supervisor.prompt(
	persona.id,
	"Create a file named proof.txt containing exactly: verified. Then say done.",
);
await waitForTurn(persona.id);

const kinds = new Set(events.map((e) => e.kind));
check("a user message was recorded", kinds.has("user"));
check("an agent message was recorded", kinds.has("agent"));
check("a tool call was recorded", kinds.has("tool"), [...kinds].join(","));
check("the turn was closed out", kinds.has("turn"));
check("proof.txt exists", existsSync(join(persona.cwd, "proof.txt")));
check(
	"the completed turn checkpointed this backend",
	getPersona(persona.id)?.sessionCheckpoints.some(
		(checkpoint) => checkpoint.backendId === backendId && checkpoint.sessionId === started.sessionId,
	) === true,
);

// One teammate can keep an independent native session in each harness.
checkpointSession(persona.id, "test-other-harness", "other-session-id");
const checkpoints = getPersona(persona.id)?.sessionCheckpoints ?? [];
check(
	"another harness checkpoint does not replace this one",
	checkpoints.some((checkpoint) => checkpoint.backendId === backendId) &&
		checkpoints.some((checkpoint) => checkpoint.backendId === "test-other-harness"),
);

const asked = events.filter((e) => e.kind === "permission");
if (asked.length > 0) {
	check(
		"permission requests were answered",
		asked.every((e) => e.decision !== undefined),
		asked.map((e) => `${e.title} -> ${e.decidedOptionName ?? e.decision}`).join(" | "),
	);
} else {
	skip("permission round trip", `${backendId} did not ask before writing`);
}

const toolEvents = events.filter((e) => e.kind === "tool");
check(
	"tool calls reached a terminal status",
	toolEvents.length > 0 && toolEvents.every((e) => e.status === "completed" || e.status === "failed"),
	toolEvents.map((e) => `${e.title}:${e.status}`).join(" | "),
);

// The agent streams many small chunks per message; the transcript should hold
// whole messages rather than one event per chunk.
const agentText = events.filter((e) => e.kind === "agent").map((e) => e.text);
check(
	"agent text was coalesced, not left as fragments",
	agentText.length > 0 &&
		agentText.every((t) => t.trim().length > 0) &&
		agentText.length <= 3,
	`${agentText.length} message(s): ${JSON.stringify(agentText.join(" ").slice(0, 80))}`,
);

// -- persistence ------------------------------------------------------------

section("Persistence");
const onDisk = transcript.load(persona.id);
check("transcript persisted to disk", onDisk.length > 0, `${onDisk.length} events`);
check("no duplicate event ids after folding", onDisk.length === new Set(onDisk.map((e) => e.id)).size);
check(
	"in-memory and on-disk transcripts agree",
	onDisk.length === events.length,
	`disk=${onDisk.length} memory=${events.length}`,
);

// -- restart and restore ----------------------------------------------------

section("Restart and restore");
await supervisor.stop(persona.id);

// Notices are Toad's own commentary rather than conversation, so they are not
// part of the history that session/load must not duplicate.
const historyLength = () => transcript.load(persona.id).filter((e) => e.kind !== "notice").length;
const beforeRestart = historyLength();

const restarted = await supervisor.start(persona.id);
check("session restarted", restarted.state === "ready", restarted.state ?? restarted.error);
if (restarted.capabilities.resume || restarted.capabilities.loadSession) {
	check("native context was restored", restarted.contextRestored === true);
} else {
	check("unsupported native restore stays honest", restarted.contextRestored === false);
}

const afterRestart = historyLength();
check(
	"reload did not duplicate history into the transcript",
	afterRestart === beforeRestart,
	`before=${beforeRestart} after=${afterRestart}`,
);

// Native restore should remember the turn directly. A backend without restore
// gets the same bounded continuity from Toad's transcript handoff.
const beforeMemory = events.length;
await supervisor.prompt(persona.id, "What file did you just create? Answer with only the filename.");
await waitForTurn(persona.id);
const answer = events
	.slice(beforeMemory)
	.filter((e) => e.kind === "agent")
	.map((e) => e.text)
	.join(" ");
check(
	"the restarted agent has conversation continuity",
	answer.includes("proof.txt"),
	JSON.stringify(answer.trim().slice(0, 80)),
);

await supervisor.stopAll();

console.log(
	`\n${fail === 0 ? "\x1b[32m" : "\x1b[31m"}${pass} passed, ${fail} failed\x1b[0m`,
);
console.log(`sandbox: ${sandboxHome}`);
process.exit(fail === 0 ? 0 : 1);
