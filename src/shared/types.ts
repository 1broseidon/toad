// Types shared between the Bun main process and the webview.
// Keep this file free of runtime imports so both sides can use it.

/**
 * A Toad teammate. Four axes make up an identity:
 *   - Identity   : `goal`, materialised as AGENTS.md inside `cwd`
 *   - Workspace  : `cwd`, passed to session/new
 *   - Capability : `mcpPolicy`, resolved against the app's MCP servers
 *   - Disposition: `modelId` / `modeId`, switchable mid-session
 */
export type Persona = {
	id: string;
	name: string;
	goal: string;
	backendId: string;
	cwd: string;
	modelId?: string;
	modeId?: string;
	/** Which of the app's MCP servers this teammate is given. */
	mcpPolicy: McpPolicy;
	/**
	 * The last durable ACP session for each backend this teammate has used.
	 *
	 * ACP session ids are opaque to the agent that issued them. Keeping one per
	 * backend lets a teammate switch harnesses and later return to either one
	 * without sending Cursor's id to Claude (or vice versa).
	 */
	sessionCheckpoints: Array<{ backendId: string; sessionId: string }>;
	/** Legacy v1 field. Read once into sessionCheckpoints; no longer written. */
	lastSessionId?: string;
	createdAt: number;
	updatedAt: number;
};

/**
 * Preferences that belong to the app rather than to any one teammate.
 *
 * The distinction is what the two settings surfaces are for: a teammate's
 * identity, backend and workspace are properties of that teammate, while these
 * are true of Toad however many teammates there are.
 */
export type AppSettings = {
	/** Backend given to a new teammate when the form does not name one. */
	defaultBackendId: string;
	/**
	 * Every MCP server Toad knows about, defined once here.
	 *
	 * Teammates reference these by id rather than carrying their own copies, so
	 * changing a server's command is one edit rather than one per teammate, and
	 * a token pasted into a header is stored in one place.
	 */
	mcpServers: McpServerConfig[];
};

/** Where this build came from and where it keeps things. */
export type AppInfo = {
	name: string;
	version: string;
	channel: string;
	identifier: string;
	dataDir: string;
	configFile: string;
};

/**
 * Whether a backend will actually stop and ask before it acts.
 *
 * `known` is false when Toad has no way to inspect that backend's approval
 * configuration, which is most of them. Reporting "it will ask" in that case
 * would be a guess dressed as a fact, and the whole point of showing this is
 * that a per-teammate working directory looks like a boundary and is not one.
 */
export type Containment = {
	known: boolean;
	asksPermission?: boolean;
	sandboxed?: boolean;
	/** The file the answer was read from, so it can be gone and changed. */
	configPath?: string;
};

export type McpServerConfig =
	| {
			id: string;
			type: "stdio";
			name: string;
			command: string;
			args: string[];
			env?: Record<string, string>;
	  }
	| { id: string; type: "http"; name: string; url: string; headers?: Record<string, string> };

/**
 * Which of the global MCP servers a teammate gets.
 *
 * A capability is a property of the teammate, not of the app: the one that
 * files tickets should not also be able to deploy just because both servers are
 * configured. `all` is the default because the common case is a roster that
 * shares its tools, and `some` exists for when it should not.
 */
export type McpPolicy = {
	mode: "all" | "none" | "some";
	/** Read only when mode is `some`; kept otherwise so toggling does not lose it. */
	serverIds: string[];
};

export type PersonaDraft = {
	name: string;
	goal?: string;
	backendId?: string;
	cwd?: string;
};

/** How a backend gets launched, and whether it is usable right now. */
export type Backend = {
	id: string;
	name: string;
	description?: string;
	/** Resolved launch command, when one is available on this machine. */
	launch?: { cmd: string; args: string[]; env?: Record<string, string> };
	/** True when the executable was found locally. */
	available: boolean;
	/** Why it is unavailable, for display. */
	unavailableReason?: string;
	source: "builtin" | "registry";
};

// ---------------------------------------------------------------------------
// Toad Agent authentication
// ---------------------------------------------------------------------------

/** Non-secret provider metadata for the settings UI. */
export type ProviderAuthInfo = {
	id: string;
	name: string;
	configured: boolean;
	/** Whether Toad/pi can remove it, rather than it coming from the environment. */
	stored: boolean;
	/** Where working auth came from, for example OAuth or an environment variable. */
	source?: string;
	credentialType?: "api_key" | "oauth";
	oauth?: { name: string; loginLabel: string; subscription: boolean };
	apiKey?: { name: string };
};

export type ProviderAuthPrompt =
	| { type: "text" | "secret" | "manual_code"; message: string; placeholder?: string }
	| {
			type: "select";
			message: string;
			options: Array<{ id: string; label: string; description?: string }>;
	  };

export type ProviderAuthNotice =
	| { type: "info" | "progress"; message: string; links?: Array<{ url: string; label?: string }> }
	| { type: "auth_url"; url: string; instructions?: string }
	| {
			type: "device_code";
			userCode: string;
			verificationUri: string;
			expiresInSeconds?: number;
	  };

