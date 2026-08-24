import type { Persona, Preview, TranscriptEvent } from "../shared/types";

/**
 * What the phone remembers of a desktop between visits.
 *
 * Opening the app should show the team and their conversations instantly —
 * the last known truth — while the wire fetches the current one behind it.
 * Without this, every cold open is a Loading… for facts the phone already
 * saw an hour ago, and a desktop that is asleep shows nothing at all.
 *
 * Per desktop, because each linked desktop is its own world. Transcripts are
 * trimmed to their recent tail: the cache paints the screen you land on, not
 * the archive — scrolling far back re-reads from the wire as it always did.
 * Everything here is a hint, replaced wholesale by the first live answer.
 */

type Snapshot = {
	v: 1;
	personas: Persona[];
	previews: Record<string, Preview>;
	transcripts: Record<string, TranscriptEvent[]>;
};

/** Events kept per conversation: about two screens of speech. */
const TAIL = 40;

const keyOf = (desktopId: string) => `toad-cache:${desktopId}`;

export function readCache(desktopId: string): Snapshot | null {
	try {
		const raw = localStorage.getItem(keyOf(desktopId));
		if (!raw) return null;
		const parsed = JSON.parse(raw) as Snapshot;
		if (parsed?.v !== 1 || !Array.isArray(parsed.personas)) return null;
		return parsed;
	} catch {
		return null;
	}
}

export function writeCache(
	desktopId: string,
	personas: Persona[],
	previews: Record<string, Preview>,
	transcripts: Record<string, TranscriptEvent[]>,
): void {
	const trimmed: Record<string, TranscriptEvent[]> = {};
	for (const persona of personas) {
		const events = transcripts[persona.id];
		if (events?.length) trimmed[persona.id] = events.slice(-TAIL);
	}
	const snapshot: Snapshot = { v: 1, personas, previews, transcripts: trimmed };
	try {
		localStorage.setItem(keyOf(desktopId), JSON.stringify(snapshot));
	} catch {
		/* Quota or private mode: the cache is a nicety, and next launch simply
		 * loads the way it did before this file existed. */
		try {
			localStorage.removeItem(keyOf(desktopId));
		} catch {
			/* ignore */
		}
	}
}

export function dropCache(desktopId: string): void {
	try {
		localStorage.removeItem(keyOf(desktopId));
	} catch {
		/* ignore */
	}
}
