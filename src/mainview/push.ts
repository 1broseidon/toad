import { nativeShell } from "./platform";

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
 * Asks iOS for permission if it has not been asked yet, and registers with
 * APNs. Safe to call again on every resume — a fresh registration event is
 * just a fresh token, and the desktop RPC it feeds is a plain upsert.
 */
export async function registerForPush(
	onToken: (token: string, environment: PushEnvironment) => void,
): Promise<void> {
	if (!nativeShell()) return;
	const { PushNotifications } = await import("@capacitor/push-notifications");
	let receive = (await PushNotifications.checkPermissions()).receive;
	if (receive === "prompt" || receive === "prompt-with-rationale") {
		receive = (await PushNotifications.requestPermissions()).receive;
	}
	if (receive !== "granted") return;
	await PushNotifications.addListener("registration", (token) => onToken(token.value, ENVIRONMENT));
	// Nothing to act on — a phone that never registers just never buzzes,
	// and the wire stays the source of truth either way.
	await PushNotifications.addListener("registrationError", () => {});
	await PushNotifications.register();
}

/** Runs `onOpen` with a persona id whenever a push notification is tapped. */
export async function onPushOpened(onOpen: (personaId: string) => void): Promise<() => void> {
	if (!nativeShell()) return () => {};
	const { PushNotifications } = await import("@capacitor/push-notifications");
	const handle = await PushNotifications.addListener("pushNotificationActionPerformed", (action) => {
		const personaId = (action.notification.data as Record<string, unknown> | undefined)?.personaId;
		if (typeof personaId === "string") onOpen(personaId);
	});
	return () => void handle.remove();
}
