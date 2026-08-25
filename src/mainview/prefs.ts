import { useSyncExternalStore } from "react";

/**
 * Shell preferences that belong to this screen, not to any desktop — kept in
 * localStorage because they describe how *this* window shows the world, and
 * should hold steady across desktop switches and restarts.
 */

const MERGED_KEY = "toad.oneRoom";
const EVENT = "toad-prefs";

/** Teammates from every linked desktop in one list. On until turned off. */
export function mergedRoom(): boolean {
	try {
		return localStorage.getItem(MERGED_KEY) !== "off";
	} catch {
		return true;
	}
}

export function setMergedRoom(on: boolean): void {
	try {
		localStorage.setItem(MERGED_KEY, on ? "on" : "off");
	} catch {
		/* Private mode keeps the default; the toggle just won't stick. */
	}
	window.dispatchEvent(new Event(EVENT));
}

function subscribe(onChange: () => void): () => void {
	window.addEventListener(EVENT, onChange);
	window.addEventListener("storage", onChange);
	return () => {
		window.removeEventListener(EVENT, onChange);
		window.removeEventListener("storage", onChange);
	};
}

export function useMergedRoom(): boolean {
	return useSyncExternalStore(subscribe, mergedRoom, () => true);
}
