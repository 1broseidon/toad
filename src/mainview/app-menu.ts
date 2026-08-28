import type { MenuAction } from "../shared/rpc";
import {
	htmlApplicationMenu,
	isDivider,
	isEditRole,
	type MenuContext,
	type MenuNode,
} from "../shared/menu";
import { acceleratorLabel, canFullScreen } from "./platform";
import type { PopupItem } from "./components/PopupMenu";

function runEdit(role: string): void {
	document.execCommand(role);
}

function toPopup(nodes: MenuNode[], run: (action: MenuAction) => void): PopupItem[] {
	return nodes.map((node) => {
		if (isDivider(node)) return { type: "divider" };
		if (node.submenu) {
			return {
				label: node.label,
				enabled: node.enabled,
				items: toPopup(node.submenu, run),
			};
		}
		const accelerator = node.accelerator ? acceleratorLabel(node.accelerator) : undefined;
		if (node.role && isEditRole(node.role)) {
			const role = node.role;
			return {
				label: node.label,
				accelerator,
				enabled: node.enabled,
				onClick: () => runEdit(role),
			};
		}
		if (node.action) {
			const action = node.action;
			const personaId = node.personaId;
			return {
				label: node.label,
				accelerator,
				enabled: node.enabled,
				checked: node.checked,
				onClick: () => run(personaId ? { action, personaId } : { action }),
			};
		}
		return { label: node.label, onClick: () => undefined };
	});
}

/** The Linux hamburger's tree, as the page's own menu. */
export function htmlMenuItems(context: MenuContext, run: (action: MenuAction) => void): PopupItem[] {
	/* Windows has no full screen to offer — Electrobun's win32 layer cannot put
	 * a frameless window into one. See htmlApplicationMenu. */
	return toPopup(htmlApplicationMenu(context, canFullScreen()), run);
}
