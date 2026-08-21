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
 */

const DEVICE_KEY = "toad-web-device";

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

/** A name the desktop's device list can recognise at a glance. */
function deviceName(): string {
	const ua = navigator.userAgent;
	if (/iPhone/.test(ua)) return "iPhone";
	if (/iPad/.test(ua)) return "iPad";
	if (/Android/.test(ua)) return "Android";
	if (/Macintosh/.test(ua)) return "Mac browser";
	return "Browser";
}

async function claim(code: string): Promise<boolean> {
	try {
		const res = await fetch("/pair", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ code, name: deviceName() }),
		});
		if (!res.ok) return false;
		const body = (await res.json()) as { ok?: boolean; token?: string };
		if (!body.ok || !body.token) return false;
		storeToken(body.token);
		return true;
	} catch {
		return false;
	}
}

/**
 * The link screen, in vanilla DOM on purpose: it exists before the app has
 * a working wire, so it cannot lean on anything that needs one.
 */
function showLinkScreen(): void {
	const root = document.createElement("div");
	root.id = "toad-link";
	root.innerHTML = `
		<style>
			#toad-link { position: fixed; inset: 0; z-index: 9999; display: flex; flex-direction: column;
				align-items: center; justify-content: center; gap: 12px; background: #040405; color: #edeef0;
				font-family: system-ui, sans-serif; padding: 24px; text-align: center; }
			#toad-link h1 { font-size: 20px; margin: 0; }
			#toad-link p { margin: 0; max-width: 30rem; font-size: 14px; line-height: 1.5; color: #949597; }
			#toad-link input { font-size: 16px; padding: 10px 12px; border-radius: 8px; border: 1px solid #2a2c2e;
				background: #0c0d0f; color: #edeef0; text-align: center; letter-spacing: 0.2em; width: 12ch; }
			#toad-link button { font-size: 16px; padding: 10px 20px; border-radius: 8px; border: 0;
				background: #6bcb62; color: #0c1f0a; font-weight: 600; }
			#toad-link .err { color: #ef6161; font-size: 13px; min-height: 1em; }
		</style>
		<h1>Link this device</h1>
		<p>On the desktop, open Settings → General → Web access and press “Add device”.
			Scan the QR code with this phone's camera — or type the code under it here.</p>
		<input id="toad-link-code" autocomplete="one-time-code" inputmode="text"
			autocapitalize="none" spellcheck="false" placeholder="code" />
		<button id="toad-link-go" type="button">Link</button>
		<p class="err" id="toad-link-err"></p>
	`;
	document.body.appendChild(root);
	const input = root.querySelector<HTMLInputElement>("#toad-link-code")!;
	const err = root.querySelector<HTMLElement>("#toad-link-err")!;
	const go = async () => {
		err.textContent = "";
		const ok = await claim(input.value.trim());
		if (ok) window.location.reload();
		else err.textContent = "That code didn't work — codes expire after two minutes.";
	};
	root.querySelector("#toad-link-go")!.addEventListener("click", () => void go());
	input.addEventListener("keydown", (event) => {
		if ((event as KeyboardEvent).key === "Enter") void go();
	});
}

/** Distinguishes a revoked token from a network blip before giving up on it. */
async function tokenRevoked(token: string): Promise<boolean> {
	try {
		const res = await fetch(`/ws?token=${token}`);
		return res.status === 401;
	} catch {
		return false;
	}
}

type Pending = { resolve(value: unknown): void; reject(reason: Error): void };

export async function connectWeb(
	dispatch: (event: string, payload: unknown) => void,
): Promise<(method: string, params?: unknown) => Promise<unknown>> {
	// A camera-scanned QR lands here with the code in the URL; claim it,
	// clean the address bar, and carry on linked.
	const url = new URL(window.location.href);
	const pairCode = url.searchParams.get("pair");
	if (pairCode) {
		await claim(pairCode);
		url.searchParams.delete("pair");
		window.history.replaceState(null, "", url.toString());
	}

	const token = storedToken();
	if (!token) {
		showLinkScreen();
		// The app above stays quiet until the reload that follows linking.
		return () => new Promise<never>(() => {});
	}

	const pending = new Map<number, Pending>();
	let nextId = 1;
	let socket: WebSocket | null = null;
	let everOpened = false;
	let ready: Promise<void>;

	const open = () => {
		const wsUrl = new URL("/ws", window.location.origin);
		wsUrl.protocol = wsUrl.protocol.replace("http", "ws");
		wsUrl.searchParams.set("token", token);
		const ws = new WebSocket(wsUrl.toString());
		socket = ws;
		ready = new Promise<void>((resolve, reject) => {
			ws.onopen = () => {
				everOpened = true;
				resolve();
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
			void (async () => {
				if (!everOpened && (await tokenRevoked(token))) {
					clearToken();
					window.location.reload();
					return;
				}
				// A phone that slept comes back; keep knocking gently.
				setTimeout(open, 1_500);
			})();
		};
	};
	open();

	return async (method, params = {}) => {
		await ready;
		const ws = socket;
		if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error("web mode disconnected");
		const id = nextId++;
		return new Promise((resolve, reject) => {
			pending.set(id, { resolve, reject });
			ws.send(JSON.stringify({ id, method, params }));
		});
	};
}
