/**
 * Seeds a throwaway data directory with a roster worth photographing: three
 * teammates on Toad Agent and one finished conversation between the user and
 * the first of them.
 *
 * The screenshots in the README come from here rather than from a live model,
 * because a capture that needs a key is a capture nobody can reproduce. What
 * the app renders is the transcript on disk; it does not care who wrote it.
 *
 * The thinking, the tool calls and the plan are in the tape but not in the
 * picture: the thread is kept at conversation altitude, and those events feed
 * the activity indicator instead of drawing rows. They are written anyway,
 * because a transcript without them is not the shape the app actually reads.
 *
 * Everything is invented. No real repository, path or person appears.
 *
 * Run: TOAD_DATA_DIR=/tmp/toad-shots bun hack/seed-capture.ts
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
	console.log("Already seeded:", listPersonas().map((p) => p.name).join(", "));
	process.exit(0);
}

const TEAM = "toad";

/* The rail reads top to bottom, and the first one is what Ctrl+1 selects, so
 * the one with the conversation goes first. */
const wren = createPersona({
	name: "Wren",
	goal: "Keep the docs honest: every claim in the README matches the code.",
	team: TEAM,
	backendId: "pi",
});
createPersona({
	name: "Pace",
	goal: "Watch the startup path and say something when a launch gets slower.",
	team: TEAM,
	backendId: "pi",
});
createPersona({
	name: "Juno",
	goal: "Triage incoming reports and reproduce them before anyone argues.",
	team: TEAM,
	backendId: "pi",
});

const MINUTE = 60_000;
let at = Date.now() - 42 * MINUTE;
const tick = (minutes: number) => (at += minutes * MINUTE);
const event = (e: Omit<TranscriptEvent, "id" | "ts"> & { minutes?: number }) => {
	tick(e.minutes ?? 1);
	const { minutes: _drop, ...rest } = e;
	return { id: randomUUID(), ts: at, ...rest } as TranscriptEvent;
};

const events: TranscriptEvent[] = [
	{ kind: "chapter", id: randomUUID(), ts: at, backendId: "pi", title: "README drift" },

	event({
		kind: "user",
		text: "The README says the registry lists 38 agents. Is that still true?",
	}),
	event({
		kind: "thought",
		text: "The number is quoted in two places — the intro and the Agents section. Whatever the registry says now, both have to agree with it, and with the cache TTL the code actually uses.",
	}),
	event({
		kind: "tool",
		toolCallId: "call_1",
		title: "Read src/bun/acp/registry.ts",
		toolKind: "read",
		status: "completed",
		locations: ["src/bun/acp/registry.ts"],
		output: [
			{
				type: "text",
				text: "The list is fetched, not vendored, and cached for a day. Nothing in the file pins a count.",
			},
		],
	}),
	event({
		kind: "plan",
		entries: [
			{ content: "Count what the registry answers today", status: "completed" },
			{ content: "Fix both places the number appears", status: "in_progress" },
			{ content: "Say where the number came from, so the next drift is obvious", status: "pending" },
		],
	}),
	event({
		kind: "tool",
		toolCallId: "call_2",
		title: "Edit README.md",
		toolKind: "edit",
		status: "completed",
		locations: ["README.md"],
		output: [
			{
				type: "diff",
				path: "README.md",
				oldText: "[ACP registry](https://github.com/agentclientprotocol/registry) (38 agents at\ntime of writing), cached for a day",
				newText: "[ACP registry](https://github.com/agentclientprotocol/registry) (41 agents at\ntime of writing), cached for a day",
			},
		],
	}),
	event({
		kind: "agent",
		text: "It is not — the registry answers **41** today, and the README said 38 in two places. Both now say 41.\n\nThe count is the kind of thing that rots quietly, so I left the phrase *at time of writing* where it was rather than dressing it up as live. If you would rather the number never drift again, the honest fix is to stop quoting one: say the list comes from the registry and let the app show the count.",
	}),
	event({ kind: "user", text: "Leave it. I like knowing roughly how many there are." }),
	event({
		kind: "agent",
		text: "Then it stays. I noted the two line numbers in the chapter so the next pass checks them first.",
	}),
	event({
		kind: "turn",
		stopReason: "end_turn",
		usage: { inputTokens: 18_442, outputTokens: 1_207, totalTokens: 19_649 },
	}),
];

for (const e of events) transcript.append(wren.id, e);

console.log(
	`Seeded ${listPersonas().length} teammates and ${events.length} transcript events into ${process.env.TOAD_DATA_DIR}`,
);
