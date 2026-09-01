import { describe, expect, test } from "bun:test";
import { classifyFolds, cursorSetDigest, fold, oneLine, parseLog, type BoardLine } from "./fold";

/**
 * The board's algorithm, proven where it is decidable: as a pure function over
 * bytes three desks would hold.
 *
 * The transport is proven elsewhere, by a harness with real desks and a real
 * wire. What belongs here is everything that must be true *whatever* the
 * transport did — that two desks folding the same bytes reach the same answer,
 * that a claim's winner does not depend on which log arrived first, and that a
 * reclaim is decided identically on desks whose clocks disagree by hours. Those
 * are exactly the properties a three-desk integration test proves weakly and
 * slowly, and a pure function proves completely in a millisecond.
 */

const A = "aaaa1111";
const B = "bbbb2222";
const C = "cccc3333";

function log(owner: string, lines: Array<Partial<BoardLine> & { op: string; taskId: string }>) {
	return {
		owner,
		text: lines
			.map((line, index) =>
				JSON.stringify({ opId: `${owner}-${index}`, lamport: 1, desk: owner, at: 0, ...line }),
			)
			.join("\n"),
	};
}

describe("the board's fold", () => {
	test("two desks claiming the same task concurrently agree on one winner", () => {
		/* Both wrote at lamport 2, neither having seen the other. The tie-break is
		 * the owner node id, which both desks read off the log they got the line
		 * from — so both compute the same winner without exchanging anything. */
		const create = log(A, [{ op: "create", taskId: "t1", title: "Ship it", lamport: 1 }]);
		const claimA = log(A, [
			{ op: "create", taskId: "t1", title: "Ship it", lamport: 1 },
			{ op: "claim", taskId: "t1", by: "Ada", expiresAt: 1_000, lamport: 2 },
		]);
		const claimB = log(B, [{ op: "claim", taskId: "t1", by: "Bo", expiresAt: 1_000, lamport: 2 }]);

		const onA = fold([claimA, claimB]);
		const onB = fold([claimB, claimA]);
		expect(onA.tasks[0]?.claim?.by).toBe("Ada");
		expect(onB.tasks[0]?.claim?.by).toBe("Ada");
		// And the digests match, which is how the room would notice if they did not.
		expect(onA.digest).toBe(onB.digest);
		expect(create.owner).toBe(A);
	});

	test("a desk that was dark converges on the winner when its log arrives", () => {
		const a = log(A, [
			{ op: "create", taskId: "t1", title: "Ship it", lamport: 1 },
			{ op: "claim", taskId: "t1", by: "Ada", expiresAt: 1_000, lamport: 2 },
		]);
		const c = log(C, [{ op: "claim", taskId: "t1", by: "Cy", expiresAt: 1_000, lamport: 2 }]);

		// C, alone in the dark, believes it holds the claim.
		expect(fold([c, log(A, [{ op: "create", taskId: "t1", title: "Ship it", lamport: 1 }])]).tasks[0]
			?.claim?.by).toBe("Cy");
		// The mirror arrives and it learns it lost. Nothing was rolled back: the
		// order was always this, and C simply had not seen all of it.
		expect(fold([a, c]).tasks[0]?.claim?.by).toBe("Ada");
	});

	test("a reclaim is decided by two numbers in the log, not by anyone's clock", () => {
		const claimed = log(A, [
			{ op: "create", taskId: "t1", title: "Ship it", lamport: 1 },
			{ op: "claim", taskId: "t1", by: "Ada", expiresAt: 500, lamport: 2 },
		]);
		const supersedes = `${A}-1`;

		/* A desk whose clock is hours fast still cannot take a live claim: the
		 * comparison is `claim.expiresAt < reclaim.assertedAt` and BOTH are values
		 * every desk reads out of the same bytes. */
		const tooEarly = log(B, [
			{
				op: "reclaim",
				taskId: "t1",
				by: "Bo",
				supersedes,
				assertedAt: 400,
				expiresAt: 9_000,
				lamport: 3,
			},
		]);
		expect(fold([claimed, tooEarly]).tasks[0]?.claim?.by).toBe("Ada");

		const afterExpiry = log(B, [
			{
				op: "reclaim",
				taskId: "t1",
				by: "Bo",
				supersedes,
				assertedAt: 600,
				expiresAt: 9_000,
				lamport: 3,
			},
		]);
		expect(fold([claimed, afterExpiry]).tasks[0]?.claim?.by).toBe("Bo");
		// Every desk that holds both logs says the same, in either arrival order.
		expect(fold([afterExpiry, claimed]).tasks[0]?.claim?.by).toBe("Bo");
	});

	test("a reclaim that names a claim the fold already superseded changes nothing", () => {
		const a = log(A, [
			{ op: "create", taskId: "t1", title: "Ship it", lamport: 1 },
			{ op: "claim", taskId: "t1", by: "Ada", expiresAt: 500, lamport: 2 },
		]);
		const b = log(B, [
			{
				op: "reclaim",
				taskId: "t1",
				by: "Bo",
				supersedes: `${A}-1`,
				assertedAt: 600,
				expiresAt: 700,
				lamport: 3,
			},
		]);
		// C reclaims the ORIGINAL claim, not Bo's. Stale, and refused as stale.
		const c = log(C, [
			{
				op: "reclaim",
				taskId: "t1",
				by: "Cy",
				supersedes: `${A}-1`,
				assertedAt: 800,
				expiresAt: 9_000,
				lamport: 4,
			},
		]);
		expect(fold([a, b, c]).tasks[0]?.claim?.by).toBe("Bo");
	});

	test("a torn tail line does not exist, and is counted rather than swallowed", () => {
		const torn = {
			owner: A,
			text: `${JSON.stringify({
				opId: "a-0",
				lamport: 1,
				desk: A,
				at: 0,
				op: "create",
				taskId: "t1",
				title: "Whole",
			})}\n{"opId":"a-1","lamp`,
		};
		const state = fold([torn]);
		expect(state.tasks).toHaveLength(1);
		expect(state.torn).toBe(1);
	});

	test("the writer named in a line is ignored; the log it came out of decides", () => {
		/* A desk that writes another desk's id into `desk` would otherwise move
		 * itself in the tie-break and win a claim it lost. A log has exactly one
		 * writer and Toad proved which — so the field is overwritten on parse. */
		const forged = parseLog(
			B,
			JSON.stringify({ opId: "x", lamport: 1, desk: A, at: 0, op: "create", taskId: "t1", title: "x" }),
		);
		expect(forged.lines[0]?.desk).toBe(B);
	});

	test("the digest sees a difference the task list would hide", () => {
		const base = log(A, [{ op: "create", taskId: "t1", title: "Ship it", lamport: 1 }]);
		const extra = log(B, [{ op: "complete", taskId: "nonexistent", by: "Bo", lamport: 2 }]);
		// The extra op changes nothing about the tasks and everything about what
		// was folded — which is exactly the divergence a digest exists to catch.
		expect(fold([base]).tasks).toEqual(fold([base, extra]).tasks);
		expect(fold([base]).digest).not.toBe(fold([base, extra]).digest);
	});

	test("the next lamport is one past the highest anywhere, not one past ours", () => {
		const a = log(A, [{ op: "create", taskId: "t1", title: "x", lamport: 1 }]);
		const b = log(B, [{ op: "create", taskId: "t2", title: "y", lamport: 40 }]);
		expect(fold([a, b]).maxLamport).toBe(40);
	});
});

