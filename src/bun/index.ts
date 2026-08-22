import {
	ApplicationMenu,
	app,
	BrowserView,
	BrowserWindow,
	ContextMenu,
	Screen,
	Updater,
	Utils,
} from "electrobun/main";
import { MIN_WINDOW, type ToadRPC, type WindowState } from "../shared/rpc";
import { windowTitle } from "../shared/menu";
import { randomUUID } from "node:crypto";
import { platform } from "node:os";
import type { Persona, Preview } from "../shared/types";
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
import { composePersonaFace } from "./agent/face";
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
import { createPairing, listDevices } from "./web/devices";
import {
	pairingUrl,
	revokeWebDevice,
	startWebMode,
	stopWebMode,
	webBroadcast,
	webModeStatus,
} from "./web/server";
import { recentFrames } from "./computer/frames";
import { answerHuman, configureHandoff } from "./computer/handoff";
import { computerStatus, runningEndpoint, startComputerSweeper } from "./computer/manager";
import { computerVncUrl } from "./computer/proxy";
import { Scheduler, wakeTeammate } from "./schedule";
import { decodeMenuAction, setApplicationMenu, showMessageMenu, showPersonaMenu } from "./menu";
import { createTray } from "./tray";

ensureLayout();
console.log(`Toad starting — data at ${ROOT}`);

// Fold each transcript once at startup so superseded tool and permission lines
// do not accumulate forever.
for (const persona of listPersonas()) transcript.compact(persona.id);
for (const key of threads.listAllKeys()) threads.compact(key);

// Teammate computers idle down on their own: stop after minutes, rm after
// days (docs/computer.md §Lifecycle). Wake is lazy, on the first tool call.
startComputerSweeper();

let mainRPC: { send: (name: string, payload: unknown) => void } | null = null;
const send = (name: string, payload: unknown) => {
	mainRPC?.send(name, payload);
	// Phones on web mode hear everything the desktop webview hears.
	webBroadcast(name, payload);
};

/** Which teammate the menus and the window title currently describe. */
let activePersonaId: string | null = null;

/** The message the open right-click menu would copy. */
let pendingCopy = "";

/** GTK trails maximize(); poll must not revert the icon until native agrees. */
let pendingMaximize: boolean | null = null;
let lastWinState = "";

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

/*
 * MCP tools are fixed when a session starts. Tool settings changed during a
 * reply wait for its ready edge; idle sessions restart immediately. Nothing
 * interrupts a turn, and a stopped/error session simply picks up the new tools
 * when the user starts it again.
 */
const pendingToolRestarts = new Set<string>();

const supervisor = new Supervisor({
	transcriptAppended: (p) => send("transcriptAppended", p),
	transcriptUpdated: (p) => send("transcriptUpdated", p),
	streamDelta: (p) => send("streamDelta", p),
	sessionInfoChanged: (p) => {
		send("sessionInfoChanged", p);
		// Start / Stop / Cancel enable and disable with the session they act on.
		if (p.personaId === activePersonaId) refreshMenu();
		// Session state is the only thing the menu bar reports, so it is the only
		// thing that has to redraw it.
		tray?.refresh();
		if (p.state === "ready" && pendingToolRestarts.delete(p.personaId)) {
			restartForToolChange(p.personaId);
		} else if (
			(p.state === "idle" || p.state === "stopped" || p.state === "error") &&
			pendingToolRestarts.has(p.personaId)
		) {
			// There is no live tool catalog to replace; the next start reads the
			// latest persona from disk.
			pendingToolRestarts.delete(p.personaId);
		}
	},
});

