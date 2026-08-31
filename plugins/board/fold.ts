import { createHash } from "node:crypto";

/**
 * The board's whole distributed algorithm, as a pure function.
 *
 * N single-writer logs plus a local fold. That is the entire coordination
 * model: every desk owns one `ops` log, mirrors every other desk's, and folds
 * all of them the same way, so every desk reaches the same answer without any
 * desk being in charge. There is no coordinator, no lock and no leader
 * election — and it resolves correctly while a desk is dark, converging the
 * moment that desk's log arrives.
 *
 * **The Lamport stamp is the board's, not Toad's.** The log plane supplies no
 * ordering across streams, deliberately: the mirror does not need one, and
 * shipping ordering for the board would have been the special case that proves
 * an API wrong. So a writer stamps `lamport = 1 + max seen across every log it
 * has folded`, ties broken by owner node id — a total order every desk computes
 * identically from bytes every desk holds.
 *
 * **Nothing here reads a clock.** `reclaim` is the operation that most wants
 * to, and it is written so it cannot: a reclaim is accepted iff its lamport
 * beats the claim's *and* the claim's own `expiresAt` is earlier than the
 * reclaim's stated `assertedAt` — both numbers being values in the log. Every
 * desk reads the same two numbers and reaches the same verdict under any clock
 * skew whatsoever. The reclaiming desk's clock decides only *when* it writes,
 * which is a liveness matter and never a correctness one.
 *
 * **`desk` is authority, and it is the only authority here.** Toad stamps the
 * owner of every log it hands back on read, and a log has exactly one writer,
 * so `desk` is the one field in this whole model that cannot be forged. Every
 * rule that needs to say "only the holder may do this" — release, progress,
 * complete — is therefore written against `desk` and never against `by`, which
 * is a name an agent typed.
 *
 * Pure, so the harness can hand it any world it likes, and so the fold that
 * runs on three desks in a test is the fold that runs in the product.
 */

export type BoardOp =
	| { op: "create"; taskId: string; title: string; note?: string; by?: string }
	| { op: "claim"; taskId: string; by: string; expiresAt: number }
	| { op: "progress"; taskId: string; by: string; claimId: string; note: string; expiresAt: number }
	| { op: "release"; taskId: string; by: string; claimId: string }
	| { op: "reclaim"; taskId: string; by: string; supersedes: string; assertedAt: number; expiresAt: number }
	| { op: "complete"; taskId: string; by: string };

/** One line of a desk's `ops` log. `desk` is written by the desk that owns the
 *  log; it can only ever be its own, because a log has exactly one writer. */
export type BoardLine = BoardOp & {
	opId: string;
	lamport: number;
	desk: string;
	at: number;
};

export type BoardClaim = {
	opId: string;
	by: string;
	desk: string;
	lamport: number;
	expiresAt: number;
};

export type BoardTask = {
	taskId: string;
	title: string;
	note?: string;
	createdBy: string;
	/** The desk that wrote the `create`. Provenance, not authority over the task. */
	createdOn: string;
	createdAt: number;
	claim: BoardClaim | null;
	/** The claimant's own last word on how it is going. plan-10 calls this
	 *  progress and requires it renew the claim, which it does. */
	progress?: { note: string; by: string; desk: string; at: number };
	done: boolean;
	doneBy?: string;
	doneAt?: number;
	/** The `at` of the last line, in fold order, that changed this task. Every
	 *  desk folds the same lines in the same order, so every desk agrees. */
	updatedAt: number;
};

export type Fold = {
	tasks: BoardTask[];
	/** The highest lamport seen anywhere in the folded input. The next stamp. */
	maxLamport: number;
	/** How many op lines were folded, of any kind. The digest's input length. */
	ops: number;
	/** sha256 of the ordered op ids folded. Two desks at the same cursor set
	 *  reporting different digests is a wrong fold, which is the one failure
	 *  that would otherwise rot invisibly. */
	digest: string;
	/** How many lines were unreadable — a torn tail, mid-ship. Not an error;
	 *  the next delta completes them. */
	torn: number;
};

/**
 * The total order. `(lamport, desk, opId)` — lamport first because it is
 * causality, desk second because it is the tie-break the whole room agrees on,
 * opId last so two ops a desk wrote in the same tick still order stably.
 */
