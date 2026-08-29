import {
	chmodSync,
	existsSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import {
	createHash,
	createPrivateKey,
	createPublicKey,
	generateKeyPairSync,
	sign,
	verify,
} from "node:crypto";
import { hostname, platform } from "node:os";
import { join } from "node:path";
import type { NodeIdentity } from "../../shared/types";
import { ROOT, ensureLayout } from "../paths";
import { instanceIdentity } from "../web/devices";

type StoredIdentity = {
	version: 1;
	id: string;
	privateKey: string;
	publicKey: string;
	createdAt: number;
};

const FILE = join(ROOT, "node.json");
const CAPABILITIES: NodeIdentity["capabilities"] = ["admin", "executor", "store", "gateway"];

let held: StoredIdentity | null = null;

function createIdentity(): StoredIdentity {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const stored: StoredIdentity = {
		version: 1,
		// Preserve the install id already carried by fleet and phone links. The
		// key makes it a node identity without duplicating this desktop in rooms
		// that predate the control plane.
		id: instanceIdentity().instanceId,
		privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
		publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
		createdAt: Date.now(),
	};
	ensureLayout();
	writeFileSync(FILE, `${JSON.stringify(stored, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	if (platform() !== "win32") chmodSync(FILE, 0o600);
	return stored;
}

function storedIdentity(): StoredIdentity {
	if (held) return held;
	try {
		if (existsSync(FILE)) {
			const parsed = JSON.parse(readFileSync(FILE, "utf8")) as Partial<StoredIdentity>;
			if (
				parsed.version === 1 &&
				typeof parsed.id === "string" &&
				typeof parsed.privateKey === "string" &&
				typeof parsed.publicKey === "string"
			) {
				held = parsed as StoredIdentity;
				return held;
			}
		}
	} catch {
		// An unreadable identity cannot safely be guessed back into existence.
		throw new Error(`Toad could not read its node identity at ${FILE}`);
	}
	held = createIdentity();
	return held;
}

function fingerprint(publicKey: string): string {
	const der = createPublicKey(publicKey).export({ type: "spki", format: "der" });
	return createHash("sha256").update(der).digest("hex");
}

export function nodeIdentity(): NodeIdentity {
	const stored = storedIdentity();
	return {
		id: stored.id,
		/* Verify harnesses run several nodes on one machine, and desk names are
		 * the interface teammates address desks by — so a harness child needs a
		 * name of its own, the way TOAD_CAPS_BUILTIN_STUB gives it a reach of
		 * its own. Not user-facing. */
		name: process.env.TOAD_NODE_NAME?.slice(0, 80) || hostname(),
		publicKey: stored.publicKey,
		fingerprint: fingerprint(stored.publicKey),
		protocol: 1,
		capabilities: [...CAPABILITIES],
	};
}

/**
 * This desk's Ed25519 private key, in PEM.
 *
 * The only export that hands private material out, and it exists so a
 * replicated credential can be sealed to a desk using the identity the plane
 * already admits and pins, rather than minting a second keypair and inventing a
 * second thing to distribute and rotate. Its one caller is `node/seal.ts`,
 * which derives an X25519 agreement key from it and never lets the signing key
 * itself out again.
 */
export function nodeIdentityPrivateKey(): string {
	return storedIdentity().privateKey;
}

function bytes(kind: string, payload: unknown): Buffer {
	return Buffer.from(`toad-node:${kind}:v1\n${JSON.stringify(payload)}`);
}

export function signNodePayload(kind: string, payload: unknown): string {
	const stored = storedIdentity();
	return sign(null, bytes(kind, payload), createPrivateKey(stored.privateKey)).toString("base64url");
}

export function verifyNodePayload(
	identity: NodeIdentity,
	kind: string,
	payload: unknown,
	signature: string,
): boolean {
	try {
		if (fingerprint(identity.publicKey) !== identity.fingerprint) return false;
		return verify(
			null,
			bytes(kind, payload),
			createPublicKey(identity.publicKey),
			Buffer.from(signature, "base64url"),
		);
	} catch {
		return false;
	}
}

export function isNodeIdentity(value: unknown): value is NodeIdentity {
	const node = value as Partial<NodeIdentity> | null;
	const capabilities = new Set(["admin", "executor", "store", "gateway", "endpoint", "observer"]);
	return Boolean(
		node &&
			typeof node.id === "string" &&
			node.id.length > 0 &&
			node.id.length <= 128 &&
			typeof node.name === "string" &&
			node.name.length > 0 &&
			node.name.length <= 80 &&
			typeof node.publicKey === "string" &&
			node.publicKey.length <= 4_096 &&
			typeof node.fingerprint === "string" &&
			/^[a-f0-9]{64}$/.test(node.fingerprint) &&
			node.protocol === 1 &&
			Array.isArray(node.capabilities) &&
			node.capabilities.length > 0 &&
			node.capabilities.every((capability) => capabilities.has(capability)),
	);
}
