import { Tray, Utils, type MenuItemConfig } from "electrobun/main";
import { isBusy } from "../shared/session";
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

export function createTray(host: TrayHost) {
	const tray = new Tray({
		image: "views://mainview/tray/trayTemplate.png",
		template: true,
	});

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
