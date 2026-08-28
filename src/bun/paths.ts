import { homedir, platform } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";

function appSupportDir(): string {
	// An explicit override keeps tests and multiple profiles off the real data.
	const override = process.env.TOAD_DATA_DIR;
	if (override) return override;

	const home = homedir();
	switch (platform()) {
		case "darwin":
			return join(home, "Library", "Application Support", "Toad");
		case "win32":
			return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Toad");
		default:
			return join(process.env.XDG_DATA_HOME ?? join(home, ".local", "share"), "toad");
	}
}

export const ROOT = appSupportDir();
export const CONFIG_FILE = join(ROOT, "config.json");
/** App preferences and remembered window state, kept apart from the roster. */
export const SETTINGS_FILE = join(ROOT, "settings.json");
export const SCHEDULES_FILE = join(ROOT, "schedules.json");
/** Bun-derived per-teammate computer state (tokens, activity) — not user config. */
export const COMPUTERS_FILE = join(ROOT, "computers.json");
export const TRANSCRIPTS_DIR = join(ROOT, "transcripts");
/** The record store: owner-stamped rosters, their oplog, and their tombstones. */
export const STORE_FILE = join(ROOT, "store.sqlite");
/** Plain-JSON export of the store, written for humans and never read back. */
export const STORE_SNAPSHOT_FILE = join(ROOT, "store-snapshot.json");
export const WORKSPACES_DIR = join(ROOT, "workspaces");
export const CACHE_DIR = join(ROOT, "cache");
export const ATTACHMENTS_DIR = join(ROOT, "attachments");
export const THREADS_DIR = join(ROOT, "threads");
export const RUN_DIR = join(ROOT, "run");
/**
 * The APNs signing key and its identifiers.
 *
 * Here rather than in settings for the same reason the wire token is: settings
 * are a file a person edits, and a `.p8` signs pushes for every device that
 * ever paired with this desktop. Locked to the owner on POSIX.
 */
export const PUSH_DIR = join(ROOT, "push");
/**
 * Toad's own pi configuration directory.
 *
 * Deliberately not `~/.pi/agent`: pi's resource loader executes whatever it
 * finds in `extensions/`, and a global extension a user installed for their
 * terminal has no business running inside a desktop app that never asked. Only
 * credentials are shared from the user's own pi install, and only by reading
 * that one file — see `authPath` in src/bun/pi/runtime.ts.
 */
export const PI_DIR = join(ROOT, "pi");

/**
 * Refuses to touch the real data directory when something asked for another.
 *
 * `ROOT` resolves once, at import. Bun runs every test file in one process, so
 * a file that statically imports anything reaching this module — `pi/subagent`
 * does, by way of `PI_DIR` — resolves `ROOT` before a later file sets
 * `TOAD_DATA_DIR`. That later file then writes its fixtures into the user's own
 * roster believing it is in `/tmp`. That is how a live roster was replaced by
 * two test personas. Tests now get their directory from a preload
 * (`test/preload.ts`); this makes the failure loud if anything slips past it.
 */
export function assertDataRoot(): void {
	const override = process.env.TOAD_DATA_DIR;
	if (override && override !== ROOT) {
		throw new Error(
			`TOAD_DATA_DIR is ${override} but paths already resolved ${ROOT}. ` +
				"Set it before any Toad module is imported — see test/preload.ts.",
		);
	}
}

export function ensureLayout(): void {
	assertDataRoot();
	for (const dir of [
		ROOT,
		TRANSCRIPTS_DIR,
		WORKSPACES_DIR,
		CACHE_DIR,
		ATTACHMENTS_DIR,
		THREADS_DIR,
		RUN_DIR,
		PI_DIR,
		PUSH_DIR,
	]) {
		mkdirSync(dir, { recursive: true });
	}
	if (platform() !== "win32") {
		chmodSync(RUN_DIR, 0o700);
		chmodSync(PUSH_DIR, 0o700);
	}
}

