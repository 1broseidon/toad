import { Electroview } from "electrobun/view";
import type { FaceProgress, MenuAction, WindowFrame, WindowState } from "../shared/rpc";
import type { Face } from "../shared/face";
import { connect } from "./bridge";
import type {
	AppInfo,
	AppSettings,
	Attachment,
	Backend,
	ComputerStatus,
	Containment,
	Persona,
	PersonaDraft,
	PeerActivity,
	PeerThread,
	PeerThreadSummary,
	Preview,
	ScheduledJob,
	ProviderAuthFlow,
	ProviderAuthInfo,
	SessionInfo,
	StreamDelta,
	TranscriptEvent,
} from "../shared/types";

type TranscriptMessage = { personaId: string; event: TranscriptEvent };
type PeerThreadMessage = { threadKey: string; event: TranscriptEvent };

type EventMap = {
	transcriptAppended: TranscriptMessage;
	transcriptUpdated: TranscriptMessage;
	streamDelta: StreamDelta;
	sessionInfoChanged: SessionInfo;
	peerThreadAppended: PeerThreadMessage;
	peerThreadUpdated: PeerThreadMessage;
	peerActivityChanged: Record<string, PeerActivity>;
	schedulesChanged: ScheduledJob[];
	menuAction: MenuAction;
	faceProgress: FaceProgress;
	windowStateChanged: WindowState;
};

const listeners: { [K in keyof EventMap]: Set<(payload: EventMap[K]) => void> } = {
	transcriptAppended: new Set(),
	transcriptUpdated: new Set(),
	streamDelta: new Set(),
	sessionInfoChanged: new Set(),
	peerThreadAppended: new Set(),
	peerThreadUpdated: new Set(),
	peerActivityChanged: new Set(),
	schedulesChanged: new Set(),
	menuAction: new Set(),
	faceProgress: new Set(),
	windowStateChanged: new Set(),
};

function fanOut<K extends keyof EventMap>(event: K) {
	return (payload: EventMap[K]) => {
		for (const listener of listeners[event]) listener(payload);
	};
}

const rpc = Electroview.defineRPC<never>({
	maxRequestTime: 120_000,
	handlers: {
		requests: {},
		messages: {
			transcriptAppended: fanOut("transcriptAppended"),
			transcriptUpdated: fanOut("transcriptUpdated"),
			streamDelta: fanOut("streamDelta"),
			sessionInfoChanged: fanOut("sessionInfoChanged"),
			peerThreadAppended: fanOut("peerThreadAppended"),
			peerThreadUpdated: fanOut("peerThreadUpdated"),
			peerActivityChanged: fanOut("peerActivityChanged"),
			schedulesChanged: fanOut("schedulesChanged"),
			menuAction: fanOut("menuAction"),
			faceProgress: fanOut("faceProgress"),
			windowStateChanged: fanOut("windowStateChanged"),
		},
	},
} as never);

connect("app", rpc);

// A hot reload of this file would build a second Electroview on the same page.
// The first wire's replies get dropped, and every request hangs until timeout —
// which is the window that says Loading and never stops. So on any hot update,
// escalate to a full page reload instead. The invalidate() has to live inside
// accept(): called at module scope it fires on the initial load too, and Vite
// re-runs the module — creating the very duplicate this is here to prevent.
if (import.meta.hot) {
	// Bun's import.meta.hot types shadow Vite's and omit invalidate().
	const hot = import.meta.hot as unknown as { invalidate?: () => void };
	import.meta.hot.accept(() => hot.invalidate?.());
}

/** Subscribes to a main-process message. Returns an unsubscribe function. */
export function on<K extends keyof EventMap>(
	event: K,
	handler: (payload: EventMap[K]) => void,
): () => void {
	listeners[event].add(handler);
	return () => listeners[event].delete(handler);
}

const request = (method: string, params: unknown = {}): Promise<unknown> =>
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	((rpc as any).request[method] as (p: unknown) => Promise<unknown>)(params);

