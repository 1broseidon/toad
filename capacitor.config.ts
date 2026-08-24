import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Native host for the same mainview the desktop and PWA already ship.
 *
 * `webDir` is the Vite outDir. Live reload on a phone is opt-in:
 * `TOAD_CAP_LIVE=http://<lan-ip>:5173 bun x cap sync ios` points the
 * webview at Vite instead of the bundled files. Production syncs omit it.
 */
const live = process.env.TOAD_CAP_LIVE;

const config: CapacitorConfig = {
	appId: "team.toad.ios",
	appName: "Toad",
	webDir: "dist",
	/* --color-paper. What the webview and the window behind it are painted
	 * while the bundle is still parsing, and what a rubber-banded scroll
	 * reveals — either one flashing white is the whole illusion gone. */
	backgroundColor: "#040405",
	ios: {
		/* Every scrolling surface in the app is a div. Left on, the webview's own
		 * scroll view is a second one wrapped around all of them, and focusing
		 * the composer makes WebKit scroll *it* to reveal the caret — which
		 * slides the whole app up and puts the nav bar under the status bar. */
		scrollEnabled: false,
	},
	plugins: {
		Keyboard: {
			/* Shrink the webview rather than sliding the page: `100dvh` then
			 * tracks the space left above the keyboard, so the composer rides up
			 * on it and the conversation reflows behind it the way a native
			 * app's does. `body` alone would leave fixed chrome behind. */
			resize: "native",
		},
	},
	...(live ? { server: { url: live, cleartext: true } } : {}),
};

export default config;