/**
 * A logical id as one portable filesystem component.
 *
 * `%` is escaped first, making the encoding reversible without a prefix and
 * leaving the UUID-only names already on disk byte-for-byte unchanged. The
 * set is Windows' forbidden filename set plus control bytes, trailing dots or
 * spaces, and device names; applying it on every OS makes moved data keep the
 * same names.
 */
export function encodeFileComponent(value: string): string {
	if (!value) throw new Error("An empty value cannot name a file");
	const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value);
	let encoded = value.replace(/[%<>:\"/\\|?*\u0000-\u001f\u007f]/g, (character) =>
		[...Buffer.from(character)]
			.map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`)
			.join(""),
	);
	encoded = encoded.replace(/[ .]+$/g, (tail) =>
		[...Buffer.from(tail)]
			.map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`)
			.join(""),
	);
	if (reserved) {
		encoded = `%${encoded.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}${encoded.slice(1)}`;
	}
	return encoded;
}

export function decodeFileComponent(value: string): string {
	return value.replace(/%([0-9a-f]{2})/gi, (_, hex: string) =>
		String.fromCharCode(Number.parseInt(hex, 16)),
	);
}

/**
 * New managed names use the portable component. A path-safe raw predecessor
 * still wins when it already exists, so Mac/Linux threads written before this
 * encoding continue in place rather than splitting their history.
 */
function managedPath(directory: string, logical: string, suffix = ""): string {
	const encoded = join(directory, `${encodeFileComponent(logical)}${suffix}`);
	if (encoded === join(directory, `${logical}${suffix}`)) return encoded;
	if (!/[\\/]/.test(logical)) {
		const legacy = join(directory, `${logical}${suffix}`);
		if (existsSync(legacy) && !existsSync(encoded)) return legacy;
	}
	return encoded;
}

/** The legacy flat transcript, which readers keep consulting as the epoch-1 segment. */
export function transcriptPath(personaId: string): string {
	return managedPath(TRANSCRIPTS_DIR, personaId, ".jsonl");
}

/**
 * Directory of a teammate's epoch segments.
 *
 * A sibling of the legacy flat file rather than a replacement for it: the two
 * names never collide, so relocating one is a rename and never a rewrite.
 */
export function transcriptSegmentsDir(personaId: string): string {
	return managedPath(TRANSCRIPTS_DIR, personaId);
}

export function transcriptSegmentPath(personaId: string, epoch: number): string {
	return join(transcriptSegmentsDir(personaId), `${epoch}.jsonl`);
}

/**
 * Where a teammate's pasted attachments live.
 *
 * Kept beside the transcript rather than in the workspace: a screenshot pasted
 * into a conversation is part of the conversation, and dropping it into the
 * agent's working directory would put it in front of `git status`.
 */
export function attachmentsDir(personaId: string): string {
	const dir = managedPath(ATTACHMENTS_DIR, personaId);
	mkdirSync(dir, { recursive: true });
	return dir;
}

export function defaultWorkspace(personaId: string): string {
	return managedPath(WORKSPACES_DIR, personaId);
}

function safeThreadId(id: string): void {
	if (!id || /[~/.]/.test(id)) throw new Error("Invalid persona id for peer thread");
}

export function threadKey(a: string, b: string): string {
	safeThreadId(a);
	safeThreadId(b);
	return [a, b].sort().join("~");
}

export function threadPath(key: string): string {
	const [a, b, ...rest] = key.split("~");
	if (!a || !b || rest.length > 0 || threadKey(a, b) !== key) throw new Error("Invalid thread key");
	return managedPath(THREADS_DIR, key, ".jsonl");
}

export function threadMetaPath(key: string): string {
	const [a, b, ...rest] = key.split("~");
	if (!a || !b || rest.length > 0 || threadKey(a, b) !== key) throw new Error("Invalid thread key");
	return managedPath(THREADS_DIR, key, ".json");
}

export function bridgeSocketPath(): string {
	if (platform() === "win32") {
		const hash = createHash("sha256").update(ROOT).digest("hex").slice(0, 16);
		return `\\\\.\\pipe\\toad-${hash}`;
	}
	return join(RUN_DIR, "bridge.sock");
}
