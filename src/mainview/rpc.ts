import type { FaceProgress, MenuAction, WindowFrame, WindowState } from "../shared/rpc";
import type { Face } from "../shared/face";
import type {
	AppInfo,
	AppSettings,
	Attachment,
	Backend,
	ChapterSummary,
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
	PushStatus,
	SessionInfo,
	StreamDelta,
	ThreadSearchHit,
	TranscriptEvent,
	WebDeviceInfo,
	WebModeStatus,
} from "../shared/types";
import { nativeShell, webClient } from "./platform";
import type { WebSession, WebTarget } from "./web-transport";

type TranscriptMessage = { personaId: string; event: TranscriptEvent };
type PeerThreadMessage = { threadKey: string; event: TranscriptEvent };

type EventMap = {
	personasChanged: Persona[];
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
	personasChanged: new Set(),
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

/* The web wire coming back after a drop. Not in EventMap: it is news about
 * the wire itself, not a push that rode it — and pushes missed while it was
 * down are simply gone. Hooks holding push-fed state subscribe to refetch
 * the truth. The hosted channel never drops, so on the desktop this never
 * fires. */
const restored = new Set<() => void>();
const notifyRestored = () => {
	for (const listener of restored) listener();
};

/** Runs the handler each time the web wire reconnects. Returns unsubscribe. */
export function onWireRestored(handler: () => void): () => void {
	restored.add(handler);
	return () => restored.delete(handler);
}

const dispatch = (event: string, payload: unknown) => {
	const set = listeners[event as keyof EventMap];
	if (!set) return;
	for (const listener of set) listener(payload as never);
};

/**
 * Which wire this page is on.
 *
 * Electrobun's host injects `__electrobun`; its presence means this is the
 * app's own webview and the native channel applies. Without it this is web
 * mode — a plain browser (a phone on the LAN) — and the same contract rides
 * a WebSocket instead. Both transports are loaded dynamically so neither
 * ships its machinery to the other's page.
 *
 * The native shell is web mode with the question of *which* desktop left
 * open: it is served by nobody, so there is nothing to assume and no wire
 * until `setWebTarget` names one. The browser still connects on sight,
 * because the desktop that served the page is the only answer there is.
 */
const hosted = typeof (window as { __electrobunPlatform?: unknown }).__electrobunPlatform !== "undefined";

type Invoke = (method: string, params?: unknown) => Promise<unknown>;

/* Said rather than hung: everything above this waits on an answer, and a
 * request that never settles is indistinguishable from a slow desktop. */
const notConnected: Invoke = () => Promise.reject(new Error("no Toad instance connected"));

let transport: Promise<Invoke> = hosted
	? import("./host-transport").then(({ connectHost }) => connectHost(Object.keys(listeners), dispatch))
	: nativeShell()
		? Promise.resolve(notConnected)
		: import("./web-transport").then(({ connectWeb }) =>
				connectWeb(dispatch, { onReopen: notifyRestored }),
			);

let session: WebSession | null = null;
/* Which switch is the current one. Two taps in a row while the first socket
 * is still opening would otherwise leave the loser connected — nothing is
 * holding it, and it would go on reconnecting to a desktop nobody chose. */
let generation = 0;

/**
 * Points the wire at a desktop, taking down whichever one it was on.
 *
 * Native only: on the desktop there is one channel, and in a browser the
 * page's own origin is the target by definition.
 */
export async function setWebTarget(
	target: WebTarget | null,
	hooks?: { onRevoked?: () => void; onStatus?: (status: "connecting" | "open" | "reconnecting") => void },
): Promise<void> {
	const mine = ++generation;
	session?.close();
	session = null;
	if (!target) {
		transport = Promise.resolve(notConnected);
		return;
	}
	const opening = import("./web-transport").then(({ connectWebSession }) =>
		connectWebSession(dispatch, {
			target,
			onRevoked: hooks?.onRevoked,
			onStatus: hooks?.onStatus,
			onReopen: notifyRestored,
		}),
	);
	// Assigned before the socket exists, so a request made in the same tick
	// queues on it rather than landing on the transport just replaced.
	transport = opening.then(({ invoke }) => invoke);
	let opened: WebSession;
	try {
		opened = await opening;
	} catch {
		if (mine === generation) transport = Promise.resolve(notConnected);
		return;
	}
	if (mine !== generation) {
		opened.close();
		return;
	}
	session = opened;
}

// A hot reload of this file would build a second wire on the same page. The
// first wire's replies get dropped, and every request hangs until timeout —
// which is the window that says Loading and never stops. So on any hot
// update, escalate to a full page reload instead. The invalidate() has to
// live inside accept(): called at module scope it fires on the initial load
// too, and Vite re-runs the module — creating the very duplicate this is
// here to prevent.
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

const request = async (method: string, params: unknown = {}): Promise<unknown> =>
	(await transport)(method, params);

export const api = {
	listPersonas: () => request("listPersonas") as Promise<Persona[]>,
	createPersona: (draft: PersonaDraft) => request("createPersona", draft) as Promise<Persona>,
	updatePersona: (id: string, patch: Partial<Persona>) =>
		request("updatePersona", { id, patch }) as Promise<Persona>,
	deletePersona: (id: string, confirmed = false) =>
		request("deletePersona", { id, confirmed }) as Promise<{ deleted: boolean }>,
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
	toggleReaction: (personaId: string, eventId: string, emoji: string) =>
		request("toggleReaction", { personaId, eventId, emoji }) as Promise<void>,
	searchThread: (personaId: string, query: string, limit?: number) =>
		request("searchThread", { personaId, query, limit }) as Promise<{
			hits: ThreadSearchHit[];
			truncated: boolean;
		}>,
	listChapters: (personaId: string) =>
		request("listChapters", { personaId }) as Promise<ChapterSummary[]>,
	startFreshChapter: (personaId: string) =>
		request("startFreshChapter", { personaId }) as Promise<{ title?: string }>,
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

	sendPrompt: (personaId: string, text: string, attachments?: Attachment[], replyTo?: string) =>
		request("sendPrompt", { personaId, text, attachments, replyTo }) as Promise<void>,
	steerPrompt: (personaId: string, text: string, attachments?: Attachment[], replyTo?: string) =>
		request("steerPrompt", { personaId, text, attachments, replyTo }) as Promise<void>,
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

	openLink: (url: string) => {
		/* The desktop's handler calls openExternal — on *its* screen. A link
		 * tapped on the phone opens on the phone; WKWebView hands external
		 * origins to Safari. The scheme guard mirrors the desktop's. */
		if (!hosted && webClient()) {
			try {
				if (["http:", "https:", "mailto:"].includes(new URL(url).protocol)) {
					window.open(url, "_blank", "noopener");
				}
			} catch {}
			return Promise.resolve();
		}
		return request("openLink", { url }) as Promise<void>;
	},

	getWebMode: () => request("getWebMode") as Promise<WebModeStatus>,
	setWebMode: (enabled: boolean) => request("setWebMode", { enabled }) as Promise<WebModeStatus>,
	listWebDevices: () => request("listWebDevices") as Promise<WebDeviceInfo[]>,
	createWebPairing: () =>
		request("createWebPairing") as Promise<{ url: string | null; code: string }>,
	revokeWebDevice: (id: string) =>
		request("revokeWebDevice", { id }) as Promise<{ revoked: boolean }>,

	registerPushDevice: (token: string, environment: "sandbox" | "production") =>
		request("registerPushDevice", { token, environment }) as Promise<{ registered: boolean }>,
	reportPushProblem: (reason: string) => request("reportPushProblem", { reason }) as Promise<void>,

	getPushStatus: () => request("getPushStatus") as Promise<PushStatus>,
	installPushKey: (pem: string, keyId: string, teamId: string, topic?: string) =>
		request("installPushKey", { pem, keyId, teamId, topic }) as Promise<{ ok: boolean; error?: string }>,
	clearPushKey: () => request("clearPushKey") as Promise<PushStatus>,
	sendTestPush: () =>
		request("sendTestPush") as Promise<{ sent: number; failed: { reason: string }[] }>,

	answerHumanAction: (actionId: string, status: "done" | "dismissed") =>
		request("answerHumanAction", { actionId, status }) as Promise<{ answered: boolean }>,

	computerStatus: (personaId: string) =>
		request("computerStatus", { personaId }) as Promise<ComputerStatus>,
	computerScreenshot: (personaId: string) =>
		request("computerScreenshot", { personaId }) as Promise<{ dataUrl: string | null }>,
	computerFrames: (personaId: string) =>
		request("computerFrames", { personaId }) as Promise<{
			frames: Array<{ ts: number; dataUrl: string }>;
		}>,
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
