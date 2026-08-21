import { homedir, platform } from "node:os";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Which colour the status icon has to be painted to survive the panel it sits in.
 *
 * macOS answers this itself: hand AppKit a template image and it tints the mark
 * to the menu bar, including the inactive and menu-open states. Nothing else
 * does. Electrobun's `template` flag reaches `app_indicator_set_icon_full` and
 * Windows' notification area as a value neither of them reads — both load the
 * PNG as authored. So on those two the mark is only ever the colour we shipped,
 * and shipping one colour means it disappears on half the desktops out there.
 *
 * Hence this: ask the desktop what its panel looks like, and pick the ink. The
 * question has no single cross-desktop answer, so each one is asked in its own
 * terms, and the guess is white when there is no answer — an unreadable icon is
 * the failure to avoid, and far more panels are dark than light.
 */
export type Ink = "white" | "black";

/** Escape hatch for a desktop we read wrong. */
const OVERRIDE = "TOAD_TRAY_INK";

export function panelInk(): Ink {
	const forced = process.env[OVERRIDE];
	if (forced === "white" || forced === "black") return forced;
	return platform() === "win32" ? windowsInk() : linuxInk();
}

/**
 * The taskbar follows the system theme, which is one registry value.
 *
 * Absent means dark: the tray was dark before Windows had the setting, and the
 * value only ever spells out light.
 */
function windowsInk(): Ink {
	const out = run([
		"reg",
		"query",
		"HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize",
		"/v",
		"SystemUsesLightTheme",
	]);
	const value = out?.match(/0x([0-9a-f]+)/i);
	return value && Number.parseInt(value[1], 16) === 1 ? "black" : "white";
}

/**
 * Read the thing that actually paints the panel, which is not always the GTK theme.
 *
 * Cinnamon styles its panel from its own shell theme and ships a dark one by
 * default, so a light GTK theme there still means a dark panel. GNOME's top bar
 * is dark in both of its colour schemes, so there is nothing to ask. XFCE and
 * MATE panels do follow the GTK theme. Plasma is the only one that will state a
 * colour outright, so it is asked for one.
 */
function linuxInk(): Ink {
	const desktop = (process.env.XDG_CURRENT_DESKTOP ?? "").toLowerCase();

	if (desktop.includes("cinnamon")) {
		// A Cinnamon theme is dark unless it says otherwise — "cinnamon", the
		// stock one, is dark, and so is Mint's default panel under a light GTK
		// theme.
		const theme = gsettings("org.cinnamon.theme", "name") ?? "";
		return /light/i.test(theme) && !/dark/i.test(theme) ? "black" : "white";
	}
	if (desktop.includes("kde") || desktop.includes("plasma")) return plasmaInk();
	if (desktop.includes("xfce")) return gtkInk(xfconf("xsettings", "/Net/ThemeName"));
	if (desktop.includes("mate")) return gtkInk(gsettings("org.mate.interface", "gtk-theme"));

	return "white";
}

/** A GTK theme names its own darkness, and light is the unmarked case. */
function gtkInk(theme: string | undefined): Ink {
	return theme && /dark/i.test(theme) ? "white" : "black";
}

/**
 * Plasma writes its palette to disk, so this is a colour rather than a name.
 *
 * The window background stands in for the panel: Plasma's panel takes its
 * colours from the same scheme, and a scheme with a dark window and a light
 * panel is not something the colour editor produces.
 */
function plasmaInk(): Ink {
	const rgb = kdeglobals()?.match(
		/^\s*\[Colors:Window\][^[]*?^\s*BackgroundNormal\s*=\s*(\d+),(\d+),(\d+)/ms,
	);
	if (!rgb) return "white";
	const [r, g, b] = rgb.slice(1, 4).map(Number);
	// Rec. 601 luma, which is what "is this light" means to an eye.
	return 0.299 * r + 0.587 * g + 0.114 * b > 128 ? "black" : "white";
}

function kdeglobals(): string | undefined {
	const config = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
	try {
		return readFileSync(join(config, "kdeglobals"), "utf8");
	} catch {
		return undefined;
	}
}

function gsettings(schema: string, key: string): string | undefined {
	return unquote(run(["gsettings", "get", schema, key]));
}

function xfconf(channel: string, property: string): string | undefined {
	return unquote(run(["xfconf-query", "-c", channel, "-p", property]));
}

function unquote(value: string | undefined): string | undefined {
	const trimmed = value?.trim().replace(/^'(.*)'$/, "$1");
	return trimmed ? trimmed : undefined;
}

/**
 * A one-shot read of some command's answer.
 *
 * Everything here is optional — the tool is missing, the schema is not
 * installed, the desktop is something else entirely — and every one of those
 * failures means the same thing: no answer, use the default.
 */
function run(command: string[]): string | undefined {
	try {
		const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "ignore" });
		if (result.exitCode !== 0) return undefined;
		return result.stdout.toString();
	} catch {
		return undefined;
	}
}
