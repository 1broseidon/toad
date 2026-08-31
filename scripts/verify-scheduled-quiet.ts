/**
 * A schedule's two ends, driven through the real main process on a scratch
 * data directory: one quiet line in, and nothing out when silence was the ask.
 *
 * - a job carries a name and a quiet flag through the real store, survives a
 *   restart of the scheduler, and its firing hands the teammate the bare
 *   prompt plus the stamp that says which job spoke
 * - the firing writes ONE user event carrying that stamp — the prompt is still
 *   its text, so nothing is lost, and `scheduledLine` collapses it to a line
 * - a quiet turn leaves no `agent` event in the tape at all, while its
 *   thoughts and tool calls are recorded exactly as they happened
 * - the words are demoted rather than destroyed: they are in the tape as
 *   thinking, and the live delta is demoted with them
 * - a failure is never quieted: an error notice lands mid-silence
 * - a non-quiet job of the same shape says the same sentence out loud, which
 *   is the proof that nothing here reads the text
 * - a firing that lands mid-turn does not mute the turn already in flight
 * - a person typing during a quiet run gets answered
 * - the window closes with the turn: the teammate's next reply is a message
 * - the user's own switch, `setQuiet`, flips a live job in both directions
 * - a loop re-arms with its name and flag intact; a one-shot removes itself
 *
 * The one thing scripted rather than real is the agent process: a
 * `TeammateSession` stub drives the supervisor's own emitters — the same
 * `appendEvent`/`delta` funnel `PiSession` and `AcpSession` both hand their
 * output to — so everything downstream of the protocol is production code.
 * That funnel is exactly where the gate lives, which is why one harness
 * covers both agent kinds. See src/bun/agent/quiet.ts.
 *
 * Run: bun scripts/verify-scheduled-quiet.ts
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "toad-quiet-"));
process.env.TOAD_DATA_DIR = root;

const { Supervisor } = await import("../src/bun/acp/supervisor");
const { Scheduler, wakeTeammate } = await import("../src/bun/schedule");
const personas = await import("../src/bun/store/personas");
const transcript = await import("../src/bun/store/transcript");
const { scheduledLine } = await import("../src/shared/scheduled");
const { idleInfo } = await import("../src/bun/agent/session");

import type { Emitters, TeammateSession } from "../src/bun/agent/session";
import type {
	Attachment,
	ScheduledJob,
	SessionInfo,
	SessionState,
	StreamDelta,
	TranscriptEvent,
} from "../src/shared/types";

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
	console.log(
		ok ? `\x1b[32m  PASS\x1b[0m ${label}` : `\x1b[31m  FAIL\x1b[0m ${label}`,
		detail === undefined || ok ? "" : JSON.stringify(detail),
	);
	ok ? pass++ : fail++;
};

// ---------------------------------------------------------------------------
// A teammate whose turns are written here rather than by a model
// ---------------------------------------------------------------------------

/** One beat of a scripted turn, in the vocabulary the supervisor receives. */
type Beat =
	| { say: string }
	| { think: string }
	| { tool: string }
	| { fail: string }
	| { endTurn: true };

/**
 * A session that speaks Toad's own event vocabulary directly.
 *
 * `send` does what both real sessions do at the same moment: record the user's
 * turn immediately, then run the turn. Nothing here knows about the quiet gate
 * — that is the point. It emits the same events a teammate that never stopped
 * talking would emit, and the supervisor decides what becomes a message.
 */
class ScriptedSession implements TeammateSession {
	private info: SessionInfo;
	/** Filled before each send; the beats that turn will produce. */
	script: Beat[] = [];
	/** Set to leave the session busy, standing in for a turn already in flight. */
	state: SessionState = "ready";

	constructor(
		personaId: string,
		private emit: Emitters,
	) {
		this.info = { ...idleInfo(personaId), state: "ready" };
	}

	getInfo(): SessionInfo {
		return { ...this.info, state: this.state };
	}