/** One provider-owned login wizard currently running in the main process. */
export type ProviderAuthFlow = {
	id: string;
	providerId: string;
	providerName: string;
	method: "oauth" | "api_key";
	status: "running" | "prompt" | "success" | "error" | "cancelled";
	prompt?: ProviderAuthPrompt;
	notices: ProviderAuthNotice[];
	error?: string;
};

/** Capabilities and options a live session reported, used to drive the UI. */
export type SessionInfo = {
	personaId: string;
	state: SessionState;
	sessionId?: string;
	agentName?: string;
	agentVersion?: string;
	/** Whether Toad's transcript is showing history the agent no longer remembers. */
	contextRestored: boolean;
	restoreNote?: string;
	models: ConfigChoice[];
	currentModelId?: string;
	modes: ConfigChoice[];
	currentModeId?: string;
	slashCommands: SlashCommand[];
	capabilities: {
		loadSession: boolean;
		resume: boolean;
		fork: boolean;
		mcpHttp: boolean;
		image: boolean;
	};
	error?: string;
};

export type SessionState = "idle" | "starting" | "ready" | "thinking" | "error" | "stopped";

export type ConfigChoice = { id: string; name: string; description?: string };

export type SlashCommand = { name: string; description?: string; hint?: string };

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

/**
 * Something handed to a teammate alongside a message.
 *
 * Everything is a path, pasted images included: a pasted screenshot is written
 * into the persona's `attachments` directory before it is ever attached. That
 * keeps one shape on the wire, keeps base64 out of the transcript on disk, and
 * means an attachment can still be opened months later from the record of the
 * conversation that mentioned it.
 */
export type Attachment = {
	/** Images can be inlined for an agent that takes them; files are linked. */
	kind: "image" | "file";
	/** Basename, which is all the composer and the bubble ever show. */
	name: string;
	path: string;
	mimeType?: string;
	/** Bytes on disk, for the size a chip shows. */
	size?: number;
};


// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

/**
 * One durable line in a persona's transcript. Appended as JSONL and replayed at
 * startup. Note this is Toad's own record: replaying it is not the same as the
 * agent remembering the conversation.
 */
export type TranscriptEvent =
	| { kind: "user"; id: string; ts: number; text: string; attachments?: Attachment[] }
	| { kind: "agent"; id: string; ts: number; text: string }
	| { kind: "thought"; id: string; ts: number; text: string }
	| { kind: "tool"; id: string; ts: number; toolCallId: string; title: string; toolKind?: string; status: ToolStatus; locations?: string[]; output?: ToolOutput[] }
	| { kind: "permission"; id: string; ts: number; requestId: string; title: string; options: PermissionOption[]; decision?: string; decidedOptionName?: string }
	| { kind: "plan"; id: string; ts: number; entries: PlanEntry[] }
	| { kind: "notice"; id: string; ts: number; level: "info" | "warn" | "error"; text: string }
	| {
			kind: "peer";
			id: string;
			ts: number;
			threadKey: string;
			withPersonaId: string;
			withName: string;
			role: "caller" | "target";
			exchanges: number;
			status: "open" | "done" | "waiting" | "failed";
	  }
	| { kind: "turn"; id: string; ts: number; stopReason: string; usage?: TokenUsage };

/**
 * The last thing either side said, shown under a name in the roster.
 *
 * A roster of names alone says who is there; a roster with these says what is
 * going on. Only messages count — a teammate's last tool call is Toad's
 * business, not a line of conversation.
 */
export type Preview = { from: "me" | "them"; text: string; at: number };

/**
 * A peer thread has no "me" in it — both speakers are teammates — so the last
 * line is attributed by name rather than by which side of the thread it sits on.
 */
export type PeerPreview = { fromName: string; text: string; at: number };

export type PeerThreadSummary = {
	threadKey: string;
	withPersonaId: string;
	withName: string;
	exchanges: number;
	lastAt: number;
	waiting: boolean;
	preview: PeerPreview | null;
};

export type PeerThread = {
	threadKey: string;
	sides: {
		user: { personaId: string; name: string };
		agent: { personaId: string; name: string };
	};
	events: TranscriptEvent[];
};

export type PeerActivity = { threads: number; waiting: boolean; lastAt: number };

export type ToolStatus = "pending" | "in_progress" | "completed" | "failed";

export type ToolOutput =
	| { type: "text"; text: string }
	| { type: "diff"; path: string; oldText?: string | null; newText: string };

export type PermissionOption = { optionId: string; name: string; kind?: string };

export type PlanEntry = { content: string; status: string; priority?: string };

export type TokenUsage = { inputTokens?: number; outputTokens?: number; totalTokens?: number };

// ---------------------------------------------------------------------------
// Live streaming deltas (not persisted; UI-only)
// ---------------------------------------------------------------------------

export type StreamDelta =
	| { personaId: string; type: "agent_delta"; messageId: string; text: string }
	| { personaId: string; type: "thought_delta"; messageId: string; text: string };
