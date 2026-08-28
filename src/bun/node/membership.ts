import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { NodeIdentity } from "../../shared/types";
import { ROOT, ensureLayout } from "../paths";
import { isNodeIdentity, nodeIdentity, signNodePayload, verifyNodePayload } from "./identity";
import { forgetPeerCert, isCertFingerprint } from "./tls";

export type MembershipAdmission = {
	node: NodeIdentity;
	origin: string;
	admittedBy: string;
	admittedAt: number;
	/**
	 * The one TLS certificate this node may present, as a SHA-256
	 * fingerprint — absent for a plain-http peer, and for every admission
	 * written before the node plane had TLS.
	 *
	 * It lives inside the signature deliberately. The pin is not a cache of
	 * something seen on a wire; it is a fact this desk asserted at admission
	 * time and re-verifies from its own file forever. A tampered nodes.json
	 * cannot move a pin without breaking the signature, and a machine in the
	 * middle of a later connection cannot offer a certificate the admission
	 * never named.
	 */
	certFingerprint?: string;
	signature: string;
};

type Store = {
	version: 1;
	admissions: MembershipAdmission[];
};

const FILE = join(ROOT, "nodes.json");

/**
 * The signed shape of an admission.
 *
 * `certFingerprint` is appended only when present, so an admission written
 * before node TLS still hashes to exactly the bytes it was signed over and
 * survives the upgrade. A pinned admission signs one more key at the end.
 */
function unsigned(admission: Omit<MembershipAdmission, "signature">): Omit<MembershipAdmission, "signature"> {
	return {
		node: admission.node,
		origin: admission.origin,
		admittedBy: admission.admittedBy,
		admittedAt: admission.admittedAt,
		...(admission.certFingerprint ? { certFingerprint: admission.certFingerprint } : {}),
	};
}

function validAdmission(value: unknown): value is MembershipAdmission {
	const row = value as Partial<MembershipAdmission> | null;
	if (
		!row ||
		!isNodeIdentity(row.node) ||
		typeof row.origin !== "string" ||
		typeof row.admittedBy !== "string" ||
		typeof row.admittedAt !== "number" ||
		typeof row.signature !== "string" ||
		(row.certFingerprint !== undefined && !isCertFingerprint(row.certFingerprint))
	) {
		return false;
	}
	const me = nodeIdentity();
	if (row.admittedBy !== me.id) return false;
	return verifyNodePayload(me, "membership-admission", unsigned(row as MembershipAdmission), row.signature);
}

function read(): Store {
	try {
		if (existsSync(FILE)) {
			const parsed = JSON.parse(readFileSync(FILE, "utf8")) as Partial<Store>;
			if (parsed.version === 1 && Array.isArray(parsed.admissions)) {
				return { version: 1, admissions: parsed.admissions.filter(validAdmission) };
			}
		}
	} catch {
		// Membership is rebuilt through explicit admission, never guessed.
	}
	return { version: 1, admissions: [] };
}

function write(store: Store): void {
	ensureLayout();
	writeFileSync(FILE, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

export function admitNode(
	node: NodeIdentity,
	origin: string,
	certFingerprint?: string,
): MembershipAdmission {
	const base = {
		node,
		origin,
		admittedBy: nodeIdentity().id,
		admittedAt: Date.now(),
		...(isCertFingerprint(certFingerprint) ? { certFingerprint } : {}),
	};
	const admission: MembershipAdmission = {
		...base,
		signature: signNodePayload("membership-admission", base),
	};
	const store = read();
	store.admissions = store.admissions.filter((row) => row.node.id !== node.id);
	store.admissions.push(admission);
	write(store);
	return admission;
}

export function listAdmittedNodes(): MembershipAdmission[] {
	return read().admissions;
}

export function admittedNode(id: string): MembershipAdmission | null {
	return read().admissions.find((row) => row.node.id === id) ?? null;
}

/**
 * Moves an admitted node's certificate pin, keeping the admission itself.
 *
 * Rotation is a re-admission of the same node under a new key: this desk
 * re-signs the row, because an admission is this desk's own word and nobody
 * else may write it. The caller is responsible for having established that
 * the announcement came from the node it names — over an authenticated link,
 * carrying that node's Ed25519 signature. Returns the rewritten admission, or
 * null when the node is not admitted here.
 */
export function repinAdmittedNode(
	id: string,
	certFingerprint: string | undefined,
	origin?: string,
): MembershipAdmission | null {
	const store = read();
	const existing = store.admissions.find((row) => row.node.id === id);
	if (!existing) return null;
	const base = {
		node: existing.node,
		origin: origin ?? existing.origin,
		admittedBy: nodeIdentity().id,
		admittedAt: Date.now(),
		...(isCertFingerprint(certFingerprint) ? { certFingerprint } : {}),
	};
	const admission: MembershipAdmission = {
		...base,
		signature: signNodePayload("membership-admission", base),
	};
	store.admissions = store.admissions.filter((row) => row.node.id !== id);
	store.admissions.push(admission);
	write(store);
	return admission;
}

export function forgetAdmittedNode(id: string): boolean {
	const store = read();
	const admissions = store.admissions.filter((row) => row.node.id !== id);
	/* The pin outlives nothing: a node this desk no longer admits keeps no
	 * trust root here either. */
	forgetPeerCert(id);
	if (admissions.length === store.admissions.length) return false;
	write({ ...store, admissions });
	return true;
}