	async start(): Promise<SessionInfo> {
		return this.getInfo();
	}
	async stop(): Promise<void> {}

	send(text: string, attachments: Attachment[] = [], shown = text): void {
		void attachments;
		this.emit.appendEvent({ kind: "user", id: randomUUID(), ts: Date.now(), text: shown });
		this.runScript();
	}

	async prompt(text: string, attachments?: Attachment[], shown?: string): Promise<void> {
		this.send(text, attachments, shown);
	}
	steer(text: string, attachments?: Attachment[], shown?: string): void {
		this.send(text, attachments, shown);
	}
	nudge(): void {}
	async cancel(): Promise<void> {}

	async setModel(): Promise<SessionInfo> {
		return this.getInfo();
	}
	async setMode(): Promise<SessionInfo> {
		return this.getInfo();
	}
	async setConfig(): Promise<SessionInfo> {
		return this.getInfo();
	}
	answerPermission(): boolean {
		return false;
	}
	updatePersona(): void {}

	/** Runs the queued beats, streaming each message before it lands. */
	private runScript(): void {
		const beats = this.script;
		this.script = [];
		for (const beat of beats) {
			if ("say" in beat) {
				const id = randomUUID();
				this.emit.delta(id, "agent", beat.say);
				this.emit.appendEvent({ kind: "agent", id, ts: Date.now(), text: beat.say });
			} else if ("think" in beat) {
				const id = randomUUID();
				this.emit.delta(id, "thought", beat.think);
				this.emit.appendEvent({ kind: "thought", id, ts: Date.now(), text: beat.think });
			} else if ("tool" in beat) {
				this.emit.appendEvent({
					kind: "tool",
					id: `tool:${randomUUID()}`,
					ts: Date.now(),
					toolCallId: randomUUID(),
					title: beat.tool,
					status: "completed",
				});
			} else if ("fail" in beat) {
				this.emit.appendEvent({
					kind: "notice",
					id: randomUUID(),
					ts: Date.now(),
					level: "error",
					text: beat.fail,
				});
			} else {
				this.emit.appendEvent({
					kind: "turn",
					id: randomUUID(),
					ts: Date.now(),
					stopReason: "end_turn",
				});
			}
		}
	}
}

// ---------------------------------------------------------------------------
// The room, wired the way index.ts wires it
// ---------------------------------------------------------------------------

const deltas: StreamDelta[] = [];
const supervisor = new Supervisor({
	transcriptAppended: () => {},
	transcriptUpdated: () => {},
	streamDelta: (payload) => deltas.push(payload),
	sessionInfoChanged: () => {},
});

const persona = personas.createPersona({ name: "Runner", goal: "Check things on a clock" });

/**
 * The one reach past a private: the supervisor builds its emitters for a
 * session it created itself, and this harness supplies the session instead.
 * Everything the emitters do — the stamp, the gate, the tape, the broadcast —
 * is the production path, unmodified.
 */
const reach = supervisor as unknown as {
	emitters(personaId: string): Emitters;
	sessions: Map<string, TeammateSession>;
};
const session = new ScriptedSession(persona.id, reach.emitters(persona.id));
reach.sessions.set(persona.id, session);

/**
 * The clock, jumped. `fire` is the scheduler's own private path — the same one
 * a timer takes — reached directly so the harness does not have to sit out a
 * real interval per case.
 */
const fireNow = (id: string): Promise<void> =>
	(scheduler as unknown as { fire(id: string): Promise<void> }).fire(id);

let published: ScheduledJob[] = [];
const scheduler = new Scheduler({
	wake: (personaId, prompt, run) => wakeTeammate(supervisor, personaId, prompt, run),
	changed: (jobs) => {
		published = jobs;
	},
});

const tape = () => transcript.load(persona.id);
const since = (mark: number) => tape().slice(mark);
const agentText = (events: TranscriptEvent[]) =>
	events.filter((event) => event.kind === "agent").map((event) => event.text);