function restartForToolChange(personaId: string): void {
	void (async () => {
		await supervisor.stop(personaId);
		await supervisor.start(personaId);
	})().catch((error) => {
		console.error(
			`Could not restart ${personaId} after its tools changed: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	});
}

function applyToolChange(personaId: string): void {
	const state = supervisor.info(personaId).state;
	if (state === "ready") {
		restartForToolChange(personaId);
	} else if (state === "thinking" || state === "starting") {
		pendingToolRestarts.add(personaId);
	} else {
		pendingToolRestarts.delete(personaId);
	}
}

const scheduler = new Scheduler({
	wake: (personaId, text) => wakeTeammate(supervisor, personaId, text),
	changed: (jobs) => send("schedulesChanged", jobs),
});

const peers = new PeerSessions({
	peerThreadAppended: (payload) => send("peerThreadAppended", payload),
	peerThreadUpdated: (payload) => send("peerThreadUpdated", payload),
	peerActivityChanged: (payload) => send("peerActivityChanged", payload),
	transcriptAppended: (payload) => send("transcriptAppended", payload),
	transcriptUpdated: (payload) => send("transcriptUpdated", payload),
});
supervisor.setTranscriptObserver((personaId, event) => peers.observeHumanEvent(personaId, event));

// Hand-to-human cards write to the transcript the same way sessions do, so
// they persist, replay, and reach the webview over the same channels.
configureHandoff({
	append: (personaId, event) => {
		transcript.append(personaId, event);
		send("transcriptAppended", { personaId, event });
	},
	update: (personaId, event) => {
		transcript.append(personaId, event);
		send("transcriptUpdated", { personaId, event });
	},
});

const bridge = new Bridge({ supervisor, peers, scheduler });
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

/** Keep every open renderer on the same authoritative roster. */
function publishPersonas(): void {
	refreshMenu();
	send("personasChanged", listPersonas());
}

function toolTopologyChanged(
	before: Persona | undefined,
	after: Persona,
	patch: Partial<Persona>,
): boolean {
	const computerChanged =
		"computer" in patch &&
		(before?.computer?.enabled !== after.computer?.enabled ||
			before?.computer?.image !== after.computer?.image);
	const policyChanged =
		"mcpPolicy" in patch &&
		JSON.stringify(before?.mcpPolicy) !== JSON.stringify(after.mcpPolicy);
	return computerChanged || policyChanged;
}

/* Declared as a named config rather than inline: defineRPC folds the
 * handler map into its transport and keeps no public copy, and web mode
 * serves this same request map over its own wire. The instantiation
 * expression keeps the contextual typing an inline literal would have had. */
const rpcConfig: Parameters<typeof BrowserView.defineRPC<ToadRPC>>[0] = {
	maxRequestTime: 120_000,
	handlers: {
		requests: {
			listPersonas: async () => listPersonas(),

			createPersona: async (draft) => {
				const persona = createPersona({
					...draft,
					backendId: draft.backendId ?? getSettings().defaultBackendId,
				});
				publishPersonas();
				return persona;
			},

			updatePersona: async ({ id, patch }) => {
				const before = getPersona(id);
				const persona = updatePersona(id, patch);
				// A rename has to reach the roster in the Agent menu and, when it is
				// the teammate in focus, the window title.
				publishPersonas();
				if (toolTopologyChanged(before, persona, patch)) applyToolChange(id);
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
				scheduler.dropPersona(id);
				deletePersona(id);
				publishPersonas();
				return { deleted: true };
			},

			/* The one turn in which a new teammate chooses its own icon. Runs in a
			 * hidden session (see agent/face.ts); progress is narrated to the
			 * setup screen over `faceProgress`. Always resolves with a face — the
			 * fallback composer answers when the agent cannot. */
			composeFace: async ({ personaId }) => {
				const persona = getPersona(personaId);
				if (!persona) throw new Error(`No persona ${personaId}`);
				const result = await composePersonaFace(persona, (stage) =>
					send("faceProgress", { personaId, stage }),
				);
				updatePersona(personaId, { face: result.face });
				publishPersonas();
				send("faceProgress", { personaId, stage: "done" });
				return result;
			},

			listBackends: async ({ refresh }) => listBackends(refresh ?? false),

			/* Imported on demand so an ACP-only launch does not pay to load pi's
			 * module graph merely because the settings screen might be opened. */
			listProviderAuth: async () => (await import("./pi/auth")).listProviderAuth(),
			startProviderLogin: async ({ providerId, method }) =>
				(await import("./pi/auth")).startProviderLogin({
					providerId,
					method,
					openUrl: (url) => Utils.openExternal(url),
				}),
			getProviderLogin: async ({ flowId }) =>
				(await import("./pi/auth")).getProviderLogin(flowId),
			answerProviderLogin: async ({ flowId, value }) =>
				(await import("./pi/auth")).answerProviderLogin(flowId, value),
			cancelProviderLogin: async ({ flowId }) => {
				(await import("./pi/auth")).cancelProviderLogin(flowId);
			},
			logoutProvider: async ({ providerId }) =>
				(await import("./pi/auth")).logoutProvider(providerId),

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
			listSchedules: async ({ personaId }) => scheduler.list(personaId),
			cancelSchedule: async ({ id }) => ({ cancelled: scheduler.cancel(id) }),
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

			steerPrompt: async ({ personaId, text, attachments }) => {
				void supervisor.steer(personaId, text, attachments);
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

			answerHumanAction: async ({ actionId, status }) => ({
				answered: answerHuman(actionId, status),
			}),

			answerPermission: async ({ personaId, requestId, optionId }) => {
				supervisor.answerPermission(personaId, requestId, optionId);
			},

			setModel: async ({ personaId, modelId }) => {
				const info = await supervisor.setModel(personaId, modelId);
				publishPersonas();
				return info;
			},
			setMode: async ({ personaId, modeId }) => {
				const info = await supervisor.setMode(personaId, modeId);
				publishPersonas();
				return info;
			},
			setConfig: async ({ personaId, configId, value }) =>
				supervisor.setConfig(personaId, configId, value),

			openLink: async ({ url }) => {
				if (isSafeLink(url)) Utils.openExternal(url);
			},

			computerStatus: async ({ personaId }) => {
				const persona = getPersona(personaId);
				const status = await computerStatus(personaId, persona?.computer?.image);
				return { enabled: Boolean(persona?.computer?.enabled), ...status };
			},

			// A look at the desktop as it is, never a reason to wake it: a stopped
			// machine reports null and the drawer says "asleep" instead.
			computerScreenshot: async ({ personaId }) => {
				const endpoint = await runningEndpoint(personaId);
				if (!endpoint) return { dataUrl: null };
				try {
					const res = await fetch(`${endpoint.baseUrl}/screenshot`, {
						headers: { Authorization: `Bearer ${endpoint.token}` },
						signal: AbortSignal.timeout(10_000),
					});
					if (!res.ok) return { dataUrl: null };
					const bytes = Buffer.from(await res.arrayBuffer());
					return { dataUrl: `data:image/png;base64,${bytes.toString("base64")}` };
				} catch {
					return { dataUrl: null };
				}
			},

			// The filmstrip: what the machine's hands looked at lately, for the
			// drawer. In-memory and rolling; an empty list is a quiet desktop.
			computerFrames: async ({ personaId }) => ({ frames: recentFrames(personaId) }),

			computerVncUrl: async ({ personaId }) => ({ url: computerVncUrl(personaId) }),

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

			writeClipboard: async ({ text }) => {
				Utils.clipboardWriteText(text);
			},

			readClipboardImage: async () => {
				const png = Utils.clipboardReadImage();
				if (!png || png.length === 0) return null;
				return { data: Buffer.from(png).toString("base64") };
			},

			windowState: async () => readWindowState(),
			windowMinimize: async () => {
				mainWindow.minimize();
				return readWindowState();
			},
			windowMaximizeToggle: async () => {
				const maximized = !mainWindow.isMaximized();
				if (maximized) mainWindow.maximize();
				else mainWindow.unmaximize();
				// GTK's isMaximized() lags the call, so sampling it here would
				// leave the restore glyph one click behind. Report what we asked.
				pendingMaximize = maximized;
				const state = { maximized, fullScreen: mainWindow.isFullScreen() };
				rememberWindowState(state);
				return state;
			},
			windowSetFullScreen: async ({ fullScreen }) => {
				mainWindow.setFullScreen(fullScreen);
				return { maximized: mainWindow.isMaximized(), fullScreen };
			},
			windowClose: async () => {
				mainWindow.close();
			},
			appQuit: async () => {
				Utils.quit();
			},
			windowGetFrame: async () => mainWindow.getFrame(),
			windowSetFrame: async (frame) => {
				mainWindow.setFrame(
					frame.x,
					frame.y,
					Math.max(MIN_WINDOW.width, frame.width),
					Math.max(MIN_WINDOW.height, frame.height),
				);
			},

			getWebMode: async () => webModeStatus(),
			setWebMode: async ({ enabled }) => {
				updateSettings({ webMode: { enabled } });
				if (enabled) return startWebMode(webHandler);
				stopWebMode();
				return webModeStatus();
			},
			listWebDevices: async () => listDevices(),
			createWebPairing: async () => {
				const code = createPairing();
				return { url: pairingUrl(code), code };
			},
			revokeWebDevice: async ({ id }) => ({ revoked: revokeWebDevice(id) }),
		},
	},
};

const rpc = BrowserView.defineRPC<ToadRPC>(rpcConfig);

/** Web mode answers from the same request map, over its own wire. */
const webHandler = (method: string) =>
	(rpcConfig.handlers.requests as unknown as Record<string, (params: unknown) => Promise<unknown>>)[
		method
	];

if (getSettings().webMode?.enabled) {
	try {
		startWebMode(webHandler);
	} catch (error) {
		console.error("web mode failed to start:", error);
	}
}

function readWindowState(): WindowState {
	return {
		maximized: mainWindow.isMaximized(),
		fullScreen: mainWindow.isFullScreen(),
	};
}

function rememberWindowState(state: WindowState): void {
	lastWinState = JSON.stringify(state);
}

function publishWindowState(): void {
	try {
		const native = readWindowState();
		if (pendingMaximize !== null) {
			if (native.maximized === pendingMaximize) pendingMaximize = null;
			else return;
		}
		const seen = JSON.stringify(native);
		if (seen === lastWinState) return;
		lastWinState = seen;
		send("windowStateChanged", native);
	} catch {
		/* window is gone */
	}
}

const DEV_SERVER_URL = "http://localhost:5173";

async function mainViewUrl(): Promise<string> {
	const channel = await Updater.localInfo.channel();
	if (channel === "dev") {
		/* `hutch run dev` starts vite on 5173 beside the app. The two races, so
		 * sit here until the server answers rather than opening the views://
		 * fallback — on Linux that page's host WebSocket never completes, and
		 * the roster request hangs until the window just says Loading…. */
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline) {
			try {
				await fetch(DEV_SERVER_URL, { method: "HEAD", signal: AbortSignal.timeout(400) });
				return DEV_SERVER_URL;
			} catch {
				await new Promise((resolve) => setTimeout(resolve, 200));
			}
		}
	}
	return "views://mainview/index.html";
}

const DEFAULT_FRAME: WindowFrame = { width: 1280, height: 860, x: 120, y: 90 };

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
	if (saved.width < MIN_WINDOW.width || saved.height < MIN_WINDOW.height) return DEFAULT_FRAME;

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
 * On Linux that style is a no-op for caption buttons, and GTK's own File/Edit
 * bar is a documented no-op too. `"hidden"` drops both, and the webview draws
 * the hamburger, mark, and min/max/close itself.
 *
 * The lights cannot be moved: Electrobun accepts `trafficLightOffset` but its
 * native layer ignores the value, and `UnifiedTitleAndToolbar` does not make
 * AppKit re-centre them either. They sit centred on y=13.5, so the toolbar in
 * the webview is built to that line rather than fighting it.
 */
/* Annotated because the window takes `rpc` and the RPC handlers reach back for
 * the window: without a type here each one waits on the other to be inferred. */
const mainWindow: BrowserWindow = new BrowserWindow({
	title: "Toad",
	url: await mainViewUrl(),
	frame: restorableFrame(),
	titleBarStyle: platform() === "linux" ? "hidden" : "hiddenInset",
	rpc,
});

/*
 * The mark in the menu bar, as a template image so macOS tints it itself —
 * black in a light bar, white in a dark one, and correctly dimmed when the bar
 * is inactive. Supplying our own green here would fight all three.
 *
 * Clicking it raises the window, which is the only thing a single-window app's
 * status item is really for.
 */
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
		if (frame.width < MIN_WINDOW.width || frame.height < MIN_WINDOW.height) return;
		const seen = JSON.stringify(frame);
		if (seen !== lastFrame) {
			lastFrame = seen;
			setWindowFrame(frame);
		}
		publishWindowState();
	} catch {
		/* the window is gone; there is nothing left to remember */
	}
}, 1_000).unref();

/** Assigned once the window exists; events can arrive before that. */
let tray: { refresh(): void } | undefined;

tray = createTray({
	personas: () => listPersonas(),
	state: (personaId) => supervisor.info(personaId).state,
	open: (personaId) => {
		showMainWindow();
		if (personaId) send("menuAction", { action: "selectTeammate", personaId });
	},
});

function showMainWindow(): void {
	mainWindow.show();
	mainWindow.activate();
}

/*
 * Closing puts Toad in the menu bar instead of ending it.
 *
 * The window is a view onto the teammates; the teammates are the app, and they
 * live in this process. Letting the red button take them down would mean an
 * agent halfway through a task dies because you wanted the screen back. The
 * sessions are untouched by this — only the view goes away.
 */
mainWindow.on("will-close", (event) => {
	(event as { response?: { allow: boolean } }).response = { allow: false };
	mainWindow.hide();
});

mainWindow.on("resize", () => publishWindowState());

// Clicking the dock icon with no window on screen is the other half of that
// bargain: it has to bring the window back, or closing it looks like a crash.
app.on("reopen", () => showMainWindow());

mainRPC = mainWindow.webview.rpc as unknown as typeof mainRPC;
scheduler.start();

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
	scheduler.stop();
	bridge.stop();
});
