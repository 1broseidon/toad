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
import type {
	PeerThread, Persona, Preview, PushStatus, UpdateStatus } from "../shared/types";
import { readFileSync, writeFileSync } from "node:fs";
import { threadKey, CONFIG_FILE, ROOT, ensureLayout } from "./paths";
import {
	describe as describeAttachment,
	locate as locateAttachments,
	resolve as resolveAttachments,
	save as saveAttachment,
} from "./attachments";
import { listBackends } from "./acp/registry";
import { describeContainment } from "./acp/containment";
import { Supervisor } from "./acp/supervisor";
import { PeerSessions, inboundFleetCaller } from "./acp/peers";
import { expireOrphanedPermissions } from "./acp/permissions";
import { Bridge } from "./mcp/bridge";
import {
	authorizeMcpServer,
	disconnectMcpServer,
	mcpAuthStatuses,
} from "./mcp/oauth";
import { savePreRegisteredClientSecret, saveStaticHeaders } from "./mcp/credentials";
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
	reorderPersonas,
	getPersona,
	listPersonas,
	updatePersona,
} from "./store/personas";
import * as transcript from "./store/transcript";
import * as threads from "./store/threads";
import * as search from "./store/search";
import { applyRosterOrder, saveRosterOrder } from "./store/roster";
import {
	broadcastNodeLinks,
	firstHandForPeers,
	initPeerWires,
	mergePeerRecords,
	nodeLinkServerHooks,
	peerOwningThreadKey,
	peerWireFor,
	peerWireSecurity,
	remotePersonas,
	remoteSessionState,
	routePersonaOrder,
	routeRemotePersonas,
	syncPeerWires,
} from "./fleet/wire";
import {
	createFleetInvite,
	fleetNode,
	fleetRosters,
	initFleet,
	joinFleet,
	listFleetPeers,
	createTeammateOnPeer,
	parseRemoteTarget,
	webAccessFromPeer,
	remoteTargetId,
	revokeFleetPeer,
} from "./fleet/fleet";
import {
	deskCapabilities,
	initDeskCapabilities,
	refreshDeskCapabilities,
	resolveTeammateHarness,
} from "./fleet/capabilities";
import { syncRoomCredentials } from "./fleet/credentials";
import { pushReachReport } from "./fleet/push";
import {
	createCredential,
	deleteCredential,
	listCredentials,
	revokeCredential,
	setCredentialReplication,
} from "./store/credentials";
import { meshCount } from "./fleet/metrics";
import { initHop, requestHop } from "./fleet/hop";
import { initSelfHop, observeSessionForSelfHop } from "./fleet/self-hop";
import { createFleetRollout, type RolloutDesk } from "./fleet/rollout";
import { createDesktopUpdate, type UpdateBridge } from "./update";
import { Chapters } from "./agent/chapters";
import { clearCheckpoint, checkpointSession } from "./store/personas";
import { createPairing, listDevices, pushProblems } from "./web/devices";
import { unpairPushDevicesForMember } from "./store/push";
import {
	closeFleetPeerSockets,
	closeMemberSockets,
	httpOrigin,
	pairingUrl,
	peerBroadcast,
	revokeWebDevice,
	startWebMode,
	stopWebMode,
	webBroadcast,
	webModeStatus,
} from "./web/server";
import { listMobileMembers, revokeMember, setMemberGrant } from "./node/members";
import {
	cancelClientEnrollment,
	createClientEnrollment,
	currentClientEnrollment,
	listClientSeats,
	sweepRevokedClients,
} from "./mcp/seat";
import { initSeatTools } from "./mcp/seat-tools";
import { currentRoom, renameRoom, setRoomDefaultHarness } from "./node/room";
import { recentFrames } from "./computer/frames";
import { answerHuman, configureHandoff } from "./computer/handoff";
import { computerStatus, runningEndpoint, startComputerSweeper } from "./computer/manager";
import { computerVncUrl } from "./computer/proxy";
import {
	createNodeInvite,
	decideNodeRequest,
	joinNodeInvite,
	listIncomingNodeRequests,
	listOutgoingNodeRequests,
	requestNearbyNode,
} from "./node/admission";
import { listNearbyNodes, startNodeDiscovery, stopNodeDiscovery } from "./node/discovery";
import { nodeIdentity } from "./node/identity";
import { listAdmittedNodes } from "./node/membership";
import {
	closeNodePeer,
	nodeOrigin,
	nodePeerBroadcast,
	startNodeServer,
	stopNodeServer,
} from "./node/server";
import { notifyTeammate } from "./agent/notify";
import { Scheduler, wakeTeammate } from "./schedule";
import { decodeMenuAction, setApplicationMenu, showMessageMenu, showPersonaMenu } from "./menu";
import { createTray } from "./tray";
import { restoreUserPath } from "./child-env";
import { clearPushKey, installPushKey, pushCredentials } from "./push/apns";
import {
	desktopShown,
	desktopViewing,
	desktopAttentive,
	forgetPersonaState,
	observeSession,
	observeTranscript,
	sendTestDesktopNotification,
	sendTestNotification,
} from "./push/notify";

await restoreUserPath();
ensureLayout();
console.log(`Toad starting — data at ${ROOT}`);

/* One Toad per data folder. LaunchServices stops the same bundle launching
 * twice, but a dev build beside the installed app is a different bundle on
 * the same data — two supervisors racing one config, one port, one set of
 * session files, which reads as a hang from the outside. The lock is a pid;
 * a stale one (force quit, crash) is dead and ignored. */
{
	const lockFile = `${ROOT}/toad.lock`;
	try {
		const held = Number(readFileSync(lockFile, "utf8").trim());
		if (held && held !== process.pid) {
			process.kill(held, 0);
			console.error(`Another Toad (pid ${held}) is already using ${ROOT}; quitting.`);
			process.exit(1);
		}
	} catch {
		/* No lock, unreadable lock, or a dead holder: the folder is ours. */
	}
	writeFileSync(lockFile, `${process.pid}
`, "utf8");
}

