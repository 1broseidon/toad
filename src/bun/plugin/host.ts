import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import packageInfo from "../../../package.json" with { type: "json" };
import type {
	PluginInfo,
	PluginManifest,
	PluginState,
	PluginToolSpec,
	PluginUninstallReport,
} from "../../shared/types";
import { childEnv } from "../child-env";
import { ROOT, ensureLayout } from "../paths";
import { loadJson, saveJson } from "../store/durable";
import { forgetTeammateTools, ledgersMentioning, markToolsAbsent } from "../agent/tool-ledger";
import { retirePluginLogs } from "./log-plane";
import { readManifest, toolListDisagreement } from "./manifest";
import { pluginReach } from "./permission";

/**
 * A plugin is a supervised per-desk child process speaking MCP over stdio.
 *
 * Toad is its client, not the agent. That inversion is the whole design and it
 * is what buys enumerability: for an ACP backend Toad hands over descriptors
 * and the backend spawns the servers itself, so Toad would never learn a
 * plugin's tool names and "not loaded, because X" would be an intention rather
 * than a fact. Standing in the middle means Toad answers `tools/list` from its
 * own knowledge and sees every `tools/call`, on both agent kinds.
 *
 * Per desk and not per session, for three reasons that all point the same way:
 * a log has exactly one writer per desk and N sessions would be N writers on
 * one stream; RPC needs an answerer when no teammate is running; and
 * enumeration needs a tool list that exists before any session starts. Per
 * teammate identity rides the proxy URL path instead.
 *
 * The manifest is captured at install, so the tool list survives the process
 * being down and the answer to "why is this tool absent" is `plugin_down`
 * rather than silence.
 */

const PLUGINS_FILE = join(ROOT, "plugins.json");
/** Each plugin's own namespace on disk: storage today, logs and blobs later. */
const PLUGINS_DIR = join(ROOT, "plugins");

/** The backoff `node/link.ts` already uses for a peer that will not stay up. */
const RESTART_BASE_MS = 2_000;
const RESTART_MAX_MS = 30_000;
const RESTART_FACTOR = 1.6;
/** Three crashes this close together and the plugin stops competing with the room. */
const CRASH_WINDOW_MS = 60_000;
const CRASH_LIMIT = 3;
const CONNECT_TIMEOUT_MS = 15_000;
/** A slow plugin must not occupy the proxy capacity Toad's own tools share. */
export const PLUGIN_CALL_TIMEOUT_MS = 60_000;
export const PLUGIN_MAX_CONCURRENT_CALLS = 4;
/** The last of the child's complaints, kept so a failure is readable. */
const STDERR_LINES = 200;

type Stored = {
	version: 1;
	plugins: Array<{ id: string; dir: string; installedAt: number; manifest: PluginManifest }>;
};

type Live = {
	manifest: PluginManifest;
	dir: string;
	installedAt: number;
	state: PluginState;
	reason: string;
	client?: Client;
	transport?: StdioClientTransport;
	stderr: string[];
	crashes: number;
	firstCrashAt: number;
	restartTimer?: ReturnType<typeof setTimeout>;
	restartDelayMs: number;
	inflight: number;
	/** The bridge token this plugin's upward door authenticates with, while up. */
	bridgeToken?: string;
	/** Set while a deliberate stop is in progress, so exit is not read as a crash. */
	stopping: boolean;
};

const live = new Map<string, Live>();
let loaded = false;

/**
 * Told when something about a plugin changed.
 *
 * `installed` and `removed` change the *descriptor list* a session is built
 * with, so a running teammate has to restart to see them. `state` does not: a
 * descriptor is emitted for a stopped plugin too, and the proxy answers
 * `tools/list` from the manifest either way, so a crash changes what a tool
 * call *returns* and not what tools exist. Keeping that distinction is what
 * stops a plugin in a restart loop from restarting every teammate on the desk
 * with it.
 */
export type PluginChange = "installed" | "removed" | "state";
type Listener = (pluginId: string, change: PluginChange) => void;
const listeners = new Set<Listener>();

export function onPluginsChanged(listener: Listener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

function announce(pluginId: string, change: PluginChange): void {
	for (const listener of listeners) {
		try {
			listener(pluginId, change);
		} catch {
			// A listener that throws must not take the supervisor with it.
		}
	}
}

function read(): Stored {
	ensureLayout();
	const parsed = loadJson<Partial<Stored>>(PLUGINS_FILE).value;
	if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.plugins)) {
		return { version: 1, plugins: [] };
	}
	return { version: 1, plugins: parsed.plugins };
}

