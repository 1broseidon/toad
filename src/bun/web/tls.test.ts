import { describe, expect, test } from "bun:test";
import { X509Certificate, createPrivateKey } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The throwaway root comes from test/preload.ts. Setting TOAD_DATA_DIR here
// would be far too late: these imports resolve it.
const { ROOT } = await import("../paths");
const tls = await import("./tls");
const credentials = await import("../store/credentials");

const TLS_DIR = join(ROOT, "web-tls");
const KEY_FILE = join(TLS_DIR, "key.pem");
const CERT_FILE = join(TLS_DIR, "cert.pem");
const META_FILE = join(TLS_DIR, "meta.json");

/**
 * A room with no certificate and no root, which is where every desk starts.
 *
 * The store is shared by every test in this process, so a leftover `toad.web-ca`
 * record from the test above would be the room this one joins.
 */
function emptyRoom(): void {
	rmSync(TLS_DIR, { recursive: true, force: true });
	for (const credential of credentials.listCredentials()) {
		if (credential.providerId !== tls.WEB_CA_PROVIDER_ID) continue;
		try {
			credentials.deleteCredential(credential.id);
		} catch {
			/* Another desk's row, which this desk may not delete. */
		}
	}
}

function caRecords() {
	return credentials
		.listCredentials()
		.filter((credential) => credential.providerId === tls.WEB_CA_PROVIDER_ID);
}

/**
 * The roots the room would actually choose between.
 *
 * A revoked row cannot always be deleted — a withdrawal still owed to a desk
 * some other test file admitted keeps it on the books, which is the credential
 * store working as designed — so what a test means by "the room's roots" is the
 * live ones.
 */
function liveCaRecords() {
	return caRecords().filter((credential) => !credential.revoked);
}

function leaf(): X509Certificate {
	return new X509Certificate(readFileSync(CERT_FILE, "utf8"));
}

function installedCa(): X509Certificate {
	return new X509Certificate(readFileSync(tls.WEB_TLS_CA_FILE, "utf8"));
}

/** A `toad.web-ca` row this desk owns, holding whatever bytes the test wants. */
function plantCa(secret: string): string {
	const created = credentials.createCredential({
		providerId: tls.WEB_CA_PROVIDER_ID,
		kind: "api_key",
		label: "Toad room certificate authority",
		secret,
	});
	credentials.setCredentialReplication(created.id, true);
	return created.id;
}

/** Rewrites the leaf's meta so the next call believes the desk's address moved. */
function addressMoved(): void {
	const meta = JSON.parse(readFileSync(META_FILE, "utf8")) as { ca: string | null };
	writeFileSync(META_FILE, JSON.stringify({ ips: ["203.0.113.7"], ca: meta.ca }, null, 2), "utf8");
}

