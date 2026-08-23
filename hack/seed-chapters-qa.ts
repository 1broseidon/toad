/**
 * Seeds a throwaway data directory for a live look at chapters: one teammate
 * on Toad Agent whose conversation stopped twenty hours ago inside an open
 * chapter. On launch the sweep should close it with a real note, and the
 * first message should wake a fresh context that reads that note.
 *
 * Run: TOAD_DATA_DIR=/tmp/toad-chapters-qa bun hack/seed-chapters-qa.ts
 */
import { randomUUID } from "node:crypto";

if (!process.env.TOAD_DATA_DIR) {
	console.error("Set TOAD_DATA_DIR to a throwaway directory first.");
	process.exit(1);
}

const { createPersona, listPersonas } = await import("../src/bun/store/personas");
const transcript = await import("../src/bun/store/transcript");
type TranscriptEvent = import("../src/shared/types").TranscriptEvent;

if (listPersonas().length > 0) {
	console.log("Already seeded:", listPersonas().map((p) => `${p.name} (${p.id})`).join(", "));
	process.exit(0);
}

const persona = createPersona({
	name: "Pace",
	goal: "Help George stress-test the Toad computer and keep notes on what breaks.",
	backendId: "pi",
});

const HOUR = 3_600_000;
let at = Date.now() - 20 * HOUR;
const tick = (minutes: number) => (at += minutes * 60_000);

const lines: Array<["user" | "agent", string]> = [
	["user", "sup"],
	["agent", "hey. what are we doing today?"],
	["user", "let's stress test the container. spin up the computer and hammer it with playwright — 20 tabs, screenshots every second"],
	["agent", "on it."],
	["agent", "started. the container came up in 4s; playwright is opening tabs. I'll report when it's been running a few minutes."],
	["user", "how's it going?"],
	["agent", "three of five rounds finished. the fourth stalled — chromium is complaining about /dev/shm being full. I think the shm size is too small for 20 tabs; 1g looks like the limit we set in driver.ts."],
	["user", "ok bump it to 2g and rerun, I'm heading to bed"],
	["agent", "will do. I'll leave the results in /tmp/stress/run-4.log and a summary here when it's done."],
	["agent", "run 4 with shm 2g: 20 tabs stayed up for 11 minutes, no stalls. run 5 is going now; I'll stop after that and write it up."],
];

const events: TranscriptEvent[] = [
	{ kind: "chapter", id: randomUUID(), ts: at, backendId: "pi" },
];
for (const [kind, text] of lines) {
	tick(kind === "user" ? 3 : 1);
	events.push({ kind, id: randomUUID(), ts: at, text });
}
for (const event of events) transcript.append(persona.id, event);

console.log(`Seeded ${persona.name} (${persona.id}) with ${lines.length} messages in an open chapter, last said ${Math.round((Date.now() - at) / HOUR)}h ago.`);
console.log(`Data dir: ${process.env.TOAD_DATA_DIR}`);
