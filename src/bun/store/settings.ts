import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { AppSettings } from "../../shared/types";
import { DEFAULT_BACKEND_ID } from "../acp/registry";
import { SETTINGS_FILE, ensureLayout } from "../paths";

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

const DEFAULTS: AppSettings = { defaultBackendId: DEFAULT_BACKEND_ID };

function empty(): Stored {
	return { version: 1, settings: { ...DEFAULTS } };
}

function read(): Stored {
	ensureLayout();
	if (!existsSync(SETTINGS_FILE)) return empty();
	try {
		const parsed = JSON.parse(readFileSync(SETTINGS_FILE, "utf8")) as Partial<Stored>;
		return {
			version: 1,
			// Merged over the defaults rather than trusted, so a file written by an
			// older build is missing keys rather than broken.
			settings: { ...DEFAULTS, ...parsed.settings },
			window: validFrame(parsed.window) ? parsed.window : undefined,
			lastPersonaId:
				typeof parsed.lastPersonaId === "string" && parsed.lastPersonaId.length > 0
					? parsed.lastPersonaId
					: undefined,
		};
	} catch {
		return empty();
	}
}

function write(next: Stored): void {
	ensureLayout();
	writeFileSync(SETTINGS_FILE, `${JSON.stringify(next, null, 2)}\n`, "utf8");
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
	const settings = { ...stored.settings, ...patch };
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
	write({ ...read(), lastPersonaId });
}