export const api = {
	listPersonas: () => request("listPersonas") as Promise<Persona[]>,
	createPersona: (draft: PersonaDraft) => request("createPersona", draft) as Promise<Persona>,
	updatePersona: (id: string, patch: Partial<Persona>) =>
		request("updatePersona", { id, patch }) as Promise<Persona>,
	deletePersona: (id: string) =>
		request("deletePersona", { id }) as Promise<{ deleted: boolean }>,
	composeFace: (personaId: string) =>
		request("composeFace", { personaId }) as Promise<{
			face: Face;
			source: "agent" | "fallback";
		}>,

	listBackends: (refresh = false) => request("listBackends", { refresh }) as Promise<Backend[]>,

	listProviderAuth: () => request("listProviderAuth") as Promise<ProviderAuthInfo[]>,
	startProviderLogin: (providerId: string, method: "oauth" | "api_key") =>
		request("startProviderLogin", { providerId, method }) as Promise<ProviderAuthFlow>,
	getProviderLogin: (flowId: string) =>
		request("getProviderLogin", { flowId }) as Promise<ProviderAuthFlow | null>,
	answerProviderLogin: (flowId: string, value: string) =>
		request("answerProviderLogin", { flowId, value }) as Promise<ProviderAuthFlow>,
	cancelProviderLogin: (flowId: string) =>
		request("cancelProviderLogin", { flowId }) as Promise<void>,
	logoutProvider: (providerId: string) =>
		request("logoutProvider", { providerId }) as Promise<ProviderAuthInfo[]>,

	getAppSettings: () => request("getAppSettings") as Promise<AppSettings>,
	updateAppSettings: (patch: Partial<AppSettings>) =>
		request("updateAppSettings", patch) as Promise<AppSettings>,
	getAppInfo: () => request("getAppInfo") as Promise<AppInfo>,
	getContainment: (backendId: string) =>
		request("getContainment", { backendId }) as Promise<Containment>,
	revealDataFolder: () => request("revealDataFolder") as Promise<void>,
	getLastPersonaId: () => request("getLastPersonaId") as Promise<string | null>,

	loadTranscript: (personaId: string) =>
		request("loadTranscript", { personaId }) as Promise<TranscriptEvent[]>,
	listPreviews: () => request("listPreviews") as Promise<Record<string, Preview>>,
	listPeerThreads: (personaId: string) =>
		request("listPeerThreads", { personaId }) as Promise<PeerThreadSummary[]>,
	loadPeerThread: (threadKey: string) =>
		request("loadPeerThread", { threadKey }) as Promise<PeerThread | null>,
	listPeerActivity: () =>
		request("listPeerActivity") as Promise<Record<string, PeerActivity>>,
	listSchedules: (personaId?: string) =>
		request("listSchedules", { personaId }) as Promise<ScheduledJob[]>,
	cancelSchedule: (id: string) =>
		request("cancelSchedule", { id }) as Promise<{ cancelled: boolean }>,
	answerPeerPermission: (requestId: string, optionId: string) =>
		request("answerPeerPermission", { requestId, optionId }) as Promise<void>,

	startSession: (personaId: string) => request("startSession", { personaId }) as Promise<SessionInfo>,
	stopSession: (personaId: string) => request("stopSession", { personaId }) as Promise<void>,
	getSessionInfo: (personaId: string) =>
		request("getSessionInfo", { personaId }) as Promise<SessionInfo>,

	sendPrompt: (personaId: string, text: string, attachments?: Attachment[]) =>
		request("sendPrompt", { personaId, text, attachments }) as Promise<void>,
	steerPrompt: (personaId: string, text: string, attachments?: Attachment[]) =>
		request("steerPrompt", { personaId, text, attachments }) as Promise<void>,
	cancelTurn: (personaId: string) => request("cancelTurn", { personaId }) as Promise<void>,

	pickAttachments: (personaId: string) =>
		request("pickAttachments", { personaId }) as Promise<Attachment[]>,
	resolveAttachments: (paths: string[]) =>
		request("resolveAttachments", { paths }) as Promise<Attachment[]>,
	locateAttachments: (prints: { name: string; size: number; lastModified: number }[]) =>
		request("locateAttachments", { prints }) as Promise<(Attachment | null)[]>,
	saveAttachment: (personaId: string, name: string, mimeType: string, data: string) =>
		request("saveAttachment", { personaId, name, mimeType, data }) as Promise<Attachment>,
	readClipboardImage: () =>
		request("readClipboardImage") as Promise<{ data: string } | null>,

	answerPermission: (personaId: string, requestId: string, optionId: string) =>
		request("answerPermission", { personaId, requestId, optionId }) as Promise<void>,

	setModel: (personaId: string, modelId: string) =>
		request("setModel", { personaId, modelId }) as Promise<SessionInfo>,
	setMode: (personaId: string, modeId: string) =>
		request("setMode", { personaId, modeId }) as Promise<SessionInfo>,
	setConfig: (personaId: string, configId: string, value: string) =>
		request("setConfig", { personaId, configId, value }) as Promise<SessionInfo>,

	openLink: (url: string) => request("openLink", { url }) as Promise<void>,

	answerHumanAction: (actionId: string, status: "done" | "dismissed") =>
		request("answerHumanAction", { actionId, status }) as Promise<{ answered: boolean }>,

	computerStatus: (personaId: string) =>
		request("computerStatus", { personaId }) as Promise<ComputerStatus>,
	computerScreenshot: (personaId: string) =>
		request("computerScreenshot", { personaId }) as Promise<{ dataUrl: string | null }>,
	computerVncUrl: (personaId: string) =>
		request("computerVncUrl", { personaId }) as Promise<{ url: string }>,

	revealWorkspace: (personaId: string) => request("revealWorkspace", { personaId }) as Promise<void>,
	pickWorkspace: (startingFolder?: string) =>
		request("pickWorkspace", { startingFolder }) as Promise<string | null>,

	setActivePersona: (personaId: string | null) =>
		request("setActivePersona", { personaId }) as Promise<void>,
	showPersonaMenu: (personaId: string) =>
		request("showPersonaMenu", { personaId }) as Promise<void>,
	showMessageMenu: (text: string) => request("showMessageMenu", { text }) as Promise<void>,
	writeClipboard: (text: string) => request("writeClipboard", { text }) as Promise<void>,

	windowState: () => request("windowState") as Promise<WindowState>,
	windowMinimize: () => request("windowMinimize") as Promise<WindowState>,
	windowMaximizeToggle: () => request("windowMaximizeToggle") as Promise<WindowState>,
	windowSetFullScreen: (fullScreen: boolean) =>
		request("windowSetFullScreen", { fullScreen }) as Promise<WindowState>,
	windowClose: () => request("windowClose") as Promise<void>,
	appQuit: () => request("appQuit") as Promise<void>,
	windowGetFrame: () => request("windowGetFrame") as Promise<WindowFrame>,
	windowSetFrame: (frame: WindowFrame) => request("windowSetFrame", frame) as Promise<void>,
};