describe("the room's certificate authority", () => {
	test("a first desk mints one root, replicated, and serves a leaf under it", () => {
		emptyRoom();

		const material = tls.ensureTls();
		expect(material).not.toBeNull();

		// One root, published as a room record from birth: every desk signs its
		// own leaf, so a CA that stayed on the desk that minted it would be half
		// a feature.
		const rows = liveCaRecords();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.replicate).toBe(true);
		expect(rows[0]?.usableHere).toBe(true);

		const ca = installedCa();
		expect(ca.ca).toBe(true);
		expect(ca.subject).toContain("Toad room CA");

		const served = new X509Certificate(material?.cert ?? "");
		expect(served.ca).toBe(false);
		expect(served.issuer).toBe(ca.subject);
		expect(served.verify(ca.publicKey)).toBe(true);
		// Apple refuses a locally trusted leaf without it, and a browser that
		// takes the certificate anyway would still refuse the connection.
		expect(served.keyUsage).toContain("1.3.6.1.5.5.7.3.1");
		expect(served.subjectAltName).toContain("IP Address:127.0.0.1");
	});

	test("the key names its curve, which is what LibreSSL drops", () => {
		emptyRoom();
		tls.ensureTls();

		// macOS LibreSSL writes explicit domain parameters unless told otherwise,
		// Bun's BoringSSL refuses such a key, and `Bun.serve` throws at startup.
		// Both openssl calls that generate a key pass `ec_param_enc:named_curve`.
		const details = createPrivateKey(readFileSync(KEY_FILE, "utf8")).asymmetricKeyDetails;
		expect(details?.namedCurve).toBe("prime256v1");
	});

	test("an address move remints the leaf and leaves the root alone", () => {
		emptyRoom();
		tls.ensureTls();
		const rootBefore = installedCa().fingerprint256;
		const leafBefore = leaf().fingerprint256;

		addressMoved();
		const material = tls.ensureTls();

		// The whole point of the change: trust an operator installed on a client
		// machine survives DHCP. Only the leaf is reissued.
		expect(installedCa().fingerprint256).toBe(rootBefore);
		expect(leaf().fingerprint256).not.toBe(leafBefore);
		expect(new X509Certificate(material?.cert ?? "").verify(installedCa().publicKey)).toBe(true);
	});

	test("a desk that already has its leaf mints nothing on the next start", () => {
		emptyRoom();
		tls.ensureTls();
		const rootBefore = installedCa().fingerprint256;
		const leafBefore = leaf().fingerprint256;

		tls.ensureTls();

		expect(liveCaRecords()).toHaveLength(1);
		expect(installedCa().fingerprint256).toBe(rootBefore);
		expect(leaf().fingerprint256).toBe(leafBefore);
	});

	test("two roots converge on the older one, and the loser is revoked", () => {
		emptyRoom();
		// Two desks that mint in the same instant both succeed and publish. The
		// room converges by a rule every desk computes from the same bytes:
		// oldest record wins, ties broken by id.
		tls.ensureTls();
		const first = caRecords()[0]?.id;
		const second = plantCa("a second desk's root, minted in the same instant");
		expect(second).not.toBe(first);

		rmSync(META_FILE, { force: true });
		const material = tls.ensureTls();

		const live = liveCaRecords();
		expect(live).toHaveLength(1);
		expect(live[0]?.id).toBe(first);
		expect(caRecords().find((row) => row.id === second)?.revoked).toBe(true);
		expect(new X509Certificate(material?.cert ?? "").verify(installedCa().publicKey)).toBe(true);
	});

	test("a root this desk cannot open degrades to a self-signed leaf, never to no door", () => {
		emptyRoom();
		// The shape of a desk admitted after the CA was minted, before its owner
		// swept and sealed a box to it. A second root would be the wrong answer;
		// no door at all would be worse.
		plantCa("not the room's certificate authority");

		const material = tls.ensureTls();

		expect(material).not.toBeNull();
		// Unreadable material is not a reason to mint a second root.
		expect(liveCaRecords()).toHaveLength(1);
		expect(existsSync(tls.WEB_TLS_CA_FILE)).toBe(false);
		const served = new X509Certificate(material?.cert ?? "");
		expect(served.issuer).toBe(served.subject);

		const trust = tls.webTlsTrust();
		expect(trust.roomCa).toBe(false);
		expect(trust.path).toBe(tls.WEB_TLS_CERT_FILE);
		expect(trust.fingerprint).toBe(served.fingerprint256.replace(/:/g, "").toLowerCase());
	});

	test("a root left behind by one the room replaced is not offered as trust", () => {
		emptyRoom();
		tls.ensureTls();
		const stale = readFileSync(tls.WEB_TLS_CA_FILE, "utf8");

		// The desk loses its root and falls back to self-signing, but the file it
		// once told operators to install is still on disk. Handing that over would
		// be an install that verifies nothing at all.
		emptyRoom();
		plantCa("not the room's certificate authority");
		tls.ensureTls();
		writeFileSync(tls.WEB_TLS_CA_FILE, stale, "utf8");

		const trust = tls.webTlsTrust();
		expect(trust.roomCa).toBe(false);
		expect(trust.path).toBe(tls.WEB_TLS_CERT_FILE);
	});

	test("enrollment hands over the root, in the fingerprint dialect the room speaks", async () => {
		emptyRoom();
		tls.ensureTls();

		const trust = tls.webTlsTrust();
		const { certFingerprint } = await import("../node/tls");

		expect(trust.roomCa).toBe(true);
		expect(trust.path).toBe(tls.WEB_TLS_CA_FILE);
		// The same lowercase, separator-free hex the node plane pins in: two
		// spellings of one hash is a comparison that quietly never matches.
		expect(trust.fingerprint).toBe(certFingerprint(readFileSync(tls.WEB_TLS_CA_FILE, "utf8")));
		expect(trust.fingerprint).toMatch(/^[a-f0-9]{64}$/);
	});

	test("a mint that cannot be sealed to the room leaves no root behind", async () => {
		emptyRoom();
		const membership = await import("../node/membership");
		// A desk admitted with a key that will not take a box. Sealing throws, and
		// it throws *after* the record is published — which is the whole hazard: a
		// row with no boxes in it that this desk can still open from its own vault
		// would win every later election and lock the room out of its own root.
		membership.admitNode(
			{
				id: "unsealable-desk",
				name: "unsealable",
				publicKey: "-----BEGIN PUBLIC KEY-----\nnot a key at all\n-----END PUBLIC KEY-----\n",
				fingerprint: "a".repeat(64),
				protocol: 1,
				capabilities: ["executor"],
			},
			"http://198.51.100.9:4180",
		);

		try {
			const material = tls.ensureTls();

			// The mint is one op or none: no LIVE root, revoked or otherwise, that
			// this desk could later open from its own vault and elect. A revoked
			// row may survive the rollback when a withdrawal is still owed to a
			// desk another test file admitted — that is the credential store
			// working as designed, and it is not a root the room would choose.
			expect(liveCaRecords()).toHaveLength(0);
			// And the desk still has a door — the honest fallback, honestly labelled.
			expect(material).not.toBeNull();
			const served = new X509Certificate(material?.cert ?? "");
			expect(served.issuer).toBe(served.subject);
			expect(tls.webTlsTrust().roomCa).toBe(false);
		} finally {
			membership.forgetAdmittedNode("unsealable-desk");
		}

		// Nothing is stuck: once the room can be sealed to again, the next start
		// mints a real root rather than adopting the half-made one.
		rmSync(META_FILE, { force: true });
		tls.ensureTls();
		const rows = liveCaRecords();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.replicate).toBe(true);
		expect(tls.webTlsTrust().roomCa).toBe(true);
	});
});