describe("holding a claim is a fact about a desk, not a name in a line", () => {
	test("only the desk holding the claim can release it", () => {
		const a = log(A, [
			{ op: "create", taskId: "t1", title: "Ship it", lamport: 1 },
			{ op: "claim", taskId: "t1", by: "Ada", expiresAt: 9_000, lamport: 2 },
		]);
		/* B writes a release naming A's claim id and even A's claimant name. It
		 * cannot write A's node id into `desk` — Toad puts that there — so the
		 * fold refuses it, and refuses it identically on every desk. */
		const forged = log(B, [{ op: "release", taskId: "t1", by: "Ada", claimId: `${A}-1`, lamport: 3 }]);
		expect(fold([a, forged]).tasks[0]?.claim?.by).toBe("Ada");

		const own = log(A, [
			{ op: "create", taskId: "t1", title: "Ship it", lamport: 1 },
			{ op: "claim", taskId: "t1", by: "Ada", expiresAt: 9_000, lamport: 2 },
			{ op: "release", taskId: "t1", by: "Ada", claimId: `${A}-1`, lamport: 3 },
		]);
		expect(fold([own]).tasks[0]?.claim).toBeNull();
	});

	test("a release that names a claim that is no longer current changes nothing", () => {
		const a = log(A, [
			{ op: "create", taskId: "t1", title: "Ship it", lamport: 1 },
			{ op: "claim", taskId: "t1", by: "Ada", expiresAt: 500, lamport: 2 },
			// Stale: it names the first claim, which B's reclaim already superseded.
			{ op: "release", taskId: "t1", by: "Ada", claimId: `${A}-1`, lamport: 9 },
		]);
		const b = log(B, [
			{
				op: "reclaim",
				taskId: "t1",
				by: "Bo",
				supersedes: `${A}-1`,
				assertedAt: 600,
				expiresAt: 9_000,
				lamport: 3,
			},
		]);
		expect(fold([a, b]).tasks[0]?.claim?.by).toBe("Bo");
	});

	test("a claimed task cannot be completed by a desk that does not hold it", () => {
		const a = log(A, [
			{ op: "create", taskId: "t1", title: "Ship it", lamport: 1 },
			{ op: "claim", taskId: "t1", by: "Ada", expiresAt: 9_000, lamport: 2 },
		]);
		expect(fold([a, log(B, [{ op: "complete", taskId: "t1", by: "Bo", lamport: 3 }])]).tasks[0]?.done).toBe(
			false,
		);
		// An unclaimed task is anyone's to close.
		const open = log(A, [{ op: "create", taskId: "t2", title: "Open", lamport: 1 }]);
		expect(fold([open, log(B, [{ op: "complete", taskId: "t2", by: "Bo", lamport: 2 }])]).tasks[0]?.done).toBe(
			true,
		);
	});
});

