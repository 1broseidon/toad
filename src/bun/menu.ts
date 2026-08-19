import { ApplicationMenu, ContextMenu, type ApplicationMenuItemConfig } from "electrobun/main";
import type { MenuAction, MenuActionName } from "../shared/rpc";
import { isUp } from "../shared/session";
import type { Persona, SessionState } from "../shared/types";

/**
 * The native menu bar and the right-click menus.
 *
 * Neither one acts on its own: every item resolves to a `MenuAction` that the
 * webview handles, so a keyboard shortcut, a menu item, and the equivalent
 * button in the UI all run the same code.
 */

/*
 * Electrobun can attach a structured `data` payload to a menu item, but it
 * clears that payload from its registry the first time the item is read. That
 * is fine for a context menu, which is rebuilt on every open, and wrong for the
 * application menu, which is built once and clicked for the life of the
 * process. So the target rides in the action string instead.
 *
 * The separator has to survive the trip through native code, which rules out
 * NUL: it terminates a C string, so the id was being silently cut off and every
 * ⌘1–⌘9 landed on whoever was already selected. A colon appears in neither an
 * action name nor a UUID.
 */
const SEPARATOR = ":";

const encode = (action: MenuActionName, personaId?: string) =>
	personaId ? `${action}${SEPARATOR}${personaId}` : action;

export function decodeMenuAction(encoded: string): MenuAction | null {
	if (!encoded) return null;
	// Split once, so an id that ever contains the separator arrives whole.
	const at = encoded.indexOf(SEPARATOR);
	const action = (at === -1 ? encoded : encoded.slice(0, at)) as MenuActionName;
	if (!action) return null;
	const personaId = at === -1 ? "" : encoded.slice(at + 1);
	return personaId ? { action, personaId } : { action };
}

const DIVIDER = { type: "divider" } as const;

export type MenuContext = {
	personas: Persona[];
	activeId: string | null;
	activeState: SessionState;
};

/** ⌘1–⌘9 selects a teammate, the way ⌘1–⌘9 selects a tab everywhere else. */
function rosterItems({ personas, activeId }: MenuContext): ApplicationMenuItemConfig[] {
	if (personas.length === 0) return [];
	return [
		DIVIDER,
		...personas.slice(0, 9).map((persona, index) => ({
			label: persona.name,
			action: encode("selectTeammate", persona.id),
			accelerator: `CmdOrCtrl+${index + 1}`,
			checked: persona.id === activeId,
		})),
	];
}

export function applicationMenu(context: MenuContext): ApplicationMenuItemConfig[] {
	const hasActive = context.activeId !== null;
	const running = context.activeState === "ready" || context.activeState === "thinking";

	return [
		{
			label: "Toad",
			submenu: [
				{ role: "about", label: "About Toad" },
				DIVIDER,
				// ⌘, is the app's own settings by convention everywhere on macOS. A
				// teammate's settings are that teammate's, so they sit in its menu.
				{ label: "Settings…", action: encode("appSettings"), accelerator: "CmdOrCtrl+," },
				DIVIDER,
				{ role: "hide", label: "Hide Toad" },
				{ role: "hideOthers" },
				{ role: "showAll" },
				DIVIDER,
				{ role: "quit", label: "Quit Toad" },
			],
		},
		{
			label: "File",
			submenu: [
				{ label: "New Teammate…", action: encode("newTeammate"), accelerator: "CmdOrCtrl+N" },
				DIVIDER,
				{
					label: "Reveal Workspace in Finder",
					action: encode("revealWorkspace"),
					accelerator: "CmdOrCtrl+Shift+O",
					enabled: hasActive,
				},
				DIVIDER,
				{ role: "close" },
			],
		},
		{
			label: "Edit",
			submenu: [
				{ role: "undo" },
				{ role: "redo" },
				DIVIDER,
				{ role: "cut" },
				{ role: "copy" },
				{ role: "paste" },
				{ role: "selectAll" },
			],
		},
		{
			label: "Agent",
			submenu: [
				{
					label: "Start Session",
					action: encode("startSession"),
					accelerator: "CmdOrCtrl+R",
					enabled: hasActive && !running,
				},
				{
					label: "Stop Session",
					action: encode("stopSession"),
					accelerator: "CmdOrCtrl+Shift+R",
					enabled: running,
				},
				DIVIDER,
				{
					label: "Cancel Turn",
					action: encode("cancelTurn"),
					accelerator: "CmdOrCtrl+.",
					enabled: context.activeState === "thinking",
				},
				DIVIDER,
				{
					label: "Teammate Settings…",
					action: encode("settings"),
					accelerator: "CmdOrCtrl+I",
					enabled: hasActive,
				},
				...rosterItems(context),
			],
		},
		{
			label: "Window",
			submenu: [
				{ role: "minimize" },
				{ role: "zoom" },
				DIVIDER,
				{ role: "toggleFullScreen" },
				DIVIDER,
				{ role: "bringAllToFront" },
			],
		},
	];
}

export function setApplicationMenu(context: MenuContext) {
	ApplicationMenu.setApplicationMenu(applicationMenu(context));
}

export function showPersonaMenu(persona: Persona, state: SessionState) {
	const running = isUp(state);
	ContextMenu.showContextMenu([
		running
			? { label: "Stop Session", action: encode("stopSession", persona.id) }
			: { label: "Start Session", action: encode("startSession", persona.id) },
		DIVIDER,
		{ label: "Reveal Workspace in Finder", action: encode("revealWorkspace", persona.id) },
		{ label: "Rename…", action: encode("renameTeammate", persona.id) },
		DIVIDER,
		{ label: "Delete Teammate", action: encode("deleteTeammate", persona.id) },
	]);
}

export function showMessageMenu() {
	ContextMenu.showContextMenu([{ label: "Copy Message", action: encode("copyMessage") }]);
}