// A resolver only exists in the process that received the ACP request. Retire
// cards orphaned by the previous process before serving any restored history,
// then fold superseded transcript lines so they do not accumulate forever.
const startupTs = Date.now();
for (const persona of listPersonas()) {
	for (const event of expireOrphanedPermissions(transcript.load(persona.id), startupTs)) {
		transcript.append(persona.id, event);
	}
	transcript.compact(persona.id);
}
for (const key of threads.listAllKeys()) {
	for (const event of expireOrphanedPermissions(threads.load(key), startupTs)) {
		threads.append(key, event);
	}
	threads.compact(key);
}
// The search index follows the files; a transcript that changed since it was
// last indexed — the fold above, a crash — is re-read here.
search.sync(listPersonas().map((persona) => persona.id));

// Teammate computers idle down on their own: stop after minutes, rm after
// days (docs/computer.md §Lifecycle). Wake is lazy, on the first tool call.
startComputerSweeper();

let mainRPC: { send: (name: string, payload: unknown) => void } | null = null;
const send = (name: string, payload: unknown) => {
	meshCount("send", name);
	mainRPC?.send(name, payload);
	// Phones on web mode hear everything the desktop webview hears.
	webBroadcast(name, payload);
	// A linked desktop is not a client and hears nothing by default: only
	// first-hand facts about this desk's teammates go out, and only the
	// pushes its wire actually reads.
	const firstHand = firstHandForPeers(name, payload);
	if (firstHand !== null) {
		peerBroadcast(name, firstHand);
		nodePeerBroadcast(name, firstHand);
		broadcastNodeLinks(name, firstHand);
	}
};

/** Which teammate the menus and the window title currently describe. */
let activePersonaId: string | null = null;

/** The message the open right-click menu would copy. */
let pendingCopy = "";

/** Native maximize state may trail; do not revert custom chrome until it agrees. */
let pendingMaximize: boolean | null = null;
let lastWinState = "";

/**
 * Whether a link out of a message may be handed to the system.
 *
 * Allow-listed rather than filtered: the schemes people actually write in prose
 * are few, and everything else — `javascript:`, `file:`, an app's own custom
 * scheme — is a way to make a click do something other than open a page.
 */
/** The first line of a message, at reaction-note length. */
function reactionSnippet(text: string): string {
	const line = text.split("\n").find((piece) => piece.trim().length > 0) ?? "";
	return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}

/**
 * The agent's own emoji on the user's latest message — the react tool's
 * hands. Add-only: an agent has no business taking marks off.
 */
function reactAsAgent(personaId: string, emoji: string): { on: string } | { error: string } {
	const events = transcript.load(personaId);
	const latest = [...events].reverse().find((event) => event.kind === "user");
	if (!latest || latest.kind !== "user") return { error: "No message to react to yet." };
	const current = latest.reactions ?? [];
	if (!current.includes(emoji)) {
		const updated = { ...latest, reactions: [...current, emoji] };
		transcript.append(personaId, updated);
		send("transcriptUpdated", { personaId, event: updated });
	}
	return { on: reactionSnippet(latest.text) };
}

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

/**
 * The signing key this desk would use, and the phones that could not register.
 *
 * It used to carry a count of reachable phones too. `getPushReach` answers that
 * properly now — by name, with the desk that would actually post — and a number
 * beside that list would be a second, weaker copy of the same answer, right
 * where the two could disagree.
 */
function pushStatus(): PushStatus {
	return { ...pushCredentials(), problems: pushProblems() };
}

