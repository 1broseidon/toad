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

function haptics(): Promise<HapticsModule> | null {
	if (!nativeShell()) return null;
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
