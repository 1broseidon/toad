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
 * Pure, so the harness can hand it any world it likes, and so the fold that
 * runs on three desks in a test is the fold that runs in the product.
 */

export type BoardOp =
	| { op: "create"; taskId: string; title: string; note?: string }
	| { op: "claim"; taskId: string; by: string; expiresAt: number }
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

export type BoardTask = {
	taskId: string;
	title: string;
	note?: string;
	createdBy: string;
	claim: { opId: string; by: string; desk: string; lamport: number; expiresAt: number } | null;
	done: boolean;
	doneBy?: string;
};

export type Fold = {
	tasks: BoardTask[];
	/** The highest lamport seen anywhere in the folded input. The next stamp. */
	maxLamport: number;
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
	const claims = new Map<string, BoardLine>();
	let maxLamport = 0;
	const digest = createHash("sha256");

	for (const line of all) {
		maxLamport = Math.max(maxLamport, line.lamport);
		digest.update(`${line.opId}\n`);
		switch (line.op) {
			case "create": {
				if (tasks.has(line.taskId)) break;
				tasks.set(line.taskId, {
					taskId: line.taskId,
					title: line.title,
					...(line.note ? { note: line.note } : {}),
					createdBy: line.desk,
					claim: null,
					done: false,
				});
				break;
			}
			case "claim": {
				const task = tasks.get(line.taskId);
				if (!task || task.done || task.claim) break;
				task.claim = {
					opId: line.opId,
					by: line.by,
					desk: line.desk,
					lamport: line.lamport,
					expiresAt: line.expiresAt,
				};
				claims.set(line.opId, line);
				break;
			}
			case "reclaim": {
				const task = tasks.get(line.taskId);
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
				break;
			}
			case "complete": {
				const task = tasks.get(line.taskId);
				if (!task) break;
				task.done = true;
				task.doneBy = line.by;
				break;
			}
		}
	}

	return {
		tasks: [...tasks.values()].sort((a, b) => (a.taskId < b.taskId ? -1 : 1)),
		maxLamport,
		digest: digest.digest("hex"),
		torn,
	};
}

/** Deterministic markdown, written locally from this desk's own fold. The
 *  projection is one-way and Toad is not involved, so it can never become a
 *  coordination path. */
export function renderMarkdown(state: Fold, completeness: string): string {
	const lines = ["# Fleet board", "", completeness, ""];
	for (const task of state.tasks) {
		const status = task.done
			? `done (${task.doneBy})`
			: task.claim
				? `claimed by ${task.claim.by} on ${task.claim.desk}`
				: "open";
		lines.push(`- [${task.done ? "x" : " "}] **${task.title}** — ${status}  \`${task.taskId}\``);
		if (task.note) lines.push(`      ${task.note}`);
	}
	lines.push("", `fold digest: \`${state.digest}\``, "");
	return lines.join("\n");
}
