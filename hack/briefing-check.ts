/**
 * Checks that the house-style briefing actually reaches the agent.
 *
 * It travels as its own content block ahead of the person's first message, and
 * an agent that only read the last block would drop it silently — the app would
 * look fine and every reply would still arrive shaped like a terminal report.
 * So the agent is asked to quote it back.
 *
 *   bun hack/briefing-check.ts [backendId]
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const backendId = process.argv[2] ?? "cursor";
const dataDir = mkdtempSync(join(tmpdir(), "toad-briefing-"));
process.env.TOAD_DATA_DIR = dataDir;

const { ensureLayout } = await import("../src/bun/paths");
ensureLayout();
const { createPersona } = await import("../src/bun/store/personas");
const { Supervisor } = await import("../src/bun/acp/supervisor");

const persona = createPersona({
	name: "Briefing probe",
	goal: "Answer exactly what is asked.",
	backendId,
});

const replies: string[] = [];
const supervisor = new Supervisor({
	transcriptAppended: ({ event }) => {
		if (event.kind === "agent") replies.push(event.text);
		if (event.kind === "notice") console.log(`  [${event.level}] ${event.text}`);
		/* A backend may want approval just to answer; this probe is not testing
		 * containment, so anything offered is accepted. */
		if (event.kind === "permission") {
			const allow = event.options.find((o) => o.kind?.startsWith("allow")) ?? event.options[0];
			if (allow) supervisor.answerPermission(persona.id, event.requestId, allow.optionId);
		}
	},
	transcriptUpdated: () => {},
	streamDelta: () => {},
	sessionInfoChanged: () => {},
});

console.log(`backend: ${backendId}\ndata dir: ${dataDir}\n`);
const info = await supervisor.start(persona.id);
if (info.state === "error") {
	console.error(`could not start: ${info.error}`);
	process.exit(1);
}

await supervisor.prompt(
	persona.id,
	"Before my message, did you receive any instructions about what kind of app you are speaking in? Answer in one sentence, quoting the app's name if you saw one. Do not use any tools.",
);

const answer = replies.join("\n").trim();
console.log(`\nagent said:\n  ${answer.replace(/\n/g, "\n  ")}\n`);

await supervisor.stop(persona.id);

const heard = /toad/i.test(answer);
console.log(heard ? "\x1b[32mbriefing received\x1b[0m" : "\x1b[31mbriefing did NOT reach the agent\x1b[0m");
process.exit(heard ? 0 : 1);
