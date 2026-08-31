import { existsSync, mkdirSync, readdirSync, rmSync, statSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, encodeFileComponent, ensureLayout } from "../paths";
import { loadJson, saveJson } from "../store/durable";
import { localNodeId } from "../store/records";
import {
	readFileRange,
	streamCursor,
	streamHoldings,
	streamOwners,
	streamRetire,
	type StreamCursor,
} from "../store/streams";
import {
	noteAppend,
	registerLogSource,
	type LogSource,
	type ReplicationLink,
} from "../fleet/stream-replication";

/**
 * A plugin's own append-only replicated logs — pattern 2, and the only durable
 * shape the plugin API offers.
 *
 * Every desk that installs a plugin owns its own copy of each declared log and
 * mirrors every other desk's. N single-writer logs plus a local fold is what
 * lets a plugin build shared state with no coordinator: the board's concurrent
 * claim resolves because both claims exist in different logs and every desk
 * folds the same two of them, not because anybody took a lock.
 *
 * **There is no `owner` parameter on append.** Writing someone else's mirror is
 * inexpressible here, which is exactly how transcript replication gets its
 * first-hand-ness and it survives verbatim: Toad stamps the writer from the
 * authenticated link on the way in, and the writer cannot forge it.
 *
 * **The third key component is `gen`, never `epoch`.** A persona's epoch means
 * ownership and rotates on a hop. A plugin log has no ownership epoch, so it
 * gets its own generation, minted the first time the log is opened and bumped
 * only when the bytes behind it are gone — a reinstall after an uninstall, or
 * an explicit rotate. That is the whole reason the counter exists: a mirror on
 * a desk that was dark through the uninstall still holds the old life's bytes,
 * and a new life that reused the number would append into them.
 *
 * No compaction, no retention, no cross-stream ordering. A log carries what
 * must survive a dark peer; ordering across two logs is the plugin's own
 * business — the board writes a Lamport stamp in about twenty lines, and
 * supplying ordering here would be the special case that proves the API wrong.
 */

export const PLUGIN_STREAM_PREFIX = "plugin:";

/** Owned logs, apart from `plugins/<id>` which is the plugin's own scratch —
 *  a process that can write its storage must not be able to rewrite its log. */
const LOGS_DIR = () => join(ROOT, "plugin-logs");
const GENERATIONS_FILE = () => join(LOGS_DIR(), "generations.json");

/** One frame of log, matching what the mirror ships. */
const MAX_READ_BYTES = 256 * 1024;
/** One appended line. Bytes are pattern 4; this is not the way to move a file. */
export const MAX_APPEND_BYTES = 64 * 1024;

export function pluginLogStreamId(pluginId: string, logId: string): string {
	return `${PLUGIN_STREAM_PREFIX}${pluginId}/${logId}`;
}

export function parsePluginLogStream(streamId: string): { pluginId: string; logId: string } | null {
	if (!streamId.startsWith(PLUGIN_STREAM_PREFIX)) return null;
	const rest = streamId.slice(PLUGIN_STREAM_PREFIX.length);
	const slash = rest.indexOf("/");
	if (slash <= 0 || slash === rest.length - 1) return null;
	return { pluginId: rest.slice(0, slash), logId: rest.slice(slash + 1) };
}

function logDir(pluginId: string, logId: string): string {
	return join(LOGS_DIR(), encodeFileComponent(pluginId), encodeFileComponent(logId));
}

function segmentPath(pluginId: string, logId: string, gen: number): string {
	return join(logDir(pluginId, logId), `${gen}.jsonl`);
}

type Generations = { version: 1; gens: Record<string, number> };

function readGenerations(): Generations {
	const parsed = loadJson<Partial<Generations>>(GENERATIONS_FILE()).value;
	if (!parsed || parsed.version !== 1 || !parsed.gens) return { version: 1, gens: {} };
	return { version: 1, gens: parsed.gens };
}

function writeGenerations(gens: Record<string, number>): void {
	mkdirSync(LOGS_DIR(), { recursive: true });
	saveJson(GENERATIONS_FILE(), { version: 1, gens } satisfies Generations);
}

