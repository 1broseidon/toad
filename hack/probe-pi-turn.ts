/**
 * One real pi turn, through Toad's own Supervisor.
 *
 * Written to be run twice — from source and from a bundle — because those are
 * two different programs. See hack/verify-pi-bundle.ts.
 *
 * Prints one `key=value` line per result so the caller can assert on it
 * without parsing prose.
 */
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.TOAD_DATA_DIR = mkdtempSync(join(tmpdir(), "toad-pi-probe-"));

const { createPersona } = await import("../src/bun/store/personas");
const { Supervisor } = await import("../src/bun/acp/supervisor");
type TranscriptEvent = import("../src/shared/types").TranscriptEvent;

const events: TranscriptEvent[] = [];
const supervisor = new Supervisor({
	transcriptAppended: ({ event }) => events.push(event),
	transcriptUpdated: () => {},
	streamDelta: () => {},
	sessionInfoChanged: () => {},
});

const persona = createPersona({
	name: "Bundle probe",
	goal: "Answer briefly.",
	backendId: "pi",
});

const started = await supervisor.start(persona.id);
console.log(`state=${started.state}`);
console.log(`models=${started.models.length}`);
console.log(`error=${started.error ?? ""}`);

if (started.state === "ready") {
	await supervisor.prompt(
		persona.id,
		"Write a file named probe.txt containing exactly: ok. Then say done.",
	);
	const deadline = Date.now() + 120_000;
	while (supervisor.info(persona.id).state === "thinking" && Date.now() < deadline) {
		await Bun.sleep(50);
	}
}

const notices = events.filter((event) => event.kind === "notice" && event.level === "error");
console.log(`kinds=${[...new Set(events.map((event) => event.kind))].join(",")}`);
console.log(`wrote=${existsSync(join(persona.cwd, "probe.txt"))}`);
console.log(`notices=${notices.map((n) => (n.kind === "notice" ? n.text : "")).join(" | ")}`);

await supervisor.stopAll();
