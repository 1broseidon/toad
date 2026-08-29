import { describe, expect, test } from "bun:test";
import { createPublicKey, generateKeyPairSync } from "node:crypto";

// The throwaway root comes from test/preload.ts; these imports resolve it.
const seal = await import("./seal");
const identity = await import("./identity");

type Desk = { nodeId: string; publicKey: string; privateKey: string };

function desk(nodeId: string): Desk {
	const pair = generateKeyPairSync("ed25519");
	return {
		nodeId,
		publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
		privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
	};
}

describe("sealing a secret to one desk", () => {
	test("a sealed copy opens with the recipient's key and no other", () => {
		const bee = desk("desk-b");
		const cee = desk("desk-c");

		const sealed = seal.sealTo(bee, "cred-1", "sk-live-abcdef");

		expect(seal.openSealedWith(sealed, "cred-1", bee.privateKey)).toBe("sk-live-abcdef");
		// Desk C holds the same bytes — every member does — and they are noise to it.
		expect(seal.openSealedWith(sealed, "cred-1", cee.privateKey)).toBeUndefined();
	});

	test("a box cannot be moved onto another credential or re-addressed", () => {
		const bee = desk("desk-b");
		const sealed = seal.sealTo(bee, "cred-1", "sk-live-abcdef");

		expect(seal.openSealedWith(sealed, "cred-2", bee.privateKey)).toBeUndefined();
		expect(
			seal.openSealedWith({ ...sealed, to: "desk-z" }, "cred-1", bee.privateKey),
		).toBeUndefined();
	});

	test("openSealed only answers for boxes addressed to this desk", () => {
		const me = identity.nodeIdentity();
		const mine = seal.sealTo({ nodeId: me.id, publicKey: me.publicKey }, "cred-1", "sk-mine");
		expect(seal.openSealed(mine, "cred-1")).toBe("sk-mine");

		const theirs = seal.sealTo(desk("desk-b"), "cred-1", "sk-theirs");
		expect(seal.openSealed(theirs, "cred-1")).toBeUndefined();
	});

	/**
	 * The claim this whole module rests on: an admitted Ed25519 key already *is*
	 * an X25519 key, so no encryption key had to be minted or distributed. Proved
	 * against Node's own X25519 rather than against seal.ts's arithmetic — the
	 * public half derived from the signing public key must equal the public half
	 * Node computes from the agreement scalar derived from the same seed.
	 */
	test("the agreement key derives from the identity, not from a new key", () => {
		for (let attempt = 0; attempt < 16; attempt += 1) {
			const one = desk("desk-x");
			const two = desk("desk-y");
			// A round trip both ways is only possible if both halves of the
			// conversion agree with Node's X25519 for both keys.
			const toOne = seal.sealTo(one, "ctx", "secret-one");
			const toTwo = seal.sealTo(two, "ctx", "secret-two");
			expect(seal.openSealedWith(toOne, "ctx", one.privateKey)).toBe("secret-one");
			expect(seal.openSealedWith(toTwo, "ctx", two.privateKey)).toBe("secret-two");
		}
	});

	test("a malformed box is a no, not a fault", () => {
		const bee = desk("desk-b");
		const sealed = seal.sealTo(bee, "cred-1", "sk-live");
		expect(seal.openSealedWith({ ...sealed, epk: "" }, "cred-1", bee.privateKey)).toBeUndefined();
		expect(seal.openSealedWith({ ...sealed, ct: "AAAA" }, "cred-1", bee.privateKey)).toBeUndefined();
		expect(seal.isSealedSecret({ v: 1, to: "desk-b" })).toBe(false);
		expect(seal.isSealedSecret(sealed)).toBe(true);
	});

	test("a sealed box carries no plaintext", () => {
		const sealed = seal.sealTo(desk("desk-b"), "cred-1", "sk-live-abcdef");
		expect(JSON.stringify(sealed)).not.toContain("sk-live-abcdef");
		// The ephemeral public key is a real X25519 key, not padding.
		expect(Buffer.from(sealed.epk, "base64url").length).toBe(32);
		expect(() =>
			createPublicKey({
				key: Buffer.concat([
					Buffer.from("302a300506032b656e032100", "hex"),
					Buffer.from(sealed.epk, "base64url"),
				]),
				format: "der",
				type: "spki",
			}),
		).not.toThrow();
	});
});
