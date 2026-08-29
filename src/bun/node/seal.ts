import {
	createCipheriv,
	createDecipheriv,
	createPrivateKey,
	createPublicKey,
	createHash,
	diffieHellman,
	hkdfSync,
	randomBytes,
	type KeyObject,
} from "node:crypto";
import { nodeIdentity, nodeIdentityPrivateKey } from "./identity";

/**
 * Sealing a secret to one desk, using the identity the plane already has.
 *
 * A replicated credential travels as an ordinary record, so its ciphertext ends
 * up on every member's disk. Sealing it once under a shared passphrase would
 * mean desk B's copy is readable by desk C, by a backup, and by anything that
 * ever synced that folder. So each recipient gets its own box: an ephemeral
 * X25519 agreement against *that desk's* key, and nobody else's key opens it.
 *
 * The recipient key is not a new key. Ed25519 and X25519 are the same curve
 * wearing two coordinate systems, and the birational map between them is
 * standard: a desk's admitted, signed, pinned Ed25519 public key is therefore
 * already an X25519 public key, and no admission field, no key distribution,
 * and no rotation story had to be invented to get one. `seal.test.ts` proves
 * the conversion against Node's own X25519 rather than against this file's
 * arithmetic.
 *
 * The limit, plainly: a process that can use a key can read it. This protects
 * backups, cloud-synced folders, other users on the box, and a stolen disk. It
 * does not protect against someone holding your login on the machine that holds
 * the key.
 */

export type SealedSecret = {
	/** Format version. 1 means X25519 → HKDF-SHA256 → AES-256-GCM, exactly. */
	v: 1;
	/** The recipient desk's node id. The only desk whose key opens this box. */
	to: string;
	/** The sender's ephemeral X25519 public key, base64url raw. */
	epk: string;
	/** GCM nonce, base64url. */
	iv: string;
	/** Ciphertext, base64url. */
	ct: string;
	/** GCM tag, base64url. */
	tag: string;
};

/** 2^255 - 19: the field both curves are defined over. */
const P = (1n << 255n) - 19n;

/** DER preambles for a raw X25519 key, so Node will hold one as a KeyObject. */
const X25519_PKCS8 = Buffer.from("302e020100300506032b656e04220420", "hex");
const X25519_SPKI = Buffer.from("302a300506032b656e032100", "hex");

function modInverse(value: bigint): bigint {
	let [previousRemainder, remainder] = [((value % P) + P) % P, P];
	let [previousCoefficient, coefficient] = [1n, 0n];
	while (remainder !== 0n) {
		const quotient = previousRemainder / remainder;
		[previousRemainder, remainder] = [remainder, previousRemainder - quotient * remainder];
		[previousCoefficient, coefficient] = [
			coefficient,
			previousCoefficient - quotient * coefficient,
		];
	}
	return ((previousCoefficient % P) + P) % P;
}

function littleEndianToBigInt(bytes: Uint8Array): bigint {
	let value = 0n;
	for (let index = bytes.length - 1; index >= 0; index -= 1) {
		value = (value << 8n) | BigInt(bytes[index] ?? 0);
	}
	return value;
}

function bigIntToLittleEndian(value: bigint, length: number): Buffer {
	const out = Buffer.alloc(length);
	let rest = value;
	for (let index = 0; index < length; index += 1) {
		out[index] = Number(rest & 0xffn);
		rest >>= 8n;
	}
	return out;
}

/** The trailing 32 bytes of an Ed25519 SPKI DER are the raw public point. */
function rawEd25519PublicKey(pem: string): Buffer {
	const der = createPublicKey(pem).export({ type: "spki", format: "der" }) as Buffer;
	return Buffer.from(der.subarray(der.length - 32));
}

/** The trailing 32 bytes of an Ed25519 PKCS8 DER are the seed. */
function rawEd25519Seed(pem: string): Buffer {
	const der = createPrivateKey(pem).export({ type: "pkcs8", format: "der" }) as Buffer;
	return Buffer.from(der.subarray(der.length - 32));
}

/**
 * The Montgomery u of an Edwards point: u = (1 + y) / (1 - y).
 *
 * The sign bit of the Edwards encoding names x, which the map discards — which
 * is exactly why an X25519 public key is 32 bytes with nothing left over.
 */
function agreementPublicKey(ed25519PublicKeyPem: string): KeyObject {
	const y = littleEndianToBigInt(rawEd25519PublicKey(ed25519PublicKeyPem)) & ((1n << 255n) - 1n);
	const denominator = ((1n - y) % P + P) % P;
	if (denominator === 0n) throw new Error("this node key has no X25519 form");
	const u = ((1n + y) * modInverse(denominator)) % P;
	return createPublicKey({
		key: Buffer.concat([X25519_SPKI, bigIntToLittleEndian(u, 32)]),
		format: "der",
		type: "spki",
	});
}

/**
 * The X25519 scalar behind an Ed25519 seed: SHA-512 of the seed, clamped.
 *
 * This is the same scalar Ed25519 multiplies its basepoint by, so the agreement
 * key and the signing key describe one point in two coordinate systems — that
 * is what makes the public half derivable by anyone holding the admission.
 */
