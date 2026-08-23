/**
 * The transport for a plain browser: web mode.
 *
 * Same RPC contract as the hosted webview, carried over a WebSocket to the
 * bun process instead of Electrobun's channel. Requests are
 * `{id, method, params}` answered by `{id, ok, result|error}`; pushes
 * arrive as `{push, payload}` and fan into the same listeners the hosted
 * page uses.
 *
 * A device speaks only once it is linked: a one-time pairing code — scanned
 * as a QR from the desktop, or typed — is traded at /pair for this device's
 * own token. Unlinked, the page shows the link screen and the app behind it
 * simply never hears an answer. A revoked token clears itself and lands
 * back on the link screen rather than wedging on a dead socket.
 *
 * Two callers, and they are not the same shape. A browser served by the
 * desktop is *on* the desktop's origin: it keeps its token in localStorage,
 * speaks in relative paths, and reloads the page to change state. A native
 * shell is served by nobody — it is handed a target, holds several of them
 * at once, and cannot reload its way out of anything. So the target, the
 * token and the link screen are all optional: passed a target, this file
 * touches neither storage nor the address bar.
 */

import { claimPairing } from "./pair";
import { nativeShell } from "./platform";
import { codeFromPhoto, startViewfinder } from "./qr-scan";

export type { PairedDevice } from "./pair";
export { claimPairing };

const DEVICE_KEY = "toad-web-device";

/** A desktop to speak to, when it is not the one that served this page. */
export type WebTarget = { origin: string; token: string };

export type WebConnectOptions = {
	target?: WebTarget;
	onRevoked?: () => void;
	onStatus?: (status: "connecting" | "open" | "reconnecting") => void;
	/** The wire came back after a drop. Whatever was pushed meanwhile is gone
	 * — there is no replay — so this is the moment to refetch, not resume. */
	onReopen?: () => void;
};

/** A wire that can be taken down again, which switching desktops requires. */
export type WebSession = {
	invoke: (method: string, params?: unknown) => Promise<unknown>;
	close: () => void;
};

function storedToken(): string {
	try {
		return localStorage.getItem(DEVICE_KEY) ?? "";
	} catch {
		return "";
	}
}

function storeToken(token: string): void {
	try {
		localStorage.setItem(DEVICE_KEY, token);
	} catch {}
}

function clearToken(): void {
	try {
		localStorage.removeItem(DEVICE_KEY);
	} catch {}
}

/** The page's own claim: the token belongs to this browser, so it is kept. */
async function claim(code: string): Promise<boolean> {
	const paired = await claimPairing(code);
	if (!paired) return false;
	storeToken(paired.token);
	return true;
}

/**
 * The link screen, in vanilla DOM on purpose: it exists before the app has
 * a working wire, so it cannot lean on anything that needs one.
 *
 * Scanning happens *here*, not in the camera app, because an installed
 * home-screen app has its own storage — a link made in Safari does not
 * carry over, so the installed app must be able to enroll itself. Over
 * HTTPS the scan is a live viewfinder; over plain HTTP (no camera for
 * insecure origins) it degrades to a photo capture, then to typing.
 *
 * This is the browser's screen only. A native shell has a target handed to
 * it and its own link screen in React, so it never gets here.
 */
