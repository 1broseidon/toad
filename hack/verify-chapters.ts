/**
 * Chapters (docs/chapters.md): does the mechanism do what the document says?
 *
 * Exercised against a throwaway data directory with a fake session and a
 * canned summariser, so it needs no model and no backend: the chapter
 * lifecycle, the search index, the wake block, and the checkpoint handling
 * are all Toad's own logic and this is where that logic is measured.
 *
 * Run: TOAD_DATA_DIR=$(mktemp -d) bun hack/verify-chapters.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.TOAD_DATA_DIR) {
	process.env.TOAD_DATA_DIR = mkdtempSync(join(tmpdir(), "toad-chapters-"));
}
const dataDir = process.env.TOAD_DATA_DIR;

const { createPersona, checkpointSession, clearCheckpoint, getPersona } = await import(
	"../src/bun/store/personas"
);
const transcript = await import("../src/bun/store/transcript");
const search = await import("../src/bun/store/search");
const { openChapter, previousChapter, sliceOf, summarize } = await import("../src/bun/store/chapters");
const { Chapters } = await import("../src/bun/agent/chapters");
const { conversationHandoffBlock } = await import("../src/bun/acp/style");
const { parseNote, serializeChapter } = await import("../src/bun/agent/summarize");
type TranscriptEvent = import("../src/shared/types").TranscriptEvent;
type SessionInfo = import("../src/shared/types").SessionInfo;

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
	if (!ok) failures++;
}

const persona = createPersona({ name: "Probe", goal: "verify chapters", backendId: "toad-agent" });
const id = persona.id;
let clock = Date.UTC(2026, 7, 20, 9, 0, 0);
const HOUR = 3_600_000;

// -- a fake session: what the supervisor would do, recorded ---------------

let state: SessionInfo["state"] = "idle";
let sessionId: string | undefined;
let starts = 0;
let stops = 0;
const nudges: string[] = [];
const broadcast: Array<{ mode: string; event: TranscriptEvent }> = [];

function info(): SessionInfo {
	return {
		personaId: id,
		state,
		sessionId,
		contextRestored: false,
		models: [],
		modes: [],
		configs: [],
		slashCommands: [],
		capabilities: { loadSession: true, resume: true, fork: false, mcpHttp: false, image: false },
	};
}

let idleMs = 8 * HOUR;
let summaries = 0;
const chapters = new Chapters({
	persona: () => getPersona(id),
	history: () => transcript.load(id),
	record: (personaId, event, mode) => {
		transcript.append(personaId, event);
		search.indexEvent(personaId, event);
		broadcast.push({ mode, event });
	},
	info,
	stop: async () => {
		stops++;
		state = "stopped";
		sessionId = undefined;
	},
	start: async () => {
		starts++;
		state = "ready";
		// A fresh start takes the checkpoint if there is one, else a new id.
		const checkpoint = getPersona(id)!.sessionCheckpoints.find((c) => c.backendId === "toad-agent");
		sessionId = checkpoint?.sessionId ?? `fresh-${starts}`;
	},
	nudge: (_personaId, text) => {
		nudges.push(text);
	},
	checkpoint: (personaId, backendId, sid) => {
		checkpointSession(personaId, backendId, sid);
	},
	clearCheckpoint: (personaId, backendId, onlyIf) => clearCheckpoint(personaId, backendId, onlyIf),
	summarize: async (_persona, events) => {
		summaries++;
		const said = events.filter((e) => e.kind === "user" || e.kind === "agent").length;
		return {
			title: `Chapter of ${said} messages`,
			note: `Goal: test the container stress harness\nOutcome: ${said} messages were exchanged\nOpen loops:\n- finish the playwright run`,
			status: "in-progress" as const,
			tags: ["docker", "playwright", "stress", "container"],
		};
	},
	idleMs: () => idleMs,
	log: (message) => console.error(`  log: ${message}`),
});

/** A user message the way the supervisor would write it, then the agent's reply. */
function say(user: string, agent: string): void {
	const u: TranscriptEvent = { kind: "user", id: crypto.randomUUID(), ts: clock, text: user };
	transcript.append(id, u);
	search.indexEvent(id, u);
	chapters.observe(id, u);
	clock += 30_000;
	const a: TranscriptEvent = { kind: "agent", id: crypto.randomUUID(), ts: clock, text: agent };
	transcript.append(id, a);
	search.indexEvent(id, a);
	chapters.observe(id, a);
	clock += 30_000;
}