/**
 * The generation this desk writes, minted on demand.
 *
 * A remembered generation whose bytes are gone opens the next one. That is the
 * uninstall-then-reinstall case, and it is why the counter outlives the
 * directory it counts: a desk that was dark through the uninstall still holds
 * generation 1, and re-opening at 1 would append this life's lines into the
 * last life's mirror.
 */
export function openPluginLog(pluginId: string, logId: string): { gen: number; offset: number } {
	ensureLayout();
	const streamId = pluginLogStreamId(pluginId, logId);
	const stored = readGenerations();
	const remembered = stored.gens[streamId];
	let gen = remembered ?? 1;
	if (remembered !== undefined && !existsSync(segmentPath(pluginId, logId, remembered))) {
		gen = remembered + 1;
	}
	if (gen !== remembered) {
		stored.gens[streamId] = gen;
		writeGenerations(stored.gens);
	}
	mkdirSync(logDir(pluginId, logId), { recursive: true });
	/* The segment file is created empty at open, and that is load-bearing: the
	 * bump above fires when a remembered generation has no bytes on disk, so a
	 * log that was opened and not yet written to would otherwise bump its
	 * generation on every single open. An empty segment is a log that exists
	 * and is empty, which is exactly the true statement. */
	const path = segmentPath(pluginId, logId, gen);
	if (!existsSync(path)) appendFileSync(path, "");
	return { gen, offset: sizeOf(pluginId, logId, gen) };
}

function sizeOf(pluginId: string, logId: string, gen: number): number {
	const path = segmentPath(pluginId, logId, gen);
	return existsSync(path) ? statSync(path).size : 0;
}

/** Which generation this desk writes, without minting one. */
export function currentGeneration(pluginId: string, logId: string): number | undefined {
	return readGenerations().gens[pluginLogStreamId(pluginId, logId)];
}

/**
 * One line appended to a log this desk owns, and shipped to every up wire.
 *
 * The bytes are a line: a trailing newline is added when the caller left one
 * off, because the whole store is newline-delimited and half a record on the
 * end of a segment is a torn tail every mirror will then hold forever.
 */
export function appendPluginLog(
	pluginId: string,
	logId: string,
	bytes: Uint8Array,
): { gen: number; offset: number; size: number } {
	const { gen } = openPluginLog(pluginId, logId);
	const terminated =
		bytes.length > 0 && bytes[bytes.length - 1] === 0x0a
			? bytes
			: new Uint8Array([...bytes, 0x0a]);
	const offset = sizeOf(pluginId, logId, gen);
	appendFileSync(segmentPath(pluginId, logId, gen), terminated);
	noteAppend(pluginLogStreamId(pluginId, logId), gen, offset, terminated);
	return { gen, offset, size: offset + terminated.length };
}

/** Byte length of each generation of an owned log. */
export function ownedSizes(pluginId: string, logId: string): Record<string, number> {
	const dir = logDir(pluginId, logId);
	const sizes: Record<string, number> = {};
	if (!existsSync(dir)) return sizes;
	for (const name of readdirSync(dir)) {
		const match = /^([1-9]\d*)\.jsonl$/.exec(name);
		if (!match) continue;
		sizes[match[1]!] = statSync(join(dir, name)).size;
	}
	return sizes;
}

export function readOwned(
	pluginId: string,
	logId: string,
	gen: number,
	offset: number,
	length: number,
): Uint8Array {
	return readFileRange(segmentPath(pluginId, logId, gen), offset, length);
}

/** Every log this desk owns bytes for, as stream ids. */
export function ownedLogStreams(): string[] {
	const root = LOGS_DIR();
	if (!existsSync(root)) return [];
	const streams: string[] = [];
	for (const [streamId] of Object.entries(readGenerations().gens)) {
		const parsed = parsePluginLogStream(streamId);
		if (!parsed) continue;
		if (Object.keys(ownedSizes(parsed.pluginId, parsed.logId)).length === 0) continue;
		streams.push(streamId);
	}
	return streams;
}

