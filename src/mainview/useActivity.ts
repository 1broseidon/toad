import { useEffect, useRef, useState } from "react";
import type { SessionInfo, TranscriptEvent } from "../shared/types";
import { on } from "./rpc";

/**
 * What a teammate is doing right now, at the grain a person would report it.
 *
 * `state` on a session only says a turn is running. That is enough to raise an
 * indicator and not enough to say what the indicator should be: reaching for a
 * tool, turning something over, and actually writing to you are three different
 * things, and only the last one is typing.
 */
export type ActivityPhase = "idle" | "thinking" | "tool" | "typing";

export type Activity = {
	phase: ActivityPhase;
	/** The tool the teammate has open, phrased for a status line. */
	label?: string;
};

/**
 * How long after the last token we still call it typing.
 *
 * Agents stream in bursts with real gaps between them. Anything shorter than
 * this makes the indicator flicker between typing and thinking mid-sentence,
 * which reads as indecision rather than as work.
 */
const TYPING_LINGER = 700;

/**
 * @param pacing whether the transcript is holding a reply back between the
 * bubbles it invented — that time is Toad's own theatre, but from the outside
 * it is the same thing as a message being written.
 */
export function useActivity(
	personaId: string | null,
	info: SessionInfo | null,
	events: TranscriptEvent[],
	pacing: boolean,
): Activity {
	const [streaming, setStreaming] = useState(false);
	// Deltas arrive per token. Re-rendering on each one to set a flag that is
	// already set would put the whole composer on the token loop.
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
			timer = setTimeout(stop, TYPING_LINGER);
		});

		return () => {
			off();
			clearTimeout(timer);
			stop();
		};
	}, [personaId]);

	const working = info?.state === "thinking";
	const tool = openTool(events);

	// Typing outranks the rest: once words are coming out, what produced them is
	// no longer the headline.
	if (streaming || pacing) return { phase: "typing" };
	if (!working) return { phase: "idle" };
	return tool ? { phase: "tool", label: tool } : { phase: "thinking" };
}

/** The tool a teammate has open right now, or nothing if the last one closed. */
function openTool(events: TranscriptEvent[]): string | undefined {
	for (let index = events.length - 1; index >= 0; index--) {
		const event = events[index]!;
		if (event.kind !== "tool") continue;
		if (event.status !== "pending" && event.status !== "in_progress") return undefined;
		// Agents title shell calls in markdown; this is a status line, not prose.
		return (event.title || event.toolKind)?.replace(/`/g, "");
	}
	return undefined;
}
