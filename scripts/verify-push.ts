/**
 * The push sender, end to end against Apple — everything but a real key.
 *
 * A self-signed P-256 key is a key Apple has never issued, so the honest
 * finish line is `InvalidProviderToken`: reaching that reason proves the
 * config was read, the JWT was signed in JOSE's raw `r||s` form rather than
 * DER, HTTP/2 reached APNs, and the error body was parsed. Everything up to
 * Apple recognising the key is covered; only the key itself is not.
 *
 * Also checks the part that would quietly corrupt state — that a rejection
 * Apple did not frame as a dead token never prunes a device (docs/push.md).
 *
 *   bun scripts/verify-push.ts
 */
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.TOAD_DATA_DIR = mkdtempSync(join(tmpdir(), "toad-push-"));

const { installPushKey, pushCredentials, clearPushKey, closePushSessions, sendPush } = await import(
	"../src/bun/push/apns"
);
const { createPairing, claimPairing, setDevicePush, clearDevicePush, pushTargets, listDevices } =
	await import("../src/bun/web/devices");

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;

// A file that is not a key should fail while a human is looking at it.
const bad = installPushKey({ pem: "-----BEGIN NOTHING-----", keyId: "ABCD123456", teamId: "TEAM123456" });
if (bad.ok) throw new Error("a non-key must be refused at install time");
if (pushCredentials().configured) throw new Error("a refused key must not count as configured");

const good = installPushKey({ pem, keyId: "ABCD123456", teamId: "TEAM123456" });
if (!good.ok) throw new Error(`a real P-256 key should install: ${good.error}`);

const credentials = pushCredentials();
if (!credentials.configured) throw new Error("an installed key should read as configured");
if (credentials.topic !== "team.toad.ios") throw new Error("topic should default to the app's bundle id");

// The device record: push rides on the pairing, and revocation takes it along.
const device = claimPairing(createPairing(), "verify-phone");
if (!device) throw new Error("pairing should claim");
if (!setDevicePush(device.id, "f".repeat(64), "sandbox")) throw new Error("registration should stick");
if (pushTargets().length !== 1) throw new Error("a registered device should be a push target");
if (listDevices()[0]?.push !== true) throw new Error("settings should see push as a boolean");
if (listDevices().some((entry) => "token" in entry)) throw new Error("no credential may reach the UI");

const result = await sendPush("a".repeat(64), "sandbox", {
	title: "Verify",
	body: "Reaching Apple with a key it has never seen.",
	data: { personaId: "verify", kind: "turn-ended" },
	collapseId: "verify:turn-ended",
});
if (result.ok) throw new Error("Apple cannot have accepted a self-signed provider key");
if (result.reason !== "InvalidProviderToken") {
	throw new Error(`expected InvalidProviderToken from APNs, got ${result.reason}`);
}
// The dangerous failure: treating any rejection as a dead token would unregister
// every phone the moment a key expired.
if (result.gone) throw new Error("a bad *key* must never be read as a bad *device token*");

if (clearDevicePush("nosuchtoken")) throw new Error("clearing an unknown token should report nothing");
if (!clearDevicePush("f".repeat(64))) throw new Error("clearing a known token should report the prune");
if (pushTargets().length !== 0) throw new Error("a pruned device should stop being a target");
if (listDevices().length !== 1) throw new Error("pruning push must not unpair the device");

clearPushKey();
if (pushCredentials().configured) throw new Error("cleared credentials should read as unconfigured");
const withoutKey = await sendPush("a".repeat(64), "sandbox", { title: "x", body: "y" });
if (withoutKey.ok || withoutKey.reason !== "NoCredentials") {
	throw new Error("sending without a key should fail as NoCredentials, not throw");
}

closePushSessions();
console.log("push: signs ES256, reaches APNs over h2, prunes only what Apple calls dead");
