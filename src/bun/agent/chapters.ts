import { randomUUID } from "node:crypto";
import { isUp } from "../../shared/session";
import type {
	ChapterEvent,
	ChapterSummary,
	Persona,
	SessionInfo,
	TranscriptEvent,
} from "../../shared/types";
import {
	fallbackTitle,
	isMessage,
	lastActivity,
	openChapter,
	previousChapter,
	sliceOf,
	summarize as summarizeChapters,
} from "../store/chapters";
import type { ChapterNote } from "./summarize";

/**
 * One working context at a time, for a relationship that goes on.
 *
 * A teammate is one long conversation, and that is right: nobody should have
 * to open a new chat to ask the next thing. But the agent's context cannot be
 * that long. A day fits a modern model comfortably; a week in one window is
 * where it starts confusing last Tuesday's task with today's. So the tape is
 * divided into chapters, and each chapter is one context.
 *
 * A chapter closes when the teammate has been idle for long enough (a
 * setting, eight hours by default), when the user asks for a fresh start, or
 * when the agent itself decides the subject has changed. Closing writes a
 * note — goal, outcome, open loops, decisions, files — onto the marker, and
 * lets go of the agent's checkpoint so the next message starts a new context.
 * That next context reads the note on wake, can reopen the previous chapter's
 * full context when the work was mid-flight, and can search every chapter
 * before that. See docs/chapters.md.
 *
 * Everything here is expressed through things Toad already had: the
 * transcript, the per-backend session checkpoint, and stop/start. Closing a
 * chapter does not reach into a session; it changes what the next start will
 * find.
 */

export type ChapterHooks = {
	persona(personaId: string): Persona | undefined;
	history(personaId: string): TranscriptEvent[];
	/** Writes a marker — appended when it opens, updated when it closes. */
	record(personaId: string, event: ChapterEvent, mode: "append" | "update"): void;
	info(personaId: string): SessionInfo;
	stop(personaId: string): Promise<void>;
	start(personaId: string): Promise<unknown>;
	/** Hands the agent text without writing it to the transcript. */
	nudge(personaId: string, text: string): void;
	checkpoint(personaId: string, backendId: string, sessionId: string): void;
	/** Drops the backend's checkpoint — only the named one, if given, so a newer session survives. */
	clearCheckpoint(personaId: string, backendId: string, onlyIf?: string): void;
	summarize(persona: Persona, events: TranscriptEvent[], signal?: AbortSignal): Promise<ChapterNote | undefined>;
	idleMs(): number;
	log(message: string): void;
};

/** While a turn is running at the idle mark, look again after this long. */
const BUSY_RECHECK_MS = 10 * 60_000;

export type ResumeResult =
	| { ok: true; title: string }
	| { ok: false; reason: "no_previous" | "other_backend" | "busy"; detail: string };

export class Chapters {
	private timers = new Map<string, ReturnType<typeof setTimeout>>();
	private closing = new Map<string, Promise<void>>();
	/** Teammates whose live session belongs to a chapter that has closed. */
	private rotate = new Set<string>();
	private swapping = new Set<string>();

	constructor(private hooks: ChapterHooks) {}

	// -- observation --------------------------------------------------------

	/**
	 * Every message keeps the chapter warm. A message with no open chapter —
	 * an agent speaking first after a restore, say — opens one after the fact,
	 * so nothing said is ever outside a chapter once chapters exist.
	 */
	observe(personaId: string, event: TranscriptEvent): void {
		if (!isMessage(event)) return;
		if (!openChapter(this.hooks.history(personaId))) this.open(personaId);
		this.arm(personaId);
	}

	/** The agent's memory of the open chapter became something worth keeping. */
	sessionCheckpointed(personaId: string, backendId: string, sessionId: string): void {
		const open = openChapter(this.hooks.history(personaId));
		if (!open || open.backendId !== backendId || open.sessionId === sessionId) return;
		this.hooks.record(personaId, { ...open, sessionId }, "update");
	}

	forget(personaId: string): void {
		const timer = this.timers.get(personaId);
		if (timer) clearTimeout(timer);
		this.timers.delete(personaId);
		this.closing.delete(personaId);
		this.rotate.delete(personaId);
	}

	list(personaId: string): ChapterSummary[] {
		return summarizeChapters(this.hooks.history(personaId));
	}

	// -- lifecycle ----------------------------------------------------------

