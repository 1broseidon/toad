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
 * Linux is the exception. Electrobun's GTK wrappers for both of these are
 * no-ops that log every time they are asked, and `refreshMenu` asks on every
 * session tick. The same actions live in the window — shortcuts and HTML
 * menus — so Linux simply does not ask.
 */
const NATIVE_MENUS = platform() !== "linux";

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
	if (!NATIVE_MENUS) return;
	ApplicationMenu.setApplicationMenu(toNative(applicationMenu(context)));
}

export function showPersonaMenu(persona: Persona, state: SessionState) {
	if (!NATIVE_MENUS) return;
	const running = isUp(state);
	ContextMenu.showContextMenu([
		running
			? { label: "Stop Session", action: encodeMenuAction("stopSession", persona.id) }
			: { label: "Start Session", action: encodeMenuAction("startSession", persona.id) },
		DIVIDER,
		{ label: "Reveal Workspace in Finder", action: encodeMenuAction("revealWorkspace", persona.id) },
		{ label: "Rename…", action: encodeMenuAction("renameTeammate", persona.id) },
		DIVIDER,
		{ label: "Delete Teammate", action: encodeMenuAction("deleteTeammate", persona.id) },
	]);
}

export function showMessageMenu() {
	if (!NATIVE_MENUS) return;
	ContextMenu.showContextMenu([{ label: "Copy Message", action: encodeMenuAction("copyMessage") }]);
}
