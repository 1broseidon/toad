/**
 * The transport for a plain browser: web mode.
 *
 * Same RPC contract as the hosted webview, carried over a WebSocket to the
 * bun process instead of Electrobun's channel. Requests are
 * `{id, method, params}` answered by `{id, ok, result|error}`; pushes
 * arrive as `{push, payload}` and fan into the same listeners the hosted
 * page uses. The wire token comes in on the URL once, moves to
 * localStorage, and leaves the address bar.
 */

const TOKEN_KEY = "toad-web-token";

function claimToken(): string {
	const url = new URL(window.location.href);
	const fromUrl = url.searchParams.get("token");
	if (fromUrl) {
		try {
			localStorage.setItem(TOKEN_KEY, fromUrl);
		} catch {}
		url.searchParams.delete("token");
		window.history.replaceState(null, "", url.toString());
		return fromUrl;
	}
	try {
		return localStorage.getItem(TOKEN_KEY) ?? "";
	} catch {
		return "";
	}
}

type Pending = { resolve(value: unknown): void; reject(reason: Error): void };

export function connectWeb(
	dispatch: (event: string, payload: unknown) => void,
): (method: string, params?: unknown) => Promise<unknown> {
	const token = claimToken();
	const pending = new Map<number, Pending>();
	let nextId = 1;
	let socket: WebSocket | null = null;
	let ready: Promise<void> = Promise.reject(new Error("not connected"));
	ready.catch(() => {}); // replaced immediately below

	const open = () => {
		const url = new URL("/ws", window.location.origin);
		url.protocol = url.protocol.replace("http", "ws");
		url.searchParams.set("token", token);
		const ws = new WebSocket(url.toString());
		socket = ws;
		ready = new Promise<void>((resolve, reject) => {
			ws.onopen = () => resolve();
			ws.onerror = () => reject(new Error("web mode connection failed"));
		});
		ready.catch(() => {});
		ws.onmessage = (event) => {
			let frame: { id?: number; ok?: boolean; result?: unknown; error?: string; push?: string; payload?: unknown };
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
			// A phone that slept comes back; keep knocking gently.
			setTimeout(open, 1_500);
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
