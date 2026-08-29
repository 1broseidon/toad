import { describe, expect, test } from "bun:test";
import { createHash, createPublicKey, generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { platform } from "node:os";
// Type-only, so it costs no module resolution before the preload's override.
import type { SealedSecret } from "../node/seal";

// The throwaway root comes from test/preload.ts. Setting TOAD_DATA_DIR here
// would be far too late: these imports resolve it.
const { CREDENTIAL_DIR, CREDENTIAL_VAULT_FILE } = await import("../paths");
const credentials = await import("./credentials");
const records = await import("./records");
const membership = await import("../node/membership");
const identity = await import("../node/identity");
const seal = await import("../node/seal");

type Desk = { nodeId: string; publicKey: string; privateKey: string };

/** A desk this room could admit: a real key pair, fingerprinted the way identity.ts does. */
function desk(nodeId: string): Desk {
	const pair = generateKeyPairSync("ed25519");
	const publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
	return {
		nodeId,
		publicKey,
		privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
	};
}

function admit(one: Desk): void {
	membership.admitNode(
		{
			id: one.nodeId,
			name: one.nodeId,
			publicKey: one.publicKey,
			fingerprint: createHash("sha256")
				.update(createPublicKey(one.publicKey).export({ type: "spki", format: "der" }))
				.digest("hex"),
			protocol: 1,
			capabilities: ["executor"],
		},
		"https://example.invalid",
	);
}

/** The replicated class exactly as it sits in the store, read back raw. */
function replicatedClass(id: string): Record<string, unknown> {
	const record = records.getRecord("credential", id);
	if (!record) throw new Error(`no credential record ${id}`);
	return record.replicated;
}

function seals(id: string): Record<string, SealedSecret> {
	return (replicatedClass(id).seals ?? {}) as Record<string, SealedSecret>;
}

function vaultText(): string {
	return existsSync(CREDENTIAL_VAULT_FILE) ? readFileSync(CREDENTIAL_VAULT_FILE, "utf8") : "";
}

describe("credential records", () => {
	test("a new credential is machine-local until somebody opts in", () => {
		const created = credentials.createCredential({
			providerId: "anthropic",
			kind: "api_key",
			secret: "sk-default-local",
		});

		expect(created.replicate).toBe(false);
		expect(created.sealedTo).toEqual([]);
		expect(created.ownerNode).toBe(records.localNodeId());
		expect(created.usableHere).toBe(true);
		expect(credentials.credentialSecret(created.id)).toBe("sk-default-local");
		// Nothing that travels carries the key.
		expect(JSON.stringify(replicatedClass(created.id))).not.toContain("sk-default-local");
	});

	test("an OAuth credential cannot be marked replicated", () => {
		const oauth = credentials.createCredential({
			providerId: "anthropic-oauth",
			kind: "oauth",
			label: "Claude subscription",
		});

		expect(() => credentials.setCredentialReplication(oauth.id, true)).toThrow(/OAuth/);
		// Refused, not half-applied: the record is exactly where it was.
		expect(credentials.getCredential(oauth.id)?.replicate).toBe(false);
		expect(seals(oauth.id)).toEqual({});
		// And its material never entered this store in the first place.
		expect(() =>
			credentials.createCredential({
				providerId: "anthropic-oauth",
				kind: "oauth",
				secret: "refresh-token",
			}),
		).toThrow(/not a secret to copy/);
	});

	test("an OAuth login is reachable here but serves no key", () => {
		const oauth = credentials.createCredential({
			providerId: "zed",
			kind: "oauth",
			label: "Zed login",
		});

		// The desk holding the login can reach the provider — that is what the
		// ladder asks — but the tokens belong to whatever rotates them.
		expect(credentials.getCredential(oauth.id)?.usableHere).toBe(true);
		expect(credentials.providerCredential("zed")?.id).toBe(oauth.id);
		expect(credentials.credentialSecret(oauth.id)).toBeUndefined();
		expect(credentials.providerCredentialSecret("zed")).toBeUndefined();

		// An API key for the same provider outranks it, and does serve a key.
		const key = credentials.createCredential({
			providerId: "zed",
			kind: "api_key",
			secret: "sk-zed-key",
		});
		expect(credentials.providerCredential("zed")?.id).toBe(key.id);
		expect(credentials.providerCredentialSecret("zed")).toBe("sk-zed-key");
	});

	test("an API key is sealed to each admitted desk and to nobody else", () => {
		const bee = desk("desk-b-seal");
		const cee = desk("desk-c-seal");
		admit(bee);
		admit(cee);

		const created = credentials.createCredential({
			providerId: "openai",
			kind: "api_key",
			secret: "sk-shared-key",
		});
		const shared = credentials.setCredentialReplication(created.id, true);

		expect(shared.replicate).toBe(true);
		expect(shared.sealedTo).toEqual([bee.nodeId, cee.nodeId].sort());
		// This desk owns it, so it is never sealed to itself.
		expect(shared.sealedTo).not.toContain(records.localNodeId());

		const forBee = seals(created.id)[bee.nodeId];
		expect(forBee).toBeDefined();
		expect(seal.openSealedWith(forBee!, created.id, bee.privateKey)).toBe("sk-shared-key");
		// Desk C holds desk B's box too — every member does — and it is ciphertext there.
		expect(seal.openSealedWith(forBee!, created.id, cee.privateKey)).toBeUndefined();
		// Two desks, two different boxes: there is no shared-passphrase blob.
		expect(seals(created.id)[cee.nodeId]?.ct).not.toBe(forBee?.ct);
		expect(JSON.stringify(replicatedClass(created.id))).not.toContain("sk-shared-key");
	});

	test("opting out deletes the copies rather than merely stopping the sync", () => {
		const bee = desk("desk-b-teardown");
		admit(bee);

		const created = credentials.createCredential({
			providerId: "groq",
			kind: "api_key",
			secret: "sk-torn-down",
		});
		credentials.setCredentialReplication(created.id, true);
		expect(seals(created.id)[bee.nodeId]).toBeDefined();

		const local = credentials.setCredentialReplication(created.id, false);

		expect(local.replicate).toBe(false);
		expect(local.sealedTo).toEqual([]);
		// The teardown is the op: what travels is a record with no material in it.
		expect(seals(created.id)).toEqual({});
		expect(JSON.stringify(replicatedClass(created.id))).not.toContain("sk-torn-down");
		// The owner keeps working; only the copies went.
		expect(credentials.credentialSecret(created.id)).toBe("sk-torn-down");
	});

	test("a revoked credential is dropped everywhere, owner included", () => {
		const bee = desk("desk-b-revoke");
		admit(bee);

		const created = credentials.createCredential({
			providerId: "mistral",
			kind: "api_key",
			secret: "sk-revoked-key",
		});
		credentials.setCredentialReplication(created.id, true);
		expect(vaultText()).toContain("sk-revoked-key");

		const revoked = credentials.revokeCredential(created.id);

		expect(revoked.revoked).toBe(true);
		expect(revoked.replicate).toBe(false);
		expect(revoked.sealedTo).toEqual([]);
		expect(revoked.usableHere).toBe(false);
		expect(credentials.credentialSecret(created.id)).toBeUndefined();
		expect(credentials.providerCredential("mistral")).toBeUndefined();
		// The owner's own plaintext dies too: revocation does not wait for opt-out.
		expect(vaultText()).not.toContain("sk-revoked-key");
		expect(() => credentials.setCredentialReplication(created.id, true)).toThrow(/revoked/);
	});

	test("a desk admitted after the opt-in gets a box only when re-sealed", () => {
		const early = desk("desk-early-reseal");
		admit(early);
		const created = credentials.createCredential({
			providerId: "voyage",
			kind: "api_key",
			secret: "sk-resealed",
		});
		credentials.setCredentialReplication(created.id, true);

		const late = desk("desk-late-reseal");
		admit(late);
		// Admission alone does not hand out a key; something has to seal one.
		expect(credentials.getCredential(created.id)?.sealedTo).not.toContain(late.nodeId);

		expect(credentials.resealCredentials()).toContain(created.id);
		const box = seals(created.id)[late.nodeId];
		expect(box).toBeDefined();
		expect(seal.openSealedWith(box!, created.id, late.privateKey)).toBe("sk-resealed");
		// An unchanged room re-seals nothing: a fresh box every call would be
		// version churn the whole room has to store.
		expect(credentials.resealCredentials()).not.toContain(created.id);
	});

	test("deleting strips the material before the tombstone that outlives it", () => {
		const bee = desk("desk-b-delete");
		admit(bee);
		const created = credentials.createCredential({
			providerId: "deepseek",
			kind: "api_key",
			secret: "sk-deleted-key",
		});
		credentials.setCredentialReplication(created.id, true);

		credentials.deleteCredential(created.id);

		expect(credentials.getCredential(created.id)).toBeUndefined();
		// A tombstone keeps the last replicated JSON, so that JSON must be empty
		// of boxes or the delete deleted nothing.
		expect(records.getRecord("credential", created.id)?.deleted).toBe(true);
		expect(seals(created.id)).toEqual({});
		expect(vaultText()).not.toContain("sk-deleted-key");
	});
});

describe("a desk that is not the owner", () => {
	/** An op as the owning desk would ship it, sealed to this desk. */
	function remoteCredential(
		id: string,
		owner: Desk,
		version: number,
		payload: Record<string, unknown>,
	) {
		return {
			kind: "credential" as const,
			id,
			ownerNode: owner.nodeId,
			ownerEpoch: 1,
			version,
			op: "put" as const,
			payload,
			at: Date.now(),
		};
	}

	test("opens its own sealed copy, loses it when the owner tears down", () => {
		const owner = desk("desk-owner-remote");
		admit(owner);
		const me = identity.nodeIdentity();
		const id = "remote-credential-1";
		const sealed = seal.sealTo({ nodeId: me.id, publicKey: me.publicKey }, id, "sk-from-owner");
		const base = {
			providerId: "cohere",
			label: "Cohere",
			kind: "api_key",
			replicate: true,
			revoked: false,
			createdAt: Date.now(),
		};

		expect(
			records.applyRemoteOps([
				remoteCredential(id, owner, 1, { ...base, seals: { [me.id]: sealed } }),
			]).applied,
		).toBe(true);

		const view = credentials.getCredential(id);
		expect(view?.ownerNode).toBe(owner.nodeId);
		expect(view?.usableHere).toBe(true);
		expect(credentials.credentialSecret(id)).toBe("sk-from-owner");
		expect(credentials.providerCredentialSecret("cohere")).toBe("sk-from-owner");

		// The owner opts out. The instruction and the deletion are one op.
		expect(
			records.applyRemoteOps([
				remoteCredential(id, owner, 2, { ...base, replicate: false, seals: {} }),
			]).applied,
		).toBe(true);

		expect(credentials.credentialSecret(id)).toBeUndefined();
		expect(credentials.getCredential(id)?.usableHere).toBe(false);
		expect(credentials.providerCredentialSecret("cohere")).toBeUndefined();
	});

	test("stops using a credential the moment revocation arrives", () => {
		const owner = desk("desk-owner-revoked");
		admit(owner);
		const me = identity.nodeIdentity();
		const id = "remote-credential-2";
		const sealed = seal.sealTo({ nodeId: me.id, publicKey: me.publicKey }, id, "sk-doomed");
		const base = {
			providerId: "fireworks",
			label: "Fireworks",
			kind: "api_key",
			replicate: true,
			revoked: false,
			createdAt: Date.now(),
		};
		records.applyRemoteOps([remoteCredential(id, owner, 1, { ...base, seals: { [me.id]: sealed } })]);
		expect(credentials.credentialSecret(id)).toBe("sk-doomed");

		// Revocation is a fact, and it is refused even where the ciphertext is
		// somehow still in front of us.
		records.applyRemoteOps([
			remoteCredential(id, owner, 2, { ...base, revoked: true, seals: { [me.id]: sealed } }),
		]);

		expect(credentials.credentialSecret(id)).toBeUndefined();
		expect(credentials.getCredential(id)?.revoked).toBe(true);
	});

	test("refuses to write a record another desk owns", () => {
		const owner = desk("desk-owner-guard");
		const id = "remote-credential-3";
		records.applyRemoteOps([
			remoteCredential(id, owner, 1, {
				providerId: "xai",
				label: "xAI",
				kind: "api_key",
				replicate: false,
				revoked: false,
				createdAt: Date.now(),
				seals: {},
			}),
		]);

		expect(() => credentials.setCredentialReplication(id, true)).toThrow(/owned by desk/);
		expect(() => credentials.revokeCredential(id)).toThrow(/owned by desk/);
		expect(() => credentials.deleteCredential(id)).toThrow(/owned by desk/);
	});
});

describe("the vault on disk", () => {
	test("is an owner-only file inside an owner-only directory", () => {
		credentials.createCredential({
			providerId: "together",
			kind: "api_key",
			secret: "sk-mode-check",
		});

		expect(existsSync(CREDENTIAL_VAULT_FILE)).toBe(true);
		if (platform() !== "win32") {
			expect(statSync(CREDENTIAL_DIR).mode & 0o777).toBe(0o700);
			expect(statSync(CREDENTIAL_VAULT_FILE).mode & 0o777).toBe(0o600);
		}
	});

	test("keeps only what a live record this desk owns justifies", () => {
		const created = credentials.createCredential({
			providerId: "perplexity",
			kind: "api_key",
			secret: "sk-orphan-check",
		});
		expect(credentials.reconcileCredentialMaterial()).toEqual([]);

		// The record goes away behind the vault's back — a tombstone applied from
		// a peer, or a store restored from an older snapshot.
		records.tombstoneLocal("credential", created.id);

		expect(credentials.reconcileCredentialMaterial()).toEqual([created.id]);
		expect(vaultText()).not.toContain("sk-orphan-check");
		expect(credentials.reconcileCredentialMaterial()).toEqual([]);
	});
});
