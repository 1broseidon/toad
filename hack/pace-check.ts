/**
 * Watches the shape of a real errand, end to end.
 *
 * The house style asks for a particular rhythm — one short line to say you were
 * heard, silence while the work happens, then the result — and nothing about the
 * app can tell whether an agent is actually doing that. The transcript can. This
 * runs an errand that needs a tool to answer, then prints what arrived and when,
 * with the bubbles Toad would draw and the pacing it would give them.
 *
 * The mechanical checks are deliberately crude: they catch a wall of text and a
 * silent agent. Whether a reply reads like a colleague is a judgement, so the
 * transcript is printed to be read.
 *
 * With a question of your own, the word caps are dropped and it only prints. They
 * describe an errand — "how many files" — and a question that deserves three
 * paragraphs is the case the house style is explicitly told not to gag.
 *
 *   bun hack/pace-check.ts [backendId] ["your own errand"]
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { splitMessage } from "../src/mainview/messages";

const backendId = process.argv[2] ?? "cursor";
const ERRAND = "how many typescript files are under src/bun?";
const errand = process.argv[3] ?? ERRAND;
process.env.TOAD_DATA_DIR = mkdtempSync(join(tmpdir(), "toad-pace-"));

const { ensureLayout } = await import("../src/bun/paths");
ensureLayout();
const { createPersona } = await import("../src/bun/store/personas");
const { Supervisor } = await import("../src/bun/acp/supervisor");

/* A real repository, so the errand has something to actually look at. Read-only
 * either way: the question can be answered by counting files. */
const persona = createPersona({
	name: "Pace probe",
	goal: "",
	backendId,
	cwd: process.cwd(),
});

type Moment = { at: number; kind: string; text: string };
const moments: Moment[] = [];
const began = Date.now();

const supervisor = new Supervisor({
	transcriptAppended: ({ event }) => {
		if (event.kind === "agent" || event.kind === "tool") {
			moments.push({
				at: Date.now() - began,
				kind: event.kind,
				text: event.kind === "agent" ? event.text : (event.title ?? ""),
			});
		}
		if (event.kind === "notice") console.log(`  [${event.level}] ${event.text}`);
		if (event.kind === "permission") {
			const allow = event.options.find((o) => o.kind?.startsWith("allow")) ?? event.options[0];
			if (allow) supervisor.answerPermission(persona.id, event.requestId, allow.optionId);
		}
	},
	transcriptUpdated: () => {},
	streamDelta: () => {},
	sessionInfoChanged: () => {},
});

console.log(`backend: ${backendId}\nerrand: ${errand}\n`);
const info = await supervisor.start(persona.id);
if (info.state === "error") {
	console.error(`could not start: ${info.error}`);
	process.exit(1);
}

await supervisor.prompt(persona.id, errand);
await supervisor.stop(persona.id);

// -- what arrived -----------------------------------------------------------

const words = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;
const said = moments.filter((m) => m.kind === "agent");
const firstTool = moments.findIndex((m) => m.kind === "tool");
const firstSaid = moments.findIndex((m) => m.kind === "agent");

console.log("\nwhat arrived\n────────────");
for (const moment of moments) {
	const stamp = `${(moment.at / 1000).toFixed(1)}s`.padStart(6);
	if (moment.kind === "tool") {
		console.log(`${stamp}  ·  ${moment.text.replace(/`/g, "").slice(0, 62)}`);
		continue;
	}
	const bubbles = splitMessage(moment.text);
	console.log(`${stamp}  ▸  ${words(moment.text)}w in ${bubbles.length} bubble(s)`);
	for (const bubble of bubbles) {
		const body = bubble.text.replace(/\n/g, " ⏎ ");
		console.log(`         ${bubble.code ? "▪" : "▫"} ${body.slice(0, 84)}`);
	}
}

// -- how it reads -----------------------------------------------------------

/* Compared by position in the stream rather than by clock: an agent that writes
 * "on it" and calls a tool in the same breath produces both inside one
 * millisecond, and the order they arrived in is the only thing that says which
 * came first. */
const acked = firstSaid !== -1 && firstSaid < firstTool;
const longest = Math.max(0, ...said.map((m) => words(m.text)));
const total = said.reduce((sum, m) => sum + words(m.text), 0);

console.log("\nhow it reads\n────────────");
const report = (ok: boolean, line: string) =>
	console.log(`${ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"} ${line}`);

report(said.length > 0, `the agent said something at all (${said.length} message(s))`);
if (firstTool === -1) {
	console.log("     ·  no tools used, so there was nothing to acknowledge");
} else {
	report(acked, `it said it was on it before touching a tool${acked ? "" : " — went silent instead"}`);
}
/* The caps describe the errand this was written around. Someone else's question
 * may well deserve more, and saying so is the point of the substance rule. */
const capped = errand === ERRAND;
if (capped) {
	report(longest <= 90, `no message is a wall (longest ${longest}w, allowed 90)`);
	report(total <= 160, `the whole errand stayed conversational (${total}w, allowed 160)`);
} else {
	console.log(`     ·  ${total}w over ${said.length} message(s), longest ${longest}w — read it, don't score it`);
}

const failed =
	said.length === 0 || (firstTool !== -1 && !acked) || (capped && (longest > 90 || total > 160));
process.exit(failed ? 1 : 0);
