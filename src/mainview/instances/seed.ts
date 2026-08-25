import type { PairedInstance } from "./store";

/**
 * A desktop opening a window onto another desktop arrives credentialed: the
 * seed in the URL fragment is a finished pairing, minted over the fleet
 * trust. The fragment never crosses the network, and it is stripped from
 * history the moment it is read so the token does not outlive the arrival.
 */

export type FleetSeed = PairedInstance & { select?: string };

let seeded: FleetSeed | null = null;
let taken = false;

export function takeFleetSeed(): FleetSeed | null {
	if (taken) return seeded;
	taken = true;
	const match = /#fleet=([^&]+)/.exec(window.location.hash);
	if (!match) return null;
	try {
		const parsed = JSON.parse(decodeURIComponent(match[1])) as Partial<FleetSeed>;
		if (
			typeof parsed.id === "string" &&
			typeof parsed.name === "string" &&
			typeof parsed.origin === "string" &&
			typeof parsed.token === "string"
		) {
			seeded = {
				id: parsed.id,
				name: parsed.name,
				origin: parsed.origin,
				token: parsed.token,
				deviceId: typeof parsed.deviceId === "string" ? parsed.deviceId : "",
				select: typeof parsed.select === "string" ? parsed.select : undefined,
			};
		}
	} catch {
		seeded = null;
	}
	window.history.replaceState(null, "", window.location.pathname + window.location.search);
	return seeded;
}
