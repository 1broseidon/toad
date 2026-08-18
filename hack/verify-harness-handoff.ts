/**
 * Proves both kinds of continuity Toad promises:
 *
 * 1. a new harness receives a bounded transcript handoff;
 * 2. switching back resumes that harness's own native ACP session.
 *
 * Run: bun hack/verify-harness-handoff.ts [firstBackend] [secondBackend]
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "toad-handoff-"));
process.env.TOAD_DATA_DIR = dataDir;

const { createPersona, getPersona, updatePersona } = await import("../src/bun/store/personas");
const { Supervisor } = await import("../src/bun/acp/supervisor");
type TranscriptEvent = import("../src/shared/types").TranscriptEvent;

const firstBackend = process.argv[2] ?? "cursor";
const secondBackend = process.argv[3] ?? "claude-acp";
const TOKEN = "riverstone-47";

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
	console.log(
		ok ? `\x1b[32m  PASS\x1b[0m ${label}` : `\x1b[31m  FAIL\x1b[0m ${label}`,
		detail === undefined ? "" : detail,
	);
	ok ? pass++ : fail++;
};

const events: TranscriptEvent[] = [];
const supervisor = new Supervisor({
	transcriptAppended: ({ personaId, event }) => {
		events.push(event);
		if (event.kind === "permission" && event.decision === undefined) {
			const allow =
				event.options.find((option) => option.kind?.startsWith("allow")) ?? event.options[0];
			if (allow) supervisor.answerPermission(personaId, event.requestId, allow.optionId);
		}
	},
	transcriptUpdated: ({ event }) => {
		const index = events.findIndex((candidate) => candidate.id === event.id);
		if (index === -1) events.push(event);
		else events[index] = event;
	},
	streamDelta: () => {},
	sessionInfoChanged: () => {},
});

const persona = createPersona({
	name: "Courier",
	goal: "Answer plainly.",
	backendId: firstBackend,
});

console.log(`\n\x1b[36m${firstBackend}: establish native context\x1b[0m`);
const first = await supervisor.start(persona.id);
check("first harness started", first.state === "ready", first.error);
await supervisor.prompt(
	persona.id,
	`Remember this continuity token for later: ${TOKEN}. Reply with only "remembered".`,
);
const firstCheckpoint = getPersona(persona.id)?.sessionCheckpoints.find(
	(checkpoint) => checkpoint.backendId === firstBackend,
);
check("first harness checkpointed", Boolean(firstCheckpoint));
await supervisor.stop(persona.id);

console.log(`\n\x1b[36m${secondBackend}: receive Toad handoff\x1b[0m`);
updatePersona(persona.id, { backendId: secondBackend });
const second = await supervisor.start(persona.id);
check("second harness started", second.state === "ready", second.error);
check("another harness id was not used as native context", second.contextRestored === false);
const beforeHandoffAnswer = events.length;
await supervisor.prompt(
	persona.id,
	"What continuity token was mentioned earlier? Reply with only the token.",
);
const handoffAnswer = events
	.slice(beforeHandoffAnswer)
	.filter((event) => event.kind === "agent")
	.map((event) => event.text)
	.join(" ");
check(
	"new harness received transcript continuity",
	handoffAnswer.toLowerCase().includes(TOKEN),
	JSON.stringify(handoffAnswer.trim().slice(0, 120)),
);
const afterSecond = getPersona(persona.id)?.sessionCheckpoints ?? [];
check(
	"both native checkpoints are preserved",
	afterSecond.some((checkpoint) => checkpoint.backendId === firstBackend) &&
		afterSecond.some((checkpoint) => checkpoint.backendId === secondBackend),
);
await supervisor.stop(persona.id);

console.log(`\n\x1b[36m${firstBackend}: return to native context\x1b[0m`);
updatePersona(persona.id, { backendId: firstBackend });
const returned = await supervisor.start(persona.id);
check("first harness restarted", returned.state === "ready", returned.error);
check("first harness resumed its own context", returned.contextRestored === true);
check("first harness resumed the same id", returned.sessionId === firstCheckpoint?.sessionId);
await supervisor.stopAll();

console.log(
	`\n${fail === 0 ? "\x1b[32m" : "\x1b[31m"}${pass} passed, ${fail} failed\x1b[0m`,
);
console.log(`sandbox: ${dataDir}`);
process.exit(fail === 0 ? 0 : 1);
