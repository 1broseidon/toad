/**
 * The pairing additions a native client needs: a stable instance id, and
 * that revocation does not drop it. CORS and the QR's `&http=` param live
 * on the server and are checked by reading the source contract, not here.
 *
 *   bun scripts/verify-web-pair.ts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.TOAD_DATA_DIR = mkdtempSync(join(tmpdir(), "toad-web-pair-"));

const {
	instanceIdentity,
	createPairing,
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

const after = instanceIdentity();
if (after.instanceId !== first.instanceId) {
	throw new Error("revoking a device must not remint the install's instanceId");
}

console.log(`instance ${first.instanceId} on ${first.hostName} — pairing holds`);
