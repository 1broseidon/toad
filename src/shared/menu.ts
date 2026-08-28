import type { MenuAction, MenuActionName } from "./rpc";
import { flattenTeamRoster } from "./roster";
import { isUp } from "./session";
import type { Persona, SessionState } from "./types";

/**
 * The application menu, as a tree the native bar and the Linux HTML chrome
 * both read. Native Electrobun menus stay in bun/menu.ts; this file has no
 * Electrobun import so the webview can build the same tree.
 */

export type MenuContext = {
	personas: Persona[];
	activeId: string | null;
	activeState: SessionState;
};

export type EditRole = "undo" | "redo" | "cut" | "copy" | "paste" | "selectAll";

export type MenuRole =
	| EditRole
	| "about"
	| "hide"
	| "hideOthers"
	| "showAll"
	| "quit"
	| "close"
	| "minimize"
	| "zoom"
	| "toggleFullScreen"
	| "bringAllToFront";

export type MenuNode =
	| { type: "divider" }
	| {
			label: string;
			action?: MenuActionName;
			personaId?: string;
			role?: MenuRole;
			accelerator?: string;
			enabled?: boolean;
			checked?: boolean;
			submenu?: MenuNode[];
	  };

const DIVIDER: MenuNode = { type: "divider" };

export const EDIT_ROLES: readonly EditRole[] = [
	"undo",
	"redo",
	"cut",
	"copy",
	"paste",
	"selectAll",
];

export function isEditRole(role: string): role is EditRole {
	return (EDIT_ROLES as readonly string[]).includes(role);
}

export function isDivider(node: MenuNode): node is { type: "divider" } {
	return "type" in node && node.type === "divider";
}

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

export function encodeMenuAction(action: MenuActionName, personaId?: string): string {
	return personaId ? `${action}${SEPARATOR}${personaId}` : action;
}

export function decodeMenuAction(encoded: string): MenuAction | null {
	if (!encoded) return null;
	const at = encoded.indexOf(SEPARATOR);
	const action = (at === -1 ? encoded : encoded.slice(0, at)) as MenuActionName;
	if (!action) return null;
	const personaId = at === -1 ? "" : encoded.slice(at + 1);
	return personaId ? { action, personaId } : { action };
}

export const windowTitle = (personaName?: string | null) =>
	personaName ? `${personaName} — Toad` : "Toad";

/** ⌘1–⌘9 selects a teammate, the way ⌘1–⌘9 selects a tab everywhere else. */
function rosterItems({ personas, activeId }: MenuContext): MenuNode[] {
	if (personas.length === 0) return [];
	return [
		DIVIDER,
		...flattenTeamRoster(personas)
			.slice(0, 9)
			.map((persona, index) => ({
			label: persona.name,
			action: "selectTeammate" as const,
			personaId: persona.id,
			accelerator: `CmdOrCtrl+${index + 1}`,
				checked: persona.id === activeId,
			})),
	];
}

function agentItems(context: MenuContext): MenuNode[] {
	const hasActive = context.activeId !== null;
	const running = isUp(context.activeState);
	return [
		{
			label: "Start Session",
			action: "startSession",
			accelerator: "CmdOrCtrl+R",
			enabled: hasActive && !running,
		},
		{
			label: "Stop Session",
			action: "stopSession",
			accelerator: "CmdOrCtrl+Shift+R",
			enabled: running,
		},
		DIVIDER,
		{
			label: "Cancel Turn",
			action: "cancelTurn",
			accelerator: "CmdOrCtrl+.",
			enabled: context.activeState === "thinking",
		},
		DIVIDER,
		{
			label: "Teammate Settings…",
			action: "settings",
			accelerator: "CmdOrCtrl+I",
			enabled: hasActive,
		},
		...rosterItems(context),
	];
}

