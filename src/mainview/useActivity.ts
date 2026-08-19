import { useEffect, useMemo, useRef, useState } from "react";
import { isWorking } from "../shared/session";
import type { SessionInfo, TranscriptEvent } from "../shared/types";
import { on } from "./rpc";

/**
 * What a teammate is doing right now, at the grain the mark can show it.
 *
 * `state` on a session only says a turn is running. That is enough to raise an
 * indicator and not enough to drive one: reaching for a file, hunting for a
 * string, running a command, and writing to you are different kinds of work,
 * and the protocol already labels them. Everything here is read off events that
 * actually happened — nothing is inferred from elapsed time or invented to fill
 * a gap, because a mark that moves for reasons you cannot name is decoration.
 */
export type ActivityPhase =
	| "idle"
	| "thinking"
	| "read"
	| "search"
	| "edit"
	| "execute"
	| "doing"
	| "blocked"
	| "failed"
	| "writing";

export type Activity = {
	phase: ActivityPhase;
	/** The single word a hover reveals. Never a path or a command. */
	word: string;
};

/**
 * ACP's tool kinds, collapsed to what the mark can actually distinguish.
 *
 * Seven kinds would be seven animations nobody learns. Four physical
 * categories — looking at, looking for, working on, running — are legible at
 * 30px without being taught, because they are what those verbs look like.
 */
const KINDS: Record<string, ActivityPhase> = {
	read: "read",
	search: "search",
	fetch: "search",
	edit: "edit",
	move: "edit",
	delete: "edit",
	execute: "execute",
	think: "thinking",
};

const WORDS: Record<ActivityPhase, string> = {
	idle: "",
	thinking: "thinking",
	read: "reading",
	search: "searching",
	edit: "editing",
	execute: "running",
	doing: "working",
	blocked: "waiting on you",
	failed: "failed",
	writing: "writing",
};

/**
 * How long after the last token we still call it writing.
 *
 * Agents stream in bursts with real gaps. Anything shorter makes the mark flip
 * between writing and thinking mid-sentence, which reads as indecision.
 */
const WRITING_LINGER = 700;

/** How long a failure shows. One flinch — an error that repeats gets tuned out. */
const FLINCH = 700;

export function useActivity(
	personaId: string | null,
	info: SessionInfo | null,
	events: TranscriptEvent[],
	pacing: boolean,
): Activity {
	const [streaming, setStreaming] = useState(false);
	// Deltas arrive per token; re-rendering to set a flag that is already set
	// would put the whole composer on the token loop.
	const live = useRef(false);

	useEffect(() => {
		if (!personaId) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const stop = () => {
			live.current = false;
			setStreaming(false);
		};
		const off = on("streamDelta", (delta) => {
			if (delta.personaId !== personaId || delta.type !== "agent_delta") return;
			if (!live.current) {
				live.current = true;
				setStreaming(true);
			}
			clearTimeout(timer);
			timer = setTimeout(stop, WRITING_LINGER);
		});
		return () => {
			off();
			clearTimeout(timer);
			stop();
		};
	}, [personaId]);

	const latest = useMemo(() => scan(events), [events]);

	// A failure is a moment, not a state, so it has to expire on its own rather
	// than wait for the next event to push it off screen.
	const [, tick] = useState(0);
	useEffect(() => {
		if (latest.failedAt === undefined) return;
		const left = FLINCH - (Date.now() - latest.failedAt);
		if (left <= 0) return;
		const timer = setTimeout(() => tick((n) => n + 1), left);
		return () => clearTimeout(timer);
	}, [latest.failedAt]);

	const working = info ? isWorking(info.state) : false;

	// Blocked outranks everything: it is the one state where nothing is
	// happening and nothing will until you answer.
	if (latest.blocked) return phase("blocked");
	if (!working && !streaming && !pacing) return phase("idle");
	if (latest.failedAt !== undefined && Date.now() - latest.failedAt < FLINCH) {
		return phase("failed");
	}
	// Writing outranks the tool that produced it: once words are coming out,
	// what produced them is no longer the headline.
	if (streaming || pacing) return phase("writing");
	// `running` rather than a truthy kind: plenty of agents send a tool call with
	// no kind at all, and an empty string is falsy — testing the kind would drop
	// every one of those back to "thinking" and claim nothing was happening.
	if (latest.running) return phase(KINDS[latest.kind ?? ""] ?? "doing");
	return phase("thinking");
}

const phase = (phase: ActivityPhase): Activity => ({ phase, word: WORDS[phase] });

/**
 * The last thing in the transcript that says what is happening.
 *
 * Walked backwards and stopped early, because the answer is always near the
 * end and this runs on every event of a live turn.
 */
function scan(events: TranscriptEvent[]): {
	blocked: boolean;
	running?: boolean;
	kind?: string;
	failedAt?: number;
} {
	let failedAt: number | undefined;
	for (let index = events.length - 1; index >= 0; index--) {
		const event = events[index]!;

		if (event.kind === "permission" && event.decision === undefined) {
			return { blocked: true };
		}
		if (event.kind !== "tool") continue;

		if (event.status === "pending" || event.status === "in_progress") {
			return { blocked: false, running: true, kind: event.toolKind, failedAt };
		}
		// The newest finished call is only interesting if it just failed.
		if (event.status === "failed" && failedAt === undefined) failedAt = event.ts;
		// Nothing older than the newest completed call can still be running.
		if (event.status === "completed") break;
	}
	return { blocked: false, failedAt };
}
