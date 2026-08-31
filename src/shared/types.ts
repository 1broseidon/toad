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
	/**
	 * A configured fallback harness for a desk that cannot run this teammate's
	 * current one — the matching ladder's middle rung, between "exactly what it
	 * runs now" and the room's default. Absent means no preference beyond those.
	 */
	harnessOverride?: HarnessChoice;
	/**
	 * Plugins this teammate's work depends on, by plugin id.
	 *
	 * Replicated, and for the reason written beside `harnessOverride`: any desk
	 * may be asked what would run this teammate elsewhere, so the requirement
	 * has to be knowable without asking the owner. A hop to a desk that lacks
	 * one refuses and names it. The *configuration* a teammate gives a plugin is
	 * a different thing and stays portable — the requirement is identity, the
	 * config is baggage.
	 */
	plugins?: string[];
	/**
	 * A hop landed this teammate here and it has not been told yet. Machine-
	 * bound and consumed once: the first message after the move carries this
	 * ahead of the user's words, so the agent knows it changed machines and
	 * must verify its workspace instead of assuming old filesystem state.
	 */
	hopNotice?: string;
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
	 * changing a server's command is one edit rather than one per teammate.
	 * Authentication secrets are deliberately not part of this settings object.
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
	/**
	 * The live wire's word on its own transport — up, and riding TLS or not.
	 * Absent when no wire object stands (phones, or a desk the sweep has not
	 * dialed). The stored origin string cannot answer this: an incoming link
	 * rides the local listener's socket, not the scheme written in the row.
	 */
	/** The live NodeLink, which is the only word on whether a desk is reachable:
	 *  a desk that serves no port but dials in is connected, not offline. */
	wire?: { up: boolean; encrypted: boolean; direction: "incoming" | "outgoing" | null };
	/** A mobile plane member: carries a grant instead of transport tokens. */
	mobile?: boolean;
	/** Desk node ids this phone may list and open. Mobile members only. */
	grant?: string[];
	/** The desk whose record this is — the only one that may edit the grant. */
	ownerNode?: string;
};

/**
 * One outside MCP agent's seat, as the Room settings pane reads it.
 *
 * The same shape of answer a phone gets in `NodeMemberInfo`: a name, a grant,
 * the desk that owns the row. What differs is the proof behind it, and the
 * proof is exactly what never appears here — the client secret was never
 * stored, and its digest does not leave the main process.
 */
export type ClientSeatInfo = {
	clientId: string;
	name: string;
	/** Desk node ids this agent may reach. */
	grant: string[];
	admittedAt: number;
	/** The desk whose record this is — the only one that may edit the grant. */
	ownerNode: string;
	/** RFC 7591 `software_id`/`software_version`, when the agent sent them. */
	software: { id: string; version: string } | null;
	/** Whether this desk is honouring an access token for it right now. */
	connected: boolean;
};

/**
 * The one-time code an outside MCP agent enrolls with, and what it needs
 * alongside it: where to point, and which certificate to trust getting there.
 */
export type ClientEnrollmentInfo = {
	code: string;
	expiresAt: number;
	/** Null when this desk has no TLS door — there is nothing to join without one. */
	mcpUrl: string | null;
	registrationEndpoint: string | null;
	/** The room's self-signed certificate on disk, for an agent elsewhere. */
	certPath: string | null;
};

/** The room: the named thing everything joins. One per mesh of desks. */
export type RoomInfo = {
	id: string;
	name: string;
	/** The desk that founded it and owns the record. */
	foundedBy: string;
	createdAt: number;
	/** Whether this desk may rename it. */
	editable: boolean;
	/**
	 * The room's fallback harness — the matching ladder's last rung, for a
	 * teammate landing on a desk that can run neither its current harness nor
	 * its own override. Room policy, so it lives on the room record and only
	 * the founding desk writes it.
	 */
	defaultHarness?: HarnessChoice;
};

