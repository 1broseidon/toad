import type {
	Attachment,
	Persona,
	SessionInfo,
	StreamDelta,
	TranscriptEvent,
} from "../../shared/types";
import { checkpointSession, getPersona, takeHopNotice, updatePersona } from "../store/personas";
import * as transcript from "../store/transcript";
import { createTeammateSession } from "../agent/create";
import { idleInfo, type TeammateSession } from "../agent/session";
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

		const session = await createTeammateSession(persona, {
			appendEvent: (event) => {
				if (event.kind === "user") {
					const mark = this.pendingReply.get(persona.id);
					this.pendingReply.delete(persona.id);
					if (mark && Date.now() < mark.until) {
						event = { ...event, replyTo: mark.eventId };
					}
				}
				transcript.append(persona.id, event);
				this.transcriptObserver?.(persona.id, event);
				this.broadcast.transcriptAppended({ personaId: persona.id, event });
			},
			updateEvent: (event) => {
				transcript.append(persona.id, event);
				this.broadcast.transcriptUpdated({ personaId: persona.id, event });
			},
			delta: (messageId, kind, text) => {
				this.broadcast.streamDelta({
					personaId: persona.id,
					type: kind === "agent" ? "agent_delta" : "thought_delta",
					messageId,
					text,
				});
			},
			infoChanged: (info) => this.broadcast.sessionInfoChanged(info),
			history: () => transcript.load(persona.id),
			sessionCheckpointed: (backendId, sessionId) => {
				checkpointSession(persona.id, backendId, sessionId);
				this.checkpointObserver?.(persona.id, backendId, sessionId);
			},
		});

		this.sessions.set(persona.id, session);
		return session;
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
		updatePersona(personaId, { modeId });
		return info;
	}

	async setConfig(personaId: string, configId: string, value: string): Promise<SessionInfo> {
		return this.require(personaId).setConfig(configId, value);
	}

	async stopAll(): Promise<void> {
		await Promise.all([...this.sessions.keys()].map((id) => this.stop(id)));
	}
}
