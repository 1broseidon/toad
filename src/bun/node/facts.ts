import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { NodeIdentity } from "../../shared/types";
import { ROOT, ensureLayout } from "../paths";
import { isNodeIdentity, nodeIdentity, signNodePayload, verifyNodePayload } from "./identity";

/**
 * Room membership as gossip-able facts.
 *
 * A pairwise admission (membership.ts) says "I linked with you". It cannot say
 * "and now the whole room should forget you" — which is why removing a node
 * from one desk left it alive on every other desk, and why the mesh closure
 * would then helpfully resurrect it. Membership is room policy, and policy has
 * to travel.
 *
 * Facts travel differently than persona records on purpose. First-hand-only
 * sync exists because a relayed record is unverifiable hearsay; a membership
 * fact is signed by its asserter over its full content, so provenance rides
 * inside it and any member can verify it no matter who handed it over. Small,
 * signed, relayable — the one deliberate carve-out from first-hand-only.
 *
 * Trust is flat: any member's signed fact is valid. The room is one person's
 * machines; the threat model is mistakes, not adversaries. Conflicts resolve
 * by ordering — newest fact per subject wins, asserter id breaks ties — and a
 * revocation is a ban that only a strictly newer admission supersedes.
 */

export type MembershipFact = {
	/** Who the fact is about. Identity minimum: a revoke must be mintable for
	 *  a node that will never speak again, so no public key is required. */
	subject: { id: string; name: string };
	/** Last known origin, carried so a re-admitted subject is dialable. */
	origin: string;
	action: "admit" | "revoke";
	/** Full identity of the asserting node — the signature verifies against
	 *  this key, which is what makes the fact safe to relay. */
	asserter: NodeIdentity;
	at: number;
	signature: string;
};

type Store = { version: 1; facts: MembershipFact[] };

const FILE = join(ROOT, "membership.json");

function unsigned(fact: Omit<MembershipFact, "signature">): Omit<MembershipFact, "signature"> {
	return {
		subject: { id: fact.subject.id, name: fact.subject.name },
		origin: fact.origin,
		action: fact.action,
		asserter: fact.asserter,
		at: fact.at,
	};
}

export function validFact(value: unknown): value is MembershipFact {
	const fact = value as Partial<MembershipFact> | null;
	if (
		!fact ||
		typeof fact.subject?.id !== "string" ||
		!fact.subject.id ||
		typeof fact.subject.name !== "string" ||
		typeof fact.origin !== "string" ||
		(fact.action !== "admit" && fact.action !== "revoke") ||
		!isNodeIdentity(fact.asserter) ||
		typeof fact.at !== "number" ||
		typeof fact.signature !== "string"
	) {
		return false;
	}
	return verifyNodePayload(
		fact.asserter,
		"membership-fact",
		unsigned(fact as MembershipFact),
		fact.signature,
	);
}

/** Newest wins; asserter id breaks a timestamp tie deterministically. */
function newer(a: MembershipFact, b: MembershipFact): boolean {
	if (a.at !== b.at) return a.at > b.at;
	return a.asserter.id > b.asserter.id;
}

function read(): Store {
	try {
		if (existsSync(FILE)) {
			const parsed = JSON.parse(readFileSync(FILE, "utf8")) as Partial<Store>;
			if (parsed.version === 1 && Array.isArray(parsed.facts)) {
				return { version: 1, facts: parsed.facts.filter(validFact) };
			}
		}
	} catch {
		// Facts are re-learned from any peer; never guessed from a bad file.
	}
	return { version: 1, facts: [] };
}