function before(a: BoardLine, b: BoardLine): number {
	if (a.lamport !== b.lamport) return a.lamport - b.lamport;
	if (a.desk !== b.desk) return a.desk < b.desk ? -1 : 1;
	return a.opId < b.opId ? -1 : a.opId > b.opId ? 1 : 0;
}

/** Parses one desk's log text. A line that will not parse is a shipping cut
 *  mid-record and does not exist until the delta that completes it lands. */
export function parseLog(owner: string, text: string): { lines: BoardLine[]; torn: number } {
	const lines: BoardLine[] = [];
	let torn = 0;
	for (const raw of text.split("\n")) {
		if (!raw.trim()) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			torn += 1;
			continue;
		}
		const line = parsed as Partial<BoardLine>;
		if (
			typeof line.opId !== "string" ||
			typeof line.lamport !== "number" ||
			typeof line.taskId !== "string" ||
			typeof line.op !== "string"
		) {
			torn += 1;
			continue;
		}
		/* `desk` is taken from the log this line came out of, never from the
		 * line. A log has one writer and Toad proved who that is; believing the
		 * field instead would let a desk write another desk's name into the
		 * order and win a claim it lost. */
		lines.push({ ...(line as BoardLine), desk: owner });
	}
	return { lines, torn };
}

/**
 * The fold.
 *
 * `board_claim` is the contentious operation and the reason this pattern earns
 * its place. Two desks claim concurrently, both lines exist in different logs,
 * every desk folds both, and the lowest `(lamport, desk)` wins — the loser
 * learns it lost when its mirror catches up. No round trip decided it.
 */
export function fold(logs: Array<{ owner: string; text: string }>): Fold {
	const all: BoardLine[] = [];
	let torn = 0;
	for (const log of logs) {
		const parsed = parseLog(log.owner, log.text);
		all.push(...parsed.lines);
		torn += parsed.torn;
	}
	all.sort(before);

	const tasks = new Map<string, BoardTask>();
	let maxLamport = 0;
	const digest = createHash("sha256");

	/** Only the desk holding a claim may act on it, and only on the claim it
	 *  named. `desk` is Toad's word; `by` is a string an agent typed. */
	const holds = (task: BoardTask | undefined, line: BoardLine & { claimId: string }): boolean =>
		task?.claim?.opId === line.claimId && task.claim.desk === line.desk;

	for (const line of all) {
		maxLamport = Math.max(maxLamport, line.lamport);
		digest.update(`${line.opId}\n`);
		const task = tasks.get(line.taskId);
		switch (line.op) {
			case "create": {
				if (task) break;
				tasks.set(line.taskId, {
					taskId: line.taskId,
					title: line.title,
					...(line.note ? { note: line.note } : {}),
					createdBy: line.by ?? line.desk,
					createdOn: line.desk,
					createdAt: line.at,
					claim: null,
					done: false,
					updatedAt: line.at,
				});
				break;
			}
			case "claim": {
				if (!task || task.done || task.claim) break;
				task.claim = {
					opId: line.opId,
					by: line.by,
					desk: line.desk,
					lamport: line.lamport,
					expiresAt: line.expiresAt,
				};
				task.updatedAt = line.at;
				break;
			}
			case "progress": {
				if (!task || task.done || !holds(task, line)) break;
				task.progress = { note: line.note, by: line.by, desk: line.desk, at: line.at };
				/* Renewal is a maximum, not an assignment, so a progress line that
				 * arrives after a later one cannot shorten a live claim. That is what
				 * makes the renewed expiry independent of arrival order, which is what
				 * makes a later reclaim decidable identically everywhere. */
				if (task.claim) task.claim.expiresAt = Math.max(task.claim.expiresAt, line.expiresAt);
				task.updatedAt = line.at;
				break;
			}
			case "release": {
				if (!task || task.done || !holds(task, line)) break;
				task.claim = null;
				task.progress = undefined;
				task.updatedAt = line.at;
				break;
			}
			case "reclaim": {
				if (!task || task.done || !task.claim) break;
				if (task.claim.opId !== line.supersedes) break;
				/* Both halves are values in the log, so every desk decides this the
				 * same way under any clock skew. A reclaim that arrives out of order
				 * is refused on the first half; a reclaim of a claim that had not in
				 * fact expired is refused on the second. */
				if (line.lamport <= task.claim.lamport) break;
				if (task.claim.expiresAt >= line.assertedAt) break;
				task.claim = {
					opId: line.opId,
					by: line.by,
					desk: line.desk,
					lamport: line.lamport,
					expiresAt: line.expiresAt,
				};
				task.progress = undefined;
				task.updatedAt = line.at;
				break;
			}
			case "complete": {
				if (!task || task.done) break;
				/* plan-10's rule: completion belongs to whoever holds the claim. An
				 * unclaimed task is anyone's to close; a claimed one is not, or a desk
				 * could close work another desk is in the middle of. */
				if (task.claim && task.claim.desk !== line.desk) break;
				task.done = true;
				task.doneBy = line.by;
				task.doneAt = line.at;
				task.updatedAt = line.at;
				break;
			}
		}
	}

	return {
		tasks: [...tasks.values()].sort((a, b) => (a.taskId < b.taskId ? -1 : 1)),
		maxLamport,
		ops: all.length,
		digest: digest.digest("hex"),
		torn,
	};
}

