import { X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../paths";

/**
 * The node plane's own certificate, and the pins it holds for its peers.
 *
 * Confidentiality, not chain trust. The frames on a NodeLink are already
 * HMAC-signed end to end and every pairing payload carries an Ed25519 proof,
 * so TLS here adds exactly one thing: nobody on the LAN gets to read a desk's
 * traffic. Which is why there is no CA, no expiry dance, and no name to buy —
 * a self-signed key per desk, and the fingerprint travels inside the signed
 * admission so the dialer knows the one certificate it will accept.
 *
 * Generated the way `src/bun/web/tls.ts` already does it: openssl, the tool
 * every dev box and homelab has, writing a P-256 key next to its certificate.
 *
 * ## Why a fixed SAN name instead of the LAN IP
 *
 * Bun (1.3.14) enforces subjectAltName on the client side, and it does NOT
 * call `checkServerIdentity` — see the note below. A cert whose only SAN is
 * today's DHCP lease therefore stops verifying the morning the lease moves,
 * which would rotate every pin in the fleet for a reason that has nothing to
 * do with security. So the cert carries a constant, deliberately
 * unresolvable name (`node.toad.invalid`) alongside the loopback and LAN
 * addresses, and dialers pass that name as `servername`. Identity is the
 * pinned key; the hostname check is satisfied by a name that means "this is a
 * Toad node" and nothing else. The address may move freely underneath it.
 *
 * ## What Bun actually supports (measured on 1.3.14, not assumed)
 *
 * - `Bun.serve({ tls: { key, cert } })` — works.
 * - `fetch(url, { tls: { ca, servername } })` and
 *   `new WebSocket(url, { tls: { ca, servername } })` — both accept the peer's
 *   own self-signed certificate as the trust root, and both REFUSE a
 *   different self-signed certificate. That is per-connection pinning, and it
 *   is what this module hands every dialer.
 * - `tls.checkServerIdentity` is accepted in the options bag and then
 *   ignored: it is never invoked, and a callback returning an Error does not
 *   fail the connection. Anything built on it would have been a silent hole,
 *   so nothing here uses it.
 * - There is no per-connection way to read the presented certificate back out
 *   of `fetch` or `WebSocket`. Learning an unknown peer's certificate is
 *   therefore a `node:tls` handshake of its own — see `learnPeerCertificate`.
 *
 * Never `NODE_TLS_REJECT_UNAUTHORIZED`. A process-global disable would turn
 * every unrelated outbound request in the app into an unauthenticated one.
 */

const TLS_DIR = join(ROOT, "node-tls");
const KEY_FILE = join(TLS_DIR, "key.pem");
const CERT_FILE = join(TLS_DIR, "cert.pem");
const PINS_DIR = join(TLS_DIR, "peers");

const VALID_DAYS = 3650;

/** The name every Toad node's certificate answers to. Never resolvable. */
export const NODE_TLS_SERVERNAME = "node.toad.invalid";

export type NodeTlsMaterial = { key: string; cert: string; fingerprint: string };

/** What a dialer needs to reach one pinned peer: its exact certificate. */
export type NodeTlsPin = { fingerprint: string; cert: string };

let held: NodeTlsMaterial | null = null;

/** TLS is on unless a desk is deliberately kept plain (migration, no openssl). */
function enabled(): boolean {
	return process.env.TOAD_NODE_TLS !== "0";
}

/**
 * The SHA-256 fingerprint of a certificate, lowercase hex, no separators.
 *
 * Node prints `AA:BB:…`; a wire format with punctuation in it invites two
 * spellings of the same pin and a comparison that quietly never matches.
 */
export function certFingerprint(pem: string): string {
	return new X509Certificate(pem).fingerprint256.replace(/:/g, "").toLowerCase();
}

export function isCertFingerprint(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function generate(): boolean {
	mkdirSync(TLS_DIR, { recursive: true });
	/* Loopback and the wildcard are listed so a dialer that has no better
	 * address than 127.0.0.1 still verifies; the constant name is what the
	 * fleet actually uses. */
	const san = [`DNS:${NODE_TLS_SERVERNAME}`, "DNS:localhost", "IP:127.0.0.1", "IP:::1"].join(",");
	const result = Bun.spawnSync(
		[
			"openssl", "req", "-x509", "-newkey", "ec",
			"-pkeyopt", "ec_paramgen_curve:prime256v1",
			"-keyout", KEY_FILE, "-out", CERT_FILE,
			"-days", String(VALID_DAYS), "-nodes",
			"-subj", "/CN=Toad node",
			"-addext", `subjectAltName=${san}`,
		],
		{ stdout: "ignore", stderr: "pipe" },
	);
	return result.exitCode === 0;
}

function load(): NodeTlsMaterial | null {
	try {
		const key = readFileSync(KEY_FILE, "utf8");
		const cert = readFileSync(CERT_FILE, "utf8");
		return { key, cert, fingerprint: certFingerprint(cert) };
	} catch {
		return null;
	}
}

/**
 * This desk's TLS material, or null when it has none — a desk with no
 * openssl, or one deliberately kept plain, still runs the node plane over
 * http and still verifies the pins of peers that do have certificates.
 */
export function ensureNodeTls(): NodeTlsMaterial | null {
	if (!enabled()) return null;
	if (held) return held;
	if (!existsSync(KEY_FILE) || !existsSync(CERT_FILE)) {
		if (!generate()) return null;
	}
	held = load();
	return held;
}

/** The pin this desk asks its peers to remember, or null when it is plain. */
export function localCertFingerprint(): string | null {
	return ensureNodeTls()?.fingerprint ?? null;
}

export function localCertPem(): string | null {
	return ensureNodeTls()?.cert ?? null;
}

/**
 * Replaces this desk's key and certificate with a fresh pair.
 *
 * The new fingerprint is announced over every authenticated link, so peers
 * re-pin without a human retyping anything — see `announceCertRotation` in
 * src/bun/fleet/wire.ts. Callers must announce AFTER rotating, because a link
 * that drops mid-rotation reconnects against the new certificate.
 */
export function rotateNodeCert(): NodeTlsMaterial | null {
	if (!enabled()) return null;
	held = null;
	if (!generate()) {
		held = load();
		return held;
	}
	held = load();
	return held;
}

/* ------------------------------------------------------------------ pins */

function pinFile(nodeId: string): string {
	/* A node id is an install uuid, but it arrives over the wire, and a wire
	 * value must never be able to name a path outside its own directory. */
	return join(PINS_DIR, `${nodeId.replace(/[^A-Za-z0-9._-]/g, "_")}.pem`);
}

/**
 * Remembers the certificate a peer's signed admission pinned.
 *
 * The fingerprint is the authority — it is covered by the admitter's Ed25519
 * signature. The PEM is only the material needed to hand Bun a trust root, so
 * it is accepted only when it hashes to the pin it claims.
 */
export function storePeerCert(nodeId: string, fingerprint: string, pem: string): boolean {
	if (!isCertFingerprint(fingerprint)) return false;
	let actual: string;
	try {
		actual = certFingerprint(pem);
	} catch {
		return false;
	}
	if (actual !== fingerprint) return false;
	mkdirSync(PINS_DIR, { recursive: true });
	writeFileSync(pinFile(nodeId), pem, "utf8");
	return true;
}

export function forgetPeerCert(nodeId: string): void {
	rmSync(pinFile(nodeId), { force: true });
}

/**
 * The pin for one peer, or null when there is none to enforce.
 *
 * A stored certificate that no longer matches the fingerprint the caller
 * holds is not a pin, it is drift — the caller must refuse the connection
 * rather than fall back to something weaker.
 */
export function peerCertPin(nodeId: string, fingerprint: string | undefined): NodeTlsPin | null {
	if (!isCertFingerprint(fingerprint)) return null;
	let pem: string;
	try {
		pem = readFileSync(pinFile(nodeId), "utf8");
	} catch {
		return null;
	}
	try {
		if (certFingerprint(pem) !== fingerprint) return null;
	} catch {
		return null;
	}
	return { fingerprint, cert: pem };
}

/**
 * The `tls` options bag for one pinned peer, shaped for both `fetch` and
 * `WebSocket`. The certificate is its own root; the constant servername
 * satisfies Bun's hostname check without binding trust to an address.
 */
export function pinnedTlsOptions(pin: NodeTlsPin): { ca: string; servername: string } {
	return { ca: pin.cert, servername: NODE_TLS_SERVERNAME };
}