function write(store: Store): void {
	ensureLayout();
	writeFileSync(FILE, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

export function listMembershipFacts(): MembershipFact[] {
	return read().facts;
}

/** Mints and stores a fact asserted by this node. Returns it for broadcast. */
export function assertMembership(
	subject: { id: string; name: string },
	origin: string,
	action: "admit" | "revoke",
): MembershipFact {
	/* A wall clock cannot order two facts minted in the same millisecond, and
	 * "admit, then immediately revoke" is a real sequence. Bump past the
	 * newest fact on this subject from ANY asserter — a new assertion is the
	 * room's newest word by construction: a logical clock wearing a wall
	 * clock's face. */
	const newest = read()
		.facts.filter((row) => row.subject.id === subject.id)
		.reduce((max, row) => Math.max(max, row.at), 0);
	const base = {
		subject: { id: subject.id, name: subject.name },
		origin,
		action,
		asserter: nodeIdentity(),
		at: Math.max(Date.now(), newest + 1),
	};
	const fact: MembershipFact = { ...base, signature: signNodePayload("membership-fact", base) };
	mergeMembershipFacts([fact]);
	return fact;
}

/**
 * Merges incoming facts — one kept per (subject, asserter) pair, newest wins
 * within a pair. Keying by pair rather than by subject is load-bearing: two
 * members can each have a word about the same node, and one displacing the
 * other would orphan trust chains (B's own admission of A must survive C also
 * admitting A, or B's whole room view collapses to itself). Returns the
 * subject ids whose fact set changed — the apply set and the gossip damper:
 * nothing changed, nothing rebroadcast, no loops.
 */
export function mergeMembershipFacts(incoming: unknown[]): string[] {
	const store = read();
	const byPair = new Map(store.facts.map((fact) => [`${fact.subject.id}~${fact.asserter.id}`, fact]));
	const changed = new Set<string>();
	for (const candidate of incoming) {
		if (!validFact(candidate)) continue;
		const key = `${candidate.subject.id}~${candidate.asserter.id}`;
		const held = byPair.get(key);
		if (held && !newer(candidate, held)) continue;
		if (held && held.signature === candidate.signature) continue;
		byPair.set(key, candidate);
		changed.add(candidate.subject.id);
	}
	if (changed.size > 0) {
		write({ version: 1, facts: [...byPair.values()] });
	}
	return [...changed];
}

/**
 * The room evaluated under flat trust from this node as the axiom.
 *
 * Two passes with different questions. `everAdmitted` asks "whose word
 * counts": it grows monotonically over admit facts from already-counted
 * asserters — a revoked member's *earlier* facts stand, because history does
 * not retroactively unhappen, but facts minted after the asserter's own
 * revocation are dead letters. Then the room's *current* word on each subject
 * is the newest counted fact about it across asserters: admit means member,
 * revoke means banned until a strictly newer admission supersedes.
 */
function roomView(): { members: Set<string>; banned: Set<string> } {
	const facts = read().facts;
	const me = nodeIdentity().id;
	const revokedAt = new Map<string, number>();
	for (const fact of facts) {
		if (fact.action !== "revoke") continue;
		const held = revokedAt.get(fact.subject.id);
		if (held === undefined || fact.at > held) revokedAt.set(fact.subject.id, fact.at);
	}
	const postRevocation = (fact: MembershipFact) => {
		const cut = revokedAt.get(fact.asserter.id);
		return cut !== undefined && fact.at > cut && fact.asserter.id !== me;
	};

	const everAdmitted = new Set<string>([me]);
	let grew = true;
	while (grew) {
		grew = false;
		for (const fact of facts) {
			if (fact.action !== "admit" || everAdmitted.has(fact.subject.id)) continue;
			if (!everAdmitted.has(fact.asserter.id) || postRevocation(fact)) continue;
			everAdmitted.add(fact.subject.id);
			grew = true;
		}
	}

	const word = new Map<string, MembershipFact>();
	for (const fact of facts) {
		if (!everAdmitted.has(fact.asserter.id) || postRevocation(fact)) continue;
		const held = word.get(fact.subject.id);
		if (!held || newer(fact, held)) word.set(fact.subject.id, fact);
	}

	const members = new Set<string>([me]);
	const banned = new Set<string>();
	for (const [subject, fact] of word) {
		if (subject === me) continue;
		if (fact.action === "admit" && everAdmitted.has(subject)) members.add(subject);
		if (fact.action === "revoke") banned.add(subject);
	}
	return { members, banned };
}

export function effectiveMembers(): Set<string> {
	return roomView().members;
}

/** True when the room's latest word on this node is a revocation. */
export function isBannedFromRoom(id: string): boolean {
	if (id === nodeIdentity().id) return false;
	return roomView().banned.has(id);
}