const EDIT_ITEMS: MenuNode[] = [
	{ label: "Undo", role: "undo", accelerator: "CmdOrCtrl+Z" },
	{ label: "Redo", role: "redo", accelerator: "CmdOrCtrl+Shift+Z" },
	DIVIDER,
	{ label: "Cut", role: "cut", accelerator: "CmdOrCtrl+X" },
	{ label: "Copy", role: "copy", accelerator: "CmdOrCtrl+C" },
	{ label: "Paste", role: "paste", accelerator: "CmdOrCtrl+V" },
	{ label: "Select All", role: "selectAll", accelerator: "CmdOrCtrl+A" },
];

/**
 * The native menu bar, which is macOS's alone: hide/zoom/Finder wording, and
 * roles Electrobun maps to NSResponder. Windows and Linux take the HTML menu
 * below — neither has a bar this window could hang one on.
 */
export function applicationMenu(context: MenuContext): MenuNode[] {
	const hasActive = context.activeId !== null;
	return [
		{
			label: "Toad",
			submenu: [
				{ label: "About Toad", role: "about" },
				DIVIDER,
				// ⌘, is the app's own settings by convention everywhere on macOS. A
				// teammate's settings are that teammate's, so they sit in its menu.
				{ label: "Settings…", action: "appSettings", accelerator: "CmdOrCtrl+," },
				DIVIDER,
				{ label: "Hide Toad", role: "hide" },
				{ label: "Hide Others", role: "hideOthers" },
				{ label: "Show All", role: "showAll" },
				DIVIDER,
				{ label: "Quit Toad", role: "quit" },
			],
		},
		{
			label: "File",
			submenu: [
				{ label: "New Teammate…", action: "newTeammate", accelerator: "CmdOrCtrl+N" },
				DIVIDER,
				{
					label: "Reveal Workspace in Finder",
					action: "revealWorkspace",
					accelerator: "CmdOrCtrl+Shift+O",
					enabled: hasActive,
				},
				DIVIDER,
				{ label: "Close", role: "close" },
			],
		},
		{ label: "Edit", submenu: EDIT_ITEMS },
		{ label: "Agent", submenu: agentItems(context) },
		{
			label: "Window",
			submenu: [
				{ label: "Minimize", role: "minimize" },
				{ label: "Zoom", role: "zoom" },
				DIVIDER,
				{ label: "Toggle Full Screen", role: "toggleFullScreen" },
				DIVIDER,
				{ label: "Bring All To Front", role: "bringAllToFront" },
			],
		},
	];
}

/**
 * The chrome strip's menu, on Linux and Windows: no hide/show-all, no Finder,
 * window roles mapped to the same MenuActions the caption buttons use. Edit
 * roles stay roles so the webview can run them against the focused field.
 */
export function htmlApplicationMenu(context: MenuContext): MenuNode[] {
	const hasActive = context.activeId !== null;
	return [
		{
			label: "Toad",
			submenu: [
				{ label: "About Toad", action: "about" },
				DIVIDER,
				{ label: "Settings…", action: "appSettings", accelerator: "CmdOrCtrl+," },
				DIVIDER,
				{ label: "Quit Toad", action: "quit" },
			],
		},
		{
			label: "File",
			submenu: [
				{ label: "New Teammate…", action: "newTeammate", accelerator: "CmdOrCtrl+N" },
				DIVIDER,
				{
					label: "Reveal Workspace",
					action: "revealWorkspace",
					accelerator: "CmdOrCtrl+Shift+O",
					enabled: hasActive,
				},
				DIVIDER,
				{ label: "Close", action: "closeWindow" },
			],
		},
		{ label: "Edit", submenu: EDIT_ITEMS },
		{ label: "Agent", submenu: agentItems(context) },
		{
			label: "Window",
			submenu: [
				{ label: "Minimize", action: "minimize" },
				{ label: "Maximize", action: "maximize" },
				DIVIDER,
				{ label: "Full Screen", action: "toggleFullScreen" },
			],
		},
	];
}
