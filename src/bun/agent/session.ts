import type { Attachment, Persona, SessionInfo, TranscriptEvent } from "../../shared/types";
import type { BridgeScope } from "../mcp/protocol";

/**
 * How a session hands its conversation back to the rest of Toad.
 *
 * Everything a backend produces arrives here already translated into Toad's
 * own vocabulary — transcript events, streaming deltas, session info — so
 * nothing downstream of this type knows or cares which harness is running.
 * That is what makes a second implementation possible at all: `Supervisor`
 * wires these to the persona's transcript and the webview, `PeerSessions`
 * wires the same six functions to a peer thread instead, and neither one
 * mentions a protocol.
 */
export type Emitters = {
	appendEvent(event: TranscriptEvent): void;
	updateEvent(event: TranscriptEvent): void;
	delta(messageId: string, kind: "agent" | "thought", text: string): void;
	infoChanged(info: SessionInfo): void;
	history(): TranscriptEvent[];
	sessionCheckpointed(backendId: string, sessionId: string): void;
};

/**
 * What Toad tells an agent about the room it is speaking in, before anything
 * else is said. A text block rather than a bare string because that is the
 * shape both destinations want: ACP carries it as a content block ahead of the
 * first message, having no system-prompt parameter of its own.
 */
export type Briefing = { type: "text"; text: string };

export type SessionOptions = {
	briefing?: () => Briefing;
	scope?: BridgeScope;
};

/**
 * One live conversation with one agent, on behalf of one persona.
 *
 * The distinction between `prompt`, `send` and `steer` is turn-taking policy,
 * not transport: `prompt` runs a turn and resolves when it ends, which is what
 * a peer exchange needs; `send` and `steer` are the human composer's, and
 * return immediately because the transcript is written before the agent has
 * looked at anything.
 */
export interface TeammateSession {
	getInfo(): SessionInfo;

	start(): Promise<SessionInfo>;
	stop(): Promise<void>;

	/** Runs one turn immediately and resolves once it ends. */
	prompt(text: string, attachments?: Attachment[], shown?: string): Promise<void>;
	/** Queues a message; batched into the next turn if one is running. */
	send(text: string, attachments?: Attachment[]): void;
	/** Redirects the live turn, ahead of anything already queued. */
	steer(text: string, attachments?: Attachment[]): void;
	cancel(): Promise<void>;

	setModel(modelId: string): Promise<SessionInfo>;
	setMode(modeId: string): Promise<SessionInfo>;
	setConfig(configId: string, value: string): Promise<SessionInfo>;

	answerPermission(requestId: string, optionId: string): void;

	updatePersona(persona: Persona): void;
}

/**
 * A session that is not running.
 *
 * Both a fresh session and a supervisor with nothing to report need this exact
 * shape, and a capability accidentally defaulting to `true` in one of the two
 * would light up UI for something the agent never claimed.
 */
export function idleInfo(personaId: string): SessionInfo {
	return {
		personaId,
		state: "idle",
		contextRestored: false,
		models: [],
		modes: [],
		configs: [],
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
