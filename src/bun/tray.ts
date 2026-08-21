import { Tray, Utils, type MenuItemConfig } from "electrobun/main";
import { platform } from "node:os";
import { isBusy } from "../shared/session";
import { panelInk } from "./panel-ink";
import type { Persona, SessionState } from "../shared/types";

/**
 * The menu bar item.
 *
 * Closing the window puts Toad here rather than ending it, because the window
 * is a view onto the teammates and the teammates are the app: an agent halfway
 * through a task should not be killed because you wanted the screen back. So
 * this has to answer the one question that follows — is anything still running
 * in there — without making you open the window to find out.
 *
 * It answers only that. Which teammates are working, and nothing about what
 * they are working on: a tool title in a menu is a detail you cannot act on
 * from a menu, and the conversation is one click away for when you can.
 */

export type TrayHost = {
	personas(): Persona[];
	state(personaId: string): SessionState;
	/** Show the window, on a teammate when the menu named one. */
	open(personaId?: string): void;
};

const DIVIDER = { type: "divider" } as const;
const SEPARATOR = ":";

const ART = "views://mainview/tray";
const MAC = platform() === "darwin";

/**
 * The mark, in whichever ink this system's panel leaves readable.
 *
 * macOS is given a template image and tints it itself — black in a light menu
 * bar, white in a dark one, dimmed when the bar is inactive. Supplying a colour
 * there would fight all three. Linux and Windows tint nothing, so the ink is
 * chosen from the desktop's own theme and the art is drawn in it.
 */
function trayImage(): string {
	if (MAC) return `${ART}/trayTemplate.png`;
	return panelInk() === "white" ? `${ART}/trayWhite.png` : `${ART}/trayBlack.png`;
}

export function createTray(host: TrayHost) {
	let art = trayImage();
	const tray = new Tray({
		image: art,
		template: true,
	});

	/* Sampled rather than watched: light and dark is a per-desktop setting with
	 * no common change signal — GNOME, Cinnamon, XFCE, Plasma and Windows each
	 * keep it somewhere else — and asking costs one short-lived process. Someone
	 * switching themes can wait a few seconds for the mark to follow. */
	if (!MAC) {
		setInterval(() => {
			const next = trayImage();
			if (next === art) return;
			art = next;
			tray.setImage(next);
		}, 15_000).unref();
	}

	tray.on("tray-clicked", (event) => {
		const { action } = (event as { data?: { action?: string } }).data ?? {};
		if (!action) return;
		if (action === "quit") {
			// The exit hook stops every session; quitting is what runs it.
			Utils.quit();
			return;
		}
		if (action === "open") {
			host.open();
			return;
		}
		const at = action.indexOf(SEPARATOR);
		if (at !== -1) host.open(action.slice(at + 1));
	});

	/* Rebuilt rather than patched — macOS gives no way to edit a menu in place.
	 * The signature check keeps that cheap: session state changes many times a
	 * turn and almost none of those change a word of this. */
	let drawn = "";
	const refresh = () => {
		const menu = trayMenu(host);
		const signature = JSON.stringify(menu);
		if (signature === drawn) return;
		drawn = signature;
		tray.setMenu(menu);
	};

	refresh();
	return { refresh };
}

/**
 * One line per working teammate, then the two things you came for.
 *
 * When nothing is working there is no list and no line saying so. A row reading
 * "nothing running" is the same non-answer as an empty menu, only louder.
 */
export function trayMenu(host: TrayHost): MenuItemConfig[] {
	const working = host.personas().filter((persona) => isBusy(host.state(persona.id)));

	const rows: MenuItemConfig[] = working.map((persona) => ({
		type: "normal",
		label: persona.name,
		action: `open${SEPARATOR}${persona.id}`,
	}));

	return [
		...(rows.length > 0
			? [{ type: "normal", label: "Working", enabled: false } as const, ...rows, DIVIDER]
			: []),
		{ type: "normal", label: "Open Toad", action: "open" },
		DIVIDER,
		{ type: "normal", label: "Quit Toad", action: "quit" },
	];
}
