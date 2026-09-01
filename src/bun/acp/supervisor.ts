import type {
	Attachment,
	Persona,
	ScheduledRun,
	SessionInfo,
	StreamDelta,
	TranscriptEvent,
} from "../../shared/types";
import { checkpointSession, getPersona, takeHopNotice, updatePersona } from "../store/personas";
import * as transcript from "../store/transcript";
import { createTeammateSession } from "../agent/create";
import {
	openQuietWindow,
	quietMutesDeltas,
	stepQuietWindow,
	type QuietWindow,
} from "../agent/quiet";
import { idleInfo, type Emitters, type TeammateSession } from "../agent/session";
import { scheduledWireText } from "../../shared/scheduled";
import { isBusy } from "../../shared/session";

type Broadcast = {
	transcriptAppended(payload: { personaId: string; event: TranscriptEvent }): void;
	transcriptUpdated(payload: { personaId: string; event: TranscriptEvent }): void;
	streamDelta(payload: StreamDelta): void;
	sessionInfoChanged(payload: SessionInfo): void;
};

/**
 * Owns one session per persona.
 *
 * Every teammate is an independent conversation with its own transcript, so
 * one crashing or hanging must not affect the others.
 */
export class Supervisor {
	private sessions = new Map<string, TeammateSession>();
	/**
	 * The message the next user event answers, per persona. Stamped at the
	 * funnel below rather than threaded through every session kind: the
	 * prompt call and its user event are one motion, so a short-lived mark
	 * is the whole bookkeeping. The TTL keeps a mark from a prompt that
	 * never landed off some later, unrelated message.
	 */
	private pendingReply = new Map<string, { eventId: string; until: number }>();
	/**
	 * Reactions the agent has not seen yet, keyed so an un-tap before the
	 * next message simply withdraws the note. Delivered as a bracketed line
	 * ahead of the next prompt's wire text — never a turn of their own, and
	 * never a line of the transcript. What a mark means is the model's to
	 * judge; the note states only what happened.
	 */
	private pendingNotes = new Map<string, Map<string, string>>();
	/**
	 * The firing the next user event belongs to, per persona. Same short-lived
	 * mark as `pendingReply` and for the same reason: the prompt call and its
	 * user event are one motion, and the event id is minted inside the session.
	 */
	private pendingScheduled = new Map<string, { run: ScheduledRun; until: number }>();
	/**
	 * Teammates whose voice a quiet schedule is currently holding. This is the
	 * whole outbound-silence mechanism; see src/bun/agent/quiet.ts for why it
	 * lives here rather than in either session kind.
	 */
	private quiet = new Map<string, QuietWindow>();

	noteReaction(personaId: string, key: string, line: string): void {
		const notes = this.pendingNotes.get(personaId) ?? new Map<string, string>();
		notes.set(key, line);
		this.pendingNotes.set(personaId, notes);
	}

	retractReaction(personaId: string, key: string): void {
		this.pendingNotes.get(personaId)?.delete(key);
	}

	/** The next message's wire text, with anything whispered since the last. */
	private withNotes(personaId: string, text: string): { wire: string; shown?: string } {
		/* A hop parked a moved-desks notice on the persona; it rides ahead of the
		 * first words the teammate hears here, whichever agent kind is listening,
		 * so it never silently assumes the old machine's filesystem state. */
		const moved = takeHopNotice(personaId);
		const notes = this.pendingNotes.get(personaId);
		const lines = notes && notes.size > 0 ? [...notes.values()] : [];
		notes?.clear();
		let wire = text;
		if (lines.length > 0) wire = `[${lines.join("; ")}.]\n\n${wire}`;
		if (moved) wire = `${moved}\n\n${wire}`;
		return moved || lines.length > 0 ? { wire, shown: text } : { wire };
	}
	private transcriptObserver?: (personaId: string, event: TranscriptEvent) => void;
	private checkpointObserver?: (personaId: string, backendId: string, sessionId: string) => void;
	private promptGate?: (personaId: string) => Promise<void>;

	constructor(private broadcast: Broadcast) {}

