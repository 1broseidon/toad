import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";

/**
 * The native floating chrome: the glass action bar at the foot of the Team
 * screen and the computer pill at its head.
 *
 * Drawn by SwiftUI over the webview (FloatingChromePlugin.swift) so the
 * material is the system's own — the roster genuinely lenses through it.
 * The web layer only says what should be showing and hears which control
 * was tapped. Where the plugin is absent (desktop, plain browsers, Android
 * until it grows one) every call is a no-op and the DOM keeps its own
 * chrome.
 */

type ChromeState = {
	computer?: string;
	linked?: boolean;
	working?: boolean;
	bar?: boolean;
	pill?: boolean;
};

export type ChromeAction = "computer" | "add" | "settings" | "pill";

const available =
	typeof document !== "undefined" && Capacitor.isPluginAvailable("FloatingChrome");

/* The stylesheet retires the DOM footer and clears the roster's foot the
 * moment the native layer exists — a class, so the CSS can say it. */
if (available) document.documentElement.classList.add("glass-chrome");

const plugin = available
	? registerPlugin<{
			set(state: ChromeState): Promise<void>;
			addListener(
				event: "action",
				cb: (data: { id: ChromeAction }) => void,
			): Promise<PluginListenerHandle>;
		}>("FloatingChrome")
	: null;

export function chromeAvailable(): boolean {
	return available;
}

export function setChrome(state: ChromeState): void {
	void plugin?.set(state).catch(() => {});
}

export function onChromeAction(cb: (id: ChromeAction) => void): () => void {
	if (!plugin) return () => {};
	const handle = plugin.addListener("action", ({ id }) => cb(id));
	return () => {
		void handle.then((h) => h.remove());
	};
}