/** One desk a mobile member may open, as the phone should see it. */
export type GrantedDesktopInfo = {
	nodeId: string;
	name: string;
	/** The desk's plain web door, or null when it has no address right now. */
	origin: string | null;
	/** True on the desk that answered — the phone marks where it is. */
	self: boolean;
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
	/**
	 * Where the signing key this desk would sign with came from: entered `here`,
	 * or replicated from a desk in the `room`. Null when this desk holds none.
	 *
	 * A boolean question answered where the node id lives, rather than an owner
	 * id the view would have to compare against an id it does not have. It is
	 * worth saying at all because "configured" is otherwise unexplained on a
	 * machine nobody ever typed a key into.
	 */
	keyFrom: "here" | "room" | null;
	/** Whether the desk that owns the key opted it into replication. */
	keyReplicated: boolean;
	/** Phones that tried to register and could not, and what stopped them. */
	problems: { name: string; reason: string }[];
};

/** One desk's standing in a phone's reach: does it hold the two halves, is it up. */
export type PushReachDesk = {
	id: string;
	name: string;
	/** The desk being asked. */
	here: boolean;
	/** The desk that paired this phone, and the only one that may publish facts. */
	owner: boolean;
	/** Whether the standing link to it is up right now. Always true of `here`. */
	up: boolean;
	/** Whether it holds the APNs signing key as well as the phone's address. */
	signs: boolean;
};

/**
 * Whether the room can reach one phone, and from where — asked now, not stored.
 *
 * The settings pane's whole job on this screen used to be a count of paired
 * devices, which was a statement about configuration. Since a phone's address
 * replicates and the desk that posts to it is elected per event, "can we reach
 * this phone" is a question about the room *this instant*: who holds the
 * address, who holds the key, whose link is up. A pane that answered from
 * stored config would say yes on a desk that has no key and no live peer,
 * which is the failure that shows up at 3am as silence.
 */
