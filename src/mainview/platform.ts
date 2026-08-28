/**
 * The desk this window is standing on, by the only name we accept.
 *
 * `window.__electrobunPlatform` is injected as source text by the host
 * process, which makes it the one input to this file we do not own: it can
 * arrive padded, cased differently, or carrying a stray control byte, and a
 * literal comparison against any of those quietly answers "no" to every
 * question. So it is scrubbed to letters and then checked against the three
 * names that exist — anything else is not a platform we can draw for, and
 * says so by being null rather than by impersonating macOS.
 *
 * Every gate below asks this rather than the global, and each one names the
 * desks it is true for. An allowlist and a denylist read the same until an
 * unknown value turns up, and then only one of them is still right.
 */
const HOSTS = ["linux", "macos", "windows"] as const;
type Host = (typeof HOSTS)[number];

function host(): Host | null {
	const name = (window.__electrobunPlatform ?? "").replace(/[^a-z]/gi, "").toLowerCase();
	return (HOSTS as readonly string[]).includes(name) ? (name as Host) : null;
}

/**
 * Whether right-click menus are the system's. Electrobun's context menus are
 * wired on macOS and Windows; on Linux they are no-ops that log, so the window
 * pops its own and never asks.
 */
export function nativeContextMenus(): boolean {
	/* A web client's RPC lands on the desktop, so asking it for a native menu
	 * pops one on a Mac across the room. The phone draws its own. */
	if (webClient()) return false;
	const desk = host();
	return desk === "macos" || desk === "windows";
}

/**
 * Whether a bar of menu titles exists outside the webview — and so whether the
 * accelerators under it are bound for us.
 *
 * Only macOS, where the bar belongs to the screen rather than the window.
 * Linux never had one: Electrobun's GTK wrapper is a no-op. Windows hangs its
 * bar off the window frame, and this window has no frame, so what it drew on
 * the frameless desk was worse than nothing. Both draw the menu in the chrome
 * strip instead, and both listen for the accelerators themselves.
 */
export function nativeMenuBar(): boolean {
	if (webClient()) return false;
	return host() === "macos";
}

/** What this desktop calls the program that opens a folder. */
export function fileManager(): string {
	switch (host()) {
		case "windows":
			return "File Explorer";
		case "linux":
			return "Files";
		case "macos":
			return "Finder";
		/* A desk we cannot name still opens folders. Better an unglamorous
		 * label than the confident name of a program this one may not have. */
		default:
			return "the file manager";
	}
}

/**
 * Whether the window actually inlays traffic lights over the left of the
 * toolbar. That is a macOS hiddenInset thing. Linux and Windows leave that
 * corner empty, so padding as if the lights were there just shoves the mark
 * into the middle of nothing.
 */
export function insetLights(): boolean {
	return host() === "macos";
}

/**
 * Linux and Windows draw their own title strip. `titleBarStyle: "hidden"`
 * gives the webview the whole surface but leaves either platform without
 * caption buttons, so the window draws those — and its own menu, and its own
 * resize edges — itself.
 *
 * The host says "windows"; node's `platform()`, which decides the titleBarStyle
 * on the other side of the wire, says "win32". Compared against `Host` rather
 * than looked up in a `string[]`, so the wrong one of those is a type error
 * here instead of a desk with no caption buttons there.
 */
export function customChrome(): boolean {
	const desk = host();
	return desk === "linux" || desk === "windows";
}

/**
 * Whether this desk can put the window into full screen at all.
 *
 * Windows cannot. Electrobun's win32 `setWindowFullScreen` decides what to do
 * from `(style & WS_POPUP) && !(style & WS_OVERLAPPEDWINDOW)`, which is the
 * style a frameless window already has, so it takes neither branch and the
 * window never moves. Offering the item anyway is a lever attached to nothing.
 */
export function canFullScreen(): boolean {
	return host() !== "windows";
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
