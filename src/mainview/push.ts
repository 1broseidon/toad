import { capacitorNative } from "./platform";

/**
 * Registering this phone with Apple, and routing a tap back into Toad.
 *
 * Everything past permission and the token is the desktop's job — this
 * module only gets the token into APNs and back to `registerPushDevice`
 * over the wire the phone already trusts. See docs/push.md.
 */

export type PushEnvironment = "sandbox" | "production";

/**
 * Which APNs environment a token is good for is decided by which
 * entitlement signed the binary, not by anything askable at runtime — see
 * `ios/App/App/App.entitlements`. Every build shipped today is Debug-signed
 * with `aps-environment: development`, so this stays hardcoded until a
 * Release/Archive build exists to tell the two apart.
 */
const ENVIRONMENT: PushEnvironment = "sandbox";

/**
/**
 * Where a registration event should land.
 *
 * Held at module scope because the listeners below are attached once for the
 * life of the page while `registerForPush` is called again on every resume —
 * so the handler has to read the current callback rather than close over
 * whichever one happened to be passed first.
 */
let deliver: ((token: string, environment: PushEnvironment) => void) | null = null;
let problem: ((reason: string) => void) | null = null;
let listening = false;

/**
 * Asks iOS for permission if it has not been asked yet, and registers with
 * APNs.
 *
 * Safe to call again on every resume, which is the point: Apple re-mints
 * tokens whenever it likes. Only `register()` repeats — the listeners are
 * attached once, because adding them per call would stack a duplicate on
 * every resume and report the same token N times.
 */
export async function registerForPush(
	onToken: (token: string, environment: PushEnvironment) => void,
	onProblem?: (reason: string) => void,
): Promise<void> {
	/* Gated on the real plugin, not `nativeShell()`: a `?shell=native` fleet
	 * window passes that check too, and has no plugin behind it to ask. */
	if (!capacitorNative()) return;
	problem = onProblem ?? null;
	deliver = onToken;
	const { PushNotifications } = await import("@capacitor/push-notifications");
	let receive = (await PushNotifications.checkPermissions()).receive;
	if (receive === "prompt" || receive === "prompt-with-rationale") {
		receive = (await PushNotifications.requestPermissions()).receive;
	}
	if (receive !== "granted") {
		onProblem?.(receive === "denied" ? "permission-denied" : `permission-${receive}`);
		return;
	}
	if (!listening) {
		listening = true;
		await PushNotifications.addListener("registration", (token) =>
			deliver?.(token.value, ENVIRONMENT),
		);
		// Nothing to act on — a phone that never registers just never buzzes,
		// and the wire stays the source of truth either way.
		/* Reported rather than swallowed: a phone that cannot register is
		 * invisible on both ends otherwise — the desktop just shows a device
		 * count that never grows, with nothing to say why. */
		await PushNotifications.addListener("registrationError", (error) =>
			problem?.(String(error?.error ?? "registration-failed")),
		);
	}
	await PushNotifications.register();
}

/**
 * Runs `onOpen` whenever a push notification is tapped. The envelope names
 * the desktop that owns the teammate; the caller resolves that against the
 * hub it is wired to — bare id when they match, node-qualified when not.
 */
export async function onPushOpened(
	onOpen: (personaId: string, node?: string) => void,
): Promise<() => void> {
	if (!capacitorNative()) return () => {};
	const { PushNotifications } = await import("@capacitor/push-notifications");
	const handle = await PushNotifications.addListener("pushNotificationActionPerformed", (action) => {
		const data = action.notification.data as Record<string, unknown> | undefined;
		const personaId = data?.personaId;
		if (typeof personaId === "string") {
			onOpen(personaId, typeof data?.node === "string" ? data.node : undefined);
		}
	});
	return () => void handle.remove();
}