/* Date.now is what the manager reads; drive it from the fake clock so an
 * eight-hour gap is a number, not a wait. */
const realNow = Date.now;
Date.now = () => clock;

// -- 1. first message opens a chapter and checkpoints attach to it ---------

await chapters.beforePrompt(id);
state = "ready";
sessionId = "session-1";
say("sup", "hey. what are we doing today?");
let events = transcript.load(id);
check("first message opened a chapter", openChapter(events) !== undefined);
check("the opening marker precedes the message", events[0]?.kind === "chapter");

chapters.sessionCheckpointed(id, "toad-agent", "session-1");
checkpointSession(id, "toad-agent", "session-1");
events = transcript.load(id);
check("checkpoint landed on the open chapter", openChapter(events)?.sessionId === "session-1");

say("let's stress test the container with playwright", "on it. running the harness now.");
say("how did it go?", "three of five runs passed; the shm size looks wrong.");

// -- 2. an idle gap closes the chapter with a note and withdraws the checkpoint

clock += 9 * HOUR;
await chapters.beforePrompt(id);
events = transcript.load(id);
const previous = previousChapter(events);
check("stale chapter closed on the next message", previous !== undefined && previous.endedAt !== undefined);
check("the summariser ran once", summaries === 1);
check("note and tags were written", Boolean(previous?.note) && (previous?.tags?.length ?? 0) > 0, previous);
check("status came from the note", previous?.status === "in-progress");
check("the closed chapter keeps its session id", previous?.sessionId === "session-1");
check("the live session was rotated", stops === 1 && starts === 1, { stops, starts });
check(
	"the checkpoint was withdrawn so the start was fresh",
	sessionId === "fresh-1" && !getPersona(id)!.sessionCheckpoints.some((c) => c.backendId === "toad-agent"),
	{ sessionId, checkpoints: getPersona(id)!.sessionCheckpoints },
);
check("a new chapter is open for the message", openChapter(events) !== undefined && openChapter(events)!.id !== previous!.id);
check(
	"the close went out as an update and the open as an append",
	broadcast.some((b) => b.mode === "update" && b.event.kind === "chapter" && b.event.endedAt !== undefined) &&
		broadcast.filter((b) => b.mode === "append" && b.event.kind === "chapter").length === 2,
);

// -- 3. the wake block reads the note -----------------------------------

const wake = conversationHandoffBlock(events, { tools: true });
check("wake block exists", wake !== undefined);
check("wake block carries the note", wake?.text.includes("finish the playwright run") === true);
check("wake block says how long ago", /ended 9 hours ago/.test(wake?.text ?? ""), wake?.text.slice(0, 400));
check("an idle close ends when the talking stopped", previous!.endedAt! < clock - 8 * HOUR, { endedAt: previous!.endedAt, clock });
check("wake block offers resume_chapter", wake?.text.includes("resume_chapter") === true);
check("wake block marks work in progress", wake?.text.includes("still in progress") === true);
const quiet = conversationHandoffBlock(events);
check("without tools the block does not mention them", quiet?.text.includes("resume_chapter") === false);

// -- 4. search finds the chapter by a tag the conversation never used -------

say("continue", "sure — the playwright run, or something new?");
const byTag = search.search(id, "docker", 10);
check("a tag finds the chapter", byTag.hits.some((h) => h.kind === "chapter"), byTag);
const byWord = search.search(id, "shm size", 10);
check("a message is found by its words", byWord.hits.some((h) => h.kind === "message" && h.excerpt.includes("shm")), byWord);
const byPrefix = search.search(id, "contain", 10);
check("prefix matching works", byPrefix.hits.length > 0);
const orFallback = search.search(id, "playwright zebra", 10);
check("an AND miss falls back to OR", orFallback.hits.length > 0);
const punctuation = search.search(id, 'shm" OR (1=1', 10);
check("punctuation cannot break the query", Array.isArray(punctuation.hits));
check("an empty query returns nothing", search.search(id, "   ", 10).hits.length === 0);
search.reindex(id);
check("a rebuild from the file finds the same chapter", search.search(id, "docker", 10).hits.some((h) => h.kind === "chapter"));