function write(): void {
	ensureLayout();
	saveJson(PLUGINS_FILE, {
		version: 1,
		plugins: [...live.values()].map((entry) => ({
			id: entry.manifest.id,
			dir: entry.dir,
			installedAt: entry.installedAt,
			manifest: entry.manifest,
		})),
	} satisfies Stored);
}

/** Rebuilds the in-memory table from disk, once. Nothing is started by reading. */
function hydrate(): void {
	if (loaded) return;
	loaded = true;
	for (const entry of read().plugins) {
		live.set(entry.id, {
			manifest: entry.manifest,
			dir: entry.dir,
			installedAt: entry.installedAt,
			state: "installed",
			reason: "installed and agreed to; not started yet",
			stderr: [],
			crashes: 0,
			firstCrashAt: 0,
			restartDelayMs: RESTART_BASE_MS,
			inflight: 0,
			stopping: false,
		});
	}
}

/** The plugin's own directory under the data root — its storage namespace. */
export function pluginStorageDir(pluginId: string): string {
	return join(PLUGINS_DIR, pluginId);
}

export function installedPlugin(pluginId: string): PluginManifest | undefined {
	hydrate();
	return live.get(pluginId)?.manifest;
}

export function pluginState(pluginId: string): PluginState | undefined {
	hydrate();
	return live.get(pluginId)?.state;
}

/** Why a plugin is in the state it is in. Never empty for an installed plugin. */
export function pluginStateReason(pluginId: string): string | undefined {
	hydrate();
	return live.get(pluginId)?.reason;
}

export function listPlugins(): PluginInfo[] {
	hydrate();
	return [...live.values()].map((entry) => describe(entry));
}

function describe(entry: Live): PluginInfo {
	return {
		id: entry.manifest.id,
		name: entry.manifest.name,
		version: entry.manifest.version,
		...(entry.manifest.description ? { description: entry.manifest.description } : {}),
		dir: entry.dir,
		state: entry.state,
		reason: entry.reason,
		installedAt: entry.installedAt,
		tools: entry.manifest.tools,
		grants: entry.manifest.grants,
		stderr: [...entry.stderr],
		crashes: entry.crashes,
		reach: pluginReach({
			pluginId: entry.manifest.id,
			manifest: entry.manifest,
			state: entry.state,
		}),
	};
}

/** The tools a plugin declares, from the manifest, whether or not it is running. */
export function pluginTools(pluginId: string): PluginToolSpec[] {
	return installedPlugin(pluginId)?.tools ?? [];
}

/* The bridge, reached lazily — the house idiom for this cycle
 * (`fleet/fleet.ts:822`). The bridge serves the plugin surface and so imports
 * `plugin/fleet.ts`, which reads the manifests this file holds; a static import
 * back the other way would close the loop at module-evaluation time. */
type BridgeFacade = typeof import("../mcp/bridge");
function bridge(): BridgeFacade {
	return require("../mcp/bridge") as BridgeFacade;
}

/* Same reason, one layer over: `plugin/fleet.ts` reads the manifests this file
 * holds, so it imports this one. */
type PluginFleetFacade = typeof import("./fleet");
function pluginFleet(): PluginFleetFacade {
	return require("./fleet") as PluginFleetFacade;
}

/**
 * The upward door: a bridge token minted per run and revoked when the process
 * stops.
 *
 * Exactly the three variables `mcp/descriptor.ts` already injects into the ACP
 * sidecar, for exactly the same reason — the plugin is a child holding a scoped
 * connection back into Toad. What differs is the scope: a sidecar's is a
 * teammate's, and a plugin's names the plugin and no persona at all, because a
 * plugin is a desk-level process and outlives every session on the desk.
 *
 * Minted per run rather than stored, so a token that leaked into a log or a
 * crash dump dies with the process it belonged to.
 */
function openBridgeDoor(entry: Live): void {
	closeBridgeDoor(entry);
	if (!bridge().bridgeAttachmentEnabled()) return;
	entry.bridgeToken = randomUUID();
	bridge().registerBridgeScope(entry.bridgeToken, {
		kind: "plugin",
		pluginId: entry.manifest.id,
	});
}

function closeBridgeDoor(entry: Live): void {
	if (!entry.bridgeToken) return;
	bridge().revokeBridgeScope(entry.bridgeToken);
	entry.bridgeToken = undefined;
}

