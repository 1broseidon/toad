import type { TranscriptEvent } from "../../shared/types";

/**
 * A process restart destroys every ACP permission resolver. Supersede any
 * durable cards that still claim to be live before the transcript is served.
 */
export function expireOrphanedPermissions(
	events: TranscriptEvent[],
	ts = Date.now(),
): Extract<TranscriptEvent, { kind: "permission" }>[] {
	return events.flatMap((event) =>
		event.kind === "permission" && event.decision === undefined
			? [{ ...event, ts, decision: "expired" }]
			: [],
	);
}
