/**
 * Proves Toad Agent can send work to a silent subagent.
 *
 * The contract is structural as much as behavioural: a subagent is a second
 * pi session whose events are never wired to the parent's transcript. These
 * checks cover the parts that can still go wrong — the tool not being
 * attached, the subagent being briefed like a chat teammate, a cancelled
 * call still hitting the model, an invented kind or model being accepted,
 * and a real run writing a file the parent never narrated.
 *
 * Run: bun hack/verify-pi-subagent.ts
 */
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.TOAD_DATA_DIR = mkdtempSync(join(tmpdir(), "toad-pi-subagent-"));

const { createPersona, getPersona, updatePersona } = await import("../src/bun/store/personas");
const { Supervisor } = await import("../src/bun/acp/supervisor");
const { houseStyleBlock } = await import("../src/bun/acp/style");
const { describeTool } = await import("../src/bun/pi/tools");
const {
	GENERIC_SUBAGENT_KIND,
	normalizePersonaSubagents,
	resolveSubagentRoster,
} = await import("../src/shared/subagents");
const {
	MAX_LIVE_SUBAGENTS,
	SUBAGENT_TOOL_NAME,
	genericSubagentPrompt,
	resolveSubagentKind,
	resolveSubagentModel,
	runSubagent,
	subagentTool,
} = await import("../src/bun/pi/subagent");
const { piRuntime } = await import("../src/bun/pi/runtime");
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

function toolText(result: { content: Array<{ type?: string; text?: string }> }): string {
	const block = result.content[0];
	return block && typeof block.text === "string" ? block.text : "";
}

section("Briefing");
const parentBrief = houseStyleBlock({ subagentTool: true }).text;
check("Toad Agent is told about subagent", parentBrief.includes("`subagent`"));
check("ACP house style is not told about subagent", !houseStyleBlock({}).text.includes("`subagent`"));

const nestedBrief = genericSubagentPrompt({ teammateName: "Scout", goal: "Watch the repo." });
check("the subagent is told it is not speaking to the user", nestedBrief.includes("not speaking to the user"));
check("the subagent is not told to greet", !/\bon it\b/i.test(nestedBrief));
check(
	"the transcript line uses the label",
	describeTool("subagent", { label: "count files", prompt: "a long prompt the user should not see" }) ===
		"Subagent: count files",
);
check(
	"a specialist kind is named in the transcript",
	describeTool("subagent", { kind: "explore", label: "scan src" }) === "explore subagent: scan src",
);

section("Kinds and models");
const baseRoster = resolveSubagentRoster({});
check("a teammate with no config still has the task runner", baseRoster.length === 1 && baseRoster[0]!.id === GENERIC_SUBAGENT_KIND);
check("generic is the default kind", resolveSubagentKind(undefined, baseRoster).ok && resolveSubagentKind("generic", baseRoster).ok);
check("an invented kind is refused", !resolveSubagentKind("explore", baseRoster).ok);
const runtime = await piRuntime();
check("omitting model inherits", resolveSubagentModel(runtime, undefined).ok);
check("model needs provider/id", !resolveSubagentModel(runtime, "sonnet").ok);
check("an unknown model is refused", !resolveSubagentModel(runtime, "nope/definitely-not-a-model").ok);

section("Scoped per teammate");
const owner = createPersona({ name: "Has extras", goal: "g", backendId: "pi" });
updatePersona(owner.id, {
	subagents: {
		defaults: { name: "Grunt", modelId: "anthropic/claude-sonnet-4-6" },
		extras: [{ id: "review", name: "Reviewer", description: "Read diffs and say what is wrong." }],
	},
});
const stored = getPersona(owner.id)!;
const ownerRoster = resolveSubagentRoster(stored);
check("the default rename is kept", ownerRoster[0]?.name === "Grunt");
check("the extra kind is on this teammate", resolveSubagentKind("review", ownerRoster).ok);
check(
	"the house style lists this teammate's kinds",
	houseStyleBlock({ subagentTool: true, subagents: ownerRoster }).text.includes("`review`"),
);
const other = createPersona({ name: "Plain", goal: "g", backendId: "pi" });
check(
	"another teammate does not inherit the extra",
	!resolveSubagentKind("review", resolveSubagentRoster(other)).ok,
);
const junk = normalizePersonaSubagents({
	extras: [
		{ id: "generic", name: "Stolen", description: "no" },
		{ id: "???", name: "", description: "no" },
		{ id: "review", name: "Reviewer", description: "ok" },
	],
});
check("generic cannot be registered as an extra", !(junk?.extras ?? []).some((extra) => extra.id === "generic"));
check("a legal extra survives normalize", (junk?.extras ?? []).some((extra) => extra.id === "review"));

section("The tool is attached");
const events: TranscriptEvent[] = [];
const supervisor = new Supervisor({
	transcriptAppended: ({ event }) => events.push(event),
	transcriptUpdated: () => {},
	streamDelta: () => {},
	sessionInfoChanged: () => {},
});

const persona = createPersona({
	name: "Subagent host",
	goal: "Answer briefly.",
	backendId: "pi",
});
const started = await supervisor.start(persona.id);
check("session started", started.state === "ready" || started.state === "error", started.error ?? started.state);

const live = (supervisor as unknown as { sessions: Map<string, unknown> }).sessions.get(persona.id) as {
	session?: { agent: { state: { tools: Array<{ name: string }> } }; systemPrompt?: string };
};
const toolNames = live?.session?.agent.state.tools.map((tool) => tool.name) ?? [];
check("subagent is a live tool", toolNames.includes(SUBAGENT_TOOL_NAME), toolNames.join(","));
check("only one subagent tool", toolNames.filter((name) => name === SUBAGENT_TOOL_NAME).length === 1);
check(
	"the system prompt mentions the subagent",
	(live?.session?.systemPrompt ?? "").includes("subagent"),
	(live?.session?.systemPrompt ?? "").slice(0, 80),
);