function transportFor(entry: Live): StdioClientTransport {
	return new StdioClientTransport({
		command: entry.manifest.serve.command,
		args: entry.manifest.serve.args,
		cwd: entry.dir,
		/* The same login-shell PATH recovery every stdio MCP server gets: an app
		 * launched from Finder or a .desktop file has almost none of the user's
		 * PATH, and a plugin's entry point lives wherever its author put it. */
		env: childEnv({
			TOAD_PLUGIN_ID: entry.manifest.id,
			TOAD_PLUGIN_DIR: entry.dir,
			TOAD_PLUGIN_STORAGE: pluginStorageDir(entry.manifest.id),
			TOAD_APP_VERSION: packageInfo.version,
			...(entry.bridgeToken && bridge().bridgeAttachmentEnabled()
				? {
						TOAD_BRIDGE_SOCKET: bridge().bridgeAttachmentEnabled()!,
						TOAD_BRIDGE_TOKEN: entry.bridgeToken,
					}
				: {}),
		}),
		stderr: "pipe",
	});
}

function captureStderr(entry: Live, transport: StdioClientTransport): void {
	const stream = transport.stderr;
	if (!stream) return;
	stream.on("data", (chunk: Buffer) => {
		for (const line of chunk.toString("utf8").split(/\r?\n/)) {
			if (!line.trim()) continue;
			entry.stderr.push(line);
		}
		if (entry.stderr.length > STDERR_LINES) {
			entry.stderr.splice(0, entry.stderr.length - STDERR_LINES);
		}
	});
}

async function connect(entry: Live): Promise<Client> {
	const client = new Client(
		{ name: "Toad", version: packageInfo.version },
		{ versionNegotiation: { mode: "auto" } },
	);
	openBridgeDoor(entry);
	const transport = transportFor(entry);
	entry.transport = transport;
	captureStderr(entry, transport);
	transport.onclose = () => onExit(entry);
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			client.connect(transport),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error(`${entry.manifest.name} did not answer initialize in 15s`)),
					CONNECT_TIMEOUT_MS,
				);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
	return client;
}

/**
 * A plugin that exited. Deliberately, or not — and the difference decides
 * whether Toad tries again.
 *
 * Crashing three times inside a minute stops it and leaves it stopped, with
 * the reason on the plugin page, rather than restarting forever beside a room
 * that has work to do. That is the same judgment the mesh makes about a peer
 * that will not stay up.
 */
function onExit(entry: Live): void {
	entry.client = undefined;
	entry.transport = undefined;
	closeBridgeDoor(entry);
	if (entry.stopping) return;

	const now = Date.now();
	if (now - entry.firstCrashAt > CRASH_WINDOW_MS) {
		entry.firstCrashAt = now;
		entry.crashes = 0;
	}
	entry.crashes += 1;

	if (entry.crashes >= CRASH_LIMIT) {
		entry.state = "stopped";
		entry.reason = `${entry.manifest.name} crashed ${entry.crashes} times in under a minute and was left stopped; the last stderr lines are on its page`;
		toolsGone(entry);
		announce(entry.manifest.id, "state");
		return;
	}
	entry.state = "failed";
	const delay = Math.round(entry.restartDelayMs * (0.75 + Math.random() * 0.5));
	entry.reason = `${entry.manifest.name} exited; restarting in ${Math.round(delay / 1000)}s (attempt ${entry.crashes + 1})`;
	entry.restartDelayMs = Math.min(RESTART_MAX_MS, entry.restartDelayMs * RESTART_FACTOR);
	entry.restartTimer = setTimeout(() => {
		entry.restartTimer = undefined;
		void startPlugin(entry.manifest.id);
	}, delay);
	toolsGone(entry);
	announce(entry.manifest.id, "state");
}

/**
 * Every teammate whose ledger held this plugin's tools now says why they are
 * gone — in the plugin's own words, not in a sentence that fits every failure.
 *
 * "Not running" is true of a plugin that was stopped from its page, one that
 * crashed twice in ten seconds, and one whose live tool list turned out to be a
 * different tool list. Those are three different things to know, and the state
 * reason is where each of them is already written. Called after `entry.reason`
 * is set, always, or the ledger records the last life's news.
 */
function toolsGone(entry: Live): void {
	for (const personaId of ledgersMentioning("plugin", entry.manifest.id)) {
		markToolsAbsent({
			personaId,
			source: "plugin",
			origin: entry.manifest.id,
			reason: `plugin_down: ${entry.reason}`,
		});
	}
}

