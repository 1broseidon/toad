import type { InstanceStatus } from "./useInstances";
import type { LinkedInstance } from "./store";

/**
 * How a desktop is drawn in a list, in the one place both the list and the
 * chip can read it from.
 *
 * A monogram rather than a face: a desktop is a machine, and the faces in
 * this app belong to teammates who chose them.
 */

/** The first letter that is one, so "george's mbp" and " Studio" both read. */
export function monogramOf(name: string): string {
	return (name.match(/\p{L}|\p{N}/u)?.[0] ?? "?").toUpperCase();
}

/** The address without the port, which is the same on every row anyway. */
export function hostOf(origin: string): string {
	try {
		return new URL(origin).hostname;
	} catch {
		return origin;
	}
}

/**
 * A vital sign, on the same vocabulary the roster's rows use.
 *
 * Only the desktop actually on the wire gets a live dot. A row that is
 * merely in the list has no idea whether that machine is awake, and a green
 * dot claiming otherwise is a lie the app cannot back up — those rows say
 * when they were last heard from instead.
 */
export function vitalOf(
	instance: LinkedInstance,
	active: boolean,
	status: InstanceStatus,
): { className: string; label: string } {
	if (instance.state === "unlinked") return { className: "bg-rule-strong", label: "unlinked" };
	if (!active) return { className: "border-2 border-ink-3", label: "not connected" };
	if (status === "open") return { className: "bg-accent", label: "connected" };
	if (status === "reconnecting") return { className: "bg-warn animate-throat", label: "reconnecting" };
	if (status === "connecting") return { className: "bg-warn animate-throat", label: "connecting" };
	return { className: "border-2 border-ink-3", label: "not connected" };
}

/** How long ago, in the coarsest unit that still says something. */
export function since(ts: number): string {
	const ms = Date.now() - ts;
	if (ms < 90_000) return "just now";
	const minutes = Math.round(ms / 60_000);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.round(hours / 24);
	return `${days}d ago`;
}
