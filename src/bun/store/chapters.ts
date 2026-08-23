import type { ChapterEvent, ChapterSummary, TranscriptEvent } from "../../shared/types";

/**
 * Reading chapters out of a transcript.
 *
 * A chapter is not a second file. It is a marker event in the tape it divides,
 * superseded by id when it closes, so the transcript stays the one record and
 * everything here is a view of it. A transcript written before chapters
 * existed has no markers and reads as one implicit chapter.
 */

export function chaptersOf(events: TranscriptEvent[]): ChapterEvent[] {
	return events.filter((event): event is ChapterEvent => event.kind === "chapter");
}

/** The chapter that has not closed, if any. There is at most one. */
export function openChapter(events: TranscriptEvent[]): ChapterEvent | undefined {
	const chapters = chaptersOf(events);
	const last = chapters[chapters.length - 1];
	return last && last.endedAt === undefined ? last : undefined;
}

/**
 * The closed chapter a fresh context should hear about: the most recent one
 * that ended, provided it is the chapter immediately before the open one (or
 * the last chapter of all, when none is open).
 */
export function previousChapter(events: TranscriptEvent[]): ChapterEvent | undefined {
	const chapters = chaptersOf(events);
	const open = openChapter(events);
	const closed = open ? chapters.slice(0, -1) : chapters;
	const last = closed[closed.length - 1];
	return last && last.endedAt !== undefined ? last : undefined;
}

/** Everything said or done within a chapter, the marker itself excluded. */
export function sliceOf(events: TranscriptEvent[], chapter: ChapterEvent): TranscriptEvent[] {
	const start = events.findIndex((event) => event.id === chapter.id);
	if (start === -1) return [];
	const rest = events.slice(start + 1);
	const end = rest.findIndex((event) => event.kind === "chapter");
	return end === -1 ? rest : rest.slice(0, end);
}

/** The moment of the last thing said, for deciding whether a chapter is stale. */
export function lastActivity(events: TranscriptEvent[]): number | undefined {
	for (let index = events.length - 1; index >= 0; index--) {
		const event = events[index]!;
		if (event.kind === "user" || event.kind === "agent") return event.ts;
	}
	return undefined;
}

export function isMessage(event: TranscriptEvent): boolean {
	return event.kind === "user" || event.kind === "agent";
}

/** Chapters newest first, each with how many messages it holds. */
export function summarize(events: TranscriptEvent[]): ChapterSummary[] {
	return chaptersOf(events)
		.map((chapter) => ({
			id: chapter.id,
			startedAt: chapter.ts,
			endedAt: chapter.endedAt,
			title: chapter.title,
			note: chapter.note,
			status: chapter.status,
			messages: sliceOf(events, chapter).filter(isMessage).length,
		}))
		.reverse();
}

/**
 * A title when the summariser could not give one: the first thing the user
 * asked, cut to a line. Better than "Untitled", which says nothing about
 * which chapter this was.
 */
export function fallbackTitle(slice: TranscriptEvent[]): string {
	const first = slice.find((event) => event.kind === "user" && event.text.trim().length > 0);
	if (!first || first.kind !== "user") return "Conversation";
	const line = first.text.trim().split("\n")[0]!.replace(/\s+/g, " ");
	return line.length > 60 ? `${line.slice(0, 57)}…` : line;
}
