/**
 * Verifies that supplying Toad's bundled MCP server preserves a backend's
 * native tools and that the full teammate-message path works.
 *
 * Run: bun hack/verify-mcp-sidecar.ts [backendId] [--write]
 */
import { randomBytes } from "node:crypto";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";

const backendId = process.argv[2]?.startsWith("--") ? "cursor" : process.argv[2] ?? "cursor";
const shouldWrite = process.argv.includes("--write");
const dataDir = mkdtempSync(join(tmpdir(), `toad-mcp-${backendId}-`));
process.env.TOAD_DATA_DIR = dataDir;
writeFileSync(
	join(dataDir, "mcp-compat.json"),
	`${JSON.stringify({
		version: 1,
		verifiedAt: Date.now(),
		backends: { [backendId]: { attach: true } },
	})}\n`,
);

const { createPersona } = await import("../src/bun/store/personas");
const transcript = await import("../src/bun/store/transcript");
const threads = await import("../src/bun/store/threads");
const { Supervisor } = await import("../src/bun/acp/supervisor");
const { PeerSessions } = await import("../src/bun/acp/peers");
const { Bridge } = await import("../src/bun/mcp/bridge");
type TranscriptEvent = import("../src/shared/types").TranscriptEvent;

if (process.argv.includes("--check-only")) {
	const { threadKey } = await import("../src/bun/paths");
	let rejected = false;
	try {
		threadKey("../bad", "ok");
	} catch {
		rejected = true;
	}
	const sorted = threadKey("b", "a") === "a~b";
	console.log(sorted ? "\x1b[32m  PASS\x1b[0m sorted thread keys" : "\x1b[31m  FAIL\x1b[0m sorted thread keys");
	console.log(rejected ? "\x1b[32m  PASS\x1b[0m unsafe ids rejected" : "\x1b[31m  FAIL\x1b[0m unsafe ids rejected");
	process.exit(sorted && rejected ? 0 : 1);
}

let pass = 0;
let fail = 0;
const outcomes = new Map<number, boolean>();
const check = (number: number, label: string, ok: boolean, detail?: unknown) => {
	outcomes.set(number, ok);
	console.log(
		ok
			? `\x1b[32m  PASS ${number}\x1b[0m ${label}`
			: `\x1b[31m  FAIL ${number}\x1b[0m ${label}`,
		detail === undefined ? "" : detail,
	);
	ok ? pass++ : fail++;
};
const info = (number: number, label: string, detail: unknown) =>
	console.log(`\x1b[36m  INFO ${number}\x1b[0m ${label}`, detail);

const events = new Map<string, TranscriptEvent[]>();
const record = (personaId: string, event: TranscriptEvent) => {
	const list = events.get(personaId) ?? [];
	const index = list.findIndex((candidate) => candidate.id === event.id);
	if (index === -1) list.push(event);
	else list[index] = event;
	events.set(personaId, list);
};
const answer = (personaId: string, event: TranscriptEvent) => {
	if (event.kind !== "permission" || event.decision !== undefined) return;
	const allow = event.options.find((option) => option.kind?.startsWith("allow")) ?? event.options[0];
	if (allow) supervisor.answerPermission(personaId, event.requestId, allow.optionId);
};

const supervisor = new Supervisor({
	transcriptAppended: ({ personaId, event }) => {
		record(personaId, event);
		answer(personaId, event);
	},
	transcriptUpdated: ({ personaId, event }) => record(personaId, event),
	streamDelta: () => {},
	sessionInfoChanged: () => {},
});

const peers = new PeerSessions({
	peerThreadAppended: ({ event }) => {
		if (event.kind !== "permission" || event.decision !== undefined) return;
		const allow = event.options.find((option) => option.kind?.startsWith("allow")) ?? event.options[0];
		if (allow) peers.answerPermission(event.requestId, allow.optionId);
	},
	peerThreadUpdated: () => {},
	peerActivityChanged: () => {},
	transcriptAppended: ({ personaId, event }) => record(personaId, event),
	transcriptUpdated: ({ personaId, event }) => record(personaId, event),
});
supervisor.setTranscriptObserver((personaId, event) => peers.observeHumanEvent(personaId, event));
const bridge = new Bridge({
	supervisor,
	peers,
	notify: (personaId, text) => {
		try {
			supervisor.nudge(personaId, text);
		} catch {
			/* session not running */
		}
	},
});
await bridge.start();

const workspace = mkdtempSync(join(tmpdir(), `toad-mcp-work-${backendId}-`));
const sentinel = `sentinel-${randomBytes(8).toString("hex")}`;
writeFileSync(join(workspace, "probe.txt"), sentinel);
const persona = createPersona({
	name: "MCP Probe",
	goal: "Follow verification instructions exactly and answer tersely.",
	backendId,
	cwd: workspace,
});