function showLinkScreen(): void {
	const root = document.createElement("div");
	root.id = "toad-link";
	root.innerHTML = `
		<style>
			#toad-link { position: fixed; inset: 0; z-index: 9999; display: flex; flex-direction: column;
				align-items: center; justify-content: center; gap: 14px; background: #040405; color: #edeef0;
				font-family: system-ui, sans-serif; padding: 24px; text-align: center; }
			#toad-link h1 { font-size: 20px; margin: 0; }
			#toad-link p { margin: 0; max-width: 30rem; font-size: 14px; line-height: 1.5; color: #949597; }
			#toad-link .scan { font-size: 16px; padding: 12px 24px; border-radius: 8px; border: 0;
				background: #6bcb62; color: #0c1f0a; font-weight: 600; }
			#toad-link .row { display: flex; gap: 8px; align-items: center; }
			#toad-link input { font-size: 16px; padding: 10px 12px; border-radius: 8px; border: 1px solid #2a2c2e;
				background: #0c0d0f; color: #edeef0; text-align: center; letter-spacing: 0.2em; width: 12ch; }
			#toad-link .go { font-size: 15px; padding: 10px 16px; border-radius: 8px;
				border: 1px solid #2a2c2e; background: transparent; color: #bcbebf; }
			#toad-link .err { color: #ef6161; font-size: 13px; min-height: 1em; }
			#toad-link .dim { font-size: 12px; color: #6a6c6e; }
		</style>
		<h1>Link this device</h1>
		<p>On the desktop, open Settings → General → Web access and press “Add device”.</p>
		<video id="toad-link-video" playsinline muted hidden
			style="width:min(80vw,320px); aspect-ratio:1; object-fit:cover; border-radius:12px; border:1px solid #2a2c2e;"></video>
		<button class="scan" id="toad-link-scan" type="button">Scan the code</button>
		<input id="toad-link-file" type="file" accept="image/*" capture="environment" hidden />
		<p class="dim">or type the code shown under it</p>
		<div class="row">
			<input id="toad-link-code" autocomplete="one-time-code" inputmode="text"
				autocapitalize="none" spellcheck="false" placeholder="code" />
			<button class="go" id="toad-link-go" type="button">Link</button>
		</div>
		<p class="err" id="toad-link-err"></p>
	`;
	document.body.appendChild(root);
	const input = root.querySelector<HTMLInputElement>("#toad-link-code")!;
	const file = root.querySelector<HTMLInputElement>("#toad-link-file")!;
	const err = root.querySelector<HTMLElement>("#toad-link-err")!;

	const finish = async (code: string | null, missing: string) => {
		err.textContent = "";
		if (!code) {
			err.textContent = missing;
			return;
		}
		if (await claim(code)) window.location.reload();
		else err.textContent = "That code didn't work — codes expire after two minutes.";
	};

	const video = root.querySelector<HTMLVideoElement>("#toad-link-video")!;
	const scan = root.querySelector<HTMLButtonElement>("#toad-link-scan")!;
	let stopViewfinder: (() => void) | null = null;

	// Live viewfinder where the context allows a camera; photo capture where
	// it doesn't. The button is the same either way.
	const liveCapable = Boolean(navigator.mediaDevices?.getUserMedia);
	scan.addEventListener("click", () => {
		if (!liveCapable) {
			file.click();
			return;
		}
		if (stopViewfinder) return;
		err.textContent = "";
		video.hidden = false;
		scan.textContent = "Point at the code…";
		void startViewfinder(video, (code) => {
			stopViewfinder = null;
			video.hidden = true;
			scan.textContent = "Scan the code";
			void finish(code, "");
		}).then(
			(stop) => {
				stopViewfinder = stop;
			},
			() => {
				// Denied or no camera: the photo path still works everywhere.
				video.hidden = true;
				scan.textContent = "Scan the code";
				file.click();
			},
		);
	});
	file.addEventListener("change", () => {
		const photo = file.files?.[0];
		file.value = "";
		if (!photo) return;
		err.textContent = "reading…";
		void codeFromPhoto(photo)
			.then((code) => finish(code, "No QR in that shot — get the whole code in frame and try again."))
			.catch(() => finish(null, "Could not read that photo — try typing the code instead."));
	});
	root.querySelector("#toad-link-go")!.addEventListener("click", () => void finish(input.value.trim() || null, "Type the code first."));
	input.addEventListener("keydown", (event) => {
		if ((event as KeyboardEvent).key === "Enter") void finish(input.value.trim() || null, "Type the code first.");
	});
}

/** Distinguishes a revoked token from a network blip before giving up on it. */
async function tokenRevoked(token: string, origin?: string): Promise<boolean> {
	try {
		const path = `/ws?token=${token}`;
		const res = await fetch(origin ? new URL(path, origin) : path);
		return res.status === 401;
	} catch {
		return false;
	}
}

type Pending = { resolve(value: unknown): void; reject(reason: Error): void };

/**
 * One wire, with the handle needed to take it down again.
 *
 * `connectWeb` is this without the handle, for the page that only ever has
 * one desktop to speak to.
 */
