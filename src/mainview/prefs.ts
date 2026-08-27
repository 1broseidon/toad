import { useSyncExternalStore } from "react";

/**
 * Shell preferences that belong to this screen, not to any desktop — kept in
 * localStorage because they describe how *this* window shows the world, and
 * should hold steady across desktop switches and restarts.
 */

const EVENT = "toad-prefs";

function subscribe(onChange: () => void): () => void {
	window.addEventListener(EVENT, onChange);
	window.addEventListener("storage", onChange);
	return () => {
		window.removeEventListener(EVENT, onChange);
		window.removeEventListener("storage", onChange);
	};
}

/* ------------------------------------------------------------ connection
 * Which desktop the phone rides through. Auto (null) is the default: the
 * phone keeps its current hub while it is healthy and walks to another
 * linked desk when it is not — the room looks the same from any seat. A
 * pin is a manual override for debugging a specific desk. */

const PIN_KEY = "toad.connectionPin";

export function connectionPin(): string | null {
	try {
		return localStorage.getItem(PIN_KEY);
	} catch {
		return null;
	}
}

export function setConnectionPin(id: string | null): void {
	try {
		if (id) localStorage.setItem(PIN_KEY, id);
		else localStorage.removeItem(PIN_KEY);
	} catch {
		/* Private mode: Auto it stays. */
	}
	window.dispatchEvent(new Event(EVENT));
}

export function useConnectionPin(): string | null {
	return useSyncExternalStore(subscribe, connectionPin, () => null);
}