	private async ensure(persona: Persona): Promise<TeammateSession> {
		const existing = this.sessions.get(persona.id);
		if (existing) {
			existing.updatePersona(persona);
			return existing;
		}

		const session = await createTeammateSession(persona, this.emitters(persona.id));
		this.sessions.set(persona.id, session);
		return session;
	}

	/**
	 * Where a session's output becomes the room's: the tape, the webview, and
	 * whoever is observing. Named rather than inlined into `ensure` because it
	 * is the whole of what a supervisor does — the funnel every event of both
	 * agent kinds passes through, and so the only honest place for a rule that
	 * has to hold for both (see `throughQuiet`).
	 */
	private emitters(personaId: string): Emitters {
		return {
			appendEvent: (event) => {
				if (event.kind === "user") {
					const mark = this.pendingReply.get(personaId);
					this.pendingReply.delete(personaId);
					if (mark && Date.now() < mark.until) {
						event = { ...event, replyTo: mark.eventId };
					}
				}
				/* Order matters: a new speaker closes any open window first, and
				 * only then may a scheduled event open one of its own. */
				event = this.throughQuiet(personaId, event);
				event = this.stampScheduled(personaId, event);
				transcript.append(personaId, event);
				this.transcriptObserver?.(personaId, event);
				this.broadcast.transcriptAppended({ personaId, event });
			},
			updateEvent: (event) => {
				transcript.append(personaId, event);
				this.broadcast.transcriptUpdated({ personaId, event });
			},
			delta: (messageId, kind, text) => {
				/* A muted turn must not run the writing indicator for a message
				 * that will never land: the delta is demoted with the event. */
				const muted = kind === "agent" && quietMutesDeltas(this.quiet.get(personaId), Date.now());
				this.broadcast.streamDelta({
					personaId,
					type: kind === "agent" && !muted ? "agent_delta" : "thought_delta",
					messageId,
					text,
				});
			},
			infoChanged: (info) => this.broadcast.sessionInfoChanged(info),
			history: () => transcript.load(personaId),
			sessionCheckpointed: (backendId, sessionId) => {
				checkpointSession(personaId, backendId, sessionId);
				this.checkpointObserver?.(personaId, backendId, sessionId);
			},
		};
	}

	/** Runs an event past an open quiet window, which may rewrite or close it. */
	private throughQuiet(personaId: string, event: TranscriptEvent): TranscriptEvent {
		const window = this.quiet.get(personaId);
		if (!window) return event;
		const step = stepQuietWindow(window, event, Date.now());
		if (step.window) this.quiet.set(personaId, step.window);
		else this.quiet.delete(personaId);
		return step.event;
	}

	/** Claims a pending firing for the user event it woke, opening its silence. */
	private stampScheduled(personaId: string, event: TranscriptEvent): TranscriptEvent {
		if (event.kind !== "user") return event;
		const mark = this.pendingScheduled.get(personaId);
		this.pendingScheduled.delete(personaId);
		if (!mark || Date.now() >= mark.until) return event;
		const window = openQuietWindow(mark.run, {
			busy: isBusy(this.info(personaId).state),
			now: Date.now(),
		});
		if (window) this.quiet.set(personaId, window);
		return { ...event, scheduled: mark.run };
	}

	setTranscriptObserver(observer: (personaId: string, event: TranscriptEvent) => void): void {
		this.transcriptObserver = observer;
	}

	/** Told when a backend's session becomes something a later start can reopen. */
	setCheckpointObserver(
		observer: (personaId: string, backendId: string, sessionId: string) => void,
	): void {
		this.checkpointObserver = observer;
	}

	/**
	 * Runs before anything the user or a schedule sends. Chapters use it to
	 * swap a session whose chapter has closed for a fresh one, which is why
	 * the session is looked up after it rather than before.
	 */
	setPromptGate(gate: (personaId: string) => Promise<void>): void {
		this.promptGate = gate;
	}

	async start(personaId: string): Promise<SessionInfo> {
		const persona = getPersona(personaId);
		if (!persona) throw new Error(`No persona ${personaId}`);
		return (await this.ensure(persona)).start();
	}