export type PushPhoneReach = {
	/** One phone, however many desks it paired with. Stable across the room. */
	key: string;
	name: string;
	/** Every desk holding an address for it, in the order election considers. */
	desks: PushReachDesk[];
	/** The desk that would post to it if something happened now, or null. */
	senderNode: string | null;
	senderName: string | null;
	/** Whether that desk is this one. */
	sendsHere: boolean;
	/**
	 * Why nothing would reach it. Null when something would.
	 *
	 * `no-key` — desks hold the address, none of them holds the signing key.
	 * `no-desk` — a desk could sign, but no such desk is up right now.
	 * `dead` — Apple rejected the address; the phone must register a fresh one.
	 * `leaving` — the pairing was withdrawn and the room is still tearing down.
	 */
	quiet: "no-key" | "no-desk" | "dead" | "leaving" | null;
	/** For a withdrawal in flight: the desks it is still waiting on, by name. */
	pending: string[];
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
 * One bundled dependency, and the notice that has to travel with it.
 *
 * Toad ships as a single binary, so every dependency's terms are terms Toad
 * distributes under. `text` indexes a shared table because a few hundred
 * packages between them use a few dozen distinct notices.
 */
export type NoticePackage = {
	name: string;
	version: string;
	/** SPDX identifier as the package declares it. */
	license: string;
	homepage?: string;
	/** Toad ships a patched copy. The notice rides along; the change is stated. */
	modified?: boolean;
	/** Index into `ThirdPartyNotices.texts`, when a notice was found or built. */
	text?: number;
};

/** Generated at build time by `scripts/generate-notices.ts`. */
export type ThirdPartyNotices = {
	schemaVersion: 1;
	/** The build these notices were generated for, e.g. "Toad 0.2.10". */
	product: string;
	packages: NoticePackage[];
	texts: string[];
};

/** What the About pane needs to know about a self-update check. */
export type UpdatePhase =
	| "idle"
	| "checking"
	| "available"
	| "downloading"
	| "ready"
	| "applying"
	| "blocked"
	| "complete"
	| "error";

/**
 * Where one desk stands in a fleet-wide update.
 *
 * `skipped` is not a failure: a desk that was asleep when the room updated
 * will update itself when it wakes. `failed` is — it tried and did not come
 * back on the new build, which stops the rollout.
 */
export type FleetRolloutStep =
	| "waiting"
	| "downloading"
	| "restarting"
	| "done"
	| "skipped"
	| "failed";

export type FleetRolloutProgress = {
	running: boolean;
	/** The build every desk is being rolled onto. */
	target?: string;
	desks: Array<{ nodeId: string; name: string; step: FleetRolloutStep; detail?: string }>;
	message: string;
};

/**
 * An update this install tried to apply and did not get.
 *
 * The native updater records every transaction to disk, so a failure is a
 * durable fact about the machine rather than a notification someone had to be
 * looking at when it fired. `phase` and `reason` are the updater's own words:
 * where it broke, and what it said.
 */
export type FailedUpdate = {
	version: string;
	hash: string;
	phase: string;
	reason: string;
};

export type UpdateStatus = {
	phase: UpdatePhase;
	message: string;
	/** The build actually running, read from this bundle — never the manifest. */
	currentVersion: string;
	currentHash: string;
	latestVersion?: string;
	latestHash?: string;
	progress?: number;
	bytesDownloaded?: number;
	totalBytes?: number;
	/** Teammates whose turn is still running, when apply was refused. */
	blockedBy?: string[];
	/**
	 * Present while the newest recorded transaction is a failure — a desk that
	 * tried to move and is still here. Gone once it has moved.
	 */
	failedUpdate?: FailedUpdate;
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

export type McpHttpAuth =
	| { mode: "none" }
	| {
			/** Header names only. Values live in the owner-only MCP credential store. */
			mode: "static";
			headerNames: string[];
	  }
	| {
			mode: "oauth";
			/** Consent requested from the authorization server. */
			scopes: string[];
			/** Optional RFC 8707 resource indicator. Defaults to the MCP resource URL. */
			resource?: string;
			/**
			 * Optional pre-registration. Its secret, if any, is credential-store only.
			 * When absent, Toad uses RFC 7591 Dynamic Client Registration.
			 */
			client?: {
				clientId: string;
				tokenEndpointAuthMethod?: "none" | "client_secret_basic" | "client_secret_post";
			};
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
	| { id: string; type: "http"; name: string; url: string; auth: McpHttpAuth };

/** Bun-only resolved descriptor. This type is never returned by settings RPC. */
export type McpRuntimeServerConfig =
	| Extract<McpServerConfig, { type: "stdio" }>
	| (Extract<McpServerConfig, { type: "http" }> & { headers?: Record<string, string> });

/** Authentication state safe to show over app RPC. Never includes credentials. */
export type McpAuthStatus = {
	serverId: string;
	state: "not_configured" | "disconnected" | "authorizing" | "authorized" | "error";
	issuer?: string;
	grantedScopes?: string[];
	expiresAt?: number;
	error?: string;
};

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

/**
 * One tool a plugin declares.
 *
 * `subagentInherits` has no default, deliberately. Toad's own bridge tools
 * settle the same question in `ARM_TOOL_POLICY`, a compile-time exhaustive
 * record whose whole point is that adding a tool forces a decision about
 * whether a subagent may use it. A plugin's tools arrive at runtime, so the
 * required field is the only place that decision can be forced to happen.
 */
export type PluginToolSpec = {
	name: string;
	description: string;
	/** JSON Schema, which is MCP's own tool schema — not re-invented here. */
	inputSchema: Record<string, unknown>;
	subagentInherits: boolean;
};

/** An event a plugin emits or receives, and the shape of its payload. */
export type PluginEventSpec = { name: string; payload?: Record<string, unknown> };

/**
 * What a plugin asked for and what the person agreed to.
 *
 * Nothing under `fleet` is wired yet — patterns 1 to 4 are a later phase — but
 * the shape is declared and validated now so an install written today is not
 * re-negotiated when they land, and so the "what may this plugin reach" pane
 * has something honest to draw.
 */
export type PluginGrants = {
	/** Narrow room facts, never the raw stores. */
	room: Array<"desks" | "teammates">;
	fleet: {
		/** Log ids this plugin may own and mirror. */
		log: string[];
		rpc: { call: boolean; serve: string[] };
		events: boolean;
		blobs: boolean;
	};
	/** Which desks this desk's install will answer. */
	acceptFrom: "members" | "none" | string[];
};

/** `toad-plugin.json`, validated. The authoritative tool list lives here. */
export type PluginManifest = {
	/** Reverse-DNS, immutable. The one namespace root for everything the plugin owns. */
	id: string;
	version: string;
	name: string;
	description?: string;
	/** The command Toad supervises, spawned with the same login-shell PATH recovery MCP servers get. */
	serve: { command: string; args: string[] };
	tools: PluginToolSpec[];
	logs: string[];
	rpc: { serves: string[] };
	events: PluginEventSpec[];
	grants: PluginGrants;
};

/**
 * `installed` — the manifest is on disk and agreed to; nothing is running yet.
 * `running` — the child answered `initialize` and its tools match the manifest.
 * `stopped` — deliberately, or after too many crashes to keep trying.
 * `failed` — it died and a restart is pending.
 */
export type PluginState = "installed" | "running" | "stopped" | "failed";

/** One row of "what may this plugin reach", as the one decision function answers it. */
export type PluginReachRow = {
	action: string;
	target: string;
	allowed: boolean;
	reason: string;
};

/** A plugin as the plugin page draws it. */
export type PluginInfo = {
	id: string;
	name: string;
	version: string;
	description?: string;
	/** Where it was installed from, which is also where it runs. */
	dir: string;
	state: PluginState;
	/** Why it is in that state. Required, for the same reason a ledger row's is. */
	reason: string;
	installedAt: number;
	tools: PluginToolSpec[];
	grants: PluginGrants;
	/** The last stderr lines, so a failure is a thing you can read. */
	stderr: string[];
	/** How many times it has crashed since it was last started deliberately. */
	crashes: number;
	reach: PluginReachRow[];
};

/**
 * One of a plugin's logs, as the plugin page draws it.
 *
 * Two lists rather than one, because "whose writing I hold" and "who is
 * writing" are different questions and the gap between them is the only honest
 * answer to "is what I am looking at complete".
 */
export type PluginLogView = {
	logId: string;
	/** This desk's own generation and bytes, or null before it opened the log. */
	self: { gen: number; bytes: number } | null;
	/** Desks whose writing has arrived here. */
	mirrors: Array<{ nodeId: string; name: string; bytes: number; gens: number[] }>;
	/** Desks that run this plugin and whose writing has not. Named, with a cause. */
	absent: Array<{ nodeId: string; name: string; reason: string }>;
};

/** Where else in the room this plugin runs, and at which version. */
export type PluginDeskView = {
	nodeId: string;
	name: string;
	version: string;
	self: boolean;
	linked: boolean;
	stale: boolean;
};

/** What an uninstall actually did. A teardown is a look, not a promise. */
export type PluginUninstallReport = {
	id: string;
	removed: boolean;
	/** Teammates whose tool ledger lost rows, by persona id. */
	teammates: string[];
	/**
	 * The log plane's half of the teardown, looked at rather than promised:
	 * which of this desk's own logs were deleted, and which desks' mirrors of
	 * them went with it. A desk that is dark keeps its mirror until it is asked
	 * again, and saying so is the point of reporting rather than asserting.
	 */
	logs: {
		/** This desk's own logs, deleted. */
		owned: string[];
		/** Desks whose mirrors this desk was holding, and dropped. */
		mirrors: string[];
		/** Desks that confirmed dropping their mirror of THIS desk's logs. */
		confirmed: string[];
		/** Desks that did not answer, and so still hold one. Dark, usually. */
		unconfirmed: string[];
	};
	/** Anything the uninstall could not finish, named. */
	pending: string[];
};

/**
 * Where one of a teammate's tools came from.
 *
 * Coarse on purpose: this names the mechanism that supplies the tool, because
 * that is what decides how an absence is fixed. `origin` beside it names the
 * particular supplier — an MCP server's name, a plugin id, "pi", "Toad".
 */
export type ToolSourceKind =
	| "builtin"
	| "toad"
	| "mcp"
	| "computer"
	| "search"
	| "subagent"
	| "plugin";

/**
 * How sure Toad is about one tool.
 *
 * `verified` — Toad watched the agent take it: it built the tool array itself,
 * or it served the `tools/list` the agent asked for.
 * `declared` — Toad handed it over and cannot see what happened next. An ACP
 * backend spawns its own stdio MCP servers, so this is as good as it gets
 * for those; it is an honest "we asked", never a claim that it worked.
 * `absent` — it is not there, and `reason` says why.
 */
export type ToolState = "verified" | "declared" | "absent";

/**
 * One line of a teammate's tool ledger.
 *
 * `reason` is required in every state, and that is the whole design. Tools
 * vanishing silently is the worst failure this project has shipped — pi reads
 * its tool list twice and a Windows allowlist deleted every Toad tool for a
 * day — and every one of those bugs was an absence with an optional
 * explanation nobody filled in. A field that cannot be omitted cannot be
 * forgotten.
 */
export type ToolLedgerRow = {
	name: string;
	source: ToolSourceKind;
	/** The particular supplier, named: "Echo", "pi", "Toad", "com.example.board". */
	origin: string;
	state: ToolState;
	/** Why this tool is in this state. Never empty. */
	reason: string;
	/** When Toad last observed it. */
	at: number;
};

/** Everything Toad knows about one teammate's tools, and how it knows it. */
export type TeammateToolLedger = {
	personaId: string;
	/** Which kind of agent was asked: Toad Agent builds its own array; ACP does not. */
	agentKind: "pi" | "acp";
	backendId: string;
	/** When the session that produced this ledger started. */
	at: number;
	rows: ToolLedgerRow[];
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
	/** True when everything this backend needs was found locally. */
	available: boolean;
	/**
	 * What is missing, when something is. `runner` means Toad cannot start the
	 * process at all. `client` means it can — the adapter is one npm fetch away
	 * — but the agent's own CLI, which the adapter only translates for, is not
	 * installed. The second is one install away rather than a dead end, and the
	 * settings list draws it as such.
	 */
	unavailableKind?: "runner" | "client";
	/** Why it is unavailable, for display. */
	unavailableReason?: string;
	source: "builtin" | "registry";
};

// ---------------------------------------------------------------------------
// Desk capabilities and the matching ladder
// ---------------------------------------------------------------------------

/** One harness, optionally pinned to a model — how the ladder names what runs a teammate. */
export type HarnessChoice = { backendId: string; modelId?: string };

/**
 * What one desk can actually run, advertised to the room as a first-hand fact
 * about that desk. Names and booleans only — never tokens, key material, or
 * filesystem paths, because this value replicates to every member.
 */
export type DeskCapabilities = {
	/** The desk's `process.platform`: "linux", "darwin", "win32", … */
	platform: string;
	arch: string;
	/**
	 * Every harness the desk knows, each with the truth `listBackends` already
	 * computes — the adapter-is-not-the-agent rule included, so a downloaded
	 * shim whose CLI is missing advertises as unavailable.
	 */
	harnesses: Array<{ id: string; name: string; available: boolean }>;
	/**
	 * The built-in Toad Agent's reach: which providers this desk can actually
	 * reach and which models they serve, by id.
	 *
	 * "Reach" is deliberately wider than "signed in here". A provider whose API
	 * key was entered on another desk and replicated to this one is reachable
	 * here, so it is named here — that is the whole point of replication, and
	 * the matching ladder reads exactly this list. Names and booleans only: a
	 * provider id, never a key, never a path.
	 */
	builtin: { authenticated: boolean; providers: string[]; models: string[] };
	/**
	 * How much of this shape the advertising desk knew how to fill in.
	 *
	 * `capabilitiesOf` rebuilds an advertisement field by field and drops what
	 * it does not recognise, so a desk older than a field is indistinguishable
	 * from a desk that has none of it — and the ladder would then refuse a hop
	 * that would have worked, giving a reason that is a lie. `1` is the first
	 * format that carries `plugins`. Absent means "too old to say", which is a
	 * different sentence from "has none".
	 */
	format?: number;
	/**
	 * Plugins installed on that desk, so the hop's ladder has something to
	 * refuse on. Ids, versions and states only — never grants, never paths.
	 * Absent when `format` is absent, and empty when the desk really has none.
	 */
	plugins?: Array<{ id: string; version: string; state: PluginState }>;
	/** The owning desk's clock when this snapshot was computed. */
	capturedAt: number;
};

/** The advertisement format this build writes. Bump when the shape grows. */
export const DESK_CAPABILITY_FORMAT = 1;

/** A desk's advertisement as read on this desk: live, or last-known from a dark peer. */
export type DeskCapabilityInfo = {
	nodeId: string;
	capabilities: DeskCapabilities;
	/** When the owning desk last rewrote its advertisement, on its clock. */
	heardAt: number;
	/** Whether the owning desk is reachable right now. Always true for this desk. */
	online: boolean;
	/** Last-known only: the owner is dark, so this may be out of date. */
	stale: boolean;
};

// ---------------------------------------------------------------------------
// Provider credentials
// ---------------------------------------------------------------------------

/**
 * What a credential authenticates with, which is what decides whether it may
 * travel.
 *
 * The line is rotation, not sensitivity. A static bearer key has no rotation
 * race, so copies of it on several desks stay correct. OAuth rotates its
 * refresh token on use, so two desks refreshing concurrently invalidate each
 * other — a correctness bug rather than a policy preference, and the reason
 * `oauth` is refused replication rather than merely discouraged from it.
 */
export type CredentialKind = "api_key" | "oauth";

/**
 * One provider credential as the room sees it. Never carries the secret.
 *
 * Everything here is a name, a boolean, or a node id, so this value is safe in
 * an RPC response, a log line, and a capability advertisement alike.
 */
export type RoomCredential = {
	id: string;
	providerId: string;
	/** What the operator calls it. Defaults to the provider id. */
	label: string;
	kind: CredentialKind;
	/** The desk it was entered on: the only desk that may change it. */
	ownerNode: string;
	/** Opted into replication. Default false — nothing travels because it can. */
	replicate: boolean;
	/** Revoked upstream. A revoked credential is inert on every desk that hears. */
	revoked: boolean;
	/** Desks currently holding a sealed copy. Empty when machine-local. */
	sealedTo: string[];
	/**
	 * Whether this desk holds material for it: the key in its own vault, a copy
	 * sealed to it, or — for OAuth — the login itself. Answered from the record,
	 * never by decrypting anything.
	 */
	usableHere: boolean;
	/**
	 * A withdrawal still in progress, or null when nothing is outstanding.
	 *
	 * Opting out and revoking both publish a record with no boxes in it, and that
	 * op *is* the deletion — but a desk that was dark when it was published has
	 * not applied it yet, and reporting "deleted everywhere" then would be a
	 * delete that never happened. So the desks that held a copy are named, and
	 * each moves to `confirmed` only once it has been asked and has answered that
	 * it holds nothing.
	 */
	teardown: CredentialTeardown | null;
	createdAt: number;
	/** The owning desk's clock when the record last changed. */
	updatedAt: number;
};

/**
 * A withdrawal of the copies on other desks, as the surface must report it.
 *
 * `pending` is the honest half: those desks may still hold ciphertext, and the
 * operator is owed that fact rather than a checkmark. It empties when every
 * named desk has been observed holding nothing — which for a dark desk is when
 * it comes back, not when somebody flipped a switch.
 */
export type CredentialTeardown = {
	/** When the copies were withdrawn — the opt-out, or the revocation. */
	at: number;
	/** Desks not yet observed to have dropped their copy. */
	pending: string[];
	/** Desks that have since been asked, and answered that they hold nothing. */
	confirmed: string[];
};

/** One rung of the matching ladder, reported whether or not it matched. */
export type HarnessRungReport = {
	/**
	 * `plugins` is not a harness choice and never carries one. It is a rung
	 * because it is reported the same way every other one is — matched or not,
	 * with a reason — and because a teammate that names a plugin the
	 * destination lacks is unrunnable there no matter which harness matched.
	 */
	rung: "exact" | "override" | "default" | "plugins";
	/** What the rung proposed, or null when nothing is configured at it. */
	choice: HarnessChoice | null;
	ok: boolean;
	/** Why the rung matched or did not, in words the teammate's card can show. */
	reason: string;
};

/**
 * The ladder's answer for one teammate on one desk: what would run it and by
 * which rung, with every rung's verdict visible so a caller can always say why.
 */
export type HarnessResolution =
	| {
			rung: "exact" | "override" | "default";
			choice: HarnessChoice;
			rungs: HarnessRungReport[];
	  }
	| { rung: "unavailable"; rungs: HarnessRungReport[] };

/**
 * The hop's answer: the teammate now lives on `to`, running on the harness the
 * ladder matched (`rung` says which rung it landed on), under the bumped owner
 * epoch — or a refusal that says why nothing moved. A refusal the ladder caused
 * carries every rung's verdict, so the caller can name the reasons.
 */
export type HopResult =
	| {
			ok: true;
			personaId: string;
			from: string;
			to: string;
			epoch: number;
			rung: "exact" | "override" | "default";
			choice: HarnessChoice;
	  }
	| { ok: false; error: string; rungs?: HarnessRungReport[] };

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

/** The request shapes pi can speak to a model endpoint. */
export type CustomProviderApi =
	| "openai-completions"
	| "openai-responses"
	| "anthropic-messages"
	| "google-generative-ai";

/**
 * A model provider the user defined, as the settings screen sees it.
 *
 * Carries no key and no way to ask for one: `auth` says how the endpoint is
 * authenticated, never with what.
 */
export type CustomProviderInfo = {
	id: string;
	name: string;
	baseUrl: string;
	api: CustomProviderApi;
	models: string[];
	/**
	 * `credential` — a key in pi's store. `environment` — a `$VAR` reference.
	 * `local` — a placeholder for a server that ignores keys. `literal` — a key
	 * written into the file by hand. `none` — nothing, so the models stay hidden.
	 */
	auth: "credential" | "environment" | "local" | "literal" | "none";
	/** The entry carries pi settings this form does not show, and keeps them. */
	advanced: boolean;
};

/** A provider definition on its way in. `apiKey` is write-only and never returned. */
export type CustomProviderInput = {
	id: string;
	name?: string;
	baseUrl: string;
	api: CustomProviderApi;
	models: string[];
	/** A literal key, a `$VAR` reference, or empty for a server that ignores it. */
	apiKey?: string;
	compat?: {
		supportsDeveloperRole?: boolean;
		supportsReasoningEffort?: boolean;
		supportsFinishReason?: boolean;
	};
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
			/**
			 * What kind of citizen the other side is. Absent means a teammate —
			 * every marker written before client seats existed, and every one
			 * written for a teammate since. `client` means an outside MCP agent
			 * holding a seat in this room; `withName` already carries the desk
			 * it connected through, as in "Claude Code @ beastie".
			 *
			 * The field exists because the name alone cannot carry it: "Claude
			 * Code @ beastie" and "Boris @ beastie" read identically, and a
			 * message from outside the room must never look like one from a
			 * teammate.
			 */
			seat?: "client";
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
