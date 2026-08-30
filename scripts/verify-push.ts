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
const { createPairing, claimPairing, listDevices } = await import("../src/bun/web/devices");
const {
	registerPushDevice,
	pushFanout,
	pushReach,
	reportPushTokenDead,
	listPushRegistrations,
	unpairPushDevice,
} = await import("../src/bun/store/push");
const { listCredentials } = await import("../src/bun/store/credentials");

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
if (credentials.keyFrom !== "here") throw new Error("a key typed on this desk came from here");

// The key is a credential in the sealed vault, not a file beside the app. It
// is Toad's own secret rather than a model provider's, so it must never be
// advertised as reach — and none of it may show up in the room-level list.
const keyRow = listCredentials().find((entry) => entry.providerId === "toad.apns");
if (!keyRow) throw new Error("the APNs key should be a credential record");
if (keyRow.replicate) throw new Error("a fresh signing key must not replicate unasked");
if (JSON.stringify(keyRow).includes("BEGIN")) throw new Error("no key material may reach the room view");

// The registration: push rides on the pairing, replicates as its own record,
// and unpairing takes it along.
const device = claimPairing(createPairing(), "verify-phone");
if (!device) throw new Error("pairing should claim");
if (!registerPushDevice({ deviceId: device.id, token: "f".repeat(64), environment: "sandbox" })) {
	throw new Error("registration should stick");
}
if (pushReach() !== 1) throw new Error("a registered device should be reachable from this desk");
if (pushFanout().length !== 1) throw new Error("a registered device should be one fan-out target");
if (listDevices()[0]?.push !== true) throw new Error("settings should see push as a boolean");
if (listDevices().some((entry) => "token" in entry)) throw new Error("no credential may reach the UI");

// A lone desk seals to nobody, so the record that travels carries no boxes at
// all — and never the token, whatever the room looks like.
const [published] = listPushRegistrations();
if (!published) throw new Error("registering should publish a record");
if (published.ownerNode === "") throw new Error("a registration must name its pairing desk");
if (JSON.stringify(published).includes("f".repeat(64))) {
	throw new Error("the room view of a registration must never carry the token");
}

// Re-declaring the same address on the next launch must not churn an op.
const before = published.updatedAt;
registerPushDevice({ deviceId: device.id, token: "f".repeat(64), environment: "sandbox" });
const after = listPushRegistrations()[0];
if (!after || after.updatedAt !== before || after.generation !== published.generation) {
	throw new Error("re-declaring the same token must write nothing");
}

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

// A prune is a fact about a named generation, not about whatever token is
// current: a report that crossed paths with the phone's next launch must not
// kill the token that replaced it.
if (reportPushTokenDead("nosuchregistration", 1)) {
	throw new Error("pruning an unknown registration should report nothing");
}
if (reportPushTokenDead(device.id, 99)) {
	throw new Error("a prune naming a generation that is not current must be refused");
}
if (!reportPushTokenDead(device.id, published.generation)) {
	throw new Error("pruning the current generation should report the prune");
}
if (pushReach() !== 0) throw new Error("a pruned device should stop being reachable");
if (listPushRegistrations()[0]?.dead !== true) throw new Error("the prune must travel as a fact");
if (listDevices().length !== 1) throw new Error("pruning push must not unpair the device");

// The way out: unpairing withdraws the address from the room and removes the
// pairing. With no other desk in the room there is nothing to wait on, so the
// record is settled and forgotten in the same breath.
if (!unpairPushDevice(device.id)) throw new Error("unpairing should remove the device");
if (listDevices().length !== 0) throw new Error("unpairing should remove the pairing");
if (listPushRegistrations().length !== 0) throw new Error("a settled withdrawal should be forgotten");

clearPushKey();
if (pushCredentials().configured) throw new Error("cleared credentials should read as unconfigured");
if (pushCredentials().keyFrom !== null) throw new Error("a revoked key belongs to no desk");
if (listCredentials().find((entry) => entry.providerId === "toad.apns")?.revoked !== true) {
	throw new Error("clearing the key must publish a revocation, not delete the row quietly");
}
const withoutKey = await sendPush("a".repeat(64), "sandbox", { title: "x", body: "y" });
if (withoutKey.ok || withoutKey.reason !== "NoCredentials") {
	throw new Error("sending without a key should fail as NoCredentials, not throw");
}

closePushSessions();
console.log(
	"push: signs ES256 with a vaulted key, reaches APNs over h2, publishes a registration that never carries the token, prunes only the generation Apple called dead, and withdraws the address when the phone is unpaired",
);
