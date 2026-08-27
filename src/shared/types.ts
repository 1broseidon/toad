// Types shared between the Bun main process and the webview.
// Keep this file free of runtime imports so both sides can use it.

import type { Face } from "./face";

/**
 * A Toad teammate. Four axes make up an identity:
 *   - Identity   : `goal`, materialised as AGENTS.md inside `cwd`
 *   - Workspace  : `cwd`, passed to session/new
 *   - Capability : `mcpPolicy`, resolved against the app's MCP servers
 *   - Disposition: `modelId` / `modeId`, switchable mid-session
 */
export type Persona = {
	/**
	 * Set on a teammate who lives on a linked desktop: which one. Their id is
	 * node-qualified (`nodeId/personaId`) and every call about them rides the
	 * fleet wire to that desktop. Absent for teammates of this machine.
	 */
	node?: { id: string; name: string };
	id: string;
	name: string;
	goal: string;
	/**
	 * The icon the agent chose for itself at creation. Absent on teammates made
	 * before faces existed, who keep the hashed-colour initial.
	 */
	face?: Face;
	/**
	 * The team this teammate sits on — a label, not an entity. Teams are not
	 * agents and never speak: addressing one round-robins to the next
	 * available member, who routes it onward. Distinct labels ARE the teams;
	 * an empty label is the unteamed default.
	 */
	team?: string;
	backendId: string;
	cwd: string;
	modelId?: string;
	modeId?: string;
	/** Which of the app's MCP servers this teammate is given. */
	mcpPolicy: McpPolicy;
	/** Absent means inherit the desk's web search entirely. */
	webSearchPolicy?: WebSearchPolicy;
	/**
	 * This teammate's computer (docs/computer.md): a containerized desktop it
	 * drives through MCP tools. Deliberately not part of `mcpPolicy` — the
	 * computer is a per-teammate capability Toad manages, not one of the app's
	 * user-configured servers. Absent means off.
	 */
	computer?: PersonaComputer;
	/** Built-in web search providers. An absent toggle is enabled. */
	/**
	 * Subagents this teammate may send work to. Scoped here, not app-wide:
	 * one teammate's reviewer is not another's. Absent means the built-in
	 * task runner only, with no extras and no model pin.
	 */
	subagents?: PersonaSubagents;
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
 * Which moments earn a notification, and whether that destination is on.
 *
 * Shared by the phone (`push`) and this desktop (`desktop`). Kind toggles
 * default on when absent; the master switch does not — each destination
 * picks its own default for `enabled`.
 */
export type NotifyPrefs = {
	enabled: boolean;
	turnEnded?: boolean;
	permission?: boolean;
	blocked?: boolean;
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
	/**
	 * Web mode: serve the app to browsers on the LAN/VPN. The wire token is
	 * not here — settings are a file a person edits; secrets live bun-side.
	 */
	webMode?: { enabled: boolean };
	/**
	 * Push notifications to paired phones (docs/push.md).
	 *
	 * Preferences only — the `.p8` that signs them is not here, for the same
	 * reason the wire token is not. Each kind switches separately because a
	 * teammate that finished and a teammate that is stuck are not the same
	 * news, and people disagree about which one earns a buzz at midnight.
	 * Absent toggles mean on; the pane is off until `enabled`.
	 */
	push?: NotifyPrefs;
	/**
	 * Local toasts on this desktop for the same moments as `push`.
	 *
	 * Same shape, opposite default: absent `enabled` means on, because there
	 * is no key to install and the window-attention rule already keeps a
	 * toast off the conversation in your hand.
	 */
	desktop?: NotifyPrefs;
	/**
	 * How long a teammate sits idle before its working context is closed as a
	 * chapter (docs/chapters.md). A day of conversation fits a modern model
	 * comfortably; a week of it does not. Absent means the default (8).
	 */
	chapterIdleHours?: number;
	/** Optional provider keys shared by all teammates. */
	/**
	 * Web search for Toad Agent teammates — the desk's capability, not any one
	 * teammate's. Absent means on with every keyless provider: batteries
	 * included, and one master switch here to cut every outbound query.
	 */
	webSearch?: WebSearchSettings;
	webSearchKeys?: WebSearchKeys;
};

export type WebSearchSettings = {
	/** The master switch. Absent means on. */
	enabled?: boolean;
	parallel?: boolean;
	exa?: boolean;
	firecrawl?: boolean;
	keenable?: boolean;
};

export type WebSearchKeys = {
	exa?: string;
	firecrawl?: string;
	keenable?: string;
};

/** Whether web mode is up, and the plain URL a phone opens to link. */
export type WebModeStatus = { enabled: boolean; url: string | null };

/** A control-plane participant. The private key never crosses this boundary. */
export type NodeIdentity = {
	id: string;
	name: string;
	publicKey: string;
	fingerprint: string;
	protocol: 1;
	capabilities: Array<"admin" | "executor" | "store" | "gateway" | "endpoint" | "observer">;
};

/** An mDNS result. Discovery locates a node; it does not establish trust. */
export type NearbyNodeInfo = {
	id: string;
	name: string;
	origin: string;
	protocol: number;
	lastSeenAt: number;
};

/** The Nodes settings projection. Legacy fleet rows remain visible during migration. */
export type NodeMemberInfo = {
	id: string;
	name: string;
	origin: string;
	addedAt: number;
	lastSeenAt?: number;
	fingerprint?: string;
	protocol?: number;
	capabilities?: NodeIdentity["capabilities"];
	legacy: boolean;
};

/** A nearby node asking this desktop to admit it. */
export type IncomingNodeRequestInfo = {
	id: string;
	node: Pick<NodeIdentity, "id" | "name" | "fingerprint" | "protocol" | "capabilities">;
	origin: string;
	requestedAt: number;
	expiresAt: number;
};

export type NodeRequestStatus = "pending" | "accepted" | "denied" | "expired" | "failed";

/** This desktop's request, retained long enough to report the remote decision. */
export type OutgoingNodeRequestInfo = {
	id: string;
	nodeId: string;
	origin: string;
	status: NodeRequestStatus;
	requestedAt: number;
	expiresAt: number;
	error?: string;
};

/** The explicit alternative to mDNS and an incoming approval prompt. */
export type NodeInvite = {
	origin: string;
	code: string;
	expiresAt: number;
};

/**
 * Whether this desktop can sign a push, for the settings pane.
 *
 * Identifiers only: the Key ID and Team ID are printed on Apple's own console
 * and identify nothing on their own, while the key that makes them useful
 * never leaves the bun side.
 */
export type PushStatus = {
	configured: boolean;
	keyId: string | null;
	teamId: string | null;
	topic: string;
	/** How many paired devices would actually buzz right now. */
	devices: number;
	/** Phones that tried to register and could not, and what stopped them. */
	problems: { name: string; reason: string }[];
};

/** A linked web-mode device, as settings lists it. Never carries the token. */
export type WebDeviceInfo = {
	id: string;
	name: string;
	createdAt: number;
	lastSeenAt: number;
	/** Whether this device has registered for push. Not the APNs token itself. */
	push: boolean;
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
/**
 * Which of the desk's web search a teammate gets — the same inherit/override
 * question McpPolicy answers for servers. Absent means `all`: inherit
 * whatever the app's Tools pane has on. `some` intersects with the app's
 * choices — a provider the desk switched off stays off for everyone.
 */
export type WebSearchPolicy = {
	mode: "all" | "none" | "some";
	/** Read only when mode is `some`; kept otherwise so toggling does not lose it. */
	providers: Array<"parallel" | "exa" | "firecrawl" | "keenable">;
};

export type McpPolicy = {
	mode: "all" | "none" | "some";
	/** Read only when mode is `some`; kept otherwise so toggling does not lose it. */
	serverIds: string[];
};

/**
 * A teammate's computer settings (docs/computer.md).
 *
 * Only what the user decides lives here. Everything Toad derives — the bearer
 * token, container state, last activity — is bun-side state, not config.
 */
export type PersonaComputer = {
	enabled: boolean;
	/** Image override. Defaults to the app's version-pinned image. */
	image?: string;
};

/**
 * Operator-configured extras plus an optional pin on the built-in task runner.
 *
 * `generic` is reserved: it is always present, cannot be deleted, and is
 * what `subagent` runs when `kind` is omitted. Extras are additional kinds
 * the parent may choose, each with its own brief and optional model.
 */
export type PersonaSubagents = {
	defaults?: SubagentDefaults;
	extras?: SubagentSpec[];
};

/** Overrides for the built-in task runner (`kind: generic`). */
export type SubagentDefaults = {
	name?: string;
	description?: string;
	/** Extra briefing appended to the silent-runner prompt. */
	prompt?: string;
	/** Optional model as provider/id. Absent means inherit the teammate's. */
	modelId?: string;
};

/** An extra subagent the parent can pass as `kind`. */
export type SubagentSpec = {
	id: string;
	name: string;
	description: string;
	prompt?: string;
	modelId?: string;
};

/** A roster entry after defaults are filled in. */
export type ResolvedSubagent = {
	id: string;
	name: string;
	description: string;
	prompt?: string;
	modelId?: string;
	/** True for the built-in task runner. */
	builtin: boolean;
};

/**
 * A container runtime Toad found (or looked for) on this machine.
 *
 * Mirrors the backend-registry pattern: every candidate is reported, with
 * `unavailableReason` explaining an absence, so the settings screen can show
 * what was found rather than a bare failure.
 */
export type ComputerRuntimeInfo = {
	id: "docker" | "podman" | "container";
	name: string;
	available: boolean;
	/** Rootless runtimes rank first; unknown when unavailable. */
	rootless?: boolean;
	unavailableReason?: string;
};

/** What a teammate's computer is doing right now, for the computer drawer. */
export type ComputerStatus = {
	enabled: boolean;
	/** absent covers both never-created and hibernated — same wake either way. */
	state: "running" | "stopped" | "absent";
	image: string;
	/** Which runtime owns the container (e.g. "docker"); unset when none found. */
	runtime?: string;
	lastUsedAt?: number;
};

export type PersonaDraft = {
	name: string;
	goal?: string;
	/** Initial roster section. Empty and omitted both mean the default team. */
	team?: string;
	backendId?: string;
	cwd?: string;
	modelId?: string;
	computer?: PersonaComputer;
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
	modelLabel?: string;
	modes: ConfigChoice[];
	currentModeId?: string;
	modeLabel?: string;
	/** Select config options that are not the model or mode picker (e.g. Claude effort). */
	configs: Array<{ id: string; name: string; currentId?: string; options: ConfigChoice[] }>;
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

export type ConfigChoice = {
	id: string;
	name: string;
	description?: string;
	/**
	 * Picker section header — the provider serving this choice, with its
	 * billing flavor ("Anthropic — subscription", "OpenRouter — API key").
	 * The same model name can be served two ways at very different prices;
	 * the section is what tells them apart before the choice is made.
	 */
	group?: string;
};

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
	| { kind: "user"; id: string; ts: number; text: string; attachments?: Attachment[]; reactions?: string[]; replyTo?: string }
	| { kind: "agent"; id: string; ts: number; text: string; reactions?: string[] }
	| { kind: "thought"; id: string; ts: number; text: string }
	| { kind: "tool"; id: string; ts: number; toolCallId: string; title: string; toolKind?: string; status: ToolStatus; locations?: string[]; output?: ToolOutput[] }
	| { kind: "permission"; id: string; ts: number; requestId: string; title: string; options: PermissionOption[]; decision?: string; decidedOptionName?: string }
	| { kind: "plan"; id: string; ts: number; entries: PlanEntry[] }
	| { kind: "notice"; id: string; ts: number; level: "info" | "warn" | "error"; text: string }
	/**
	 * A frame of the teammate's computer screen, taken as its capture tool
	 * ran. The chat is where the work actually happens, so what the agent
	 * saw belongs in it — a thumbnail, with the live screen a click away.
	 */
	| { kind: "computer_frame"; id: string; ts: number; dataUrl: string }
	/**
	 * The agent asked the human to take an action it cannot — credentials, a
	 * 2FA tap, a CAPTCHA — usually on its computer. Pending renders a card
	 * with the way in; any other status is the card's afterlife.
	 */
	| {
			kind: "human_action";
			id: string;
			ts: number;
			actionId: string;
			reason: string;
			status: "pending" | "done" | "dismissed" | "expired";
	  }
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
	| { kind: "turn"; id: string; ts: number; stopReason: string; usage?: TokenUsage }
	/**
	 * A chapter boundary: one working context of the agent, marked in the
	 * tape it belongs to. Written once when the chapter opens and superseded
	 * by id when it closes, carrying what the next chapter needs to know.
	 * `sessionId` is the agent's own memory of this stretch, so a chapter can
	 * be reopened rather than merely summarised. See docs/chapters.md.
	 */
	| {
			kind: "chapter";
			id: string;
			ts: number;
			backendId: string;
			sessionId?: string;
			endedAt?: number;
			title?: string;
			/** The handoff note: goal, outcome, open loops, decisions, files. */
			note?: string;
			status?: "in-progress" | "done";
			tags?: string[];
			closedBy?: "idle" | "user" | "agent" | "resume";
			/** Set on a chapter that reopened an earlier one's context. */
			resumedFrom?: string;
	  };

export type ChapterEvent = Extract<TranscriptEvent, { kind: "chapter" }>;

/** A chapter as the drawer lists it: the marker plus how much was said in it. */
export type ChapterSummary = {
	id: string;
	startedAt: number;
	endedAt?: number;
	title?: string;
	note?: string;
	status?: "in-progress" | "done";
	messages: number;
};

/** One hit from a thread search: a chapter by its note, or a message by its text. */
export type ThreadSearchHit =
	| { kind: "chapter"; chapterId: string; ts: number; title: string; excerpt: string; status?: string }
	| {
			kind: "message";
			eventId: string;
			chapterId?: string;
			ts: number;
			from: "me" | "them";
			excerpt: string;
	  };

/** One teammate as a fleet snapshot reports it — presence, not internals. */
export type FleetTeammate = {
	personaId: string;
	name: string;
	team?: string;
	goal?: string;
	backendId: string;
	state: SessionState;
	face?: Face;
};

/** A linked desktop's roster, as fresh as the last successful poll. */
export type FleetNodeRoster = {
	node: { id: string; name: string };
	teammates: FleetTeammate[];
	online: boolean;
};

/** A linked desktop, minus the tokens that make it one. */
export type FleetPeerInfo = {
	id: string;
	name: string;
	origin: string;
	addedAt: number;
	lastSeenAt?: number;
};

/** A search hit that names whose conversation it came from. */
export type GlobalSearchHit = ThreadSearchHit & { personaId: string };

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

/**
 * Work a teammate has asked Toad to wake it for later.
 *
 * `schedule` is once. `loop` is every `everyMs` until cancelled. `nextAt` is
 * the next fire, so the roster can say when without the UI doing the math.
 */
export type ScheduledJob = {
	id: string;
	personaId: string;
	kind: "schedule" | "loop";
	prompt: string;
	nextAt: number;
	createdAt: number;
	/** Present on loops only. */
	everyMs?: number;
	lastFiredAt?: number;
};

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