// -- 5. resume_chapter reopens the previous context and nudges -----------

events = transcript.load(id);
const interimId = openChapter(events)!.id;
const result = chapters.resume(id);
check("resume is accepted", result.ok === true, result);
await new Promise((resolve) => setTimeout(resolve, 50));
events = transcript.load(id);
const reopened = openChapter(events);
check("the interim chapter closed as a return", events.some((e) => e.kind === "chapter" && e.id === interimId && e.title?.startsWith("Back to")));
check("the reopened chapter points at the previous one", reopened?.resumedFrom === previous!.id && reopened?.sessionId === "session-1");
check("the reopened chapter carries the note", reopened?.note === previous!.note);
check("the session was restarted on the old checkpoint", sessionId === "session-1" && stops === 2 && starts === 2, { sessionId, stops, starts });
check("the restored session was nudged with the interim message", nudges.length === 1 && nudges[0]!.includes("continue"), nudges);
check("resume will not reopen the turning point it just left", chapters.resume(id).ok === false, chapters.resume(id));

// -- 6. new_chapter from the agent waits for the next message ---------------

say("ok, different thing: rename the repo", "on it.");
state = "ready";
const fresh = await chapters.startFresh(id, "agent");
check("agent close returns the chapter title", typeof fresh.title === "string", fresh);
check("agent close did not rotate yet", stops === 2);
await chapters.beforePrompt(id);
check("the next message rotated", stops === 3 && starts === 3, { stops, starts });

// -- 7. the user's button rotates at once ----------------------------------

say("another", "ok");
await chapters.startFresh(id, "user");
check("user close rotated at once", stops === 4 && starts === 4, { stops, starts });
check("nothing said yet, so no chapter is open", openChapter(transcript.load(id)) === undefined);

// -- 8. sweep closes a stale chapter at startup ----------------------------

say("one more", "sure");
clock += 20 * HOUR;
chapters.sweep([id]);
await new Promise((resolve) => setTimeout(resolve, 50));
check(
	"sweep closed the stale chapter",
	openChapter(transcript.load(id)) === undefined,
	transcript.load(id).slice(-4).map((e) => ({ kind: e.kind, ...(e.kind === "chapter" ? { endedAt: e.endedAt, title: e.title } : {}) })),
);

// -- 9. the listing and the slice ------------------------------------------

const listed = summarize(transcript.load(id));
check("chapters list newest first", listed.length >= 4 && listed[0]!.startedAt >= listed[listed.length - 1]!.startedAt, listed.map((c) => c.title));
check("message counts exclude markers", listed.every((c) => c.messages === sliceOf(transcript.load(id), transcript.load(id).find((e) => e.id === c.id) as never).filter((e) => e.kind === "user" || e.kind === "agent").length));

// -- 10. the summariser's parsing ------------------------------------------

const parsed = parseNote(
	'Sure. {"title":"Container stress test","goal":"g","outcome":"o","open_loops":["a","b"],"decisions":[],"files":["x.ts"],"tags":["Docker","SHM"],"status":"in-progress"}',
);
check("parseNote survives prose around the JSON", parsed?.title === "Container stress test" && parsed.status === "in-progress");
check("parseNote renders sections", parsed?.note.includes("Open loops:\n- a\n- b") === true && parsed.note.includes("Files: x.ts"));
check("tags are lowercased", parsed?.tags.join(",") === "docker,shm");
check("parseNote rejects junk", parseNote("no json here") === undefined);
const serialized = serializeChapter(transcript.load(id));
check("serializeChapter lists speakers", serialized.includes("USER: ") && serialized.includes("TEAMMATE: "));

Date.now = realNow;
search.close();
if (!process.env.KEEP_DATA) rmSync(dataDir, { recursive: true, force: true });
console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
