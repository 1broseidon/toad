import { describe, expect, test } from "bun:test";
import { fold, parseLog, type BoardLine } from "./fold";

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