/**
 * Everything a plugin's logs amount to across the room, told honestly.
 *
 * The difference between "who is writing this log" and "whose writing I can
 * see" is the whole reason a fold can report its own completeness. Nothing
 * here promises a mirror will arrive; it says which owners this desk holds
 * bytes from, and how many.
 */
export type PluginLogReach = {
	logId: string;
	streamId: string;
	/** This desk's own writing, or null if it has never opened the log. */
	self: { nodeId: string; gen: number; bytes: number } | null;
	/** Every other desk whose writing this desk holds. */
	mirrors: Array<{ nodeId: string; gens: StreamCursor; bytes: number }>;
};

export function pluginLogReach(pluginId: string, logId: string): PluginLogReach {
	const streamId = pluginLogStreamId(pluginId, logId);
	const gen = currentGeneration(pluginId, logId);
	const sizes = ownedSizes(pluginId, logId);
	const mirrors: PluginLogReach["mirrors"] = [];
	for (const owner of streamOwners()) {
		if (!streamHoldings(owner).includes(streamId)) continue;
		const gens = streamCursor(owner, streamId);
		const bytes = Object.values(gens).reduce((total, entry) => total + entry.held, 0);
		mirrors.push({ nodeId: owner, gens, bytes });
	}
	return {
		logId,
		streamId,
		self:
			gen === undefined
				? null
				: { nodeId: localNodeId(), gen, bytes: sizes[String(gen)] ?? 0 },
		mirrors,
	};
}

/** A range of one log, from this desk's own bytes or from a mirror of a peer's. */
export function readPluginLog(input: {
	pluginId: string;
	logId: string;
	ownerNode: string;
	gen: number;
	from: number;
	len: number;
}): { data: string; from: number; eof: boolean } {
	const length = Math.max(0, Math.min(input.len, MAX_READ_BYTES));
	const bytes =
		input.ownerNode === localNodeId()
			? readOwned(input.pluginId, input.logId, input.gen, input.from, length)
			: readFileRange(
					mirrorSegmentPath(input.ownerNode, pluginLogStreamId(input.pluginId, input.logId), input.gen),
					input.from,
					length,
				);
	return {
		data: Buffer.from(bytes).toString("base64"),
		from: input.from,
		eof: bytes.length < length,
	};
}

/** The mirror store's own layout, reached for reads only. */
function mirrorSegmentPath(ownerNode: string, streamId: string, gen: number): string {
	return join(ROOT, "streams", ownerNode, encodeFileComponent(streamId), `${gen}.jsonl`);
}

/**
 * The way out, on the log plane: every byte of every log a plugin owned here,
 * and every mirror of another desk's copy of it. Reports what it deleted, by
 * desk, because a teardown is a look and not a promise.
 */
export function retirePluginLogs(pluginId: string): {
	owned: string[];
	mirrorsDropped: Array<{ nodeId: string; streamId: string }>;
} {
	const owned: string[] = [];
	const dir = join(LOGS_DIR(), encodeFileComponent(pluginId));
	if (existsSync(dir)) {
		for (const streamId of ownedLogStreams()) {
			if (parsePluginLogStream(streamId)?.pluginId === pluginId) owned.push(streamId);
		}
		rmSync(dir, { recursive: true, force: true });
	}
	const mirrorsDropped: Array<{ nodeId: string; streamId: string }> = [];
	const prefix = `${PLUGIN_STREAM_PREFIX}${pluginId}/`;
	for (const owner of streamOwners()) {
		for (const streamId of streamHoldings(owner)) {
			if (!streamId.startsWith(prefix)) continue;
			if (streamRetire(owner, streamId)) mirrorsDropped.push({ nodeId: owner, streamId });
		}
	}
	/* The generation counters deliberately survive. They are the only thing that
	 * stops a reinstall writing generation 1 into a mirror still holding the
	 * last life's generation 1 on a desk that was dark through the uninstall. */
	return { owned, mirrorsDropped };
}

/* ------------------------------------------------------- the replication source */

