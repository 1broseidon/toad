import type { AppSettings } from "../../shared/types";
import { DEFAULT_BACKEND_ID } from "../acp/registry";
import { migrateStaticHeaders, removeServerCredentials } from "../mcp/credentials";
import { legacyMcpHeaders, normalizeServers } from "../mcp/servers";
import { SETTINGS_FILE, ensureLayout } from "../paths";
import { loadJson, saveJson } from "./durable";

/**
 * App-wide preferences, and the little Toad remembers about how it was left.
 *
 * Kept apart from `config.json`, which is the roster: teammates are documents
 * and these are the app's own state. One file per owner also means the two
 * cannot clobber each other, since both are written on their own schedule —
 * this one from a timer that watches the window.
 */
export type WindowFrame = { x: number; y: number; width: number; height: number };

type Stored = {
	version: 1;
	settings: AppSettings;
	/** Restored on next launch, if the display it was on is still there. */
	window?: WindowFrame;
	/** Reopened on next launch, so the app comes back where you left it. */
	lastPersonaId?: string;
};

const DEFAULTS: AppSettings = { defaultBackendId: DEFAULT_BACKEND_ID, mcpServers: [] };

function bareId(id: string): string {
	const slash = id.lastIndexOf("/");
	return slash === -1 ? id : id.slice(slash + 1);
}

function bareLastPersonaId(id: string | undefined): string | undefined {
	if (id === undefined) return undefined;
	const bare = bareId(id);
	return bare.length > 0 ? bare : undefined;
}

function empty(): Stored {
	return { version: 1, settings: { ...DEFAULTS } };
}

function read(): Stored {
	ensureLayout();
	const parsed = loadJson<Partial<Stored>>(SETTINGS_FILE).value;
	if (parsed === null) return empty();
	try {
		const raw = { ...DEFAULTS, ...parsed.settings };
		const legacy = legacyMcpHeaders(raw.mcpServers);
		for (const entry of legacy) migrateStaticHeaders(entry.serverId, entry.headers);
		const next: Stored = {
			version: 1,
			// Merged over the defaults rather than trusted, so a file written by an
			// older build is missing keys rather than broken — and a hand-edited
			// server list costs the bad entry rather than the whole file.
			settings: { ...raw, mcpServers: normalizeServers(raw.mcpServers) },
			window: validFrame(parsed.window) ? parsed.window : undefined,
			lastPersonaId:
				typeof parsed.lastPersonaId === "string" && parsed.lastPersonaId.length > 0
					? bareLastPersonaId(parsed.lastPersonaId)
					: undefined,
		};
		// Scrub the old secret-bearing form, including its ordinary `.bak`, as
		// soon as the owner-only credential write has succeeded.
		if (legacy.length > 0) saveJson(SETTINGS_FILE, next);
		return next;
	} catch (error) {
		// A damaged credential boundary must be loud, not converted into empty
		// settings that a later mutation could save over the user's configuration.
		if (error instanceof Error && error.message.includes("MCP credential")) throw error;
		return empty();
	}
}

function write(next: Stored): void {
	ensureLayout();
	saveJson(SETTINGS_FILE, next);
}

function validFrame(frame: unknown): frame is WindowFrame {
	if (frame === null || typeof frame !== "object") return false;
	const candidate = frame as Partial<WindowFrame>;
	return (
		["x", "y", "width", "height"] as const
	).every((key) => typeof candidate[key] === "number" && Number.isFinite(candidate[key]));
}

export function getSettings(): AppSettings {
	return read().settings;
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
	const stored = read();
	const raw = { ...stored.settings, ...patch };
	// Treat RPC input as untrusted even though the public type has no headers:
	// older clients can still send the legacy shape. Migrate, then persist only
	// the non-secret descriptor.
	for (const entry of legacyMcpHeaders(raw.mcpServers)) {
		migrateStaticHeaders(entry.serverId, entry.headers);
	}
	const settings = { ...raw, mcpServers: normalizeServers(raw.mcpServers) };
	const previous = new Map(stored.settings.mcpServers.map((server) => [server.id, server]));
	for (const server of settings.mcpServers) {
		const before = previous.get(server.id);
		previous.delete(server.id);
		if (
			before?.type === "http" &&
			(server.type !== "http" || before.url !== server.url || before.auth.mode !== server.auth.mode)
		) {
			removeServerCredentials(server.id);
		}
	}
	for (const removed of previous.keys()) removeServerCredentials(removed);
	write({ ...stored, settings });
	return settings;
}

export function getWindowFrame(): WindowFrame | undefined {
	return read().window;
}

export function setWindowFrame(window: WindowFrame): void {
	write({ ...read(), window });
}

export function getLastPersonaId(): string | undefined {
	return read().lastPersonaId;
}

export function setLastPersonaId(lastPersonaId: string | undefined): void {
	write({ ...read(), lastPersonaId: bareLastPersonaId(lastPersonaId) });
}
