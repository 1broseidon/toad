import type { RPCSchema } from "electrobun/main";
import type { Face } from "./face";
import type {
	AppInfo,
	AppSettings,
	Attachment,
	Backend,
	ChapterSummary,
	ComputerStatus,
	Containment,
	CustomProviderInfo,
	CustomProviderInput,
	FleetNodeRoster,
	FleetPeerInfo,
	FleetRolloutProgress,
	GlobalSearchHit,
	GrantedDesktopInfo,
	IncomingNodeRequestInfo,
	McpAuthStatus,
	NearbyNodeInfo,
	NodeIdentity,
	NodeInvite,
	NodeMemberInfo,
	OutgoingNodeRequestInfo,
	PeerActivity,
	PeerThread,
	PeerThreadSummary,
	Persona,
	PersonaDraft,
	Preview,
	ProviderAuthFlow,
	ProviderAuthInfo,
	PushStatus,
	RoomInfo,
	ScheduledJob,
	SessionInfo,
	StreamDelta,
	ThirdPartyNotices,
	ThreadSearchHit,
	TranscriptEvent,
	UpdateStatus,
	WebDeviceInfo,
	WebModeStatus,
} from "./types";

/**
 * Native menus name an intent; the webview owns the behaviour. Keeping the
 * menu bar and the context menus on this one channel means a shortcut, a menu
 * item, and a button in the UI all end up in the same code path.
 */
export type MenuActionName =
	| "newTeammate"
	| "settings"
	| "appSettings"
	| "startSession"
	| "stopSession"
	| "cancelTurn"
	| "revealWorkspace"
	| "renameTeammate"
	| "deleteTeammate"
	| "selectTeammate"
	| "copyMessage"
	| "about"
	| "quit"
	| "minimize"
	| "maximize"
	| "toggleFullScreen"
	| "closeWindow";

/** Caption-button state, so Linux chrome can swap maximize/restore without a resize event. */
export type WindowState = { maximized: boolean; fullScreen: boolean };

/** Where the window sits, in screen pixels. Linux resize grips write this. */
export type WindowFrame = { x: number; y: number; width: number; height: number };

/** Smallest frame a resize will grant. Matches the restore floor in bun. */
export const MIN_WINDOW = { width: 520, height: 420 } as const;

/** `personaId` is absent when the item acted on whatever is currently selected. */
export type MenuAction = { action: MenuActionName; personaId?: string };

/**
 * Where a face composition currently is, for the setup screen's narration.
 * `spawning` is the hidden session coming up; `asking` is the one turn in
 * which the agent chooses; `done` fires after the face is saved.
 */
export type FaceProgress = {
	personaId: string;
	stage: "spawning" | "asking" | "done";
};