export async function connectWebSession(
	dispatch: (event: string, payload: unknown) => void,
	options: WebConnectOptions = {},
): Promise<WebSession> {
	const { target, onRevoked, onStatus, onReopen } = options;

	// A camera-scanned QR lands here with the code in the URL; claim it,
	// clean the address bar, and carry on linked. Only the browser served by
	// the desktop can be arrived at this way.
	if (!target) {
		const url = new URL(window.location.href);
		const pairCode = url.searchParams.get("pair");
		if (pairCode) {
			await claim(pairCode);
			url.searchParams.delete("pair");
			window.history.replaceState(null, "", url.toString());
		}
	}

	const token = target ? target.token : storedToken();
	if (!token && !target) {
		showLinkScreen();
		// The app above stays quiet until the reload that follows linking.
		return { invoke: () => new Promise<never>(() => {}), close: () => {} };
	}

	const origin = target?.origin;
	const pending = new Map<number, Pending>();
	let nextId = 1;
	let socket: WebSocket | null = null;
	let everOpened = false;
	let dropped = false;
	let retry: number | null = null;
	let ready: Promise<void>;
	let heartbeat: number | null = null;
	let probing = false;

	const open = () => {
		if (dropped) return;
		if (!everOpened) onStatus?.("connecting");
		const wsUrl = new URL("/ws", origin ?? window.location.origin);
		wsUrl.protocol = wsUrl.protocol.replace("http", "ws");
		wsUrl.searchParams.set("token", token);
		const ws = new WebSocket(wsUrl.toString());
		socket = ws;
		ready = new Promise<void>((resolve, reject) => {
			ws.onopen = () => {
				const resumed = everOpened;
				everOpened = true;
				onStatus?.("open");
				resolve();
				/* Only a *re*open: the first open has nothing to have missed. After
				 * resolve, so a refetch issued from the hook finds the wire ready. */
				if (resumed) onReopen?.();
			};
			ws.onerror = () => reject(new Error("web mode connection failed"));
		});
		ready.catch(() => {});
		ws.onmessage = (event) => {
			let frame: {
				id?: number;
				ok?: boolean;
				result?: unknown;
				error?: string;
				push?: string;
				payload?: unknown;
			};
			try {
				frame = JSON.parse(String(event.data));
			} catch {
				return;
			}
			if (frame.push) {
				dispatch(frame.push, frame.payload);
				return;
			}
			if (typeof frame.id !== "number") return;
			const entry = pending.get(frame.id);
			if (!entry) return;
			pending.delete(frame.id);
			if (frame.ok) entry.resolve(frame.result);
			else entry.reject(new Error(frame.error ?? "request failed"));
		};
		ws.onclose = () => {
			for (const entry of pending.values()) entry.reject(new Error("web mode disconnected"));
			pending.clear();
			if (dropped) return;
			void (async () => {
				if (await tokenRevoked(token, origin)) {
					// The desktop no longer knows this device. A browser can clear
					// its own token and land on the link screen; a native shell
					// holds the token elsewhere and is told instead.
					if (target) {
						dropped = true;
						onRevoked?.();
						return;
					}
					clearToken();
					window.location.reload();
					return;
				}
				if (dropped) return;
				// A phone that slept comes back; keep knocking gently. Said out
				// loud even on a first attempt that never landed, because a
				// desktop that moved is the same silence from here.
				onStatus?.("reconnecting");
				retry = window.setTimeout(open, 1_500);
			})();
		};
	};

	/**
	 * Tears the socket down by hand and knocks again now.
	 *
	 * The reconnect loop above only runs when `onclose` fires, and an iOS
	 * webview coming back from suspension routinely holds a socket that died
	 * without one — readyState says OPEN, nothing will ever arrive. Handlers
	 * come off first so the corpse's close, if it ever fires, does not
	 * schedule a second knock beside this one.
	 */
	const reopen = () => {
		if (dropped) return;
		if (retry !== null) {
			window.clearTimeout(retry);
			retry = null;
		}
		const ws = socket;
		socket = null;
		if (ws) {
			ws.onopen = null;
			ws.onclose = null;
			ws.onerror = null;
			ws.onmessage = null;
			try {
				ws.close();
			} catch {}
		}
		for (const entry of pending.values()) entry.reject(new Error("web mode disconnected"));
		pending.clear();
		onStatus?.("reconnecting");
		open();
	};

	/**
	 * Asks the desktop for any answer at all and treats silence as a dead
	 * wire. An error reply counts as life — a desktop too old to know `ping`
	 * still proves the socket by refusing it. Only silence reopens.
	 */
	const probe = (timeoutMs: number) => {
		if (dropped || probing) return;
		const ws = socket;
		if (!ws || ws.readyState !== WebSocket.OPEN) return;
		probing = true;
		const id = nextId++;
		const timer = window.setTimeout(() => {
			probing = false;
			pending.delete(id);
			reopen();
		}, timeoutMs);
		const settle = () => {
			probing = false;
			window.clearTimeout(timer);
		};
		pending.set(id, { resolve: settle, reject: settle });
		try {
			ws.send(JSON.stringify({ id, method: "ping", params: {} }));
		} catch {
			settle();
			pending.delete(id);
			reopen();
		}
	};

	/* The wire is watched, not trusted. A quarter-minute pulse catches a
	 * socket that died silently while the page was frontmost; coming back to
	 * visibility or to the network probes right now with a short fuse,
	 * because that is the exact moment iOS hands back a webview holding a
	 * corpse — and the user looking at a frozen transcript. */
	const alive = () => probe(4_000);
	const onVisible = () => {
		if (document.visibilityState === "visible") alive();
	};
	heartbeat = window.setInterval(() => probe(10_000), 25_000);
	document.addEventListener("visibilitychange", onVisible);
	window.addEventListener("pageshow", onVisible);
	window.addEventListener("online", alive);
	/* The native shell hears about its own life more reliably than the DOM
	 * does: resume fires the instant iOS hands the app back, and the network
	 * plugin the instant Wi-Fi returns. Loaded on demand so no other page
	 * carries the plugins; the handles are kept for teardown. */
	const pluginHandles: Array<{ remove(): Promise<void> }> = [];
	if (nativeShell()) {
		void import("@capacitor/app").then(async ({ App }) => {
			pluginHandles.push(await App.addListener("resume", alive));
		});
		void import("@capacitor/network").then(async ({ Network }) => {
			pluginHandles.push(
				await Network.addListener("networkStatusChange", (status) => {
					if (status.connected) alive();
				}),
			);
		});
	}
	open();

	const invoke = async (method: string, params: unknown = {}) => {
		await ready;
		const ws = socket;
		if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error("web mode disconnected");
		const id = nextId++;
		return new Promise((resolve, reject) => {
			pending.set(id, { resolve, reject });
			ws.send(JSON.stringify({ id, method, params }));
		});
	};

	/* Switching desktops closes this one. The handlers come off before the
	 * socket does, because `onclose` is what schedules the next knock — left
	 * on, a closed wire quietly reopens itself against the desktop nobody is
	 * looking at any more. */
	const close = () => {
		dropped = true;
		if (heartbeat !== null) {
			window.clearInterval(heartbeat);
			heartbeat = null;
		}
		document.removeEventListener("visibilitychange", onVisible);
		window.removeEventListener("pageshow", onVisible);
		window.removeEventListener("online", alive);
		for (const handle of pluginHandles) void handle.remove().catch(() => {});
		pluginHandles.length = 0;
		if (retry !== null) {
			window.clearTimeout(retry);
			retry = null;
		}
		const ws = socket;
		socket = null;
		if (ws) {
			ws.onopen = null;
			ws.onclose = null;
			ws.onerror = null;
			ws.onmessage = null;
			ws.close();
		}
		for (const entry of pending.values()) entry.reject(new Error("web mode disconnected"));
		pending.clear();
	};

	return { invoke, close };
}

export async function connectWeb(
	dispatch: (event: string, payload: unknown) => void,
	options?: WebConnectOptions,
): Promise<(method: string, params?: unknown) => Promise<unknown>> {
	const { invoke } = await connectWebSession(dispatch, options);
	return invoke;
}