	/**
	 * Runs before anything is sent to a teammate. This is where a closed
	 * chapter becomes a fresh context: the live session, if it belongs to a
	 * chapter that has closed, is replaced; a stale open chapter is closed
	 * first; and the message about to be sent gets a chapter to land in.
	 */
	async beforePrompt(personaId: string): Promise<void> {
		await this.closing.get(personaId);
		const events = this.hooks.history(personaId);
		const open = openChapter(events);
		if (open) {
			const at = lastActivity(sliceOf(events, open)) ?? open.ts;
			if (Date.now() - at > this.hooks.idleMs()) await this.close(personaId, "idle");
		}
		if (this.rotate.has(personaId)) {
			this.rotate.delete(personaId);
			if (isUp(this.hooks.info(personaId).state)) {
				await this.hooks.stop(personaId);
				await this.hooks.start(personaId);
			}
		}
		if (!openChapter(this.hooks.history(personaId))) this.open(personaId);
	}

	/**
	 * Closes the open chapter now and starts the next message fresh.
	 *
	 * From the user it takes effect at once, so the settings pane can say
	 * "Fresh" before anything is typed. From the agent it waits for the next
	 * message: the agent is mid-turn when it asks, and its session is the one
	 * that has to finish answering.
	 */
	async startFresh(personaId: string, by: "user" | "agent"): Promise<{ title?: string }> {
		await this.closing.get(personaId);
		const events = this.hooks.history(personaId);
		const open = openChapter(events);
		let title: string | undefined;
		if (open) {
			await this.close(personaId, by);
			title = openChapter(this.hooks.history(personaId)) ? undefined : previousChapter(this.hooks.history(personaId))?.title;
		} else {
			// A conversation from before chapters existed: nothing to close, but
			// the agent's checkpoint still holds the whole history.
			const persona = this.hooks.persona(personaId);
			if (persona) this.hooks.clearCheckpoint(personaId, persona.backendId);
			if (isUp(this.hooks.info(personaId).state)) this.rotate.add(personaId);
		}
		if (by === "user" && this.rotate.has(personaId)) {
			this.rotate.delete(personaId);
			if (isUp(this.hooks.info(personaId).state)) {
				await this.hooks.stop(personaId);
				await this.hooks.start(personaId);
			}
		}
		return { title };
	}

	/**
	 * Reopens the previous chapter's context in place of the current one.
	 *
	 * The agent calls this from a fresh chapter when the user wants to carry
	 * on with work that was mid-flight — the note says what was happening,
	 * but the old context has the file contents and the exact state, which a
	 * note cannot carry. Only the chapter immediately before is offered: a
	 * context from three weeks ago brings back nothing but sludge.
	 *
	 * Returns at once so the tool call can answer, then swaps underneath: the
	 * live session stops, the checkpoint is pointed back at the previous
	 * chapter, the restored session is started, and the messages the user sent
	 * in the meantime are handed to it as a nudge so it answers them.
	 */
	resume(personaId: string): ResumeResult {
		const persona = this.hooks.persona(personaId);
		const events = this.hooks.history(personaId);
		const open = openChapter(events);
		const previous = previousChapter(events);
		// A chapter that closed by reopening an earlier one is a turning point,
		// not a stretch of work; there is nothing in its context worth going
		// back to.
		if (!persona || !previous?.sessionId || previous.closedBy === "resume") {
			return { ok: false, reason: "no_previous", detail: "There is no previous chapter with a session to reopen." };
		}
		if (previous.backendId !== persona.backendId) {
			return {
				ok: false,
				reason: "other_backend",
				detail: "The previous chapter ran on a different agent; its context cannot be reopened here.",
			};
		}
		if (this.swapping.has(personaId)) {
			return { ok: false, reason: "busy", detail: "A chapter is already being reopened." };
		}
		this.swapping.add(personaId);
		const title = previous.title ?? "the previous chapter";
		const interim = open ? sliceOf(events, open).filter((event) => event.kind === "user") : [];

		setTimeout(() => {
			void (async () => {
				try {
					if (isUp(this.hooks.info(personaId).state)) await this.hooks.stop(personaId);
					this.hooks.checkpoint(personaId, persona.backendId, previous.sessionId!);
					const now = Date.now();
					if (open) {
						this.hooks.record(
							personaId,
							{ ...open, endedAt: now, title: `Back to: ${title}`, status: "done", closedBy: "resume" },
							"update",
						);
					}
					this.hooks.record(
						personaId,
						{
							kind: "chapter",
							id: randomUUID(),
							ts: now,
							backendId: persona.backendId,
							sessionId: previous.sessionId,
							title: previous.title,
							note: previous.note,
							status: previous.status,
							tags: previous.tags,
							resumedFrom: previous.id,
						},
						"append",
					);
					this.rotate.delete(personaId);
					await this.hooks.start(personaId);
					this.arm(personaId);
					const said = interim
						.map((event) => (event.kind === "user" ? event.text.trim() : ""))
						.filter(Boolean);
					this.hooks.nudge(
						personaId,
						"Toad has reopened this chapter's context at the user's request, so you remember the work above. " +
							(said.length > 0
								? `Since it was last active the user said:\n<toad_user_messages>\n${JSON.stringify(said)}\n</toad_user_messages>\nTreat that as the user's current message and answer it now. `
								: "Pick up where the work left off and tell the user where things stand. ") +
							"Do not mention the reopening or this note.",
					);
				} catch (error) {
					this.hooks.log(
						`Could not reopen the previous chapter for ${personaId}: ${error instanceof Error ? error.message : String(error)}`,
					);
				} finally {
					this.swapping.delete(personaId);
				}
			})();
		}, 0);
		return { ok: true, title };
	}

