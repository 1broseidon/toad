import Electrobun, { Electroview } from "electrobun/view";
import type { MenuAction } from "../shared/rpc";
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
	menuAction: MenuAction;
};

const listeners: { [K in keyof EventMap]: Set<(payload: EventMap[K]) => void> } = {
	transcriptAppended: new Set(),
	transcriptUpdated: new Set(),
	streamDelta: new Set(),
	sessionInfoChanged: new Set(),
	peerThreadAppended: new Set(),
	peerThreadUpdated: new Set(),
	peerActivityChanged: new Set(),
	menuAction: new Set(),
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
			menuAction: fanOut("menuAction"),
		},
	},
} as never);

const electrobun = new Electrobun.Electroview({ rpc });

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
	((electrobun as any).rpc.request[method] as (p: unknown) => Promise<unknown>)(params);

export const api = {
	listPersonas: () => request("listPersonas") as Promise<Persona[]>,
	createPersona: (draft: PersonaDraft) => request("createPersona", draft) as Promise<Persona>,
	updatePersona: (id: string, patch: Partial<Persona>) =>
		request("updatePersona", { id, patch }) as Promise<Persona>,
	deletePersona: (id: string) =>
		request("deletePersona", { id }) as Promise<{ deleted: boolean }>,

	listBackends: (refresh = false) => request("listBackends", { refresh }) as Promise<Backend[]>,

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
	answerPeerPermission: (requestId: string, optionId: string) =>
		request("answerPeerPermission", { requestId, optionId }) as Promise<void>,

	startSession: (personaId: string) => request("startSession", { personaId }) as Promise<SessionInfo>,
	stopSession: (personaId: string) => request("stopSession", { personaId }) as Promise<void>,
	getSessionInfo: (personaId: string) =>
		request("getSessionInfo", { personaId }) as Promise<SessionInfo>,

	sendPrompt: (personaId: string, text: string, attachments?: Attachment[]) =>
		request("sendPrompt", { personaId, text, attachments }) as Promise<void>,
	cancelTurn: (personaId: string) => request("cancelTurn", { personaId }) as Promise<void>,

	pickAttachments: (personaId: string) =>
		request("pickAttachments", { personaId }) as Promise<Attachment[]>,
	resolveAttachments: (paths: string[]) =>
		request("resolveAttachments", { paths }) as Promise<Attachment[]>,
	locateAttachments: (prints: { name: string; size: number; lastModified: number }[]) =>
		request("locateAttachments", { prints }) as Promise<(Attachment | null)[]>,
	saveAttachment: (personaId: string, name: string, mimeType: string, data: string) =>
		request("saveAttachment", { personaId, name, mimeType, data }) as Promise<Attachment>,

	answerPermission: (personaId: string, requestId: string, optionId: string) =>
		request("answerPermission", { personaId, requestId, optionId }) as Promise<void>,

	setModel: (personaId: string, modelId: string) =>
		request("setModel", { personaId, modelId }) as Promise<SessionInfo>,
	setMode: (personaId: string, modeId: string) =>
		request("setMode", { personaId, modeId }) as Promise<SessionInfo>,

	openLink: (url: string) => request("openLink", { url }) as Promise<void>,

	revealWorkspace: (personaId: string) => request("revealWorkspace", { personaId }) as Promise<void>,
	pickWorkspace: (startingFolder?: string) =>
		request("pickWorkspace", { startingFolder }) as Promise<string | null>,

	setActivePersona: (personaId: string | null) =>
		request("setActivePersona", { personaId }) as Promise<void>,
	showPersonaMenu: (personaId: string) =>
		request("showPersonaMenu", { personaId }) as Promise<void>,
	showMessageMenu: (text: string) => request("showMessageMenu", { text }) as Promise<void>,
};
