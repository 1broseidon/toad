/**
 * Electrobun's native menu bar and context menus are wired on macOS and
 * Windows. On Linux they are no-ops that log, so the window owns those
 * surfaces itself — shortcuts and HTML menus — and never asks.
 */
export function nativeMenus(): boolean {
	/* A web client's RPC lands on the desktop, so asking it for a native menu
	 * pops one on a Mac across the room. The phone draws its own. */
	if (webClient()) return false;
	return window.__electrobunPlatform !== "linux";
}

/**
 * Whether the window actually inlays traffic lights over the left of the
 * toolbar. That is a macOS hiddenInset thing. Linux and Windows leave that
 * corner empty, so padding as if the lights were there just shoves the mark
 * into the middle of nothing.
 */
export function insetLights(): boolean {
	return window.__electrobunPlatform === "macos";
}

/**
 * Linux and Windows draw their own title strip. `titleBarStyle: "hidden"`
 * gives the webview the whole surface but leaves neither platform caption
 * buttons; Windows keeps its native menus while Linux draws those in HTML too.
 */
export function customChrome(): boolean {
	/* The host injects "windows", not node's "win32" — and compared as literals
	 * rather than looked up in an array, so a wrong spelling is a type error
	 * here instead of a desk with no caption buttons there. */
	const host = window.__electrobunPlatform;
	return host === "linux" || host === "windows";
}

/**
 * A plain browser on web mode — a phone, in practice. No Electrobun host,
 * so no window chrome, no native menus, and the mobile layout regardless of
 * how wide the viewport happens to be.
 */
export function webClient(): boolean {
	if (typeof window.__electrobunPlatform === "undefined") return true;
	/* A fleet window is an Electrobun webview showing another desktop's served
	 * app. Whatever the host injects, that page is a web client of the desktop
	 * that served it — `?shell=native` in this position always means that. */
	return new URLSearchParams(window.location.search).get("shell") === "native";
}

/**
 * The app shell rather than a browser tab: an installed iOS or Android
 * build, wrapped by Capacitor.
 *
 * Still a web client — there is no Electrobun host, so the layout and the
 * transport are web mode's — but it was served by nobody, which is the
 * difference that matters: it holds its own list of desktops and is told
 * which one to speak to rather than assuming the one at this origin.
 *
 * `?shell=native` is the same thing in a desktop browser, so the screens
 * can be worked on without a device in the loop.
 */
export function nativeShell(): boolean {
	if (capacitorNative()) return true;
	return new URLSearchParams(window.location.search).get("shell") === "native";
}

/**
 * A real Capacitor app shell — not a `?shell=native` browser or fleet
 * window pretending to be one. Anything that reaches an actual device
 * plugin (push, in particular) needs this, not `nativeShell()`: a fleet
 * window opens another desktop's served app in a plain webview at
 * `?shell=native`, which is a web client with no plugins behind it.
 */
export function capacitorNative(): boolean {
	const capacitor = (window as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
	return capacitor?.isNativePlatform?.() ?? false;
}

/**
 * Classes the stylesheet can hang platform quirks on: `web` for web mode,
 * plus `ios` / `android` where the quirks actually differ (input zoom,
 * safe areas, rubber-banding). Applied once at boot.
 */
export function applyPlatformClasses(): void {
	if (!webClient()) return;
	const root = document.documentElement;
	root.classList.add("web");
	if (nativeShell()) root.classList.add("native");
	const ua = navigator.userAgent;
	if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) {
		root.classList.add("ios");
	} else if (/Android/.test(ua)) {
		root.classList.add("android");
	}
}

/**
 * A shortcut, written the way this platform's keyboard binds it.
 *
 * The accelerators are CmdOrCtrl — ⌘ under the macOS menu bar, Ctrl on
 * Windows' menu bar and on the Linux key listener — so a label that always
 * says ⌘ is wrong on two of the three platforms.
 */
const mac = /Mac|iP(hone|ad|od)/.test(navigator.platform);

export function shortcutLabel(key: string): string {
	if (webClient()) return "";
	return mac ? `⌘${key}` : `Ctrl+${key}`;
}

/** An accelerator stored as CmdOrCtrl+…, written for this platform. */
export function acceleratorLabel(accel: string): string {
	return shortcutLabel(accel.replace(/^CmdOrCtrl\+/, ""));
}
