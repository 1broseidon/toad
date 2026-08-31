/**
 * The one door from the room back down into a running plugin.
 *
 * A module of its own, with no imports, because everything that wants to wake a
 * plugin — the log plane applying a mirror delta, the fleet handing over an
 * event — sits underneath the bridge that owns the socket. Without this the
 * import graph closes a cycle through `mcp/bridge.ts`, and the alternative
 * idiom in this tree is a lazy `require`, which hides the dependency instead of
 * naming it.
 *
 * The bridge sets the pusher when it starts listening and clears it when it
 * stops. A push to a plugin that is not connected returns `false` and is
 * dropped: pushes are pattern 3's semantics all the way down, and there is no
 * store-and-forward anywhere in this tree.
 */

export type PluginPusher = (
	pluginId: string,
	name: string,
	payload: Record<string, unknown>,
) => boolean;

let pusher: PluginPusher | undefined;

export function setPluginPusher(next: PluginPusher | undefined): void {
	pusher = next;
}

/** Whether the frame reached a connected plugin. Never throws. */
export function notifyPlugin(
	pluginId: string,
	name: string,
	payload: Record<string, unknown>,
): boolean {
	if (!pusher) return false;
	try {
		return pusher(pluginId, name, payload);
	} catch {
		return false;
	}
}