/**
 * The cursor set a fold was computed from, as one hash.
 *
 * A digest on its own cannot be judged. Two desks always disagree while one is
 * behind, which is normal and constant, so a bare digest comparison is noise
 * that trains you to ignore the one signal that matters. Paired with the cursor
 * set it becomes decidable: **same cursor set, different digest** is two desks
 * folding the same bytes differently, and there is no benign explanation for
 * it. A different cursor set is just a desk at a different point.
 *
 * Computed from what was actually read into the fold, not from what the cursor
 * call reported, because a short read is a different cursor set.
 */
export function cursorSetDigest(read: Array<{ owner: string; gen: number; bytes: number }>): string {
	const canonical = [...read]
		.sort((a, b) => (a.owner === b.owner ? a.gen - b.gen : a.owner < b.owner ? -1 : 1))
		.map((entry) => `${entry.owner}:${entry.gen}:${entry.bytes}`)
		.join("\n");
	return createHash("sha256").update(canonical).digest("hex");
}

export type PeerFold = {
	nodeId: string;
	name: string;
	digest: string;
	/** Absent from a peer that predates this field — see `classifyFolds`. */
	cursorDigest?: string;
	tasks?: number;
};

export type FoldAgreement = {
	/** Peers that folded the same cursor set and got a different answer. There
	 *  is no benign reading of this: one of the two folds is wrong. */
	wrong: PeerFold[];
	/** Peers that folded the same cursor set and got the same answer. */
	agree: PeerFold[];
	/** Peers at a different point in the room. Expected, and not reported. */
	elsewhere: PeerFold[];
};

/**
 * Sorts what other desks said about their folds into the one bucket worth
 * raising and the two that are noise.
 *
 * A peer that states no cursor set at all is counted **wrong**, not ignored: it
 * is either an older build or an event nobody in this room should be sending,
 * and either way the honest answer is that its claim cannot be checked. Silence
 * about the thing that makes a digest interpretable is not reassurance.
 */
export function classifyFolds(mine: { digest: string; cursorDigest: string }, peers: PeerFold[]): FoldAgreement {
	const agreement: FoldAgreement = { wrong: [], agree: [], elsewhere: [] };
	for (const peer of peers) {
		if (peer.cursorDigest && peer.cursorDigest !== mine.cursorDigest) agreement.elsewhere.push(peer);
		else if (peer.digest === mine.digest && peer.cursorDigest) agreement.agree.push(peer);
		else agreement.wrong.push(peer);
	}
	return agreement;
}

/**
 * Task text is written by agents on other desks and read back to a model.
 *
 * plan-10 requires it be fenced so it cannot masquerade as instruction, and
 * Toad's core has no such helper to borrow, so the board does it itself. One
 * line, control characters gone, bounded length: a title cannot forge a second
 * row of the table, cannot close the fence, and cannot carry a terminal escape.
 */
export function oneLine(text: string, max = 200): string {
	const flattened = String(text ?? "")
		.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return flattened.length > max ? `${flattened.slice(0, max - 1)}\u2026` : flattened;
}
