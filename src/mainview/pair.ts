/**
 * Claiming a pairing code against a Toad desktop.
 *
 * Lives outside the transport so the native link screen can POST /pair
 * without pulling the WebSocket client into the same module — the desktop
 * bundle never opens that socket, and should not have to load it to render
 * a button that it will never show.
 */

/** A name the desktop's device list can recognise at a glance. */
export function deviceName(): string {
	const ua = navigator.userAgent;
	if (/iPhone/.test(ua)) return "iPhone";
	if (/iPad/.test(ua)) return "iPad";
	if (/Android/.test(ua)) return "Android";
	if (/Macintosh/.test(ua)) return "Mac browser";
	return "Browser";
}

/**
 * What a desktop hands back when it accepts a pairing code.
 *
 * `instanceId` and `hostName` are how a native client tells one desktop
 * from another across DHCP moves. An older desktop omits them, so both are
 * nullable here rather than assumed.
 */
export type PairedDevice = {
	deviceId: string;
	token: string;
	instanceId: string | null;
	hostName: string | null;
};

/**
 * Trades a one-time code for this device's own token.
 *
 * `origin` names a desktop this page was not served by, in which case the
 * request is cross-origin and goes through an absolute URL so the browser
 * asks for CORS. Left out, it is the page's own server and stays relative.
 */
export async function claimPairing(code: string, origin?: string): Promise<PairedDevice | null> {
	try {
		const res = await fetch(origin ? new URL("/pair", origin) : "/pair", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ code, name: deviceName() }),
		});
		if (!res.ok) return null;
		const body = (await res.json()) as {
			ok?: boolean;
			deviceId?: string;
			token?: string;
			instanceId?: string;
			hostName?: string;
		};
		if (!body.ok || !body.token) return null;
		return {
			deviceId: body.deviceId ?? "",
			token: body.token,
			instanceId: body.instanceId ?? null,
			hostName: body.hostName ?? null,
		};
	} catch {
		return null;
	}
}