const thoughtText = (events: TranscriptEvent[]) =>
	events.filter((event) => event.kind === "thought").map((event) => event.text);

/** The sentence the bug report quoted. Every case below says exactly this. */
const LEAK = "No change — staying silent per protocol.";

// ---------------------------------------------------------------------------
// The job, through the real store
// ---------------------------------------------------------------------------

console.log("\x1b[36mA job that knows its own name\x1b[0m");

const quietJob = scheduler.loop(persona.id, "15s", "Check the Apple order and report a change.", {
	name: "Apple order check",
	quiet: true,
});
check("a loop stores its name and its silence", quietJob.name === "Apple order check" && quietJob.quiet === true);
check("the change is published to the UI", published.some((job) => job.id === quietJob.id));

{
	/* A second scheduler over the same store is what a restart looks like. */
	const reopened = new Scheduler({ wake: async () => {}, changed: () => {} });
	const stored = reopened.list(persona.id).find((job) => job.id === quietJob.id);
	reopened.stop();
	check("both survive a restart", stored?.name === "Apple order check" && stored?.quiet === true);
}

const plainJob = scheduler.loop(persona.id, "15s", "Sweep the inbox.\nThen tidy up.");
check("a job with no name of its own derives one", plainJob.name === undefined);
check("…and it is not quiet", plainJob.quiet === undefined);

// ---------------------------------------------------------------------------
// Inbound: one line
// ---------------------------------------------------------------------------

console.log("\n\x1b[36mOne quiet line in\x1b[0m");

const beforeFirst = tape().length;
session.script = [{ think: "Opened the order page. Still Preparing to ship." }, { say: LEAK }, { endTurn: true }];
await fireNow(quietJob.id);

const firstRun = since(beforeFirst);
const fired = firstRun.find((event) => event.kind === "user");
check("the firing wrote exactly one user event", firstRun.filter((e) => e.kind === "user").length === 1);
check(
	"it is stamped with the job that fired it",
	fired?.kind === "user" && fired.scheduled?.jobId === quietJob.id && fired.scheduled.kind === "loop",
);
check(
	"its text is still the whole prompt, so nothing is lost",
	fired?.kind === "user" && fired.text === "Check the Apple order and report a change.",
);

const line = fired ? scheduledLine(fired) : null;
check(
	"which the transcript collapses to one line",
	line?.label === "Running loop" && line.name === "Apple order check" && line.quiet === true,
	line,
);
check("with the prompt behind it", line?.prompt === "Check the Apple order and report a change.");

// ---------------------------------------------------------------------------
// Outbound: nothing at all
// ---------------------------------------------------------------------------

console.log("\n\x1b[36mNothing out when silence was the ask\x1b[0m");

check("no assistant event reached the tape", agentText(firstRun).length === 0, agentText(firstRun));
check("the sentence is in the tape as thinking instead", thoughtText(firstRun).includes(LEAK));
check("and so is the thought that came before it", thoughtText(firstRun).length === 2);
check("the turn was still recorded", firstRun.some((event) => event.kind === "turn"));
check(
	"nothing streamed as writing",
	deltas.every((delta) => delta.type === "thought_delta"),
	deltas.map((delta) => delta.type),
);

{
	/* The same sentence, from a job the user never asked to be quiet. */
	const beforeLoud = tape().length;
	session.script = [{ say: LEAK }, { endTurn: true }];
	await fireNow(plainJob.id);
	const loud = since(beforeLoud);
	check("the identical sentence is a message from a job that is not quiet", agentText(loud).includes(LEAK));
	const stamp = loud.find((event) => event.kind === "user");
	check(
		"and that firing is one line too, named from its prompt",
		stamp?.kind === "user" ? scheduledLine(stamp)?.name === "Sweep the inbox" : false,
	);
}

// ---------------------------------------------------------------------------
// What silence does not cover
// ---------------------------------------------------------------------------

console.log("\n\x1b[36mWhat stays loud\x1b[0m");

