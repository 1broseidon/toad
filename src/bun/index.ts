import {
	ApplicationMenu,
	BrowserView,
	BrowserWindow,
	ContextMenu,
	Screen,
	Updater,
	Utils,
} from "electrobun/main";
import type { ToadRPC } from "../shared/rpc";
import { randomUUID } from "node:crypto";
import type { Preview } from "../shared/types";
import { CONFIG_FILE, ROOT, ensureLayout } from "./paths";
import {
	describe as describeAttachment,
	locate as locateAttachments,
	resolve as resolveAttachments,
	save as saveAttachment,
} from "./attachments";
import { listBackends } from "./acp/registry";
import { describeContainment } from "./acp/containment";
import { Supervisor } from "./acp/supervisor";
import { PeerSessions } from "./acp/peers";
import { Bridge } from "./mcp/bridge";
import {
	type WindowFrame,
	getLastPersonaId,
	getSettings,
	getWindowFrame,
	setLastPersonaId,
	setWindowFrame,
	updateSettings,
} from "./store/settings";
import {
	createPersona,
	deletePersona,
	getPersona,
	listPersonas,
	updatePersona,
} from "./store/personas";
import * as transcript from "./store/transcript";
import * as threads from "./store/threads";
import { decodeMenuAction, setApplicationMenu, showMessageMenu, showPersonaMenu } from "./menu";

ensureLayout();

// Fold each transcript once at startup so superseded tool and permission lines
// do not accumulate forever.
for (const persona of listPersonas()) transcript.compact(persona.id);
for (const key of threads.listAllKeys()) threads.compact(key);

let mainRPC: { send: (name: string, payload: unknown) => void } | null = null;
const send = (name: string, payload: unknown) => mainRPC?.send(name, payload);

/** Which teammate the menus and the window title currently describe. */
let activePersonaId: string | null = null;

/** The message the open right-click menu would copy. */
let pendingCopy = "";

/**
 * Whether a link out of a message may be handed to the system.
 *
 * Allow-listed rather than filtered: the schemes people actually write in prose
 * are few, and everything else — `javascript:`, `file:`, an app's own custom
 * scheme — is a way to make a click do something other than open a page.
 */
function isSafeLink(url: string): boolean {
	try {
		return ["http:", "https:", "mailto:"].includes(new URL(url).protocol);
	} catch {
		return false;
	}
}

const supervisor = new Supervisor({
	transcriptAppended: (p) => send("transcriptAppended", p),
	transcriptUpdated: (p) => send("transcriptUpdated", p),
	streamDelta: (p) => send("streamDelta", p),
	sessionInfoChanged: (p) => {
		send("sessionInfoChanged", p);
		// Start / Stop / Cancel enable and disable with the session they act on.
		if (p.personaId === activePersonaId) refreshMenu();
	},
});

const peers = new PeerSessions({
	peerThreadAppended: (payload) => send("peerThreadAppended", payload),
	peerThreadUpdated: (payload) => send("peerThreadUpdated", payload),
	peerActivityChanged: (payload) => send("peerActivityChanged", payload),
	transcriptAppended: (payload) => send("transcriptAppended", payload),
	transcriptUpdated: (payload) => send("transcriptUpdated", payload),
});
supervisor.setTranscriptObserver((personaId, event) => peers.observeHumanEvent(personaId, event));

const bridge = new Bridge({ supervisor, peers });
if (!(await bridge.start())) {
	for (const persona of listPersonas()) {
		transcript.append(persona.id, {
			kind: "notice",
			id: randomUUID(),
			ts: Date.now(),
			level: "info",
			text: "Teammate tools are disabled because another Toad instance owns the local bridge.",
		});
	}
}

function refreshMenu() {
	setApplicationMenu({
		personas: listPersonas(),
		activeId: activePersonaId,
		activeState: activePersonaId ? supervisor.info(activePersonaId).state : "idle",
	});
}

