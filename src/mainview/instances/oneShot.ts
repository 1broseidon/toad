/**
 * One request to a desktop the page is not wired to.
 *
 * The phone holds a token for every desktop it has linked, but its living
 * wire points at exactly one. Brokering a fleet introduction needs a single
 * question asked of the *other* desktop — so this opens a socket, asks it,
 * and hangs up. Not a transport: no reconnects, no pushes, one frame each way.
 */
export function oneShotRpc<T>(
	origin: string,
	token: string,
	method: string,
	params: unknown,
): Promise<T> {
	const url = `${origin.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(token)}`;
	return new Promise<T>((resolve, reject) => {
		const ws = new WebSocket(url);
		const timer = setTimeout(() => {
			ws.close();
			reject(new Error("That desktop did not answer"));
		}, 15_000);
		const done = (act: () => void) => {
			clearTimeout(timer);
			ws.close();
			act();
		};
		ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }));
		ws.onmessage = (event) => {
			try {
				const frame = JSON.parse(String(event.data)) as {
					id?: number;
					ok?: boolean;
					result?: T;
					error?: string;
				};
				if (frame.id !== 1) return;
				if (frame.ok) done(() => resolve(frame.result as T));
				else done(() => reject(new Error(frame.error ?? "That desktop refused")));
			} catch {
				done(() => reject(new Error("Malformed answer")));
			}
		};
		ws.onerror = () => done(() => reject(new Error("Could not reach that desktop")));
	});
}