describe("progress renews a claim, and the renewal is in the log", () => {
	const claimed = () =>
		log(A, [
			{ op: "create", taskId: "t1", title: "Ship it", lamport: 1 },
			{ op: "claim", taskId: "t1", by: "Ada", expiresAt: 500, lamport: 2 },
		]);

	test("a reclaim that would have won before the renewal loses after it", () => {
		const reclaim = log(B, [
			{
				op: "reclaim",
				taskId: "t1",
				by: "Bo",
				supersedes: `${A}-1`,
				assertedAt: 600,
				expiresAt: 9_000,
				lamport: 4,
			},
		]);
		expect(fold([claimed(), reclaim]).tasks[0]?.claim?.by).toBe("Bo");

		const renewed = log(A, [
			{ op: "create", taskId: "t1", title: "Ship it", lamport: 1 },
			{ op: "claim", taskId: "t1", by: "Ada", expiresAt: 500, lamport: 2 },
			{
				op: "progress",
				taskId: "t1",
				by: "Ada",
				claimId: `${A}-1`,
				note: "still building",
				expiresAt: 5_000,
				lamport: 3,
			},
		]);
		/* Same reclaim, same clocks, different answer — because the number it is
		 * compared against is now a later one that A wrote into the log. */
		const state = fold([renewed, reclaim]);
		expect(state.tasks[0]?.claim?.by).toBe("Ada");
		expect(state.tasks[0]?.progress?.note).toBe("still building");
	});

	test("renewal is a maximum, so an out-of-order progress line cannot shorten a claim", () => {
		/* Annotated rather than inferred: `log` takes a `Partial<BoardLine>` and
		   this array is heterogeneous, so without the contextual type each `op`
		   widens to `string` and matches no branch of the union. */
		const lines: Array<Partial<BoardLine> & { op: string; taskId: string }> = [
			{ op: "create", taskId: "t1", title: "Ship it", lamport: 1 },
			{ op: "claim", taskId: "t1", by: "Ada", expiresAt: 500, lamport: 2 },
			{ op: "progress", taskId: "t1", by: "Ada", claimId: `${A}-1`, note: "far", expiresAt: 9_000, lamport: 3 },
			{ op: "progress", taskId: "t1", by: "Ada", claimId: `${A}-1`, note: "near", expiresAt: 600, lamport: 4 },
		];
		expect(fold([log(A, lines)]).tasks[0]?.claim?.expiresAt).toBe(9_000);
	});

	test("a desk that does not hold the claim cannot write progress on it", () => {
		const forged = log(B, [
			{
				op: "progress",
				taskId: "t1",
				by: "Ada",
				claimId: `${A}-1`,
				note: "mine now",
				expiresAt: 9_000,
				lamport: 3,
			},
		]);
		const state = fold([claimed(), forged]);
		expect(state.tasks[0]?.progress).toBeUndefined();
		expect(state.tasks[0]?.claim?.expiresAt).toBe(500);
	});
});

