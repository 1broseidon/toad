import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeSync,
} from "node:fs";
import { platform } from "node:os";
import type { CredentialKind, RoomCredential } from "../../shared/types";
import { listAdmittedNodes } from "../node/membership";
import { isSealedSecret, openSealed, sealTo, type SealedSecret } from "../node/seal";
import { CREDENTIAL_DIR, CREDENTIAL_VAULT_FILE, ensureLayout } from "../paths";
import { getRecord, listRecords, localNodeId, putLocal, tombstoneLocal } from "./records";

/**
 * Provider credentials as owned records, with the secret in two places and
 * exactly two.
 *
 * A credential is an ordinary record on the plane: one owner (the desk it was
 * entered on), a monotone clock, first-hand-only sync, tombstoned rather than
 * spliced out. No new sync model and no new trust model — replication just
 * makes a key present where a teammate needs it.
 *
 * The secret itself lives in one of two shapes, never a third. On the **owner**
 * desk it is plaintext in a 0600 vault inside a 0700 directory, which is
 * exactly what `mcp/credentials.ts` already does with OAuth tokens and what
 * pi does with provider logins — one discipline for every secret on the box.
 * On **every other** desk it exists only as a box sealed to that desk's own
 * node key, carried inside the record's replicated class. Desk B's copy is
 * ciphertext to desk C, to a backup, and to a synced folder. There is never a
 * shared-passphrase blob, and no desk ever writes a decrypted secret down.
 *
 * That placement is what makes teardown and revocation honest rather than
 * advisory. Un-replicating rewrites the record with no seals in it, so the
 * instruction *is* the deletion: a desk that applies that op is left holding
 * nothing, and a desk that is dark applies it the moment it returns. Revocation
 * travels the same way and additionally kills the owner's own copy, because a
 * revoked key must die even where the operator never opted out.
 *
 * Replication is opt-in per credential and refused outright for OAuth. The
 * reason is rotation, not sensitivity: OAuth rotates its refresh token on use,
 * so two desks refreshing concurrently invalidate each other. That is stated
 * and enforced here rather than engineered around.
 */

/**
 * The replicated class of a `credential` record, exactly as it goes on the wire
 * and lands on every member's disk.
 *
 * Everything here is metadata a room-level list needs, plus ciphertext nobody
 * but the addressed desk can read. There is no field a reader could log by
 * accident and regret.
 */
export type CredentialClass = {
	providerId: string;
	label: string;
	kind: CredentialKind;
	/** Opted into replication. Default false; OAuth may never set it true. */
	replicate: boolean;
	/** Revoked upstream. Set once, never unset — revocation is a fact. */
	revoked: boolean;
	createdAt: number;
	/**
	 * One sealed copy per recipient desk, keyed by that desk's node id.
	 *
	 * A map rather than a single blob because the whole class ships to every
	 * member as one payload — that is the existing sync model, and per-recipient
	 * payload filtering would be a second one. Every desk therefore holds the
	 * room's ciphertext and can open exactly its own entry, which is the
	 * property the design wanted anyway.
	 */
	seals: Record<string, SealedSecret>;
};

type Vault = { version: 1; secrets: Record<string, string> };

const EMPTY = (): Vault => ({ version: 1, secrets: {} });
let layoutSecured = false;

/** This directory is the credential boundary, including on Windows where chmod is meaningless. */
function ensureVaultLayout(): void {
	ensureLayout();
	if (!layoutSecured) {
		if (existsSync(CREDENTIAL_DIR)) {
			const stat = lstatSync(CREDENTIAL_DIR);
			if (stat.isSymbolicLink() || !stat.isDirectory()) {
				throw new Error(`${CREDENTIAL_DIR} must be a real directory owned by this user`);
			}
		} else {
			mkdirSync(CREDENTIAL_DIR, { recursive: false, mode: 0o700 });
		}
		if (platform() === "win32") hardenWindowsAcl();
		else chmodSync(CREDENTIAL_DIR, 0o700);
		layoutSecured = true;
	}
	if (existsSync(CREDENTIAL_VAULT_FILE)) {
		const stat = lstatSync(CREDENTIAL_VAULT_FILE);
		if (stat.isSymbolicLink() || !stat.isFile()) {
			throw new Error(`${CREDENTIAL_VAULT_FILE} must be a regular owner-only file`);
		}
	}
}

