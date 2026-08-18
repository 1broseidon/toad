import type {
	Attachment,
	Persona,
	SessionInfo,
	StreamDelta,
	TranscriptEvent,
} from "../../shared/types";
import { checkpointSession, getPersona, updatePersona } from "../store/personas";
import * as transcript from "../store/transcript";
import { AcpSession } from "./session";

type Broadcast = {
	transcriptAppended(payload: { personaId: string; event: TranscriptEvent }): void;
	transcriptUpdated(payload: { personaId: string; event: TranscriptEvent }): void;
	streamDelta(payload: StreamDelta): void;
	sessionInfoChanged(payload: SessionInfo): void;
};

/**
 * Owns one AcpSession per persona.
 *
 * Every teammate is an independent child process with its own transcript, so
 * one crashing or hanging must not affect the others.
 */
export class Supervisor {
	private sessions = new Map<string, AcpSession>();
	private transcriptObserver?: (personaId: string, event: TranscriptEvent) => void;

	constructor(private broadcast: Broadcast) {}

	private idle(personaId: string): SessionInfo {
		return {
			personaId,
			state: "idle",
			contextRestored: false,
			models: [],
			modes: [],
			slashCommands: [],
			capabilities: {
				loadSession: false,
				resume: false,
				fork: false,
				mcpHttp: false,
				image: false,
			},
		};
	}

	private ensure(persona: Persona): AcpSession {
		const existing = this.sessions.get(persona.id);
		if (existing) {
			existing.updatePersona(persona);
			return existing;
		}

		const session = new AcpSession(persona, {
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
		return this.ensure(persona).start();
	}

	async stop(personaId: string): Promise<void> {
		const session = this.sessions.get(personaId);
		if (!session) return;
		await session.stop();
		this.sessions.delete(personaId);
		this.broadcast.sessionInfoChanged({ ...this.idle(personaId), state: "stopped" });
	}

	info(personaId: string): SessionInfo {
		return this.sessions.get(personaId)?.getInfo() ?? this.idle(personaId);
	}

	private require(personaId: string): AcpSession {
		const session = this.sessions.get(personaId);
		if (!session) throw new Error("That teammate is not running yet.");
		return session;
	}

	async prompt(personaId: string, text: string, attachments?: Attachment[]): Promise<void> {
		await this.require(personaId).prompt(text, attachments);
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

	async stopAll(): Promise<void> {
		await Promise.all([...this.sessions.keys()].map((id) => this.stop(id)));
	}
}
