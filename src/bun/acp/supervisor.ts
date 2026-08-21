import type {
	Attachment,
	Persona,
	SessionInfo,
	StreamDelta,
	TranscriptEvent,
} from "../../shared/types";
import { checkpointSession, getPersona, updatePersona } from "../store/personas";
import * as transcript from "../store/transcript";
import { createTeammateSession } from "../agent/create";
import { idleInfo, type TeammateSession } from "../agent/session";

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
	private transcriptObserver?: (personaId: string, event: TranscriptEvent) => void;

	constructor(private broadcast: Broadcast) {}

	private async ensure(persona: Persona): Promise<TeammateSession> {
		const existing = this.sessions.get(persona.id);
		if (existing) {
			existing.updatePersona(persona);
			return existing;
		}

		const session = await createTeammateSession(persona, {
			appendEvent: (event) => {
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
			},
		});

		this.sessions.set(persona.id, session);
		return session;
	}

	setTranscriptObserver(observer: (personaId: string, event: TranscriptEvent) => void): void {
		this.transcriptObserver = observer;
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

	private require(personaId: string): TeammateSession {
		const session = this.sessions.get(personaId);
		if (!session) throw new Error("That teammate is not running yet.");
		return session;
	}

	async prompt(personaId: string, text: string, attachments?: Attachment[]): Promise<void> {
		this.require(personaId).send(text, attachments);
	}

	async steer(personaId: string, text: string, attachments?: Attachment[]): Promise<void> {
		this.require(personaId).steer(text, attachments);
	}

	async cancel(personaId: string): Promise<void> {
		await this.require(personaId).cancel();
	}

	answerPermission(personaId: string, requestId: string, optionId: string): void {
		this.require(personaId).answerPermission(requestId, optionId);
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
