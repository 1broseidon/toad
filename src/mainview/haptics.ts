import { nativeShell } from "./platform";

/**
 * The phone's sense of touch, as three verbs.
 *
 * Loaded on demand and only in the native shell — the desktop has no
 * vibration motor and its bundle should not carry the plugin. Every call is
 * fire-and-forget: a haptic that failed is a haptic that did not happen,
 * and nothing above needs to know.
 */

type HapticsModule = typeof import("@capacitor/haptics");

let loaded: Promise<HapticsModule> | null = null;

/* The switch lives on this phone, not in app settings: touch is a property
 * of the hand holding the glass, and another linked phone may disagree. */
const MUTE_KEY = "toad-haptics";
let muted = (() => {
	try {
		return localStorage.getItem(MUTE_KEY) === "off";
	} catch {
		return false;
	}
})();

export function hapticsOn(): boolean {
	return !muted;
}

export function setHapticsOn(on: boolean): void {
	muted = !on;
	try {
		localStorage.setItem(MUTE_KEY, on ? "on" : "off");
	} catch {
		/* a preference that cannot persist still holds for the session */
	}
}

function haptics(): Promise<HapticsModule> | null {
	if (muted || !nativeShell()) return null;
	loaded ??= import("@capacitor/haptics");
	return loaded;
}

/** A light tick — a message sent, a control that took. */
export function hapticTap(): void {
	void haptics()
		?.then(({ Haptics, ImpactStyle }) => Haptics.impact({ style: ImpactStyle.Light }))
		.catch(() => {});
}

/** A firmer knock — a menu arriving under a held finger. */
export function hapticHold(): void {
	void haptics()
		?.then(({ Haptics, ImpactStyle }) => Haptics.impact({ style: ImpactStyle.Medium }))
		.catch(() => {});
}

/** The platform's success pattern — a teammate finishing its turn. */
export function hapticDone(): void {
	void haptics()
		?.then(({ Haptics, NotificationType }) =>
			Haptics.notification({ type: NotificationType.Success }),
		)
		.catch(() => {});
}