export async function startPlugin(pluginId: string): Promise<PluginInfo | null> {
	hydrate();
	const entry = live.get(pluginId);
	if (!entry) return null;
	if (entry.client) return describe(entry);
	entry.stopping = false;
	try {
		const client = await connect(entry);
		const { tools } = await client.listTools();
		const disagreement = toolListDisagreement(entry.manifest, tools);
		if (disagreement.length > 0) {
			/* The manifest is what Toad answers `tools/list` from before the
			 * process is awake. A live list that disagrees means Toad has been
			 * telling every teammate on this desk about tools that are not there,
			 * which is the exact failure the manifest exists to prevent. */
			entry.stopping = true;
			await client.close().catch(() => undefined);
			entry.stopping = false;
			entry.client = undefined;
			closeBridgeDoor(entry);
			entry.state = "failed";
			entry.reason = `${entry.manifest.name} serves a different tool list than its manifest: ${disagreement.join("; ")}`;
			/* The ledger has to hear about this one especially: the rows Toad
			 * wrote when the plugin last started say `verified`, and a tool list
			 * that turned out to be a different tool list is precisely when a
			 * stale `verified` becomes Toad telling a teammate something false. */
			toolsGone(entry);
			announce(pluginId, "state");
			return describe(entry);
		}
		entry.client = client;
		entry.state = "running";
		entry.reason = `${entry.manifest.name} is running and serves ${tools.length} tool${tools.length === 1 ? "" : "s"}`;
		entry.crashes = 0;
		entry.restartDelayMs = RESTART_BASE_MS;
	} catch (error) {
		closeBridgeDoor(entry);
		entry.state = "failed";
		entry.reason = `${entry.manifest.name} did not start: ${(error as Error).message}`;
		entry.client = undefined;
		toolsGone(entry);
	}
	announce(pluginId, "state");
	return describe(entry);
}

export async function stopPlugin(pluginId: string): Promise<PluginInfo | null> {
	hydrate();
	const entry = live.get(pluginId);
	if (!entry) return null;
	if (entry.restartTimer) {
		clearTimeout(entry.restartTimer);
		entry.restartTimer = undefined;
	}
	entry.stopping = true;
	const client = entry.client;
	entry.client = undefined;
	await client?.close().catch(() => undefined);
	closeBridgeDoor(entry);
	entry.stopping = false;
	entry.state = "stopped";
	entry.crashes = 0;
	entry.restartDelayMs = RESTART_BASE_MS;
	entry.reason = `${entry.manifest.name} was stopped from its plugin page`;
	toolsGone(entry);
	announce(pluginId, "state");
	return describe(entry);
}

export type InstallResult =
	| { ok: true; plugin: PluginInfo }
	| { ok: false; problems: string[] };

/**
 * The way in.
 *
 * Read the manifest, validate it, spawn once, compare the live `tools/list`
 * against the manifest and refuse on any mismatch, persist, advertise. The
 * spawn-before-persist ordering is the point: an install that has not proved
 * the plugin serves what it claims is an install that will make Toad lie later.
 *
 * `grant` is the person's decision, taken in front of the tool list and the
 * requested grants. Refusing to install without it is what keeps the dialog
 * from being decorative.
 */
export async function installPlugin(input: {
	source: string;
	granted: boolean;
}): Promise<InstallResult> {
	hydrate();
	if (!input.granted) {
		return { ok: false, problems: ["the grants were not agreed to, so nothing was installed"] };
	}
	const dir = resolve(input.source);
	const manifestResult = readManifest(dir);
	if (!manifestResult.ok) return { ok: false, problems: manifestResult.problems };
	const manifest = manifestResult.manifest;

	if (live.has(manifest.id)) {
		return {
			ok: false,
			problems: [`${manifest.id} is already installed; uninstall it first — a plugin id is immutable`],
		};
	}

	const entry: Live = {
		manifest,
		dir,
		installedAt: Date.now(),
		state: "installed",
		reason: "installed and agreed to; not started yet",
		stderr: [],
		crashes: 0,
		firstCrashAt: 0,
		restartDelayMs: RESTART_BASE_MS,
		inflight: 0,
		stopping: false,
	};
	live.set(manifest.id, entry);

	const started = await startPlugin(manifest.id);
	if (!started || started.state !== "running") {
		const reason = started?.reason ?? "the plugin did not start";
		const trailing = entry.stderr.slice(-5);
		live.delete(manifest.id);
		return { ok: false, problems: [reason, ...trailing] };
	}

	mkdirSync(pluginStorageDir(manifest.id), { recursive: true });
	write();
	announce(manifest.id, "installed");
	return { ok: true, plugin: started };
}

/**
 * The way out.
 *
 * Stops the process, drops the descriptor and the tool rows, deletes the
 * plugin's own storage, and reports what it actually did — by teammate name,
 * not as a promise. A teardown that says "done" without looking is how a
 * feature acquires a one-way door.
 */