const promptReply = async (personaId: string, prompt: string): Promise<string> => {
	const before = events.get(personaId)?.length ?? 0;
	await supervisor.prompt(personaId, prompt);
	return (events.get(personaId) ?? [])
		.slice(before)
		.filter((event): event is Extract<TranscriptEvent, { kind: "agent" }> => event.kind === "agent")
		.map((event) => event.text)
		.join("\n");
};

console.log(`\n\x1b[1mMCP compatibility: ${backendId}\x1b[0m`);
const started = await supervisor.start(persona.id);
check(1, "session reached ready", started.state === "ready", started.error ?? started.state);

let readReply = "";
let contextReply = "";
let countReply = "";
let featureReply = "";
if (started.state === "ready") {
	readReply = await promptReply(
		persona.id,
		"Read probe.txt in your working directory and reply with only the token inside it.",
	);
	check(2, "native file read survived", readReply.includes(sentinel), JSON.stringify(readReply.slice(0, 160)));

	await promptReply(
		persona.id,
		"Create a file called wrote.txt in your working directory containing exactly OK. Reply only done.",
	);
	check(3, "native file write survived", existsSync(join(workspace, "wrote.txt")));

	contextReply = await promptReply(
		persona.id,
		"Call your get_context tool and reply with only the workspace path it returned.",
	);
	check(4, "sidecar tool round-tripped", contextReply.includes(workspace), JSON.stringify(contextReply.slice(0, 160)));

	countReply = await promptReply(
		persona.id,
		"How many of your tools are named exactly get_context? Reply with only a number.",
	);
	info(5, "exact get_context tool count", countReply.trim());

	const goalToken = `goal-${randomBytes(6).toString("hex")}`;
	const teammate = createPersona({
		name: "Goal Keeper",
		goal: goalToken,
		backendId,
		cwd: mkdtempSync(join(tmpdir(), `toad-mcp-peer-${backendId}-`)),
	});
	await promptReply(
		persona.id,
		`Use message_teammate to ask Goal Keeper (personaId ${teammate.id}) what its goal is. When you are told they replied, reply with their exact answer.`,
	);
	const deadline = Date.now() + 180_000;
	while (Date.now() < deadline) {
		const soFar = (events.get(persona.id) ?? [])
			.filter((event): event is Extract<TranscriptEvent, { kind: "agent" }> => event.kind === "agent")
			.map((event) => event.text)
			.join("\n");
		if (soFar.includes(goalToken)) {
			featureReply = soFar;
			break;
		}
		await Bun.sleep(100);
	}
	const pair = [persona.id, teammate.id].sort().join("~");
	const peerMessages = threads
		.load(pair)
		.filter((event) => event.kind === "user" || event.kind === "agent");
	const callerMarker = transcript.load(persona.id).some((event) => event.kind === "peer");
	const targetMarker = transcript.load(teammate.id).some((event) => event.kind === "peer");
	check(
		6,
		"teammate message smoke test",
		featureReply.includes(goalToken) &&
			peerMessages.length >= 2 &&
			callerMarker &&
			targetMarker,
		`reply=${JSON.stringify(featureReply.slice(0, 120))} messages=${peerMessages.length} markers=${callerMarker}/${targetMarker}`,
	);
} else {
	for (const [number, label] of [
		[2, "native file read survived"],
		[3, "native file write survived"],
		[4, "sidecar tool round-tripped"],
		[6, "teammate message smoke test"],
	] as const) {
		check(number, label, false, "session unavailable");
	}
	info(5, "exact get_context tool count", "session unavailable");
}

const attach = [1, 2, 3, 4].every((number) => outcomes.get(number) === true);
let reason: string | undefined;
if (!attach) {
	reason =
		outcomes.get(2) === false || outcomes.get(3) === false
			? "supplying mcpServers replaced its native tools"
			: "sidecar tools not exposed";
}
const verdict = { attach, ...(reason ? { reason } : {}) };
console.log(`\nSHIPPED: ${JSON.stringify({ [backendId]: verdict })}`);

if (shouldWrite) {
	const realRoot =
		platform() === "darwin"
			? join(homedir(), "Library", "Application Support", "Toad")
			: platform() === "win32"
				? join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Toad")
				: join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "toad");
	const file = join(realRoot, "mcp-compat.json");
	let backends: Record<string, unknown> = {};
	try {
		const current = JSON.parse(readFileSync(file, "utf8")) as {
			version?: number;
			backends?: Record<string, unknown>;
		};
		if (current.version === 1 && current.backends) backends = current.backends;
	} catch {
		// First verification on this machine.
	}
	await Bun.write(
		file,
		`${JSON.stringify({ version: 1, verifiedAt: Date.now(), backends: { ...backends, [backendId]: verdict } }, null, 2)}\n`,
	);
	console.log(`wrote: ${file}`);
}

await supervisor.stopAll();
await peers.stopAll();
bridge.stop();
console.log(
	`\n${fail === 0 ? "\x1b[32m" : "\x1b[31m"}${pass} passed, ${fail} failed\x1b[0m`,
);
console.log(`sandbox: ${dataDir}`);
process.exit(fail === 0 ? 0 : 1);