export type ToadRPC = {
	bun: RPCSchema<{
		requests: {
			listPersonas: { params: {}; response: Persona[] };
			createPersona: { params: PersonaDraft; response: Persona };
			updatePersona: { params: { id: string; patch: Partial<Persona> }; response: Persona };
			/** Confirms natively first; `deleted` is false when the user backs out. */
			deletePersona: { params: { id: string; confirmed?: boolean }; response: { deleted: boolean } };
			/**
			 * Asks the teammate's own agent to choose its face, in a hidden session
			 * that never touches the human transcript. Falls back to a deterministic
			 * read of the persona text when the agent cannot answer; `source` says
			 * which happened. The face is saved onto the persona before returning.
			 */
			composeFace: {
				params: { personaId: string };
				response: { face: Face; source: "agent" | "fallback" };
			};

			/* ------------------------------------------------------------ fleet
			 * Linking desktops to each other, with the phone as the officiant,
			 * and reading the merged room. All same-LAN in v1. */
			fleetInvite: { params: {}; response: { origin: string; code: string } | { error: string } };
			fleetJoin: {
				params: { origin: string; code: string };
				response: { ok: true; peer: { id: string; name: string } } | { ok: false; error: string };
			};
			fleetRoster: {
				params: {};
				response: { node: { id: string; name: string }; rosters: FleetNodeRoster[] };
			};
			fleetPeers: { params: {}; response: FleetPeerInfo[] };
			/**
			 * Creates a teammate on a linked desktop instead of this one. The
			 * seat is minted there (face and all); this side only learns the
			 * new node-qualified id, which the next roster poll fills in.
			 */
			/**
			 * Clicking a teammate who lives on a linked desktop: opens a window
			 * onto that desktop's own served app, credentialed over the fleet
			 * trust — everything in it runs on that box's wire. Desktop only.
			 */
			openRemoteDesktop: {
				params: { nodeId: string; personaId?: string };
				response: { ok: true } | { ok: false; error: string };
			};
			createPersonaAt: {
				params: { nodeId: string; draft: { name: string; goal?: string; team?: string } };
				response: { ok: true; personaId: string; name: string } | { ok: false; error: string };
			};
			fleetRevoke: { params: { id: string }; response: { revoked: boolean } };
			/** Desktop node admission. Legacy fleet RPCs remain during NodeLink migration. */
			nodeInfo: { params: {}; response: NodeIdentity };
			nodeMembers: { params: {}; response: NodeMemberInfo[] };
			/** The room this desk is in; null until something founds one. */
			roomInfo: { params: {}; response: RoomInfo | null };
			/**
			 * Renames the room — or founds it under that name when none exists,
			 * which is what a fresh setup's naming ask resolves to. Renaming an
			 * existing room is the founder desk's act.
			 */
			roomRename: {
				params: { name: string };
				response: { ok: boolean; room?: RoomInfo; error?: string };
			};
			/** Rewrites a mobile member's desk allow-list. Owner desk only. */
			memberSetGrant: {
				params: { nodeId: string; grant: string[] };
				response: { ok: boolean; error?: string };
			};
			/** Tombstones a mobile membership; every desk learns it. Owner desk only. */
			memberRevoke: {
				params: { nodeId: string };
				response: { revoked: boolean; error?: string };
			};
			/**
			 * The asking phone's own grant, as desks with doors. Answered by the
			 * web wire for member sockets; the desktop webview has no membership
			 * to ask about and gets an unknown-method refusal.
			 */
			myDesktops: {
				params: {};
				response: { room: { id: string; name: string }; desktops: GrantedDesktopInfo[] };
			};
			nodeNearby: { params: {}; response: NearbyNodeInfo[] };
			nodeIncoming: { params: {}; response: IncomingNodeRequestInfo[] };
			nodeOutgoing: { params: {}; response: OutgoingNodeRequestInfo[] };
			nodeRequest: {
				params: { nodeId: string; name: string; origin: string };
				response: { ok: boolean; requestId?: string; error?: string };
			};
			nodeDecide: {
				params: { id: string; decision: "accept" | "deny" };
				response: { ok: boolean; error?: string };
			};
			nodeInvite: { params: {}; response: NodeInvite | { error: string } };
			nodeJoin: {
				params: { origin: string; code: string };
				response: { ok: true; peer: { id: string; name: string } } | { ok: false; error: string };
			};

			/** Rewrites the roster's order to match `ids`; returns the new roster. */
			setPersonaOrder: { params: { ids: string[] }; response: Persona[] };

			listBackends: { params: { refresh?: boolean }; response: Backend[] };

			/** Non-secret auth status and provider-owned setup methods for Toad Agent. */
			listProviderAuth: { params: {}; response: ProviderAuthInfo[] };
			/** Starts a provider-owned OAuth or API-key wizard in the background. */
			startProviderLogin: {
				params: { providerId: string; method: "oauth" | "api_key" };
				response: ProviderAuthFlow;
			};
			getProviderLogin: { params: { flowId: string }; response: ProviderAuthFlow | null };
			answerProviderLogin: {
				params: { flowId: string; value: string };
				response: ProviderAuthFlow;
			};
			cancelProviderLogin: { params: { flowId: string }; response: void };
			logoutProvider: { params: { providerId: string }; response: ProviderAuthInfo[] };

			/** Providers the user defined by URL. Responses never carry a key. */
			listCustomProviders: { params: {}; response: CustomProviderInfo[] };
			/** Upserts one definition; a literal key goes to pi's store, not the file. */
			saveCustomProvider: {
				params: { provider: CustomProviderInput };
				response: CustomProviderInfo[];
			};
			removeCustomProvider: { params: { id: string }; response: CustomProviderInfo[] };

			/** App-wide preferences, as opposed to any one teammate's settings. */
			getAppSettings: { params: {}; response: AppSettings };
			updateAppSettings: { params: Partial<AppSettings>; response: AppSettings };
			/** Credential-safe MCP authorization state and explicit desktop actions. */
			getMcpAuthStatuses: { params: {}; response: McpAuthStatus[] };
			authorizeMcpServer: { params: { serverId: string }; response: McpAuthStatus[] };
			disconnectMcpServer: { params: { serverId: string }; response: McpAuthStatus[] };
			setMcpStaticHeaders: {
				params: { serverId: string; headers: Record<string, string> };
				response: McpAuthStatus[];
			};
			setMcpOAuthClientSecret: {
				params: { serverId: string; clientSecret?: string };
				response: McpAuthStatus[];
			};
			/** Build and storage locations, for the About section. */
			getAppInfo: { params: {}; response: AppInfo };
			/**
			 * Every bundled dependency and the notice that travels with it.
			 * Null when this build shipped without them — a build fault, not a
			 * state the view should paper over.
			 */
			getThirdPartyNotices: { params: {}; response: ThirdPartyNotices | null };
			/** Last known self-update state, including a result from the previous launch. */
			getUpdateStatus: { params: {}; response: UpdateStatus };
			checkForUpdate: { params: {}; response: UpdateStatus };
			downloadUpdate: { params: {}; response: UpdateStatus };
			/** Restarts into the prepared update, or refuses if a teammate is mid-turn. */
			applyUpdate: { params: {}; response: UpdateStatus };
			/**
			 * Rolls every linked desk onto the latest build, one at a time,
			 * this desk last. Resolves when the room is done or the rollout
			 * stopped; progress arrives on `fleetRolloutChanged`.
			 */
			startFleetUpdate: { params: {}; response: FleetRolloutProgress };
			/**
			 * Liveness, for the web wire's heartbeat. Any answer proves the wire —
			 * a desktop too old to know this method refuses it, which proves the
			 * wire just as well.
			 */
			ping: { params: {}; response: true };
			/**
			 * Whether a backend asks before it acts. Reported per backend because it
			 * is that backend's own configuration, and unknowable for most of them.
			 */
			getContainment: { params: { backendId: string }; response: Containment };
			/**
			 * Opens Toad's own data folder. Takes no path on purpose: the webview
			 * naming a directory for the main process to open is a way to have the
			 * app reveal anything on the disk.
			 */
			revealDataFolder: { params: {}; response: void };
			/** The conversation that was open when the app last closed. */
			getLastPersonaId: { params: {}; response: string | null };

			/** Replays Toad's own transcript from disk. */
			loadTranscript: { params: { personaId: string }; response: TranscriptEvent[] };
			/**
			 * Toggle an emoji on a message. Stored on the event and folded back
			 * out over transcriptUpdated, so every screen shows the same marks.
			 */
			toggleReaction: {
				params: { personaId: string; eventId: string; emoji: string };
				response: void;
			};
			/**
			 * Full-text search over one teammate's conversation: chapters by their
			 * notes, then messages by their text. See docs/chapters.md.
			 */
			searchThread: {
				params: { personaId: string; query: string; limit?: number };
				response: { hits: ThreadSearchHit[]; truncated: boolean };
			};
			/** The same search across every teammate's conversation at once. */
			searchAllThreads: {
				params: { query: string; limit?: number };
				response: { hits: GlobalSearchHit[]; truncated: boolean };
			};
			/** The teammate's chapters, newest first. */
			listChapters: { params: { personaId: string }; response: ChapterSummary[] };
			/**
			 * Closes the open chapter now — writing its note — and starts the next
			 * message in a fresh context. Resolves once the session has been swapped.
			 */
			startFreshChapter: { params: { personaId: string }; response: { title?: string } };
			/**
			 * The last thing said in every teammate's transcript, keyed by persona id.
			 * One call rather than one per teammate, because the roster wants them all
			 * at once and there is nothing to show until it has them.
			 */
			listPreviews: { params: {}; response: Record<string, Preview> };
			/**
			 * The same, for this desktop's own teammates only.
			 *
			 * What a linked desktop asks for. `listPreviews` answers with the merge
			 * of every desk in the room, so a peer calling it would be asking us to
			 * ask it — see mergePeerRecords in fleet/wire.ts. The UI has no use for
			 * this one; the wire does.
			 */
			listLocalPreviews: { params: {}; response: Record<string, Preview> };
			/**
			 * A teammate's standing threads with other teammates, newest first. Both
			 * directions of a pair are one thread, because that is what it is to the
			 * person reading it.
			 */
			listPeerThreads: { params: { personaId: string }; response: PeerThreadSummary[] };
			/** One peer thread's own event log, for the viewer. */
			loadPeerThread: { params: { threadKey: string }; response: PeerThread | null };
			/**
			 * Peer-thread activity for every teammate, keyed by persona id. One call
			 * rather than one per teammate, for the same reason listPreviews is one call.
			 */
			listPeerActivity: { params: {}; response: Record<string, PeerActivity> };
			/** This desktop's own slice of the above, for a peer's wire to merge. */
			listLocalPeerActivity: { params: {}; response: Record<string, PeerActivity> };
			/** Scheduled and looping jobs, optionally for one teammate. */
			listSchedules: { params: { personaId?: string }; response: ScheduledJob[] };
			cancelSchedule: { params: { id: string }; response: { cancelled: boolean } };
			/**
			 * Answers a permission request raised inside a peer session. requestId is
			 * globally unique and the main process already owns the waiting session.
			 */
			answerPeerPermission: {
				params: { requestId: string; optionId: string };
				response: { answered: boolean };
			};

			/** Spawns the backend and opens (or restores) an ACP session. */
			startSession: { params: { personaId: string }; response: SessionInfo };
			stopSession: { params: { personaId: string }; response: void };
			getSessionInfo: { params: { personaId: string }; response: SessionInfo };

			/** `replyTo` marks the message this one answers — the true edge, not
			 * an inference from quoting punctuation. */
			sendPrompt: {
				params: { personaId: string; text: string; attachments?: Attachment[]; replyTo?: string };
				response: void;
			};
			/**
			 * Cancels the live turn, then sends this message as its own turn the
			 * moment the cancellation lands — ahead of anything queued behind it.
			 * If nothing is running, it behaves exactly like `sendPrompt`.
			 */
			steerPrompt: {
				params: { personaId: string; text: string; attachments?: Attachment[]; replyTo?: string };
				response: void;
			};
			cancelTurn: { params: { personaId: string }; response: void };

			/** Native open panel for attaching files. Empty when the user backs out. */
			pickAttachments: { params: { personaId: string }; response: Attachment[] };
			/**
			 * Describes local paths named by a paste or a drop, dropping any that are
			 * not really there. The webview can read a `file://` URL off the
			 * pasteboard but cannot check whether it still points at anything.
			 */
			resolveAttachments: { params: { paths: string[] }; response: Attachment[] };
			/**
			 * Tries to find where dropped files came from, so they can be linked
			 * rather than duplicated. Aligned with the fingerprints given; a null
			 * means the caller should fall back to saving the bytes it holds.
			 */
			locateAttachments: {
				params: { prints: { name: string; size: number; lastModified: number }[] };
				response: (Attachment | null)[];
			};
			/**
			 * Writes pasted or dropped bytes into the persona's attachments directory
			 * and hands back the attachment that now points at them.
			 *
			 * The webview cannot write to disk and the main process cannot read the
			 * clipboard's image flavour, so the bytes make one trip across as base64
			 * and are a path from there on.
			 */
			saveAttachment: {
				params: { personaId: string; name: string; mimeType: string; data: string };
				response: Attachment;
			};

			answerPermission: {
				params: { personaId: string; requestId: string; optionId: string };
				response: { answered: boolean };
			};

			setModel: { params: { personaId: string; modelId: string }; response: SessionInfo };
			setMode: { params: { personaId: string; modeId: string }; response: SessionInfo };
			setConfig: {
				params: { personaId: string; configId: string; value: string };
				response: SessionInfo;
			};

			/**
			 * Hands a link from an agent's message to the default browser.
			 *
			 * The scheme is checked on this side of the wire, because the text came
			 * from a model and the webview is the last place that should be deciding
			 * what counts as a safe URL.
			 */
			openLink: { params: { url: string }; response: void };

			/** Web mode: the LAN toggle and the plain URL a phone opens. */
			getWebMode: { params: {}; response: WebModeStatus };
			setWebMode: { params: { enabled: boolean }; response: WebModeStatus };
			/** Linked devices: list, mint a pairing QR, and cut one loose. */
			listWebDevices: { params: {}; response: WebDeviceInfo[] };
			createWebPairing: { params: {}; response: { url: string | null; code: string } };
			revokeWebDevice: { params: { id: string }; response: { revoked: boolean } };

			/**
			 * Push (docs/push.md). The key and its identifiers, and whether this
			 * desktop can sign at all.
			 */
			getPushStatus: { params: {}; response: PushStatus };
			/** The `.p8` as text, plus the two identifiers Apple prints beside it. */
			installPushKey: {
				params: { pem: string; keyId: string; teamId: string; topic?: string };
				response: { ok: boolean; error?: string };
			};
			clearPushKey: { params: {}; response: PushStatus };
			/**
			 * Buzz every registered phone once, on purpose. Answers with what
			 * Apple said, because "nothing happened" is the one useless reply
			 * for someone who has just installed a key.
			 */
			sendTestPush: {
				params: {};
				response: { sent: number; failed: { reason: string }[] };
			};
			/**
			 * A toast on this desktop, on purpose. Skips the "are you looking
			 * at it" rule so the person who just flipped the switch can see
			 * one land.
			 */
			sendTestDesktop: { params: {}; response: { sent: boolean } };
			/**
			 * Whether this desktop's window is focused and visible. Distinct
			 * from `setActivePersona`, which also drives the title and must
			 * not be cleared on blur.
			 */
			setDesktopAttentive: { params: { attentive: boolean }; response: void };
			/**
			 * A paired phone reporting where to buzz it.
			 *
			 * Answered by the web server rather than here, because it is the only
			 * place that knows *which* device is asking — the wire authenticated
			 * one, and the desktop calling this has no phone to register.
			 */
			registerPushDevice: {
				params: { token: string; environment: "sandbox" | "production" };
				response: { registered: boolean };
			};
			/**
			 * A paired phone saying it could not get a token. Same reason the
			 * registration itself is device-scoped: only the wire knows who is
			 * asking, and a failure nobody records is a device count that never
			 * grows with nothing to explain it.
			 */
			reportPushProblem: { params: { reason: string }; response: void };

			/** Answer a hand-to-human card; false when it already settled. */
			answerHumanAction: {
				params: { actionId: string; status: "done" | "dismissed" };
				response: { answered: boolean };
			};

			/** The computer drawer: state without waking, a look, and the screen. */
			computerStatus: { params: { personaId: string }; response: ComputerStatus };
			/** PNG as a data URL when the machine is running; null when asleep. */
			computerScreenshot: { params: { personaId: string }; response: { dataUrl: string | null } };
			/** Recent capture thumbnails, newest first — the drawer's filmstrip. */
			computerFrames: {
				params: { personaId: string };
				response: { frames: Array<{ ts: number; dataUrl: string }> };
			};
			/** The proxy's VNC WebSocket URL (token included); connecting wakes. */
			computerVncUrl: { params: { personaId: string }; response: { url: string } };

			/** Opens the persona's working directory in the OS file manager. */
			revealWorkspace: { params: { personaId: string }; response: void };
			pickWorkspace: { params: { startingFolder?: string }; response: string | null };

			/**
			 * Tells the main process which teammate is in focus, so the window
			 * title, the ⌘1–⌘9 roster, and the enabled state of the Agent menu
			 * all track the selection.
			 */
			setActivePersona: { params: { personaId: string | null }; response: void };

			/** Opens the native right-click menu for a roster row. */
			showPersonaMenu: { params: { personaId: string }; response: void };
			/**
			 * Opens the native right-click menu for a transcript message. The text
			 * travels with it because the copy happens natively: WKWebView's async
			 * clipboard needs a secure context and a live user gesture, and a menu
			 * click that has been through the main process has neither.
			 */
			showMessageMenu: { params: { text: string }; response: void };
			/** Writes text to the system clipboard. Used by the HTML menus on Linux. */
			writeClipboard: { params: { text: string }; response: void };
			/**
			 * PNG bytes off the native clipboard, base64. For platforms whose
			 * webview paste event carries no image (WebKitGTK); null when the
			 * clipboard holds no image.
			 */
			readClipboardImage: { params: {}; response: { data: string } | null };

			/** Linux custom chrome: the native caption is gone, so the strip asks. */
			windowState: { params: {}; response: WindowState };
			windowMinimize: { params: {}; response: WindowState };
			windowMaximizeToggle: { params: {}; response: WindowState };
			windowSetFullScreen: { params: { fullScreen: boolean }; response: WindowState };
			/** Hits will-close, which hides the window rather than ending the process. */
			windowClose: { params: {}; response: void };
			/** Ends the process, the way the tray's Quit does. */
			appQuit: { params: {}; response: void };
			/** Linux edge-resize: the native decorations that would do this are gone. */
			windowGetFrame: { params: {}; response: WindowFrame };
			windowSetFrame: { params: WindowFrame; response: void };
		};
		messages: {
			/** The authoritative roster after any create, update, or delete. */
			personasChanged: Persona[];
			transcriptAppended: { personaId: string; event: TranscriptEvent };
			transcriptUpdated: { personaId: string; event: TranscriptEvent };
			streamDelta: StreamDelta;
			sessionInfoChanged: SessionInfo;
			peerThreadAppended: { threadKey: string; event: TranscriptEvent };
			peerThreadUpdated: { threadKey: string; event: TranscriptEvent };
			peerActivityChanged: Record<string, PeerActivity>;
			schedulesChanged: ScheduledJob[];
			menuAction: MenuAction;
			faceProgress: FaceProgress;
			windowStateChanged: WindowState;
			updateStatusChanged: UpdateStatus;
			fleetRolloutChanged: FleetRolloutProgress;
		};
	}>;
	webview: RPCSchema<{
		requests: {};
		messages: {};
	}>;
};