function agreementPrivateKey(ed25519PrivateKeyPem: string): KeyObject {
	const digest = createHash("sha512").update(rawEd25519Seed(ed25519PrivateKeyPem)).digest();
	const scalar = Buffer.from(digest.subarray(0, 32));
	scalar[0] = (scalar[0] ?? 0) & 248;
	scalar[31] = ((scalar[31] ?? 0) & 127) | 64;
	return createPrivateKey({
		key: Buffer.concat([X25519_PKCS8, scalar]),
		format: "der",
		type: "pkcs8",
	});
}

/**
 * The one shape both ends derive their key from.
 *
 * `to` and `context` ride in the AEAD's additional data rather than in the
 * plaintext, so a box cannot be moved onto another credential's record or
 * re-addressed to another desk without failing to open at all.
 */
function aad(to: string, context: string): Buffer {
	return Buffer.from(`toad-seal:v1\n${to}\n${context}`);
}

function contentKey(shared: Buffer, epk: Buffer, recipient: Buffer): Buffer {
	return Buffer.from(
		hkdfSync("sha256", shared, Buffer.concat([epk, recipient]), "toad-credential-seal:v1", 32),
	);
}

function rawOf(key: KeyObject): Buffer {
	const der = key.export({ type: "spki", format: "der" }) as Buffer;
	return Buffer.from(der.subarray(der.length - 32));
}

/**
 * Seals a secret so that only `recipient`'s desk can open it.
 *
 * `publicKey` is the recipient's Ed25519 identity key as the admission carries
 * it — this desk's own word about who that node is, re-verified from its own
 * file. Sealing to a key learned any other way would be sealing to whoever
 * answered.
 */
export function sealTo(
	recipient: { nodeId: string; publicKey: string },
	context: string,
	secret: string,
): SealedSecret {
	const recipientKey = agreementPublicKey(recipient.publicKey);
	// The ephemeral pair exists for this one box: forward secrecy is not the
	// point (the recipient key is long-lived), but a fresh sender key means two
	// seals of the same secret to the same desk share no key material.
	const ephemeralSeed = randomBytes(32);
	ephemeralSeed[0] = (ephemeralSeed[0] ?? 0) & 248;
	ephemeralSeed[31] = ((ephemeralSeed[31] ?? 0) & 127) | 64;
	const ephemeralPrivate = createPrivateKey({
		key: Buffer.concat([X25519_PKCS8, ephemeralSeed]),
		format: "der",
		type: "pkcs8",
	});
	const ephemeralPublic = createPublicKey(ephemeralPrivate);

	const shared = diffieHellman({ privateKey: ephemeralPrivate, publicKey: recipientKey });
	const key = contentKey(shared, rawOf(ephemeralPublic), rawOf(recipientKey));
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	cipher.setAAD(aad(recipient.nodeId, context));
	const ct = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);

	return {
		v: 1,
		to: recipient.nodeId,
		epk: rawOf(ephemeralPublic).toString("base64url"),
		iv: iv.toString("base64url"),
		ct: ct.toString("base64url"),
		tag: cipher.getAuthTag().toString("base64url"),
	};
}

/**
 * Opens a box with an explicit Ed25519 private key.
 *
 * Undefined rather than a throw for every failure — a wrong key, a box meant
 * for another desk, a truncated field. A desk holding the whole room's
 * ciphertext asks this of copies it cannot open as a matter of course, and that
 * is a "no", not a fault.
 */
export function openSealedWith(
	sealed: SealedSecret,
	context: string,
	ed25519PrivateKeyPem: string,
): string | undefined {
	try {
		const privateKey = agreementPrivateKey(ed25519PrivateKeyPem);
		const epk = Buffer.from(sealed.epk, "base64url");
		if (epk.length !== 32) return undefined;
		const shared = diffieHellman({
			privateKey,
			publicKey: createPublicKey({
				key: Buffer.concat([X25519_SPKI, epk]),
				format: "der",
				type: "spki",
			}),
		});
		const key = contentKey(shared, epk, rawOf(createPublicKey(privateKey)));
		const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64url"));
		decipher.setAAD(aad(sealed.to, context));
		decipher.setAuthTag(Buffer.from(sealed.tag, "base64url"));
		return Buffer.concat([
			decipher.update(Buffer.from(sealed.ct, "base64url")),
			decipher.final(),
		]).toString("utf8");
	} catch {
		return undefined;
	}
}

/** Opens a box addressed to this desk. Undefined for anyone else's copy. */
export function openSealed(sealed: SealedSecret, context: string): string | undefined {
	if (sealed.to !== nodeIdentity().id) return undefined;
	return openSealedWith(sealed, context, nodeIdentityPrivateKey());
}

/** Structural check for a value read back off a record. */
export function isSealedSecret(value: unknown): value is SealedSecret {
	const sealed = value as Partial<SealedSecret> | null;
	return Boolean(
		sealed &&
			typeof sealed === "object" &&
			sealed.v === 1 &&
			typeof sealed.to === "string" &&
			sealed.to.length > 0 &&
			typeof sealed.epk === "string" &&
			typeof sealed.iv === "string" &&
			typeof sealed.ct === "string" &&
			typeof sealed.tag === "string",
	);
}
