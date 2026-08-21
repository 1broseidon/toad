/**
 * Electrobun's native menu bar and context menus are wired on macOS and
 * Windows. On Linux they are no-ops that log, so the window owns those
 * surfaces itself — shortcuts and HTML menus — and never asks.
 */
export function nativeMenus(): boolean {
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
 * Linux draws its own title strip: Electrobun's GTK menu bar is a no-op, and
 * `titleBarStyle: "hidden"` leaves no caption buttons either.
 */
export function linuxChrome(): boolean {
	return window.__electrobunPlatform === "linux";
}

/**
 * A plain browser on web mode — a phone, in practice. No Electrobun host,
 * so no window chrome, no native menus, and the mobile layout regardless of
 * how wide the viewport happens to be.
 */
export function webClient(): boolean {
	return typeof window.__electrobunPlatform === "undefined";
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
	return mac ? `⌘${key}` : `Ctrl+${key}`;
}

/** An accelerator stored as CmdOrCtrl+…, written for this platform. */
export function acceleratorLabel(accel: string): string {
	return shortcutLabel(accel.replace(/^CmdOrCtrl\+/, ""));
}
