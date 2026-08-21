import { randomUUID } from "node:crypto";
import type { TranscriptEvent } from "../../shared/types";
import type { ComputerEndpoint } from "./manager";

/**
 * Capture frames in the transcript, not only the drawer.
 *
 * The chat is where the work actually happens; a teammate driving its
 * computer without frames in the conversation is narrating with its hands
 * behind its back. So when the proxy sees a `capture` tool call go by, a
 * thumbnail of what the agent just looked at lands in the transcript —
 * downscaled JPEG (~40KB as a data URL), self-contained, replays with the
 * conversation.
 */

type Emit = { append(personaId: string, event: TranscriptEvent): void };

let emit: Emit | null = null;

export function configureFrames(emitters: Emit): void {
	emit = emitters;
}

/** A batch with capture_after=each could fire every step; one frame per
 * beat of conversation is the point, not a flipbook. */
const FRAME_MIN_INTERVAL_MS = 3_000;
const lastFrame = new Map<string, number>();

const THUMB_WIDTH = 640;

/**
 * Called by the proxy after a capture tool call has been answered. Best
 * effort by design: a missed thumbnail costs a picture, never the tool call.
 */
export function captureObserved(personaId: string, endpoint: ComputerEndpoint): void {
	if (!emit) return;
	const now = Date.now();
	if (now - (lastFrame.get(personaId) ?? 0) < FRAME_MIN_INTERVAL_MS) return;
	lastFrame.set(personaId, now);

	void (async () => {
		try {
			const res = await fetch(`${endpoint.baseUrl}/screenshot?w=${THUMB_WIDTH}&format=jpeg`, {
				headers: { Authorization: `Bearer ${endpoint.token}` },
				signal: AbortSignal.timeout(10_000),
			});
			if (!res.ok) return;
			const bytes = Buffer.from(await res.arrayBuffer());
			emit?.append(personaId, {
				kind: "computer_frame",
				id: `frame:${randomUUID()}`,
				ts: Date.now(),
				dataUrl: `data:image/jpeg;base64,${bytes.toString("base64")}`,
			});
		} catch {
			// The next capture brings the next chance.
		}
	})();
}
