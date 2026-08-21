import { Electroview } from "electrobun/view";
import { connect } from "./bridge";

/**
 * The transport for the page Electrobun hosts: the app's own webview.
 * Loaded dynamically so the same bundle can run in a plain browser (web
 * mode) without electrobun/view ever executing there.
 */
export function connectHost(
	events: string[],
	dispatch: (event: string, payload: unknown) => void,
): (method: string, params?: unknown) => Promise<unknown> {
	const messages: Record<string, (payload: unknown) => void> = {};
	for (const event of events) {
		messages[event] = (payload) => dispatch(event, payload);
	}

	const rpc = Electroview.defineRPC<never>({
		maxRequestTime: 120_000,
		handlers: { requests: {}, messages },
	} as never);

	connect("app", rpc);

	return (method, params = {}) =>
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		((rpc as any).request[method] as (p: unknown) => Promise<unknown>)(params);
}
