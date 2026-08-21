import type { ComputerEndpoint } from "./manager";

/**
 * Recent captures live in the computer drawer, not the chat.
 *
 * The conversation is where the teammate talks; the drawer is the window
 * onto its hands. When the proxy sees a `capture` tool call go by — the
 * teammate's or a subagent's, it cannot tell and does not care — a
 * thumbnail of what was just looked at joins a small ring of recent frames
 * the drawer shows as a filmstrip. Operators audit there; the chat stays
 * at conversation altitude.
 *
 * The ring is in-memory and shallow by design: ten frames, rolling. It is
 * a glance at what just happened, not an archive — nothing sensitive
 * outlives the app on disk.
 */

export type ComputerFrame = { ts: number; dataUrl: string };

/** A batch with capture_after=each could fire every step; one frame per
 * beat of work is the point, not a flipbook. */
const FRAME_MIN_INTERVAL_MS = 3_000;
const lastFrame = new Map<string, number>();

const MAX_FRAMES = 10;
const THUMB_WIDTH = 640;

const rings = new Map<string, ComputerFrame[]>();

/** Newest first, at most `MAX_FRAMES`, for the drawer's filmstrip. */
export function recentFrames(personaId: string): ComputerFrame[] {
	return rings.get(personaId) ?? [];
}

/**
 * Called by the proxy after a capture tool call has been answered. Best
 * effort by design: a missed thumbnail costs a picture, never the tool call.
 */
export function captureObserved(personaId: string, endpoint: ComputerEndpoint): void {
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
			const ring = rings.get(personaId) ?? [];
			ring.unshift({ ts: Date.now(), dataUrl: `data:image/jpeg;base64,${bytes.toString("base64")}` });
			rings.set(personaId, ring.slice(0, MAX_FRAMES));
		} catch {
			// The next capture brings the next chance.
		}
	})();
}
