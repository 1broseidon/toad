/**
 * The hand-to-human flow, at the module boundary the bridge and UI share:
 * a request posts a pending card, answering it settles the blocked call,
 * a timeout expires it, and a newer request supersedes an older one.
 *
 * Run: bun scripts/verify-human-handoff.ts
 */
import type { TranscriptEvent } from "../src/shared/types";
import { answerHuman, configureHandoff, requestHuman } from "../src/bun/computer/handoff";

let passed = 0;
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
	if (ok) passed++;
	else failed++;
	console.log(`  ${ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"} ${name} ${detail}`);
};

type Emitted = { op: "append" | "update"; personaId: string; event: TranscriptEvent };
const emitted: Emitted[] = [];
configureHandoff({
	append: (personaId, event) => emitted.push({ op: "append", personaId, event }),
	update: (personaId, event) => emitted.push({ op: "update", personaId, event }),
});
const last = () => emitted[emitted.length - 1]!;
const actionIdOf = (entry: Emitted) =>
	entry.event.kind === "human_action" ? entry.event.actionId : "";
const statusOf = (entry: Emitted) =>
	entry.event.kind === "human_action" ? entry.event.status : "?";

// -- answer resolves the blocked call ---------------------------------------

const first = requestHuman("persona-a", "Tap the 2FA prompt", 60);
check("request posts a pending card", last().op === "append" && statusOf(last()) === "pending");

check("answering an unknown card is a no-op", answerHuman("nope", "done") === false);
check("known card accepts the answer", answerHuman(actionIdOf(last()), "done") === true);
check("card updated to done", last().op === "update" && statusOf(last()) === "done");
check("blocked call resolved done", (await first).status === "done");
check("second answer is a no-op", answerHuman(actionIdOf(last()), "dismissed") === false);

// -- dismissal --------------------------------------------------------------

const second = requestHuman("persona-a", "Enter the vault password", 60);
answerHuman(actionIdOf(last()), "dismissed");
check("dismissal resolves dismissed", (await second).status === "dismissed");

// -- timeout ----------------------------------------------------------------

const third = requestHuman("persona-a", "Solve the CAPTCHA", 10);
// The floor is 10s; fake the clock instead of waiting it out.
const start = Date.now();
const status = await Promise.race([
	third.then((r) => r.status),
	Bun.sleep(11_000).then(() => "hung" as const),
]);
check("timeout expires the card", status === "expired", `${Math.round((Date.now() - start) / 1000)}s`);
check("card updated to expired", statusOf(last()) === "expired");

// -- supersession -----------------------------------------------------------

const stale = requestHuman("persona-b", "Old ask", 60);
const staleId = actionIdOf(last());
const fresh = requestHuman("persona-b", "New ask", 60);
check("stale card expired on supersession", (await stale).status === "expired");
check("stale answer no longer lands", answerHuman(staleId, "done") === false);
answerHuman(actionIdOf(last()), "done");
check("fresh card still answerable", (await fresh).status === "done");

// -- isolation between personas ---------------------------------------------

const a = requestHuman("persona-a", "A's ask", 60);
const aId = actionIdOf(last());
const b = requestHuman("persona-b", "B's ask", 60);
answerHuman(actionIdOf(last()), "done");
check("personas do not supersede each other", answerHuman(aId, "dismissed") === true);
await Promise.all([a, b]);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