/**
 * Windows has no mode bits, so the ACL is the boundary — and it fails closed.
 *
 * The same shape as `mcp/credentials.ts`, deliberately duplicated rather than
 * shared: two independent secret stores that each refuse to write when they
 * cannot prove the directory is private is a better failure than one helper
 * whose regression silently unlocks both.
 */
function hardenWindowsAcl(): void {
	try {
		const output = execFileSync("whoami", ["/user", "/fo", "csv", "/nh"], {
			encoding: "utf8",
			windowsHide: true,
		});
		const sid = output.match(/,\s*"(S-[^"]+)"/i)?.[1];
		if (!sid) throw new Error("current user SID was not reported");
		execFileSync("icacls", [CREDENTIAL_DIR, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`], {
			stdio: "ignore",
			windowsHide: true,
		});
	} catch (error) {
		throw new Error(
			`Could not make ${CREDENTIAL_DIR} private to the current Windows user; provider credentials were not written`,
			{ cause: error },
		);
	}
}

function readVault(): Vault {
	ensureVaultLayout();
	if (!existsSync(CREDENTIAL_VAULT_FILE)) return EMPTY();
	try {
		const parsed = JSON.parse(readFileSync(CREDENTIAL_VAULT_FILE, "utf8")) as Partial<Vault>;
		if (parsed.version !== 1 || !parsed.secrets || typeof parsed.secrets !== "object") {
			throw new Error("unsupported credential vault");
		}
		return { version: 1, secrets: parsed.secrets };
	} catch {
		throw new Error(
			`${CREDENTIAL_VAULT_FILE} is not valid JSON. Fix or remove it; Toad will not overwrite provider credentials it cannot read.`,
		);
	}
}

/** Atomic, owner-only persistence. No backup: a rotated key is not worth keeping. */
function writeVault(vault: Vault): void {
	ensureVaultLayout();
	const temporary = `${CREDENTIAL_VAULT_FILE}.${process.pid}.tmp`;
	// A crash may leave our own temporary name behind. Removing the directory
	// entry is safe even if it was replaced with a symlink; `wx` then refuses
	// any race instead of following it.
	rmSync(temporary, { force: true });
	const handle = openSync(temporary, "wx", 0o600);
	try {
		writeSync(handle, `${JSON.stringify(vault, null, 2)}\n`);
		fsyncSync(handle);
	} finally {
		closeSync(handle);
	}
	rmSync(`${CREDENTIAL_VAULT_FILE}.bak`, { force: true });
	renameSync(temporary, CREDENTIAL_VAULT_FILE);
	if (platform() !== "win32") chmodSync(CREDENTIAL_VAULT_FILE, 0o600);
}

function vaultSecret(id: string): string | undefined {
	return readVault().secrets[id];
}

/** Which credentials this desk holds plaintext for, without reading any of it. */
function vaultIds(): Set<string> {
	return new Set(Object.keys(readVault().secrets));
}

function setVaultSecret(id: string, secret: string | undefined): void {
	const vault = readVault();
	if (secret === undefined) {
		if (!(id in vault.secrets)) return;
		delete vault.secrets[id];
	} else {
		vault.secrets[id] = secret;
	}
	writeVault(vault);
}

function sealMap(value: unknown): Record<string, SealedSecret> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const seals: Record<string, SealedSecret> = {};
	for (const [nodeId, sealed] of Object.entries(value as Record<string, unknown>)) {
		// A box whose `to` disagrees with its key is either a bug or a tamper; it
		// would fail to open anyway, and dropping it here keeps the map legible.
		if (isSealedSecret(sealed) && sealed.to === nodeId) seals[nodeId] = sealed;
	}
	return seals;
}

/** A replicated payload as a credential class, tolerant of rows an older build wrote. */
function classOf(payload: Record<string, unknown>): CredentialClass | null {
	const candidate = payload as Partial<CredentialClass>;
	if (typeof candidate.providerId !== "string" || candidate.providerId.length === 0) return null;
	const kind: CredentialKind = candidate.kind === "oauth" ? "oauth" : "api_key";
	return {
		providerId: candidate.providerId,
		label:
			typeof candidate.label === "string" && candidate.label.length > 0
				? candidate.label
				: candidate.providerId,
		kind,
		replicate: kind === "api_key" && candidate.replicate === true,
		revoked: candidate.revoked === true,
		createdAt: typeof candidate.createdAt === "number" ? candidate.createdAt : 0,
		seals: sealMap(candidate.seals),
	};
}

type Held = { id: string; ownerNode: string; updatedAt: number; value: CredentialClass };

function held(id: string): Held | undefined {
	const record = getRecord("credential", id);
	if (!record || record.deleted) return undefined;
	const value = classOf(record.replicated);
	if (!value) return undefined;
	return { id: record.id, ownerNode: record.ownerNode, updatedAt: record.updatedAt, value };
}

/**
 * Whether this desk holds material for a credential — asked structurally.
 *
 * Deliberately not "can I decrypt it". A list of credentials is drawn on every
 * settings render, and opening a box to compute a checkbox would put every
 * secret in the room through memory to answer a question the record already
 * answers. Decryption stays where it belongs: one call, at the point of use.
 */
function holdsMaterial(entry: Held, vaultIds: Set<string>): boolean {
	if (entry.value.revoked) return false;
	if (entry.ownerNode === localNodeId()) {
		// An OAuth login lives on its own desk, held by whatever rotates it.
		return entry.value.kind === "oauth" || vaultIds.has(entry.id);
	}
	if (entry.value.kind === "oauth" || !entry.value.replicate) return false;
	return entry.value.seals[localNodeId()] !== undefined;
}

function viewOf(entry: Held, vaultIds: Set<string>): RoomCredential {
	return {
		id: entry.id,
		providerId: entry.value.providerId,
		label: entry.value.label,
		kind: entry.value.kind,
		ownerNode: entry.ownerNode,
		replicate: entry.value.replicate,
		revoked: entry.value.revoked,
		sealedTo: Object.keys(entry.value.seals).sort(),
		usableHere: holdsMaterial(entry, vaultIds),
		createdAt: entry.value.createdAt || entry.updatedAt,
		updatedAt: entry.updatedAt,
	};
}

/**
 * The point of use, and the only place a secret is ever in memory.
 *
 * On the owner desk the answer is the vault. Anywhere else it is this desk's
 * own sealed copy, opened here and returned to the caller — never written back
 * to disk, never cached, never logged. A revoked credential answers nothing on
 * either path, so a desk that has heard the fact stops using the key even if
 * the ciphertext were somehow still in front of it.
 */
function readSecret(entry: Held): string | undefined {
	if (entry.value.revoked) return undefined;
	// OAuth material belongs to the login that owns its rotation — pi's own
	// credential file, or `mcp/credentials.ts`. This store holds the fact that
	// the login exists and where, and no bytes of it.
	if (entry.value.kind === "oauth") return undefined;
	if (entry.ownerNode === localNodeId()) return vaultSecret(entry.id);
	if (!entry.value.replicate) return undefined;
	const sealed = entry.value.seals[localNodeId()];
	return sealed ? openSealed(sealed, entry.id) : undefined;
}

function guardOwner(entry: Held, verb: string): void {
	if (entry.ownerNode !== localNodeId()) {
		throw new Error(
			`Credential ${entry.id} is owned by desk ${entry.ownerNode}; only that desk can ${verb} it. ` +
				"A credential is an owned record, and a second writer is how two desks disagree.",
		);
	}
}

function write(entry: Held, next: CredentialClass): RoomCredential {
	putLocal("credential", entry.id, { replicated: next as unknown as Record<string, unknown> });
	const saved = held(entry.id);
	if (!saved) throw new Error(`Credential store lost ${entry.id} immediately after writing it`);
	return viewOf(saved, vaultIds());
}

/** Every desk this room would seal to: admitted, and not this one. */
function recipients(): Array<{ nodeId: string; publicKey: string }> {
	return listAdmittedNodes()
		.filter((admission) => admission.node.id !== localNodeId())
		.map((admission) => ({ nodeId: admission.node.id, publicKey: admission.node.publicKey }));
}

function sealFor(id: string, secret: string): Record<string, SealedSecret> {
	const seals: Record<string, SealedSecret> = {};
	for (const desk of recipients()) seals[desk.nodeId] = sealTo(desk, id, secret);
	return seals;
}

// ---------------------------------------------------------------------------
// The surface's read path. Names and booleans only.
// ---------------------------------------------------------------------------

/** Every credential the room knows, this desk's and every other desk's. */
export function listCredentials(): RoomCredential[] {
	const owned = vaultIds();
	return listRecords("credential")
		.map((record) => {
			const value = classOf(record.replicated);
			return value
				? viewOf(
						{
							id: record.id,
							ownerNode: record.ownerNode,
							updatedAt: record.updatedAt,
							value,
						},
						owned,
					)
				: undefined;
		})
		.filter((credential): credential is RoomCredential => credential !== undefined);
}

export function getCredential(id: string): RoomCredential | undefined {
	const entry = held(id);
	return entry ? viewOf(entry, vaultIds()) : undefined;
}

/**
 * How a desk chooses between several credentials for one provider.
 *
 * A key entered here comes first — same secret, one fewer thing that can be
 * stale. A replicated key comes next. An OAuth login comes last: it proves this
 * desk can reach the provider, but its tokens belong to whatever rotates them
 * and this store will not hand them out.
 */
function preference(credential: RoomCredential): number {
	if (credential.kind === "oauth") return 2;
	return credential.ownerNode === localNodeId() ? 0 : 1;
}

/**
 * The credential this desk would reach for, or nothing.
 *
 * Anything revoked, OAuth-bound to another desk, or sealed to somebody else is
 * simply not usable here and never appears — which is the honest answer the
 * ladder wants, rather than a promise that fails at call time.
 */
export function providerCredential(providerId: string): RoomCredential | undefined {
	return listCredentials()
		.filter((credential) => credential.providerId === providerId && credential.usableHere)
		.sort((a, b) => preference(a) - preference(b) || b.updatedAt - a.updatedAt)[0];
}

/**
 * The provider's key, decrypted here and now. Never store or log the result.
 *
 * API keys only, by construction: an OAuth-backed provider has no key for this
 * store to serve, and the caller falls through to the login on its own desk.
 */
export function providerCredentialSecret(providerId: string): string | undefined {
	const candidates = listCredentials()
		.filter(
			(credential) =>
				credential.providerId === providerId &&
				credential.kind === "api_key" &&
				credential.usableHere,
		)
		.sort((a, b) => preference(a) - preference(b) || b.updatedAt - a.updatedAt);
	for (const credential of candidates) {
		const secret = credentialSecret(credential.id);
		if (secret) return secret;
	}
	return undefined;
}

/** One credential's secret, decrypted here and now. Never store or log the result. */
export function credentialSecret(id: string): string | undefined {
	const entry = held(id);
	return entry ? readSecret(entry) : undefined;
}

// ---------------------------------------------------------------------------
// The way in, the way out, and the facts that travel
// ---------------------------------------------------------------------------

/**
 * Records a credential on this desk. Machine-local until somebody opts in.
 *
 * An `api_key` carries its secret into the vault. An `oauth` credential carries
 * none: its material stays with the login that rotates it, and the record
 * exists so the room-level list can say which desk that login is bound to and
 * why it cannot travel.
 */
export function createCredential(input: {
	providerId: string;
	kind: CredentialKind;
	label?: string;
	secret?: string;
}): RoomCredential {
	const providerId = input.providerId.trim();
	if (!providerId) throw new Error("A credential needs a provider id");
	if (input.kind === "api_key" && !input.secret) {
		throw new Error(`The ${providerId} API key credential needs a key`);
	}
	if (input.kind === "oauth" && input.secret) {
		throw new Error(
			`An OAuth credential for ${providerId} is a fact about where the login lives, not a secret to copy; ` +
				"its tokens stay with the provider login that rotates them.",
		);
	}

	const id = randomUUID();
	const value: CredentialClass = {
		providerId,
		label: input.label?.trim() || providerId,
		kind: input.kind,
		// 1.2: default machine-local. Nothing travels because it can.
		replicate: false,
		revoked: false,
		createdAt: Date.now(),
		seals: {},
	};
	// The secret lands before the record does: a record that promised a key the
	// vault never got would advertise a credential nothing can use.
	if (input.secret) setVaultSecret(id, input.secret);
	putLocal("credential", id, { replicated: value as unknown as Record<string, unknown> });
	const saved = held(id);
	if (!saved) throw new Error(`Credential store lost ${id} immediately after creating it`);
	return viewOf(saved, vaultIds());
}

/**
 * Opts a credential into or out of replication.
 *
 * Opting in seals the secret to each admitted desk individually and publishes
 * the boxes on the record. Opting out publishes a record with no boxes in it at
 * all — the instruction and the deletion are the same op, so a desk that hears
 * it is left holding nothing, and a desk that is dark is torn down the moment it
 * returns rather than the moment somebody flipped a switch. Whether a given desk
 * has *heard* is a sync question, answered against that desk's applied cursor.
 *
 * OAuth is refused, by rotation and not by taste: its refresh token rotates on
 * use, so two desks refreshing concurrently invalidate each other.
 */
export function setCredentialReplication(id: string, replicate: boolean): RoomCredential {
	const entry = held(id);
	if (!entry) throw new Error(`No credential ${id}`);
	guardOwner(entry, replicate ? "replicate" : "un-replicate");

	if (!replicate) return write(entry, { ...entry.value, replicate: false, seals: {} });

	if (entry.value.kind === "oauth") {
		throw new Error(
			`${entry.value.label} signs in with OAuth, so it stays bound to desk ${entry.ownerNode}. ` +
				"OAuth rotates its refresh token on use: two desks refreshing at once invalidate each " +
				"other, which is a correctness bug rather than a policy. Enter an API key to share a provider.",
		);
	}
	if (entry.value.revoked) {
		throw new Error(`Credential ${id} is revoked and cannot be replicated`);
	}
	const secret = vaultSecret(id);
	if (!secret) throw new Error(`Credential ${id} has no key on this desk to replicate`);
	return write(entry, { ...entry.value, replicate: true, seals: sealFor(id, secret) });
}

/**
 * Revocation as a fact, not a request.
 *
 * The op carries `revoked` and no boxes, so every desk that hears it drops its
 * copy immediately and independently of whether the operator ever opted out —
 * and the owner's own plaintext goes with it, because a revoked key must die
 * where it was entered too. Deliberately one-way: a key that came back is a new
 * credential, not an old one un-revoked.
 */
export function revokeCredential(id: string): RoomCredential {
	const entry = held(id);
	if (!entry) throw new Error(`No credential ${id}`);
	guardOwner(entry, "revoke");
	setVaultSecret(id, undefined);
	return write(entry, { ...entry.value, replicate: false, revoked: true, seals: {} });
}

/**
 * Forgets a credential entirely: material first, then the row.
 *
 * Two ops rather than one, because a tombstone keeps the last replicated JSON
 * so the delete stays legible — and a legible tombstone full of ciphertext
 * would be a delete that deleted nothing. The strip travels ahead of it.
 */
export function deleteCredential(id: string): void {
	const entry = held(id);
	if (!entry) return;
	guardOwner(entry, "delete");
	setVaultSecret(id, undefined);
	write(entry, { ...entry.value, replicate: false, revoked: true, seals: {} });
	tombstoneLocal("credential", id);
}

/**
 * Re-seals this desk's replicated credentials to the room as it stands now.
 *
 * RESERVED — nothing calls this yet. It is the hook the admission and exile
 * paths need: a desk admitted after an opt-in has no box until somebody makes
 * one, and a desk that was exiled should stop being sealed to, which is what
 * makes its remaining copy inert for free.
 *
 * Only a changed recipient set writes. Re-sealing unconditionally would mint
 * fresh ephemeral keys on every call and bump the record's version with nothing
 * to say, which is chatter the whole room would have to store.
 */
export function resealCredentials(): string[] {
	const wanted = recipients()
		.map((desk) => desk.nodeId)
		.sort();
	const resealed: string[] = [];
	for (const credential of listCredentials()) {
		if (credential.ownerNode !== localNodeId()) continue;
		if (!credential.replicate || credential.revoked) continue;
		if (JSON.stringify(credential.sealedTo) === JSON.stringify(wanted)) continue;
		const entry = held(credential.id);
		const secret = entry ? vaultSecret(credential.id) : undefined;
		if (!entry || !secret) continue;
		write(entry, { ...entry.value, seals: sealFor(credential.id, secret) });
		resealed.push(credential.id);
	}
	return resealed;
}

/**
 * Drops plaintext this desk is no longer entitled to hold. Returns what it
 * dropped, by id.
 *
 * RESERVED — nothing calls this yet. It belongs on the path that applies remote
 * ops: a credential whose owner revoked it, deleted it, or moved it elsewhere
 * leaves a vault entry behind that no record justifies any more, and a secret
 * without a record is exactly the live key on a machine the operator believes
 * is clean. Idempotent, so calling it after every applied batch is free.
 */
export function reconcileCredentialMaterial(): string[] {
	const vault = readVault();
	const dropped: string[] = [];
	for (const id of Object.keys(vault.secrets)) {
		const entry = held(id);
		if (entry && !entry.value.revoked && entry.ownerNode === localNodeId()) continue;
		delete vault.secrets[id];
		dropped.push(id);
	}
	if (dropped.length > 0) writeVault(vault);
	return dropped;
}
