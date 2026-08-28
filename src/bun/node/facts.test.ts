import { describe, expect, test } from "bun:test";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import type { NodeIdentity } from "../../shared/types";
import {
	assertMembership,
	effectiveMembers,
	isBannedFromRoom,
	listMembershipFacts,
	mergeMembershipFacts,
	validFact,
	type MembershipFact,
} from "./facts";
import { nodeIdentity } from "./identity";

/**
 * Facts are per-subject and the store keeps one per subject, so every case
 * uses subjects of its own and asserts membership of those ids only — the
 * file-wide store can hold other cases' subjects without ambiguity.
 */

type Foreign = {
	identity: NodeIdentity;
	mint(
		subject: { id: string; name: string },
		action: "admit" | "revoke",
		at: number,
	): MembershipFact;
};

function foreign(id: string): Foreign {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
	const der = createPublicKey(pem).export({ type: "spki", format: "der" });
	const identity: NodeIdentity = {
		id,
		name: `desk-${id}`,
		publicKey: pem,
		fingerprint: createHash("sha256").update(der).digest("hex"),
		protocol: 1,
		capabilities: ["admin", "executor", "store", "gateway"],
	};
	const key = createPrivateKey(privateKey.export({ type: "pkcs8", format: "pem" }).toString());
	return {
		identity,
		mint(subject, action, at) {
			const base = {
				subject: { id: subject.id, name: subject.name },
				origin: "http://198.51.100.7:4681",
				action,
				asserter: identity,
				at,
			};
			const payload = Buffer.from(`toad-node:membership-fact:v1\n${JSON.stringify(base)}`);
			return { ...base, signature: sign(null, payload, key).toString("base64url") };
		},
	};
}

describe("membership facts", () => {
	test("a fact this node mints round-trips, verifies, and lists", () => {
		const fact = assertMembership({ id: "sub-roundtrip", name: "Trip" }, "http://x:1", "admit");
		expect(validFact(fact)).toBe(true);
		expect(listMembershipFacts().some((row) => row.subject.id === "sub-roundtrip")).toBe(true);
		expect(effectiveMembers().has("sub-roundtrip")).toBe(true);
	});

	test("a tampered fact does not verify and does not merge", () => {
		const desk = foreign("forger");
		const fact = desk.mint({ id: "sub-tampered", name: "T" }, "admit", 1000);
		const bent = { ...fact, action: "revoke" as const };
		expect(validFact(bent)).toBe(false);
		expect(mergeMembershipFacts([bent])).toEqual([]);
		expect(listMembershipFacts().some((row) => row.subject.id === "sub-tampered")).toBe(false);
	});

	test("admission chains through admitted members, and only through them", () => {
		const b = foreign("chain-b");
		const c = foreign("chain-c");
		const stranger = foreign("chain-stranger");
		// me admits B; B admits C; a never-admitted stranger admits D.
		assertMembership({ id: "chain-b", name: "B" }, "http://b:1", "admit");
		mergeMembershipFacts([
			b.mint({ id: "chain-c", name: "C" }, "admit", 2000),
			stranger.mint({ id: "chain-d", name: "D" }, "admit", 2000),
		]);
		const members = effectiveMembers();
		expect(members.has("chain-b")).toBe(true);
		expect(members.has("chain-c")).toBe(true);
		expect(members.has("chain-d")).toBe(false);
		void c;
	});

	test("a newer revocation bans; a strictly newer admission lifts the ban", () => {
		assertMembership({ id: "ban-x", name: "X" }, "http://x:1", "admit");
		expect(isBannedFromRoom("ban-x")).toBe(false);
		assertMembership({ id: "ban-x", name: "X" }, "http://x:1", "revoke");
		expect(isBannedFromRoom("ban-x")).toBe(true);
		expect(effectiveMembers().has("ban-x")).toBe(false);
		assertMembership({ id: "ban-x", name: "X" }, "http://x:1", "admit");
		expect(isBannedFromRoom("ban-x")).toBe(false);
		expect(effectiveMembers().has("ban-x")).toBe(true);
	});

	test("ordering: at wins, asserter id breaks ties deterministically", () => {
		const low = foreign("aaa-tie");
		const high = foreign("zzz-tie");
		assertMembership({ id: "aaa-tie", name: "L" }, "http://l:1", "admit");
		assertMembership({ id: "zzz-tie", name: "H" }, "http://h:1", "admit");
		mergeMembershipFacts([low.mint({ id: "sub-tie", name: "S" }, "admit", 5000)]);
		// Same timestamp, higher asserter id: the revoke must win.
		mergeMembershipFacts([high.mint({ id: "sub-tie", name: "S" }, "revoke", 5000)]);
		expect(isBannedFromRoom("sub-tie")).toBe(true);
		// And an older fact never displaces a newer one.
		expect(mergeMembershipFacts([low.mint({ id: "sub-tie", name: "S" }, "admit", 4000)])).toEqual([]);
	});

	test("facts minted after the asserter's own revocation are dead letters", () => {
		const ghost = foreign("ghost-asserter");
		assertMembership({ id: "ghost-asserter", name: "G" }, "http://g:1", "admit");
		assertMembership({ id: "ghost-asserter", name: "G" }, "http://g:1", "revoke");
		const late = ghost.mint({ id: "sub-late", name: "L" }, "admit", Date.now() + 60_000);
		mergeMembershipFacts([late]);
		expect(effectiveMembers().has("sub-late")).toBe(false);
	});

	test("merging the same facts again changes nothing — the gossip damper", () => {
		const fact = assertMembership({ id: "sub-idem", name: "I" }, "http://i:1", "admit");
		expect(mergeMembershipFacts([fact])).toEqual([]);
	});

	test("this node cannot be banned in its own eyes", () => {
		const me = nodeIdentity().id;
		expect(isBannedFromRoom(me)).toBe(false);
		expect(effectiveMembers().has(me)).toBe(true);
	});
});
