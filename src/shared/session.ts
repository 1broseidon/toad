import type { SessionState } from "./types";

/**
 * What a session's state means, in the four readings the app actually asks for.
 *
 * These live in `shared` rather than the webview because the window and the
 * menu bar answer the same questions about the same teammate, and a predicate
 * written out twice is a predicate that eventually says two different things.
 *
 * Each one is exactly what its call sites were testing before, deliberately:
 * `error` is neither up nor in need of a start, because a session that failed
 * is waiting to be retried by hand rather than restarted underneath you.
 */

/** A turn is running: the teammate is composing a reply right now. */
export const isWorking = (state: SessionState) => state === "thinking";

/** Occupied — either replying, or about to be once the process is up. */
export const isBusy = (state: SessionState) => state === "thinking" || state === "starting";

/** There is a live session behind this teammate, idle or not. */
export const isUp = (state: SessionState) => state === "ready" || state === "thinking";

/** Nothing is running, and sending would have to spawn first. */
export const needsStart = (state: SessionState) => state === "idle" || state === "stopped";