export async function uninstallPlugin(pluginId: string): Promise<PluginUninstallReport> {
	hydrate();
	const entry = live.get(pluginId);
	if (!entry) {
		return {
			id: pluginId,
			removed: false,
			teammates: [],
			logs: { owned: [], mirrors: [], confirmed: [], unconfirmed: [] },
			pending: ["it is not installed here"],
		};
	}
	await stopPlugin(pluginId);
	const teammates = ledgersMentioning("plugin", pluginId);
	for (const personaId of teammates) {
		markToolsAbsent({
			personaId,
			source: "plugin",
			origin: pluginId,
			reason: `${entry.manifest.name} was uninstalled from this desk`,
		});
	}
	const pending: string[] = [];
	/* The log plane's half of the teardown, reported the same way: what was
	 * deleted here, and which desks' mirrors went with it. The generation
	 * counters deliberately survive, so a reinstall does not write generation 1
	 * into a mirror on a desk that was dark through this. */
	const retired = retirePluginLogs(pluginId);
	/* And the other half of it: every desk holding a mirror of a log this desk
	 * owned is asked to drop it, and the answer is who did. A desk that is dark
	 * keeps its mirror; naming it is what makes this a look rather than a claim. */
	const across = await pluginFleet()
		.retireLogsAcrossRoom(pluginId)
		.catch(() => ({
			confirmed: [] as string[],
			unconfirmed: [] as string[],
		}));
	const logs = {
		owned: retired.owned,
		mirrors: retired.mirrorsDropped.map((entry) => entry.nodeId),
		confirmed: across.confirmed,
		unconfirmed: across.unconfirmed,
	};
	const storage = pluginStorageDir(pluginId);
	if (existsSync(storage)) {
		try {
			rmSync(storage, { recursive: true, force: true });
		} catch (error) {
			pending.push(`${storage} could not be deleted: ${(error as Error).message}`);
		}
	}
	live.delete(pluginId);
	write();
	announce(pluginId, "removed");
	return { id: pluginId, removed: true, teammates, logs, pending };
}

/** Forget a teammate's ledger entirely — used when the teammate itself is deleted. */
export function forgetPluginTools(personaId: string): void {
	forgetTeammateTools(personaId);
}

export type PluginCallResult =
	| { ok: true; result: unknown }
	| { ok: false; code: string; reason: string };

/**
 * One tool call, forwarded to the plugin's own MCP server.
 *
 * The gate above this is `pluginMay`; this is only the hot path. Toad standing
 * in the middle is a real cost — a slow plugin occupies capacity Toad's own
 * tools share — so the concurrency limit and the timeout are here rather than
 * owed, and a plugin that hits them refuses with a sentence instead of hanging
 * the teammate that called it.
 */
export async function callPluginTool(
	pluginId: string,
	name: string,
	args: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<PluginCallResult> {
	hydrate();
	const entry = live.get(pluginId);
	if (!entry) return { ok: false, code: "plugin_absent", reason: `${pluginId} is not installed here` };
	if (!entry.client) {
		return { ok: false, code: "plugin_down", reason: entry.reason };
	}
	if (entry.inflight >= PLUGIN_MAX_CONCURRENT_CALLS) {
		return {
			ok: false,
			code: "busy",
			reason: `${entry.manifest.name} already has ${PLUGIN_MAX_CONCURRENT_CALLS} calls in flight on this desk`,
		};
	}
	entry.inflight += 1;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const result = await Promise.race([
			entry.client.callTool({ name, arguments: args }, signal ? { signal } : undefined),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error(`${entry.manifest.name} did not answer "${name}" in 60s`)),
					PLUGIN_CALL_TIMEOUT_MS,
				);
			}),
		]);
		return { ok: true, result };
	} catch (error) {
		return { ok: false, code: "failed", reason: (error as Error).message };
	} finally {
		if (timer) clearTimeout(timer);
		entry.inflight -= 1;
	}
}

/** Start everything installed. Called once at boot; safe to call again. */
export async function startInstalledPlugins(): Promise<PluginInfo[]> {
	hydrate();
	const ids = [...live.keys()];
	const started = await Promise.all(ids.map((id) => startPlugin(id)));
	return started.filter((entry): entry is PluginInfo => entry !== null);
}

/** Stops every plugin, for app shutdown. */
export async function stopAllPlugins(): Promise<void> {
	hydrate();
	await Promise.all([...live.keys()].map((id) => stopPlugin(id)));
}

/** Test seam: forget everything without touching disk. */
export function resetPluginHostForTests(): void {
	for (const entry of live.values()) {
		if (entry.restartTimer) clearTimeout(entry.restartTimer);
		closeBridgeDoor(entry);
	}
	live.clear();
	loaded = false;
}