section("Cancelled before it starts");
const cancelledCwd = mkdtempSync(join(tmpdir(), "toad-subagent-cancel-"));
const cancelled = await runSubagent(
	{
		cwd: cancelledCwd,
		personaId: "verify",
		teammateName: "Scout",
		goal: "",
		model: undefined,
		thinkingLevel: "off",
		runtime,
		extraTools: [],
		armTools: [],
		roster: baseRoster,
	},
	"write a file named should-not-exist.txt containing no",
	{ signal: AbortSignal.abort() },
);
check("an already-cancelled call does not run", cancelled.ok === false && cancelled.reason === "aborted");
check("it wrote nothing", !existsSync(join(cancelledCwd, "should-not-exist.txt")));

const noModel = await runSubagent(
	{
		cwd: cancelledCwd,
		personaId: "verify",
		teammateName: "Scout",
		goal: "",
		model: undefined,
		thinkingLevel: "off",
		runtime,
		extraTools: [],
		armTools: [],
		roster: baseRoster,
	},
	"write a file",
);
check("no model is a clean failure", noModel.ok === false && noModel.reason === "no_model");

section("The gate");
const stubHost = {
	cwd: cancelledCwd,
	personaId: "verify",
	teammateName: "Scout",
	goal: "",
	model: undefined,
	thinkingLevel: "off" as const,
	runtime,
	extraTools: [],
	armTools: [],
	roster: baseRoster,
};
const toolHost = {
	context: () => stubHost,
	begin: (): "ok" | "busy" => "ok",
	end: () => {},
	track: () => {},
	untrack: () => {},
	notify: () => {},
};
const busyHost = { ...toolHost, begin: (): "ok" | "busy" => "busy" };
const busy = await subagentTool(busyHost, baseRoster).execute(
	"gate",
	{ prompt: "anything" },
	undefined,
	undefined,
	{} as never,
);
check("too many subagents is refused", toolText(busy).includes(`max ${MAX_LIVE_SUBAGENTS}`), toolText(busy));

const invented = await subagentTool(toolHost, baseRoster).execute(
	"kind",
	{ prompt: "anything", kind: "explore" },
	undefined,
	undefined,
	{} as never,
);
check("the tool refuses an unknown kind", toolText(invented).includes("Unknown subagent kind"), toolText(invented));

section("A subagent does the work");
const models = await runtime.getAvailable();
check("a model is available", models.length > 0, models.length);
if (models.length > 0) {
	const chosen = resolveSubagentModel(runtime, `${models[0]!.provider}/${models[0]!.id}`);
	check("a real model id resolves", chosen.ok && chosen.ok && chosen.model?.id === models[0]!.id);

	const cwd = mkdtempSync(join(tmpdir(), "toad-subagent-live-"));
	writeFileSync(join(cwd, "note.txt"), "keep\n");
	const result = await runSubagent(
		{
			cwd,
			personaId: "verify",
			teammateName: "Scout",
			goal: "Keep answers short.",
			model: models[0],
			thinkingLevel: "off",
			runtime,
			extraTools: [],
			armTools: [],
			roster: baseRoster,
		},
		"Write a file named runner.txt containing exactly the three letters ok and nothing else. Then report that you wrote it.",
	);
	check("the subagent finished", result.ok, result.ok ? result.report.slice(0, 160) : result.detail);
	check("it wrote the file", existsSync(join(cwd, "runner.txt")));

	if (started.state !== "ready") {
		check("parent session was ready for the quiet-chat check", false, started.state);
	} else {
		const before = events.length;
		await supervisor.prompt(
			persona.id,
			"Use the subagent tool — and only the subagent tool, not write or bash — to create a file named quiet.txt containing exactly: silent. Then reply with only the word done.",
		);
		const deadline = Date.now() + 180_000;
		while (supervisor.info(persona.id).state !== "thinking" && Date.now() < deadline) {
			await Bun.sleep(20);
		}
		while (supervisor.info(persona.id).state === "thinking" && Date.now() < deadline) {
			await Bun.sleep(50);
		}

		const after = events.slice(before);
		const tools = after.filter((event) => event.kind === "tool");
		const childWrites = tools.filter(
			(event) =>
				event.kind === "tool" &&
				(event.toolKind === "write" || event.title.toLowerCase().includes("write quiet")),
		);
		const calls = tools.filter(
			(event) =>
				event.kind === "tool" &&
				(event.toolKind === SUBAGENT_TOOL_NAME || event.title.startsWith("Subagent")),
		);
		check(
			"the parent called subagent",
			calls.length > 0,
			tools.map((event) => (event.kind === "tool" ? event.title : "")).join(","),
		);
		check("the subagent's writes did not land in the parent transcript", childWrites.length === 0, childWrites.length);
		const fileDeadline = Date.now() + 180_000;
		while (!existsSync(join(persona.cwd, "quiet.txt")) && Date.now() < fileDeadline) {
			await Bun.sleep(50);
		}
		check("quiet.txt exists", existsSync(join(persona.cwd, "quiet.txt")));
	}
}

await supervisor.stopAll();

console.log(
	fail === 0
		? `\x1b[32m${pass} passed, 0 failed\x1b[0m`
		: `\x1b[31m${pass} passed, ${fail} failed\x1b[0m`,
);
process.exit(fail === 0 ? 0 : 1);