const rpc = BrowserView.defineRPC<ToadRPC>({
	maxRequestTime: 120_000,
	handlers: {
		requests: {
			listPersonas: async () => listPersonas(),

			createPersona: async (draft) => {
				const persona = createPersona({
					...draft,
					backendId: draft.backendId ?? getSettings().defaultBackendId,
				});
				refreshMenu();
				return persona;
			},

			updatePersona: async ({ id, patch }) => {
				const persona = updatePersona(id, patch);
				// A rename has to reach the roster in the Agent menu and, when it is
				// the teammate in focus, the window title.
				refreshMenu();
				if (id === activePersonaId) mainWindow?.setTitle(windowTitle(persona.name));
				return persona;
			},

			// Deleting a teammate also destroys its transcript, so it asks first —
			// natively, because a web confirm() in a desktop window reads as a bug.
			deletePersona: async ({ id }) => {
				const persona = getPersona(id);
				if (!persona) return { deleted: false };

				const { response } = await Utils.showMessageBox({
					type: "warning",
					title: "Delete Teammate",
					message: `Delete ${persona.name}?`,
					detail: "Its conversation and session history are deleted with it. This cannot be undone.",
					buttons: ["Delete", "Cancel"],
					defaultId: 1,
					cancelId: 1,
				});
				if (response !== 0) return { deleted: false };

				await supervisor.stop(id);
				await peers.dropPersona(id);
				threads.dropPersona(id);
				deletePersona(id);
				refreshMenu();
				return { deleted: true };
			},

			listBackends: async ({ refresh }) => listBackends(refresh ?? false),

			getAppSettings: async () => getSettings(),
			updateAppSettings: async (patch) => updateSettings(patch),

			getAppInfo: async () => {
				const local = await Updater.getLocalInfo();
				return {
					// In dev there is no bundled version.json, so these come back empty
					// rather than wrong. The screen says so instead of inventing a build.
					name: local.name || "Toad",
					version: local.version,
					channel: local.channel,
					identifier: local.identifier,
					dataDir: ROOT,
					configFile: CONFIG_FILE,
				};
			},

			getContainment: async ({ backendId }) => describeContainment(backendId),

			revealDataFolder: async () => {
				Utils.openPath(ROOT);
			},

			loadTranscript: async ({ personaId }) => transcript.load(personaId),

			listPreviews: async () => {
				const previews: Record<string, Preview> = {};
				for (const persona of listPersonas()) {
					const last = transcript.preview(persona.id);
					if (last) previews[persona.id] = last;
				}
				return previews;
			},

			listPeerThreads: async ({ personaId }) => peers.summariesFor(personaId),
			loadPeerThread: async ({ threadKey }) => peers.loadThread(threadKey),
			listPeerActivity: async () => peers.activity(),
			answerPeerPermission: async ({ requestId, optionId }) => {
				peers.answerPermission(requestId, optionId);
			},

			startSession: async ({ personaId }) => supervisor.start(personaId),
			stopSession: async ({ personaId }) => supervisor.stop(personaId),
			getSessionInfo: async ({ personaId }) => supervisor.info(personaId),

			sendPrompt: async ({ personaId, text, attachments }) => {
				// Deliberately not awaited: a turn can run for minutes, and the UI
				// follows progress through the update stream rather than this reply.
				void supervisor.prompt(personaId, text, attachments);
			},

			/* Attaching starts in the teammate's own working directory. Whatever the
			 * conversation is about is far more likely to be in there than in
			 * whichever folder was last opened somewhere else in the app. */
			pickAttachments: async ({ personaId }) => {
				const paths = await Utils.openFileDialog({
					startingFolder: getPersona(personaId)?.cwd ?? "~",
					canChooseFiles: true,
					canChooseDirectory: false,
					allowsMultipleSelection: true,
				});
				return (paths ?? []).map(describeAttachment);
			},

			saveAttachment: async ({ personaId, name, mimeType, data }) =>
				saveAttachment(personaId, name, mimeType, data),

			resolveAttachments: async ({ paths }) => resolveAttachments(paths),

			locateAttachments: async ({ prints }) => locateAttachments(prints),

			cancelTurn: async ({ personaId }) => supervisor.cancel(personaId),

			answerPermission: async ({ personaId, requestId, optionId }) => {
				supervisor.answerPermission(personaId, requestId, optionId);
			},

			setModel: async ({ personaId, modelId }) => supervisor.setModel(personaId, modelId),
			setMode: async ({ personaId, modeId }) => supervisor.setMode(personaId, modeId),

			openLink: async ({ url }) => {
				if (isSafeLink(url)) Utils.openExternal(url);
			},

			revealWorkspace: async ({ personaId }) => {
				const persona = getPersona(personaId);
				if (persona) Utils.openPath(persona.cwd);
			},

			pickWorkspace: async ({ startingFolder }) => {
				const paths = await Utils.openFileDialog({
					startingFolder: startingFolder ?? "~",
					canChooseFiles: false,
					canChooseDirectory: true,
					allowsMultipleSelection: false,
				});
				return paths?.[0] ?? null;
			},

			setActivePersona: async ({ personaId }) => {
				activePersonaId = personaId;
				setLastPersonaId(personaId ?? undefined);
				const name = personaId ? getPersona(personaId)?.name : undefined;
				mainWindow?.setTitle(windowTitle(name));
				refreshMenu();
			},

			/** Which conversation was open last, so the app reopens where you left it. */
			getLastPersonaId: async () => {
				const id = getLastPersonaId();
				// A teammate deleted since then must not leave the app pointing at a
				// conversation that no longer exists.
				return id && getPersona(id) ? id : null;
			},

			showPersonaMenu: async ({ personaId }) => {
				const persona = getPersona(personaId);
				if (persona) showPersonaMenu(persona, supervisor.info(personaId).state);
			},

			showMessageMenu: async ({ text }) => {
				pendingCopy = text;
				showMessageMenu();
			},
		},
	},
});