/**
 * What a plugin log source needs from the rest of the app, injected rather than
 * imported: the log plane sits under the plugin host and the fleet both, and
 * importing either from here would close a cycle.
 */
export type LogPlaneDeps = {
	/** Log ids the local install of this plugin was granted. Empty when absent. */
	grantedLogs(pluginId: string): string[];
	/** Plugin ids a peer desk advertises. Empty when it advertises nothing. */
	pluginsOn(nodeId: string): string[];
	/** One `plugin` fleet call to a peer over its NodeLink. */
	call(link: ReplicationLink, pluginId: string, kind: string, body: unknown): Promise<unknown>;
};

let deps: LogPlaneDeps | undefined;
let registered = false;

const logSource: LogSource = {
	prefix: PLUGIN_STREAM_PREFIX,
	owned: () => ownedLogStreams(),
	expected: (peerId) => {
		if (!deps) return [];
		const expected: string[] = [];
		for (const pluginId of deps.pluginsOn(peerId)) {
			for (const logId of deps.grantedLogs(pluginId)) {
				expected.push(pluginLogStreamId(pluginId, logId));
			}
		}
		return expected;
	},
	sizes: (streamId) => {
		const parsed = parsePluginLogStream(streamId);
		return parsed ? ownedSizes(parsed.pluginId, parsed.logId) : {};
	},
	read: (streamId, gen, offset, length) => {
		const parsed = parsePluginLogStream(streamId);
		return parsed ? readOwned(parsed.pluginId, parsed.logId, gen, offset, length) : new Uint8Array(0);
	},
	frames: { cursors: "plugin.log.cursors", delta: "plugin.log.delta", reset: "plugin.log.reset" },
	wire: {
		cursors: (link, cursors) => callFor(link, cursors, "cursors", { cursors }),
		delta: (link, streamId, gen, offset, data) =>
			callOne(link, streamId, "delta", { streamId, gen, offset, data }) as Promise<{
				ok?: boolean;
				held?: number;
			}>,
		reset: (link, streamId, gen) => callOne(link, streamId, "reset", { streamId, gen }),
	},
};

/**
 * One `plugin` fleet method, always, with the plugin id as a field.
 *
 * Never a `plugin:<id>/<method>` string on the wire: peer methods resolve
 * `peerMethod(...) ?? resolveLocal(...)` and `resolveLocal` is the entire app
 * RPC handler map, so the peer namespace is already flat and already global. A
 * prefixed string is one typo from shadowing `updateAppSettings`. A field is not.
 */
function callOne(
	link: ReplicationLink,
	streamId: string,
	kind: string,
	body: Record<string, unknown>,
): Promise<unknown> {
	const parsed = parsePluginLogStream(streamId);
	if (!parsed || !deps) return Promise.reject(new Error(`not a plugin log stream: ${streamId}`));
	return deps.call(link, parsed.pluginId, `log.${kind}`, body);
}

/** Cursors span several plugins at once, so they go out one call per plugin. */
async function callFor(
	link: ReplicationLink,
	cursors: Record<string, StreamCursor>,
	kind: string,
	_body: unknown,
): Promise<unknown> {
	if (!deps) return null;
	const byPlugin = new Map<string, Record<string, StreamCursor>>();
	for (const [streamId, cursor] of Object.entries(cursors)) {
		const parsed = parsePluginLogStream(streamId);
		if (!parsed) continue;
		const held = byPlugin.get(parsed.pluginId) ?? {};
		held[streamId] = cursor;
		byPlugin.set(parsed.pluginId, held);
	}
	await Promise.all(
		[...byPlugin].map(([pluginId, held]) =>
			deps!.call(link, pluginId, `log.${kind}`, { cursors: held }).catch(() => null),
		),
	);
	return null;
}

export function initPluginLogPlane(injected: LogPlaneDeps): void {
	deps = injected;
	if (registered) return;
	registered = true;
	registerLogSource(logSource);
}

/** The source itself, for the inbound handler that has to answer cursors. */
export function pluginLogSource(): LogSource {
	return logSource;
}