	/**
	 * At startup: close chapters that went stale while Toad was not running,
	 * and set the idle clock on those that did not. Nobody is waiting, so the
	 * notes are written before anyone comes back to read them.
	 */
	sweep(personaIds: string[]): void {
		for (const personaId of personaIds) {
			const events = this.hooks.history(personaId);
			const open = openChapter(events);
			if (!open) continue;
			const at = lastActivity(sliceOf(events, open)) ?? open.ts;
			const left = this.hooks.idleMs() - (Date.now() - at);
			if (left <= 0) void this.close(personaId, "idle");
			else this.arm(personaId, left);
		}
	}

	// -- internals ----------------------------------------------------------

	private open(personaId: string): void {
		const persona = this.hooks.persona(personaId);
		if (!persona) return;
		const info = this.hooks.info(personaId);
		const live = isUp(info.state) ? info.sessionId : undefined;
		const checkpoint = persona.sessionCheckpoints.find(
			(entry) => entry.backendId === persona.backendId,
		)?.sessionId;
		const sessionId = live ?? checkpoint;
		this.hooks.record(
			personaId,
			{
				kind: "chapter",
				id: randomUUID(),
				ts: Date.now(),
				backendId: persona.backendId,
				...(sessionId ? { sessionId } : {}),
			},
			"append",
		);
		this.arm(personaId);
	}

	private arm(personaId: string, ms = this.hooks.idleMs()): void {
		const existing = this.timers.get(personaId);
		if (existing) clearTimeout(existing);
		const timer = setTimeout(() => {
			this.timers.delete(personaId);
			const state = this.hooks.info(personaId).state;
			if (state === "thinking" || state === "starting") {
				this.arm(personaId, BUSY_RECHECK_MS);
				return;
			}
			void this.close(personaId, "idle");
		}, ms);
		timer.unref?.();
		this.timers.set(personaId, timer);
	}

	/** Closes the open chapter, writing its note. One close at a time per teammate. */
	private close(personaId: string, by: "idle" | "user" | "agent"): Promise<void> {
		const inFlight = this.closing.get(personaId);
		if (inFlight) return inFlight;
		const run = this.doClose(personaId, by).finally(() => {
			if (this.closing.get(personaId) === run) this.closing.delete(personaId);
		});
		this.closing.set(personaId, run);
		return run;
	}

	private async doClose(personaId: string, by: "idle" | "user" | "agent"): Promise<void> {
		const timer = this.timers.get(personaId);
		if (timer) clearTimeout(timer);
		this.timers.delete(personaId);

		const events = this.hooks.history(personaId);
		const open = openChapter(events);
		const persona = this.hooks.persona(personaId);
		if (!open || !persona) return;
		const slice = sliceOf(events, open);
		const said = slice.filter(isMessage);
		// An idle close ends the chapter when the conversation stopped, not when
		// the timer noticed — the two can be a night apart, or longer if Toad
		// was closed — so "ended 9 hours ago" on wake means what it says.
		const now = by === "idle" ? (lastActivity(slice) ?? open.ts) : Date.now();

		if (said.length === 0) {
			// Nothing happened in it. It closes without a title and the UI leaves it out.
			this.hooks.record(personaId, { ...open, endedAt: now, closedBy: by }, "update");
		} else {
			let note: ChapterNote | undefined;
			try {
				note = await this.hooks.summarize(persona, slice);
			} catch (error) {
				this.hooks.log(
					`Chapter note for ${persona.name} failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			this.hooks.record(
				personaId,
				{
					...open,
					endedAt: now,
					title: note?.title ?? fallbackTitle(slice),
					...(note ? { note: note.note, tags: note.tags } : {}),
					status: note?.status ?? "done",
					closedBy: by,
				},
				"update",
			);
		}

		// The next start must not find this chapter's session. The marker keeps
		// the id, which is what makes reopening possible later.
		this.hooks.clearCheckpoint(personaId, open.backendId, open.sessionId);
		if (isUp(this.hooks.info(personaId).state)) this.rotate.add(personaId);
	}
}