/** The active teammate reads in the Window menu, Mission Control, and ⌘-Tab. */
const windowTitle = (personaName?: string) =>
	personaName ? `${personaName} — Toad` : "Toad";

const DEV_SERVER_URL = "http://localhost:5173";

async function mainViewUrl(): Promise<string> {
	const channel = await Updater.localInfo.channel();
	if (channel === "dev") {
		try {
			await fetch(DEV_SERVER_URL, { method: "HEAD" });
			return DEV_SERVER_URL;
		} catch {
			/* fall through to the bundled view */
		}
	}
	return "views://mainview/index.html";
}

const DEFAULT_FRAME: WindowFrame = { width: 1280, height: 860, x: 120, y: 90 };
const MIN_FRAME = { width: 520, height: 420 };

/**
 * The remembered frame, if it would still land somewhere you can see.
 *
 * A window restored onto a display that has since been unplugged is not a
 * window: it opens at coordinates no screen covers and the app looks like it
 * failed to start. Overlap is enough — a frame hanging off the side of a screen
 * is normal and macOS will keep the titlebar reachable — but a frame that
 * touches nothing is discarded for the default.
 */
function restorableFrame(): WindowFrame {
	const saved = getWindowFrame();
	if (!saved) return DEFAULT_FRAME;
	if (saved.width < MIN_FRAME.width || saved.height < MIN_FRAME.height) return DEFAULT_FRAME;

	const areas = Screen.getAllDisplays().map((display) => display.workArea);
	// No displays reported means the query failed, not that there are none.
	if (areas.length === 0) return saved;

	const onScreen = areas.some(
		(area) =>
			saved.x < area.x + area.width &&
			saved.x + saved.width > area.x &&
			saved.y < area.y + area.height &&
			saved.y + saved.height > area.y,
	);
	return onScreen ? saved : DEFAULT_FRAME;
}

/*
 * `hiddenInset` keeps the window titled — so the traffic lights stay the
 * system's and the top strip still drags — while handing the whole surface to
 * the webview, which lets our own paper run to the top edge with no seam.
 *
 * The lights cannot be moved: Electrobun accepts `trafficLightOffset` but its
 * native layer ignores the value, and `UnifiedTitleAndToolbar` does not make
 * AppKit re-centre them either. They sit centred on y=13.5, so the toolbar in
 * the webview is built to that line rather than fighting it.
 */
const mainWindow = new BrowserWindow({
	title: "Toad",
	url: await mainViewUrl(),
	frame: restorableFrame(),
	titleBarStyle: "hiddenInset",
	rpc,
});

/*
 * Sampled rather than event-driven: Electrobun exposes the frame but emits no
 * resize or move event, and reading it is a cheap synchronous call. Writing only
 * on change means a drag costs a handful of writes and then nothing, and the
 * frame is already on disk however the app ends — including a force quit, which
 * runs no exit handler.
 */
let lastFrame = "";
setInterval(() => {
	try {
		const frame = mainWindow.getFrame();
		if (frame.width < MIN_FRAME.width || frame.height < MIN_FRAME.height) return;
		const seen = JSON.stringify(frame);
		if (seen === lastFrame) return;
		lastFrame = seen;
		setWindowFrame(frame);
	} catch {
		/* the window is gone; there is nothing left to remember */
	}
}, 1_000).unref();

mainRPC = mainWindow.webview.rpc as unknown as typeof mainRPC;

ApplicationMenu.on("application-menu-clicked", (event) => forwardMenuClick(event));
ContextMenu.on("context-menu-clicked", (event) => forwardMenuClick(event));

/* Menus name an intent; the webview decides what it means — except for Copy,
 * which is served here because the clipboard is a native surface. */
function forwardMenuClick(event: unknown) {
	const { action } = (event as { data?: { action?: string } }).data ?? {};
	const decoded = action ? decodeMenuAction(action) : null;
	if (!decoded) return;
	if (decoded.action === "copyMessage") {
		if (pendingCopy) Utils.clipboardWriteText(pendingCopy);
		return;
	}
	send("menuAction", decoded);
}

refreshMenu();

process.on("exit", () => {
	void supervisor.stopAll();
	void peers.stopAll();
	bridge.stop();
});
