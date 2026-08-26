import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { NodeIdentity } from "../../shared/types";
import { ROOT, ensureLayout } from "../paths";
import { isNodeIdentity, nodeIdentity, signNodePayload, verifyNodePayload } from "./identity";

export type MembershipAdmission = {
	node: NodeIdentity;
	origin: string;
	admittedBy: string;
	admittedAt: number;
	signature: string;
};

type Store = {
	version: 1;
	admissions: MembershipAdmission[];
};

const FILE = join(ROOT, "nodes.json");

function unsigned(admission: Omit<MembershipAdmission, "signature">): Omit<MembershipAdmission, "signature"> {
	return {
		node: admission.node,
		origin: admission.origin,
		admittedBy: admission.admittedBy,
		admittedAt: admission.admittedAt,
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
		typeof row.signature !== "string"
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

export function admitNode(node: NodeIdentity, origin: string): MembershipAdmission {
	const base = {
		node,
		origin,
		admittedBy: nodeIdentity().id,
		admittedAt: Date.now(),
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

export function forgetAdmittedNode(id: string): boolean {
	const store = read();
	const admissions = store.admissions.filter((row) => row.node.id !== id);
	if (admissions.length === store.admissions.length) return false;
	write({ ...store, admissions });
	return true;
}
