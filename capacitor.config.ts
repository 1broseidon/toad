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
	appId: "sh.toad.ios",
	appName: "Toad",
	webDir: "dist",
	...(live ? { server: { url: live, cleartext: true } } : {}),
};

export default config;
