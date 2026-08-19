import { homedir, platform } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";

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
export const TRANSCRIPTS_DIR = join(ROOT, "transcripts");
export const WORKSPACES_DIR = join(ROOT, "workspaces");
export const CACHE_DIR = join(ROOT, "cache");
export const ATTACHMENTS_DIR = join(ROOT, "attachments");
export const THREADS_DIR = join(ROOT, "threads");
export const RUN_DIR = join(ROOT, "run");
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

export function ensureLayout(): void {
	for (const dir of [
		ROOT,
		TRANSCRIPTS_DIR,
		WORKSPACES_DIR,
		CACHE_DIR,
		ATTACHMENTS_DIR,
		THREADS_DIR,
		RUN_DIR,
		PI_DIR,
	]) {
		mkdirSync(dir, { recursive: true });
	}
	if (platform() !== "win32") chmodSync(RUN_DIR, 0o700);
}

export function transcriptPath(personaId: string): string {
	return join(TRANSCRIPTS_DIR, `${personaId}.jsonl`);
}

/**
 * Where a teammate's pasted attachments live.
 *
 * Kept beside the transcript rather than in the workspace: a screenshot pasted
 * into a conversation is part of the conversation, and dropping it into the
 * agent's working directory would put it in front of `git status`.
 */
export function attachmentsDir(personaId: string): string {
	const dir = join(ATTACHMENTS_DIR, personaId);
	mkdirSync(dir, { recursive: true });
	return dir;
}

export function defaultWorkspace(personaId: string): string {
	return join(WORKSPACES_DIR, personaId);
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
	return join(THREADS_DIR, `${key}.jsonl`);
}

export function threadMetaPath(key: string): string {
	const [a, b, ...rest] = key.split("~");
	if (!a || !b || rest.length > 0 || threadKey(a, b) !== key) throw new Error("Invalid thread key");
	return join(THREADS_DIR, `${key}.json`);
}

export function bridgeSocketPath(): string {
	if (platform() === "win32") {
		const hash = createHash("sha256").update(ROOT).digest("hex").slice(0, 16);
		return `\\\\.\\pipe\\toad-${hash}`;
	}
	return join(RUN_DIR, "bridge.sock");
}