{
	const before = tape().length;
	session.script = [
		{ tool: "Read order page" },
		{ fail: "Turn failed: the model returned an error" },
		{ say: "I could not reach the page." },
		{ endTurn: true },
	];
	await fireNow(quietJob.id);
	const run = since(before);
	check("a tool call is recorded during a quiet turn", run.some((event) => event.kind === "tool"));
	check(
		"an error notice is never quieted",
		run.some((event) => event.kind === "notice" && event.level === "error"),
	);
	check("while the agent's own words still stay out of the chat", agentText(run).length === 0);
}

{
	const before = tape().length;
	session.script = [{ say: "I found something." }, { endTurn: true }];
	await fireNow(quietJob.id);
	/* Mid-run, a person types. The schedule's silence was never about them. */
	session.script = [{ say: "Here is what changed." }, { endTurn: true }];
	await supervisor.prompt(persona.id, "wait — what did you find?");
	const run = since(before);
	check("a person typing during a quiet run gets answered", agentText(run).includes("Here is what changed."));
	check("…and the quiet turn before it is still silent", !agentText(run).includes("I found something."));
}

{
	const before = tape().length;
	session.script = [{ say: "morning check" }, { endTurn: true }];
	await fireNow(quietJob.id);
	session.script = [{ say: "Good morning." }, { endTurn: true }];
	await supervisor.prompt(persona.id, "morning");
	check("the window closes with the turn, so the next reply is a message", agentText(since(before)).includes("Good morning."));
}

{
	/* The firing lands while a turn is already running: the turn in flight is
	 * the human's and must not be muted by a schedule arriving behind it. */
	const before = tape().length;
	session.state = "thinking";
	session.script = [{ say: "answering what you asked" }, { endTurn: true }, { say: LEAK }, { endTurn: true }];
	await fireNow(quietJob.id);
	session.state = "ready";
	const run = since(before);
	check("a turn already in flight is not muted", agentText(run).includes("answering what you asked"));
	check("…and the scheduled turn behind it still is", !agentText(run).includes(LEAK));
	check("…with its words kept as thinking", thoughtText(run).includes(LEAK));
}

// ---------------------------------------------------------------------------
// The user's hand on the switch
// ---------------------------------------------------------------------------

console.log("\n\x1b[36mThe way out, and the way back in\x1b[0m");

check("the switch flips off", scheduler.setQuiet(quietJob.id, false));
{
	const before = tape().length;
	session.script = [{ say: LEAK }, { endTurn: true }];
	await fireNow(quietJob.id);
	check("the same job now speaks", agentText(since(before)).includes(LEAK));
}
check("the switch flips back on", scheduler.setQuiet(quietJob.id, true));
{
	const before = tape().length;
	session.script = [{ say: LEAK }, { endTurn: true }];
	await fireNow(quietJob.id);
	check("and it is quiet again", agentText(since(before)).length === 0);
}
check("an unknown job cannot be flipped", scheduler.setQuiet("nope", true) === false);

// ---------------------------------------------------------------------------
// The clock keeps its promises
// ---------------------------------------------------------------------------

console.log("\n\x1b[36mThe clock\x1b[0m");

{
	const rearmed = scheduler.list(persona.id).find((job) => job.id === quietJob.id);
	check("a loop re-armed with its name and flag intact", rearmed?.name === "Apple order check" && rearmed.quiet === true);
	check("…and moved its next run forward", (rearmed?.nextAt ?? 0) > Date.now());
}

{
	const once = scheduler.schedule(persona.id, "30s", "Say the word.", { name: "One shot", quiet: true });
	const before = tape().length;
	session.script = [{ say: LEAK }, { endTurn: true }];
	await fireNow(once.id);
	check("a one-shot fires quiet", agentText(since(before)).length === 0);
	check("…and removes itself", scheduler.list(persona.id).every((job) => job.id !== once.id));
}

scheduler.stop();
rmSync(root, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