const supervisor = new Supervisor({
	transcriptAppended: (p) => {
		send("transcriptAppended", p);
		// Everything worth a buzz already crosses this seam; push/notify.ts owns
		// the judgement about which of it is an interruption. See docs/push.md.
		observeTranscript(p.personaId, p.event);
	},
	transcriptUpdated: (p) => {
		send("transcriptUpdated", p);
		// An answered permission arrives as an update, and closes out the
		// pending one so a later request can announce itself.
		observeTranscript(p.personaId, p.event);
	},
	streamDelta: (p) => send("streamDelta", p),
	sessionInfoChanged: (p) => {
		send("sessionInfoChanged", p);
		observeSession(p);
		// A parked self-hop fires the moment the turn that parked it ends —
		// the same state the hop's own busy rule reads.
		observeSessionForSelfHop(p);
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

const updateBridge: UpdateBridge = {
	getLocalInfo: () => Updater.getLocalInfo(),
	getUpdateInfo: () => Updater.updateInfo(),
	checkForUpdate: () => Updater.checkForUpdate(),
	downloadUpdate: () => Updater.downloadUpdate(),
	applyUpdate: () => Updater.applyUpdate(),
	onStatusChange: (callback) => Updater.onStatusChange(callback),
	appDataFolder: () => Updater.appDataFolder(),
};

const desktopUpdate = createDesktopUpdate(updateBridge, {
	busyNames: () => [...supervisor.workingNames(), ...peers.workingNames()],
	publish: (status) => send("updateStatusChanged", status),
});

/**
 * The same four calls the local update surface makes, aimed down a link.
 *
 * A linked desk already answers this desktop's RPC — that is how remote
 * session vitals arrive — so a rollout needs no new protocol, only the
 * discipline of asking in the right order. A desk that is away rejects, and
 * the rollout reads rejection as absence rather than as failure.
 */
function remoteDesk(peer: { id: string; name: string }): RolloutDesk {
	const wire = () => {
		/* Null already means "no authenticated wire right now" — the rollout
		 * reads the throw as absence, not as a broken desk. */
		const link = peerWireFor(peer.id);
		if (!link) throw new Error(`${peer.name} is not reachable right now`);
		return link;
	};
	const call = async (method: string, timeoutMs?: number) =>
		(await wire().call(method, {}, timeoutMs)) as UpdateStatus;
	return {
		nodeId: peer.id,
		name: peer.name,
		check: () => call("checkForUpdate"),
		/* A full bundle is ~140 MB over the LAN; the default call timeout is
		 * sized for conversation, not freight. */
		download: () => call("downloadUpdate", 15 * 60_000),
		apply: () => call("applyUpdate"),
		status: () => call("getUpdateStatus"),
	};
}

const fleetRollout = createFleetRollout({
	/* A stable order, so a rollout interrupted and restarted walks the room
	 * the same way twice. */
	remotes: () =>
		listFleetPeers()
			.slice()
			.sort((a, b) => a.id.localeCompare(b.id))
			.map((peer) => remoteDesk(peer)),
	local: () => ({
		nodeId: nodeIdentity().id,
		name: nodeIdentity().name,
		check: () => desktopUpdate.check(),
		download: () => desktopUpdate.download(),
		apply: () => desktopUpdate.apply(),
		status: () => desktopUpdate.snapshot(),
	}),
	publish: (progress) => send("fleetRolloutChanged", progress),
	wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	now: () => Date.now(),
});

/* The fleet layer: presence and one-shot delivery between linked desktops.
 * Inbound deliveries run through the same peer machinery local teammates
 * use, with a synthetic outside caller and a fresh chain one hop deep.
 * `fromSeat` rides along because the voice may be a client seat enrolled at
 * the sending desk rather than a teammate living on it — same wire, and the
 * receiving tape must not call it a teammate. */
initFleet({
	deliver: async ({ fromNode, fromPersona, targetPersonaId, message, fromSeat }) => {
		const result = await peers.deliver({
			...inboundFleetCaller({ fromNode, fromPersona, fromSeat }),
			targetId: targetPersonaId,
			message,
			chain: { id: randomUUID(), depth: 1, path: [] },
		});
		return result.ok
			? { ok: true, reply: result.reply, ...(result.from ? { from: result.from } : {}) }
			: { ok: false, detail: result.detail };
	},
	createTeammate: (draft) => {
		const persona = createPersona({
			name: draft.name,
			backendId: getSettings().defaultBackendId,
			goal: draft.goal || undefined,
		});
		if (draft.team) updatePersona(persona.id, { team: draft.team });
		publishPersonas();
		/* The face hatches here, where the teammate lives — the creating
		 * desktop only needs to know the seat was added. */
		void composePersonaFace(persona, () => {})
			.then(({ face }) => {
				updatePersona(persona.id, { face });
				publishPersonas();
			})
			.catch(() => {});
		return { personaId: persona.id, name: persona.name };
	},
	readTranscript: (personaId, limit) => {
		const persona = getPersona(personaId);
		if (!persona) return null;
		const { messages, truncated } = transcript.recentMessages(personaId, limit);
		return {
			personaId,
			name: persona.name,
			messages: messages.map((event) => ({
				from: event.kind === "user" ? ("user" as const) : ("teammate" as const),
				text: event.text,
				at: event.ts,
			})),
			truncated,
		};
	},
	readThread: ({ localPersonaId, remoteNodeId, remotePersonaId, limit }) => {
		const persona = getPersona(localPersonaId);
		if (!persona) return null;
		const remoteKey = `remote:${remoteNodeId}:${remotePersonaId}`;
		const key = threadKey(remoteKey, localPersonaId);
		const meta = threads.readMeta(key);
		if (!meta) return { name: persona.name, messages: [], truncated: false };
		const all = threads
			.load(key)
			.filter((event) => event.kind === "user" || event.kind === "agent");
		const selected = all.slice(-limit).map((event) => {
			const speaker = event.kind === "user" ? meta.sides.user : meta.sides.agent;
			return {
				/* "me" is the asking remote side — the caller of this method. */
				from: speaker === remoteKey ? ("me" as const) : ("them" as const),
				text: event.text,
				at: event.ts,
			};
		});
		return { name: persona.name, messages: selected, truncated: all.length > selected.length };
	},
	httpOrigin,
	nodeOrigin,
});
/*
 * Chapters (docs/chapters.md): the tape is one conversation, the agent's
 * context is one chapter of it at a time. Everything the manager does is
 * through what already exists — the transcript, the session checkpoint, and
 * stop/start — so it is wired here from those rather than built into a
 * session.
 */
const DEFAULT_CHAPTER_IDLE_HOURS = 8;
function chapterIdleMs(): number {
	const hours = getSettings().chapterIdleHours;
	const chosen = typeof hours === "number" && Number.isFinite(hours) ? hours : DEFAULT_CHAPTER_IDLE_HOURS;
	return Math.min(24 * 14, Math.max(1, chosen)) * 3_600_000;
}

const chapters = new Chapters({
	persona: (personaId) => getPersona(personaId),
	history: (personaId) => transcript.load(personaId),
	record: (personaId, event, mode) => {
		transcript.append(personaId, event);
		search.indexEvent(personaId, event);
		send(mode === "append" ? "transcriptAppended" : "transcriptUpdated", { personaId, event });
	},
	info: (personaId) => supervisor.info(personaId),
	stop: (personaId) => supervisor.stop(personaId),
	start: (personaId) => supervisor.start(personaId),
	nudge: (personaId, text) => supervisor.nudge(personaId, text),
	checkpoint: (personaId, backendId, sessionId) => {
		checkpointSession(personaId, backendId, sessionId);
	},
	clearCheckpoint: (personaId, backendId, onlyIf) => clearCheckpoint(personaId, backendId, onlyIf),
	/* Imported on demand for the same reason the provider screens are: the
	 * summariser rides Toad Agent's runtime, and an ACP-only roster should not
	 * load that module graph until a chapter actually closes. */
	summarize: async (persona, events, signal) =>
		(await import("./agent/summarize")).summarizeChapter(persona, events, signal),
	idleMs: chapterIdleMs,
	log: (message) => console.error(message),
});

supervisor.setTranscriptObserver((personaId, event) => {
	peers.observeHumanEvent(personaId, event);
	search.indexEvent(personaId, event);
	chapters.observe(personaId, event);
});
supervisor.setCheckpointObserver((personaId, backendId, sessionId) =>
	chapters.sessionCheckpointed(personaId, backendId, sessionId),
);
supervisor.setPromptGate((personaId) => chapters.beforePrompt(personaId));
// Chapters that went stale while Toad was closed get their notes now, while
// nobody is waiting on them. A moment after startup, so the window comes first.
setTimeout(() => chapters.sweep(listPersonas().map((persona) => persona.id)), 5_000).unref();

/* The persona hop rides what already exists: the supervisor's busy rule and
 * stop, the chapter close with its handoff note, and the roster publish. */
initHop({
	state: (personaId) => supervisor.info(personaId).state,
	stop: (personaId) => supervisor.stop(personaId),
	closeChapter: async (personaId) => {
		await chapters.startFresh(personaId, "user");
	},
	publish: () => publishPersonas(),
	/* A self-requested hop resumes here through the same seam a scheduled wake
	 * uses: start if needed, then prompt — the funnel lays the hop notice ahead
	 * of the continuation nudge. */
	resume: (personaId, text) => wakeTeammate(supervisor, personaId, text),
});

/* The teammate's own way to move: hop_desk parks the request mid-turn, the
 * park fires the normal hop — every guard included — when the session goes
 * idle, and a failed fire lands on the tape instead of retrying. */
initSelfHop({
	hop: (personaId, toNodeId) => requestHop(personaId, toNodeId, { self: true }),
	notice: (personaId, text) => {
		const event = {
			kind: "notice" as const,
			id: `selfhop:${randomUUID()}`,
			ts: Date.now(),
			level: "warn" as const,
			text,
		};
		transcript.append(personaId, event);
		send("transcriptAppended", { personaId, event });
	},
});

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

/* The client seat's tools reach the same two things the bridge does — a live
 * session's state, and the peer delivery machinery — so they are handed the
 * same objects rather than a second copy of the machinery. What differs is who
 * is asking, and that arrives per request with the access token. */
initSeatTools({ supervisor, peers });

const bridge = new Bridge({
	supervisor,
	peers,
	scheduler,
	react: reactAsAgent,
	chapters: {
		search: (personaId, query, limit) => search.search(personaId, query, limit),
		list: (personaId) => chapters.list(personaId),
		resume: (personaId) => chapters.resume(personaId),
		startFresh: (personaId, by) => chapters.startFresh(personaId, by),
	},
	notify: (personaId, text) => {
		void notifyTeammate(supervisor, personaId, text).catch((error) => {
			console.error(
				`Could not notify ${personaId}: ${error instanceof Error ? error.message : String(error)}`,
			);
		});
	},
});
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

/* Rebuilding the native menu is the priciest thing a publish does: AppKit
 * registers every ⌘1–9 hot key and tears the old tree down item by item, and
 * under a publish burst that teardown is what froze the app. Same inputs,
 * same menu — skip the rebuild. */
let lastMenuKey = "";
function refreshMenu() {
	const personas = listPersonas();
	const activeState = activePersonaId ? supervisor.info(activePersonaId).state : "idle";
	const key = JSON.stringify([
		personas.map((p) => [p.id, p.name, p.team ?? ""]),
		activePersonaId,
		activeState,
	]);
	if (key === lastMenuKey) return;
	lastMenuKey = key;
	setApplicationMenu({
		personas,
		activeId: activePersonaId,
		activeState,
	});
}

/** Keep every open renderer on the same authoritative roster. */
/* One roster: this desktop's teammates and every linked desktop's, the
 * latter with node-qualified ids that the routing layer follows home, all
 * interleaved the way this desk last arranged them. */
function mergedPersonas(): Persona[] {
	return applyRosterOrder([...listPersonas(), ...remotePersonas()]);
}

function publishPersonas(): void {
	refreshMenu();
	send("personasChanged", mergedPersonas());
}

/** The last thing said in each of THIS desk's transcripts. */
function localPreviews(): Record<string, Preview> {
	const previews: Record<string, Preview> = {};
	for (const persona of listPersonas()) {
		const last = transcript.preview(persona.id);
		if (last) previews[persona.id] = last;
	}
	return previews;
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
	const searchChanged =
		"webSearchPolicy" in patch &&
		JSON.stringify(before?.webSearchPolicy) !== JSON.stringify(after.webSearchPolicy);
	return computerChanged || policyChanged || searchChanged;
}

/* Declared as a named config rather than inline: defineRPC folds the
 * handler map into its transport and keeps no public copy, and web mode
 * serves this same request map over its own wire. The instantiation
 * expression keeps the contextual typing an inline literal would have had. */
const rpcConfig: Parameters<typeof BrowserView.defineRPC<ToadRPC>>[0] = {
	maxRequestTime: 120_000,
	handlers: {
		requests: {
			listPersonas: async () => mergedPersonas(),

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

			// Deleting a teammate also destroys its transcript, so someone is
			// asked first. On the desktop that is the system's message box. A wire
			// client asks on its own screen and sends `confirmed` instead: the
			// modal here nests the native run loop and starves Bun's, so every
			// wire freezes while the question waits at a desk nobody is sitting at.
			deletePersona: async ({ id, confirmed }) => {
				const remote = parseRemoteTarget(id);
				if (remote) {
					const wire = peerWireFor(remote.nodeId);
					if (!wire) return { deleted: false };
					const away = remotePersonas().find((persona) => persona.id === id);
					if (!confirmed) {
						/* Ask on THIS desk. Forwarding unconfirmed would raise the
						 * peer's native dialog, which nests its run loop and stalls
						 * every wire it serves — at a desk nobody is sitting at. */
						const { response } = await Utils.showMessageBox({
							type: "warning",
							title: "Delete Teammate",
							message: `Delete ${away?.name ?? "this teammate"} from ${wire.nodeName}?`,
							detail: "Its conversation and session history are deleted with it. This cannot be undone.",
							buttons: ["Delete", "Cancel"],
							defaultId: 1,
							cancelId: 1,
						});
						if (response !== 0) return { deleted: false };
					}
					return (await wire.call("deletePersona", {
						id: remote.personaId,
						confirmed: true,
					})) as { deleted: boolean };
				}
				const persona = getPersona(id);
				if (!persona) return { deleted: false };

				if (!confirmed) {
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
				}

				await supervisor.stop(id);
				await peers.dropPersona(id);
				threads.dropPersona(id);
				scheduler.dropPersona(id);
				chapters.forget(id);
				search.forget(id);
				forgetPersonaState(id);
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

			fleetInvite: async () => createFleetInvite(),
			fleetJoin: async ({ origin, code }) => {
				const joined = await joinFleet({ origin, code });
				if (joined.ok) void syncPeerWires();
				return joined;
			},
			fleetRoster: async () => ({ node: fleetNode(), rosters: await fleetRosters() }),
			fleetPeers: async () => listFleetPeers(),
			openRemoteDesktop: async ({ nodeId, personaId }) => {
				const peer = listFleetPeers().find((row) => row.id === nodeId);
				if (!peer) return { ok: false as const, error: "Not a linked desktop" };
				const access = await webAccessFromPeer(nodeId);
				if (!access?.ok || !access.token || !access.instanceId) {
					return { ok: false as const, error: "That desktop is not reachable right now" };
				}
				/* The seed rides the URL fragment — never sent on the network —
				 * and the app strips it from history the moment it is read. */
				const seed = {
					id: access.instanceId,
					name: access.hostName ?? peer.name,
					origin: access.origin ?? peer.origin,
					token: access.token,
					deviceId: access.deviceId ?? "",
					select: personaId,
				};
				openFleetWindow(
					peer.name,
					`${seed.origin}/?shell=native#fleet=${encodeURIComponent(JSON.stringify(seed))}`,
				);
				return { ok: true as const };
			},
			createPersonaAt: async ({ nodeId, draft }) => {
				const result = await createTeammateOnPeer(nodeId, draft);
				if (!result?.ok || !result.personaId) {
					return { ok: false as const, error: "That desktop is not reachable right now" };
				}
				return {
					ok: true as const,
					personaId: remoteTargetId(nodeId, result.personaId),
					name: result.name ?? draft.name,
				};
			},
			fleetRevoke: async ({ id }) => {
				const revoked = revokeFleetPeer(id);
				if (revoked) {
					closeNodePeer(id);
					closeFleetPeerSockets(id);
					void syncPeerWires();
				}
				return { revoked };
			},
			nodeInfo: async () => nodeIdentity(),
			nodeMembers: async () => {
				const admitted = new Map(listAdmittedNodes().map((row) => [row.node.id, row]));
				const desks = listFleetPeers().map((peer) => {
					const admission = admitted.get(peer.id);
					const security = peerWireSecurity(peer.id);
					return {
						...peer,
						legacy: !admission,
						...(security ? { wire: security } : {}),
						...(admission
							? {
									name: admission.node.name,
									origin: admission.origin,
									fingerprint: admission.node.fingerprint,
									protocol: admission.node.protocol,
									capabilities: admission.node.capabilities,
								}
							: {}),
					};
				});
				/* Phones are members of the same plane, so they answer on the same
				 * surface — flagged mobile, carrying the grant instead of tokens. */
				const phones = listMobileMembers().map((member) => ({
					id: member.nodeId,
					name: member.name,
					origin: "",
					addedAt: member.admittedAt,
					fingerprint: member.fingerprint,
					protocol: member.protocol,
					capabilities: member.capabilities,
					legacy: false,
					mobile: true,
					grant: member.grant,
					ownerNode: member.ownerNode,
				}));
				return [...desks, ...phones];
			},
			roomInfo: async () => currentRoom(),
			roomRename: async ({ name }) => {
				try {
					return { ok: true, room: renameRoom(name) };
				} catch (error) {
					return { ok: false, error: error instanceof Error ? error.message : "refused" };
				}
			},
			roomSetDefaultHarness: async ({ choice }) => {
				try {
					return { ok: true, room: setRoomDefaultHarness(choice) };
				} catch (error) {
					return { ok: false, error: error instanceof Error ? error.message : "refused" };
				}
			},
			deskCapabilities: async ({ nodeId }) => deskCapabilities(nodeId),
			resolveTeammateHarness: async ({ personaId, targetNodeId }) =>
				resolveTeammateHarness(personaId, targetNodeId),
			hopTeammate: async ({ personaId, toNodeId }) => {
				const result = await requestHop(personaId, toNodeId);
				/* Ownership changed on some desk either way this desk can see it:
				 * a hop away demotes here via the record flip, a hop home claims
				 * here. The roster republish makes both visible at once. */
				if (result.ok) publishPersonas();
				return result;
			},
			memberSetGrant: async ({ nodeId, grant }) => {
				try {
					const saved = setMemberGrant(nodeId, grant);
					if (!saved) return { ok: false, error: "That id is not a member of this room" };
					/* Narrowing reaches a live agent at once, the way it already
					 * reaches a live phone through the membership hook's socket
					 * close: the tokens this desk minted for a seat it no longer
					 * serves stop being honoured now, not at their expiry. */
					sweepRevokedClients();
					return { ok: true };
				} catch (error) {
					return { ok: false, error: error instanceof Error ? error.message : "refused" };
				}
			},
			memberRevoke: async ({ nodeId }) => {
				try {
					const revoked = revokeMember(nodeId);
					if (revoked) {
						closeMemberSockets(nodeId);
						sweepRevokedClients();
						/* The phone's address leaves the room before its row leaves
						 * this desk: dropping the row alone would delete the only
						 * plaintext and leave every other desk sealed to an address
						 * nobody answers to. A client seat has no such address, so
						 * this is a no-op for one — the same call, either seat. */
						unpairPushDevicesForMember(nodeId);
					}
					return { revoked };
				} catch (error) {
					return { revoked: false, error: error instanceof Error ? error.message : "refused" };
				}
			},
			listClientSeats: async () => listClientSeats(),
			createClientEnrollment: async () => createClientEnrollment(),
			currentClientEnrollment: async () => currentClientEnrollment(),
			cancelClientEnrollment: async () => ({ cancelled: cancelClientEnrollment() }),
			credentialList: async () => listCredentials(),
			credentialCreate: async ({ providerId, kind, label, secret }) => {
				try {
					return {
						ok: true,
						credential: createCredential({
							providerId,
							kind,
							...(label ? { label } : {}),
							...(secret ? { secret } : {}),
						}),
					};
				} catch (error) {
					return { ok: false, error: error instanceof Error ? error.message : "refused" };
				}
			},
			credentialSetReplication: async ({ id, replicate }) => {
				try {
					const credential = setCredentialReplication(id, replicate);
					/* Opting in has a key to seal and ship; opting out has desks to
					 * ask. Both are the wire's business the moment the record lands,
					 * so neither waits for the next sweep. */
					void syncRoomCredentials();
					return { ok: true, credential };
				} catch (error) {
					return { ok: false, error: error instanceof Error ? error.message : "refused" };
				}
			},
			credentialRevoke: async ({ id }) => {
				try {
					const credential = revokeCredential(id);
					void syncRoomCredentials();
					return { ok: true, credential };
				} catch (error) {
					return { ok: false, error: error instanceof Error ? error.message : "refused" };
				}
			},
			credentialDelete: async ({ id }) => {
				try {
					deleteCredential(id);
					return { ok: true };
				} catch (error) {
					return { ok: false, error: error instanceof Error ? error.message : "refused" };
				}
			},
			nodeNearby: async () => listNearbyNodes(),
			nodeIncoming: async () => listIncomingNodeRequests(),
			nodeOutgoing: async () => listOutgoingNodeRequests(),
			nodeRequest: async ({ nodeId, name, origin }) =>
				requestNearbyNode({ nodeId, name, origin }),
			nodeDecide: async ({ id, decision }) => {
				const result = await decideNodeRequest(id, decision);
				if (result.ok && decision === "accept") void syncPeerWires();
				return result;
			},
			nodeInvite: async () => createNodeInvite(),
			nodeJoin: async ({ origin, code }) => {
				const joined = await joinNodeInvite(origin, code);
				if (joined.ok) void syncPeerWires();
				return joined;
			},

			setPersonaOrder: async ({ ids }) => {
				/* A drag speaks in the merged order. Each desk keeps its own
				 * teammates' relative order; the interleave is this desk's. */
				reorderPersonas(ids.filter((id) => !id.includes("/")));
				routePersonaOrder(ids);
				saveRosterOrder(ids);
				publishPersonas();
				return mergedPersonas();
			},

			listBackends: async ({ refresh }) => {
				const backends = await listBackends(refresh ?? false);
				/* The pane that just probed availability is the moment an install
				 * made since the last sweep gets noticed; re-advertise off-turn. */
				void refreshDeskCapabilities().catch(() => {});
				return backends;
			},

			/* Imported on demand so an ACP-only launch does not pay to load pi's
			 * module graph merely because the settings screen might be opened. */
			listProviderAuth: async () => (await import("./pi/auth")).listProviderAuth(),
			startProviderLogin: async ({ providerId, method }) =>
				(await import("./pi/auth")).startProviderLogin({
					providerId,
					method,
					openUrl: (url) => Utils.openExternal(url),
				}),
			getProviderLogin: async ({ flowId }) => {
				const flow = (await import("./pi/auth")).getProviderLogin(flowId);
				/* Login completes in the background; the polling that reports it is
				 * the first place the change is visible, so the room learns here. */
				if (flow?.status === "success") void refreshDeskCapabilities().catch(() => {});
				return flow;
			},
			answerProviderLogin: async ({ flowId, value }) =>
				(await import("./pi/auth")).answerProviderLogin(flowId, value),
			cancelProviderLogin: async ({ flowId }) => {
				(await import("./pi/auth")).cancelProviderLogin(flowId);
			},
			logoutProvider: async ({ providerId }) => {
				const providers = await (await import("./pi/auth")).logoutProvider(providerId);
				void refreshDeskCapabilities().catch(() => {});
				return providers;
			},

			listCustomProviders: async () =>
				(await import("./pi/custom-providers")).listCustomProviders(),
			saveCustomProvider: async ({ provider }) =>
				(await import("./pi/custom-providers")).saveCustomProvider(provider),
			removeCustomProvider: async ({ id }) =>
				(await import("./pi/custom-providers")).removeCustomProvider(id),

			getAppSettings: async () => getSettings(),
			updateAppSettings: async (patch) => updateSettings(patch),
			getMcpAuthStatuses: async () => mcpAuthStatuses(),
			authorizeMcpServer: async ({ serverId }) => {
				await authorizeMcpServer(serverId, (url) => {
					Utils.openExternal(url);
				});
				return mcpAuthStatuses();
			},
			disconnectMcpServer: async ({ serverId }) => {
				await disconnectMcpServer(serverId);
				return mcpAuthStatuses();
			},
			setMcpStaticHeaders: async ({ serverId, headers }) => {
				const server = getSettings().mcpServers.find((entry) => entry.id === serverId);
				if (!server || server.type !== "http" || server.auth.mode !== "static") {
					throw new Error("That MCP server is not configured for static authentication");
				}
				saveStaticHeaders(serverId, headers);
				return mcpAuthStatuses();
			},
			setMcpOAuthClientSecret: async ({ serverId, clientSecret }) => {
				const server = getSettings().mcpServers.find((entry) => entry.id === serverId);
				if (!server || server.type !== "http" || server.auth.mode !== "oauth" || !server.auth.client) {
					throw new Error("That MCP server has no pre-registered OAuth client");
				}
				savePreRegisteredClientSecret(serverId, clientSecret?.trim() || undefined);
				return mcpAuthStatuses();
			},

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
			/* Imported on demand: the notices are ~380 KB of license text that
			 * only matters once someone opens the list. */
			getThirdPartyNotices: async () => (await import("./notices")).thirdPartyNotices(),
			getUpdateStatus: async () => desktopUpdate.snapshot(),
			checkForUpdate: async () => desktopUpdate.check(),
			downloadUpdate: async () => desktopUpdate.download(),
			applyUpdate: async () => desktopUpdate.apply(),
			/* Rolling the room is only offered when there is a room: a lone
			 * desk already has the single-desk update above. */
			startFleetUpdate: async () => fleetRollout.run(),

			// The web wire's heartbeat. Existing is the entire answer.
			ping: async () => true as const,

			getContainment: async ({ backendId }) => describeContainment(backendId),

			revealDataFolder: async () => {
				Utils.openPath(ROOT);
			},

			loadTranscript: async ({ personaId }) => transcript.load(personaId),

			toggleReaction: async ({ personaId, eventId, emoji }) => {
				// A courtesy bound, not a feature: a "reaction" the length of a
				// paragraph is a message that dodged the composer.
				if (!emoji || emoji.length > 16) return;
				const found = transcript.load(personaId).find((event) => event.id === eventId);
				if (!found || (found.kind !== "user" && found.kind !== "agent")) return;
				const current = found.reactions ?? [];
				const added = !current.includes(emoji);
				const next = added
					? [...current, emoji]
					: current.filter((mark) => mark !== emoji);
				const updated = { ...found, reactions: next.length > 0 ? next : undefined };
				// The store folds by id, so an update is an append wearing the same id.
				transcript.append(personaId, updated);
				send("transcriptUpdated", { personaId, event: updated });
				/* A mark on the agent's own message is worth its knowing — as a
				 * whispered line ahead of the next message, never a turn. The note
				 * states what happened and nothing about what it means. */
				if (found.kind === "agent") {
					const key = `${eventId}:${emoji}`;
					if (added) {
						supervisor.noteReaction(
							personaId,
							key,
							`the user reacted ${emoji} to your message ${JSON.stringify(reactionSnippet(found.text))}`,
						);
					} else {
						supervisor.retractReaction(personaId, key);
					}
				}
			},

			searchAllThreads: async ({ query, limit }) => search.searchAll(query, limit),
			searchThread: async ({ personaId, query, limit }) =>
				search.search(personaId, query, Math.min(40, Math.max(1, limit ?? 20))),
			listChapters: async ({ personaId }) => chapters.list(personaId),
			startFreshChapter: async ({ personaId }) => chapters.startFresh(personaId, "user"),

			/* The merged answer asks each peer for its local slice, never for its
			 * merge — a peer asked to merge would ask back, and the two calls
			 * would sit waiting on each other. The local pair below is what the
			 * wire calls, and neither is routed anywhere. */
			listPreviews: async () => mergePeerRecords("listLocalPreviews", localPreviews()),
			listLocalPreviews: async () => localPreviews(),

			listPeerThreads: async ({ personaId }) => peers.summariesFor(personaId),
			loadPeerThread: async ({ threadKey }) => {
				const local = peers.loadThread(threadKey);
				if (local) return local;
				/* Not ours. A phone wired to this desk can hold keys from any
				 * desk in the room — summaries arrive routed by persona, but the
				 * key itself names where the thread file lives. Follow it. */
				const owner = peerOwningThreadKey(threadKey);
				const wire = owner ? peerWireFor(owner) : null;
				if (!wire) return null;
				try {
					return (await wire.call("loadPeerThread", { threadKey })) as PeerThread | null;
				} catch {
					return null;
				}
			},
			listPeerActivity: async () =>
				mergePeerRecords("listLocalPeerActivity", peers.activity()),
			listLocalPeerActivity: async () => peers.activity(),
			listSchedules: async ({ personaId }) => scheduler.list(personaId),
			cancelSchedule: async ({ id }) => ({ cancelled: scheduler.cancel(id) }),
			answerPeerPermission: async ({ requestId, optionId }) => ({
				answered: peers.answerPermission(requestId, optionId),
			}),

			startSession: async ({ personaId }) => supervisor.start(personaId),
			stopSession: async ({ personaId }) => supervisor.stop(personaId),
			getSessionInfo: async ({ personaId }) => supervisor.info(personaId),

			sendPrompt: async ({ personaId, text, attachments, replyTo }) => {
				// Deliberately not awaited: a turn can run for minutes, and the UI
				// follows progress through the update stream rather than this reply.
				void supervisor.prompt(personaId, text, attachments, replyTo);
			},

			steerPrompt: async ({ personaId, text, attachments, replyTo }) => {
				void supervisor.steer(personaId, text, attachments, replyTo);
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

			answerPermission: async ({ personaId, requestId, optionId }) => ({
				answered: supervisor.answerPermission(personaId, requestId, optionId),
			}),

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
				desktopViewing(personaId);
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
				const persona = personaId.includes("/")
					? remotePersonas().find((row) => row.id === personaId)
					: getPersona(personaId);
				if (!persona) return;
				showPersonaMenu(
					persona,
					persona.node
						? remoteSessionState(personaId)
						: supervisor.info(personaId).state,
				);
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
				const state = { maximized, fullScreen: windowIsFullScreen() };
				rememberWindowState(state);
				return state;
			},
			windowSetFullScreen: async ({ fullScreen }) => {
				/* Windows has no full screen to give (see windowIsFullScreen), and
				 * echoing the request back would hide the resize grips for a state
				 * the window is not in — the bug, re-entered by one menu click. */
				if (platform() === "win32") return readWindowState();
				mainWindow.setFullScreen(fullScreen);
				return { maximized: mainWindow.isMaximized(), fullScreen };
			},
			windowClose: async () => {
				/* `close()` destroys the native window immediately. A custom caption
				 * button must take the normal close-request path so `will-close` below
				 * can refuse destruction and hide it instead. */
				mainWindow.requestClose();
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

			getPushStatus: async () => pushStatus(),
			getPushReach: async () => pushReachReport(),
			installPushKey: async ({ pem, keyId, teamId, topic }) => {
				const result = installPushKey({ pem, keyId, teamId, topic });
				return result.ok ? { ok: true } : { ok: false, error: result.error };
			},
			clearPushKey: async () => {
				clearPushKey();
				return pushStatus();
			},
			sendTestPush: async () => sendTestNotification(),
			sendTestDesktop: async () => sendTestDesktopNotification(),
			setDesktopAttentive: async ({ attentive }) => {
				desktopAttentive(attentive);
			},
			// Only a paired device can answer this; the web server takes it first
			// because it is the layer that knows which one is asking.
			registerPushDevice: async () => ({ registered: false }),
			reportPushProblem: async () => undefined,
		},
	},
};

/* Calls about a node-qualified persona follow it home over the peer wire.
 * Wrapped before the RPC is defined so the webview and every web client —
 * which resolve from this same map — get the routing alike. */
routeRemotePersonas(
	rpcConfig.handlers.requests as unknown as Record<string, (params: never) => Promise<unknown>>,
);

const rpc = BrowserView.defineRPC<ToadRPC>(rpcConfig);

/** Web mode answers from the same request map, over its own wire. */
const webHandler = (method: string) =>
	(rpcConfig.handlers.requests as unknown as Record<string, (params: unknown) => Promise<unknown>>)[
		method
	];

initPeerWires({ send, publishPersonas, resolve: webHandler });
/* After the wires: the first advertisement is a local write the sync plane
 * ships on its own, so nothing here waits on a link. */
initDeskCapabilities();

try {
	const origin = startNodeServer(webHandler, undefined, nodeLinkServerHooks);
	startNodeDiscovery(Number(new URL(origin).port));
} catch (error) {
	console.error("node plane failed to start:", error);
}

if (getSettings().webMode?.enabled) {
	try {
		startWebMode(webHandler);
	} catch (error) {
		console.error("web mode failed to start:", error);
	}
}

/*
 * Whether the window is really full screen — which on Windows it never is.
 *
 * Electrobun's win32 answer cannot be believed for this window. A
 * `titleBarStyle: "hidden"` window is created as a bare `WS_POPUP`
 * (`createWindowWithFrameAndStyleFromWorker` in
 * package/src/native/win/nativeWrapper.cpp), and `isWindowFullScreen` in that
 * same file decides full screen by `(style & WS_POPUP) && !(style &
 * WS_OVERLAPPEDWINDOW)` — the frameless style exactly. So every frameless
 * Windows window has claimed to be full screen from the moment it opened, and
 * the view hides the resize grips and the window hairline whenever it is: the
 * whole "Windows will not resize from its edges" report, one boolean upstream.
 *
 * `false` is also the truth about what Windows will ever do here, because
 * `setWindowFullScreen` guards on that same expression and so takes neither
 * branch for a frameless window.
 */
function windowIsFullScreen(): boolean {
	return platform() === "win32" ? false : mainWindow.isFullScreen();
}

function readWindowState(): WindowState {
	return {
		maximized: mainWindow.isMaximized(),
		fullScreen: windowIsFullScreen(),
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

/* Overridable so a second checkout can run its own vite beside the first:
 * two dev builds on one port is two windows showing one of them. */
const DEV_SERVER_URL = process.env.TOAD_DEV_SERVER_URL ?? "http://localhost:5173";

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
 * On Linux and Windows `"hidden"` gives the frameless webview its own caption
 * buttons and resize edges. Linux also draws the HTML application menu because
 * GTK's native one is a no-op; Windows keeps its working native menu.
 *
 * The lights cannot be moved: Electrobun accepts `trafficLightOffset` but its
 * native layer ignores the value, and `UnifiedTitleAndToolbar` does not make
 * AppKit re-centre them either. They sit centred on y=13.5, so the toolbar in
 * the webview is built to that line rather than fighting it.
 */
/* Annotated because the window takes `rpc` and the RPC handlers reach back for
 * the window: without a type here each one waits on the other to be inferred. */
/* Windows onto linked desktops — held so they are not collected out from
 * under the person using them. Phone-shaped, because the served app is the
 * phone experience whatever the viewport. */
const fleetWindows: BrowserWindow[] = [];
function openFleetWindow(name: string, url: string): void {
	fleetWindows.push(
		new BrowserWindow({
			title: `Toad — ${name}`,
			url,
			frame: { x: 160, y: 90, width: 430, height: 780 },
		}),
	);
}

const mainWindow: BrowserWindow = new BrowserWindow({
	title: "Toad",
	url: await mainViewUrl(),
	frame: restorableFrame(),
	titleBarStyle: platform() === "darwin" ? "hiddenInset" : "hidden",
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
	desktopShown(true);
	desktopAttentive(true);
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
	desktopShown(false);
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
	search.close();
	stopNodeDiscovery();
	stopNodeServer();
});
