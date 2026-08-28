import { ApplicationMenu, ContextMenu, type ApplicationMenuItemConfig } from "electrobun/main";
import { platform } from "node:os";
import {
	applicationMenu,
	decodeMenuAction,
	encodeMenuAction,
	isDivider,
	type MenuContext,
	type MenuNode,
} from "../shared/menu";
import { isUp } from "../shared/session";
import type { Persona, SessionState } from "../shared/types";

export { decodeMenuAction, type MenuContext };

/**
 * The native menu bar and the right-click menus.
 *
 * Neither one acts on its own: every item resolves to a `MenuAction` that the
 * webview handles, so a keyboard shortcut, a menu item, and the equivalent
 * button in the UI all run the same code.
 *
 * The two are asked separately, because the platforms answer differently.
 * Right-click menus are pop-ups and work wherever Electrobun wires them:
 * macOS and Windows, but not Linux, where the GTK wrapper is a no-op that
 * logs every time `refreshMenu` asks — once a session tick.
 *
 * A menu BAR is macOS only. Linux never had one either, and Windows hangs its
 * bar off the window frame, which a desk with `titleBarStyle: "hidden"` does
 * not have; what it managed to draw there was worse than nothing. Both of
 * those draw the same menu in the chrome strip and bind their own
 * accelerators, so neither asks for a bar it would not get.
 */
const NATIVE_CONTEXT_MENUS = platform() !== "linux";
const NATIVE_MENU_BAR = platform() === "darwin";

/* The word for the program that opens a folder, on the only two desks that
 * see these menus. Windows has no Finder, and a menu item naming a program
 * that desk has never had reads as a bug in the app. */
const FILE_MANAGER = platform() === "win32" ? "File Explorer" : "Finder";

const DIVIDER = { type: "divider" } as const;

function toNative(nodes: MenuNode[]): ApplicationMenuItemConfig[] {
	return nodes.map((node) => {
		if (isDivider(node)) return DIVIDER;
		if (node.submenu) {
			return { label: node.label, submenu: toNative(node.submenu) };
		}
		if (node.role) {
			return {
				role: node.role,
				label: node.label,
				accelerator: node.accelerator,
				enabled: node.enabled,
			};
		}
		return {
			label: node.label,
			action: node.action ? encodeMenuAction(node.action, node.personaId) : undefined,
			accelerator: node.accelerator,
			enabled: node.enabled,
			checked: node.checked,
		};
	});
}

export function setApplicationMenu(context: MenuContext) {
	if (!NATIVE_MENU_BAR) return;
	ApplicationMenu.setApplicationMenu(toNative(applicationMenu(context)));
}

export function showPersonaMenu(persona: Persona, state: SessionState) {
	if (!NATIVE_CONTEXT_MENUS) return;
	const running = isUp(state);
	ContextMenu.showContextMenu([
		running
			? { label: "Stop Session", action: encodeMenuAction("stopSession", persona.id) }
			: { label: "Start Session", action: encodeMenuAction("startSession", persona.id) },
		DIVIDER,
		/* A teammate on another desktop has no folder in THIS machine's Finder. */
		...(persona.node
			? []
			: [
					{
						label: `Reveal Workspace in ${FILE_MANAGER}`,
						action: encodeMenuAction("revealWorkspace", persona.id),
					},
				]),
		{ label: "Rename…", action: encodeMenuAction("renameTeammate", persona.id) },
		DIVIDER,
		{ label: "Delete Teammate", action: encodeMenuAction("deleteTeammate", persona.id) },
	]);
}

export function showMessageMenu() {
	if (!NATIVE_CONTEXT_MENUS) return;
	ContextMenu.showContextMenu([{ label: "Copy Message", action: encodeMenuAction("copyMessage") }]);
}
