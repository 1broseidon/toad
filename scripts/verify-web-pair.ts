/**
 * The pairing additions a native client needs: a stable instance id, that
 * revocation does not drop it, and that the one-time code has the enrollment
 * code's discipline — five guesses and the code burns, a code that outlives
 * its window is spent by nobody. CORS and the QR's `&http=` param live on the
 * server and are checked by reading the source contract, not here.
 *
 *   bun scripts/verify-web-pair.ts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.TOAD_DATA_DIR = mkdtempSync(join(tmpdir(), "toad-web-pair-"));
/* A window short enough to watch close. A promise about a clock is proven by
 * the clock, not by reading the branch — the same reason the seat's enrollment
 * TTL is overridable. */
process.env.TOAD_PAIRING_TTL_MS = "400";

const {
	instanceIdentity,
	createPairing,
	consumePairing,
	claimPairing,
	deviceForPeer,
	deviceByToken,
	revokeDevice,
	revokeDevicesForPeer,
	listDevices,
} = await import("../src/bun/web/devices");

const first = instanceIdentity();
const again = instanceIdentity();
if (!first.instanceId || first.instanceId !== again.instanceId) {
	throw new Error("instanceId must be minted once and then held");
}
if (!first.hostName) throw new Error("hostName should be the machine's name");

const peer = deviceForPeer("verify-peer", "verify desktop");
if (listDevices().length !== 0) {
	throw new Error("fleet peer credentials must not appear as linked devices");
}
if (revokeDevicesForPeer("verify-peer") !== 1 || deviceByToken(peer.token)) {
	throw new Error("revoking a fleet peer must remove its transport credential");
}

const code = createPairing();
const device = claimPairing(code, "verify-phone");
if (!device) throw new Error("a fresh code should claim");

if (listDevices().length !== 1) throw new Error("the claimed device should appear");
if (!revokeDevice(device.id)) throw new Error("revoke should remove the device");
if (listDevices().length !== 0) throw new Error("revoked device should be gone");

// -- the guess budget -------------------------------------------------------
//
// A phone pairing and a client seat are one ceremony, so they hold one posture.
// Unlimited guesses does not degrade gracefully: it is defensible on a LAN and
// a different shape entirely once the door is reachable from further away, and
// this is the door that is meant to become reachable.

const wrong = "00000000";

const burnable = createPairing();
if (burnable === wrong) throw new Error("the harness guessed the real code; rerun");
for (let guess = 0; guess < 5; guess += 1) {
	if (consumePairing(wrong)) throw new Error("a wrong code paired");
}
if (consumePairing(burnable)) {
	throw new Error("the pairing code survived five wrong guesses — it must burn");
}

const survivor = createPairing();
if (survivor === wrong) throw new Error("the harness guessed the real code; rerun");
for (let guess = 0; guess < 4; guess += 1) {
	if (consumePairing(wrong)) throw new Error("a wrong code paired");
}
if (!consumePairing(survivor)) {
	throw new Error("four wrong guesses must not cost the fifth, correct one");
}
if (consumePairing(survivor)) throw new Error("a spent code paired a second time");

// A fresh QR resets the budget the burnt one spent, and the claim path shares
// the same counter as the bare consume — one code, one budget, both doors.
const reminted = createPairing();
if (reminted === wrong) throw new Error("the harness guessed the real code; rerun");
for (let guess = 0; guess < 5; guess += 1) consumePairing(wrong);
if (claimPairing(reminted, "burnt-phone")) {
	throw new Error("claimPairing does not share the guess budget");
}
if (listDevices().length !== 0) throw new Error("a burnt code minted a device");

// -- the window -------------------------------------------------------------

const stale = createPairing();
await Bun.sleep(600);
if (consumePairing(stale)) throw new Error("a code outlived its window");

const after = instanceIdentity();
if (after.instanceId !== first.instanceId) {
	throw new Error("revoking a device must not remint the install's instanceId");
}

console.log(
	`instance ${first.instanceId} on ${first.hostName} — pairing holds, and the code burns after five wrong guesses and dies with its window`,
);