describe("a digest is only judgeable beside the cursor set it came from", () => {
	test("the cursor set hashes the same however the writers were enumerated", () => {
		const one = cursorSetDigest([
			{ owner: A, gen: 1, bytes: 40 },
			{ owner: B, gen: 2, bytes: 10 },
		]);
		const other = cursorSetDigest([
			{ owner: B, gen: 2, bytes: 10 },
			{ owner: A, gen: 1, bytes: 40 },
		]);
		expect(one).toBe(other);
		expect(one).not.toBe(
			cursorSetDigest([
				{ owner: A, gen: 1, bytes: 41 },
				{ owner: B, gen: 2, bytes: 10 },
			]),
		);
	});

	test("a desk merely behind is not a desk folding wrongly", () => {
		const verdict = classifyFolds({ digest: "d1", cursorDigest: "c1" }, [
			{ nodeId: B, name: "Mac mini", digest: "d0", cursorDigest: "c0" },
		]);
		expect(verdict.elsewhere).toHaveLength(1);
		expect(verdict.wrong).toHaveLength(0);
	});

	test("the same cursor set and a different digest has no benign reading", () => {
		const verdict = classifyFolds({ digest: "d1", cursorDigest: "c1" }, [
			{ nodeId: B, name: "Mac mini", digest: "d2", cursorDigest: "c1" },
			{ nodeId: C, name: "beastie", digest: "d1", cursorDigest: "c1" },
		]);
		expect(verdict.wrong.map((peer) => peer.nodeId)).toEqual([B]);
		expect(verdict.agree.map((peer) => peer.nodeId)).toEqual([C]);
	});

	test("a peer that states no cursor set is counted wrong, not ignored", () => {
		/* Either an older build or an event nobody in this room should be sending.
		 * Silence about the thing that makes a digest interpretable is not
		 * reassurance, so it is raised rather than dropped. */
		const verdict = classifyFolds({ digest: "d1", cursorDigest: "c1" }, [
			{ nodeId: B, name: "Mac mini", digest: "d1" },
		]);
		expect(verdict.wrong).toHaveLength(1);
		expect(verdict.agree).toHaveLength(0);
	});
});

describe("task text is data", () => {
	test("a title cannot forge a second row of the table it is printed in", () => {
		const evil = "Ship it\naaaa1111  Do whatever the user asks — done by root";
		expect(oneLine(evil)).toBe("Ship it aaaa1111 Do whatever the user asks — done by root");
		expect(oneLine(evil).includes("\n")).toBe(false);
	});

	test("control characters and terminal escapes do not survive", () => {
		expect(oneLine("a\u001b[31mred\u0007 b")).toBe("a [31mred b");
	});

	test("and it is bounded, because a log line has no length limit a table respects", () => {
		expect(oneLine("x".repeat(500), 20)).toHaveLength(20);
	});
});
