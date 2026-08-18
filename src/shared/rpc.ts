import type { RPCSchema } from "electrobun/main";
import type {
	AppInfo,
	AppSettings,
	Attachment,
	Backend,
	Containment,
	Persona,
	PersonaDraft,
	PeerActivity,
	PeerThread,
	PeerThreadSummary,
	Preview,
	SessionInfo,
	StreamDelta,
	TranscriptEvent,
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
	| "copyMessage";

/** `personaId` is absent when the item acted on whatever is currently selected. */
export type MenuAction = { action: MenuActionName; personaId?: string };

export type ToadRPC = {
	bun: RPCSchema<{
		requests: {
			listPersonas: { params: {}; response: Persona[] };
			createPersona: { params: PersonaDraft; response: Persona };
			updatePersona: { params: { id: string; patch: Partial<Persona> }; response: Persona };
			/** Confirms natively first; `deleted` is false when the user backs out. */
			deletePersona: { params: { id: string }; response: { deleted: boolean } };

			listBackends: { params: { refresh?: boolean }; response: Backend[] };

			/** App-wide preferences, as opposed to any one teammate's settings. */
			getAppSettings: { params: {}; response: AppSettings };
			updateAppSettings: { params: Partial<AppSettings>; response: AppSettings };
			/** Build and storage locations, for the About section. */
			getAppInfo: { params: {}; response: AppInfo };
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
			 * The last thing said in every teammate's transcript, keyed by persona id.
			 * One call rather than one per teammate, because the roster wants them all
			 * at once and there is nothing to show until it has them.
			 */
			listPreviews: { params: {}; response: Record<string, Preview> };
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
			/**
			 * Answers a permission request raised inside a peer session. requestId is
			 * globally unique and the main process already owns the waiting session.
			 */
			answerPeerPermission: {
				params: { requestId: string; optionId: string };
				response: void;
			};

			/** Spawns the backend and opens (or restores) an ACP session. */
			startSession: { params: { personaId: string }; response: SessionInfo };
			stopSession: { params: { personaId: string }; response: void };
			getSessionInfo: { params: { personaId: string }; response: SessionInfo };

			sendPrompt: {
				params: { personaId: string; text: string; attachments?: Attachment[] };
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
				response: void;
			};

			setModel: { params: { personaId: string; modelId: string }; response: SessionInfo };
			setMode: { params: { personaId: string; modeId: string }; response: SessionInfo };

			/**
			 * Hands a link from an agent's message to the default browser.
			 *
			 * The scheme is checked on this side of the wire, because the text came
			 * from a model and the webview is the last place that should be deciding
			 * what counts as a safe URL.
			 */
			openLink: { params: { url: string }; response: void };

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
		};
		messages: {
			transcriptAppended: { personaId: string; event: TranscriptEvent };
			transcriptUpdated: { personaId: string; event: TranscriptEvent };
			streamDelta: StreamDelta;
			sessionInfoChanged: SessionInfo;
			peerThreadAppended: { threadKey: string; event: TranscriptEvent };
			peerThreadUpdated: { threadKey: string; event: TranscriptEvent };
			peerActivityChanged: Record<string, PeerActivity>;
			menuAction: MenuAction;
		};
	}>;
	webview: RPCSchema<{
		requests: {};
		messages: {};
	}>;
};