	async stop(personaId: string): Promise<void> {
		/* A stopped session has no turn left to be quiet about; a window that
		 * outlived it would mute the first thing said after the restart. */
		this.quiet.delete(personaId);
		this.pendingScheduled.delete(personaId);
		const session = this.sessions.get(personaId);
		if (!session) return;
		await session.stop();
		this.sessions.delete(personaId);
		this.broadcast.sessionInfoChanged({ ...idleInfo(personaId), state: "stopped" });
	}

	info(personaId: string): SessionInfo {
		return this.sessions.get(personaId)?.getInfo() ?? idleInfo(personaId);
	}

	/** Teammates whose turn is still running — a restart would cut them off. */
	workingNames(): string[] {
		const names: string[] = [];
		for (const [id, session] of this.sessions) {
			if (!isBusy(session.getInfo().state)) continue;
			names.push(getPersona(id)?.name ?? id);
		}
		return names;
	}

	private require(personaId: string): TeammateSession {
		const session = this.sessions.get(personaId);
		if (!session) throw new Error("That teammate is not running yet.");
		return session;
	}

	async prompt(
		personaId: string,
		text: string,
		attachments?: Attachment[],
		replyTo?: string,
	): Promise<void> {
		if (replyTo) this.pendingReply.set(personaId, { eventId: replyTo, until: Date.now() + 15_000 });
		await this.promptGate?.(personaId);
		const session = this.require(personaId);
		const { wire, shown } = this.withNotes(personaId, text);
		session.send(wire, attachments, shown);
	}

	/**
	 * A schedule firing, down the same funnel as everything else — with two
	 * differences the tape can see.
	 *
	 * The agent still hears the framed prompt it always heard; the transcript
	 * keeps the bare prompt and the stamp that says which job spoke, so the
	 * conversation can draw one line instead of a wall. And if the job is
	 * quiet, this is where the window over its turn opens.
	 */
	async promptScheduled(personaId: string, prompt: string, run: ScheduledRun): Promise<void> {
		await this.promptGate?.(personaId);
		const session = this.require(personaId);
		const { wire } = this.withNotes(personaId, scheduledWireText(run, prompt));
		this.pendingScheduled.set(personaId, { run, until: Date.now() + 15_000 });
		session.send(wire, [], prompt);
	}

	async steer(
		personaId: string,
		text: string,
		attachments?: Attachment[],
		replyTo?: string,
	): Promise<void> {
		if (replyTo) this.pendingReply.set(personaId, { eventId: replyTo, until: Date.now() + 15_000 });
		await this.promptGate?.(personaId);
		const session = this.require(personaId);
		const { wire, shown } = this.withNotes(personaId, text);
		session.steer(wire, attachments, shown);
	}

	/** Toad's own words to a running teammate; never a line of the conversation. */
	nudge(personaId: string, text: string): void {
		this.require(personaId).nudge(text);
	}

	async cancel(personaId: string): Promise<void> {
		await this.require(personaId).cancel();
	}

	answerPermission(personaId: string, requestId: string, optionId: string): boolean {
		return this.sessions.get(personaId)?.answerPermission(requestId, optionId) ?? false;
	}

	async setModel(personaId: string, modelId: string): Promise<SessionInfo> {
		const info = await this.require(personaId).setModel(modelId);
		updatePersona(personaId, { modelId });
		return info;
	}

	async setMode(personaId: string, modeId: string): Promise<SessionInfo> {
		const info = await this.require(personaId).setMode(modeId);
		// What took effect, not what was asked for. pi clamps a level to what the
		// model accepts and an ACP backend answers with its own current mode, so
		// storing the session's word is the only way the roster and the header
		// agree after a restart.
		updatePersona(personaId, { modeId: info.currentModeId ?? modeId });
		return info;
	}

	async setConfig(personaId: string, configId: string, value: string): Promise<SessionInfo> {
		return this.require(personaId).setConfig(configId, value);
	}

	async stopAll(): Promise<void> {
		await Promise.all([...this.sessions.keys()].map((id) => this.stop(id)));
	}
}
