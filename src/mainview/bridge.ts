import Electrobun from "electrobun/view";

/**
 * The page's one connection to the main process.
 *
 * `Electroview` claims `window.__electrobun.receiveMessageFromHost` and opens a
 * socket for the webview id, and both of those are single slots. Build a second
 * one on the same page and it takes the channel over: every reply the first is
 * still waiting on gets handed to the wrong schema and dropped, so requests
 * never settle and never fail either. Nothing in the app can tell that apart
 * from the main process being slow.
 *
 * Both surfaces ship in one bundle, which is exactly the arrangement where that
 * happens by accident, so the wires are built through here — a second one is a
 * loud error at startup instead of a window that loads and then waits forever.
 */
let connected: string | undefined;

export function connect(surface: string, rpc: unknown): void {
	if (connected) {
		throw new Error(
			`The ${connected} wire is already connected on this page; ${surface} would take it over. ` +
				"Load one surface per page.",
		);
	}
	connected = surface;
	// electrobun/view does not export the transport type this is checked against,
	// which is why the schemas are declared with `as never` where they are defined.
	new Electrobun.Electroview({ rpc: rpc as never });
}
