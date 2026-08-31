import type { Attachment, Persona, SessionInfo, TranscriptEvent } from "../../shared/types";
import type { TeammateScope } from "../mcp/protocol";

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
	/**
	 * A session always speaks for a teammate, never for a plugin. The narrower
	 * type is the statement: a plugin's bridge connection is per desk and holds
	 * no persona, so it can never become the scope a session runs under.
	 */
	scope?: TeammateScope;
	/** Test seam for ACP's human permission deadline. */
	permissionTimeoutMs?: number;
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
	send(text: string, attachments?: Attachment[], shown?: string): void;
	/** Redirects the live turn, ahead of anything already queued. */
	steer(text: string, attachments?: Attachment[], shown?: string): void;
	/**
	 * Hands the agent text that is Toad's, not the user's: queued like `send`,
	 * but never written to the transcript. A reopened chapter is told what
	 * the user said while it was away this way.
	 */
	nudge(text: string): void;
	cancel(): Promise<void>;

	setModel(modelId: string): Promise<SessionInfo>;
	setMode(modeId: string): Promise<SessionInfo>;
	setConfig(configId: string, value: string): Promise<SessionInfo>;

	/** False means the request is no longer live (for example, after restart). */
	answerPermission(requestId: string, optionId: string): boolean;

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
