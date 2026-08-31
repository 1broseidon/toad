import type { Fold, FoldAgreement } from "./fold";
import { oneLine } from "./fold";

/**
 * The brainfile projection: task-15's non-negotiable, and the reason it is a
 * plugin rather than a feature.
 *
 * "Local .brainfile markdown is PM-side projection on one machine, never fleet
 * authority." Here that is not a rule anyone has to remember — it is a fact
 * about the code. This module is a pure function from a fold to a list of files
 * and the plugin writes them with its own `writeFileSync`. Toad is not
 * involved, holds no copy, and offers no way to read one desk's projection from
 * another, so the projection **cannot** become a coordination path however
 * badly a later change wants it to.
 *
 * The split between the two halves is the point:
 *
 * - **`taskFiles`** is a function of the fold alone. Two desks holding the same
 *   bytes write byte-identical task files. Nothing local — no node id, no
 *   clock, no reachability — reaches this half, which is what makes "one-way
 *   deterministic projection" checkable rather than aspirational.
 * - **`indexFile`** is this desk's own view and is expected to differ: how much
 *   of the room it can see, and who disagrees with its fold. That belongs in
 *   exactly one file, clearly marked, so the deterministic half stays clean.
 *
 * Field names follow brainfile's own (`id`, `title`, `column`, `assignee`,
 * `status`, `progress`, `createdAt`, `updatedAt`, `tags`) so brainfile-core's
 * pure domain logic can be pointed at these files later without a translation
 * layer, which is the compatibility task-15 asks for.
 */

export type ProjectionFile = { path: string; text: string };

export const PROJECTION_TAG = "fleet-board";

/** brainfile's own column vocabulary, so its board reads these unchanged. */
function column(status: "open" | "claimed" | "done"): string {
	return status === "open" ? "todo" : status === "claimed" ? "in-progress" : "done";
}

/**
 * A task id becomes a filename, so it is checked before it becomes one.
 *
 * Ids are minted by the tool and are hex, but the ids this desk folds arrive
 * out of *other desks'* logs, and a line in a log is bytes another agent wrote.
 * `../../.ssh/authorized_keys` is a perfectly good JSON string.
 */
export function filableId(taskId: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(taskId) && !taskId.includes("..");
}

/** YAML scalars, via the JSON that YAML 1.2 is a superset of — so a title
 *  containing a newline and `assignee: someone-else` is a string and not a
 *  second field. */
function scalar(value: string | number): string {
	return JSON.stringify(value);
}

function iso(at: number): string {
	return Number.isFinite(at) && at > 0 ? new Date(at).toISOString() : new Date(0).toISOString();
}

/** Untrusted prose, as a blockquote. Nothing an agent writes can leave it. */
function quoted(text: string): string[] {
	return String(text)
		.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
		.split(/\r?\n/)
		.map((line) => `> ${line}`.trimEnd());
}

/**
 * One markdown file per task, in brainfile's shape.
 *
 * Deterministic in the strong sense: same fold, same bytes, on every desk in
 * the room and on every run. The harness checks two desks byte for byte.
 */
export function taskFiles(state: Fold): ProjectionFile[] {
	const files: ProjectionFile[] = [];
	for (const task of state.tasks) {
		if (!filableId(task.taskId)) continue;
		const status = task.done ? "done" : task.claim ? "claimed" : "open";
		const front = [
			`id: ${scalar(task.taskId)}`,
			`title: ${scalar(oneLine(task.title, 300))}`,
			`column: ${scalar(column(status))}`,
			`status: ${scalar(status)}`,
		];
		const assignee = task.done ? task.doneBy : task.claim?.by;
		if (assignee) front.push(`assignee: ${scalar(oneLine(assignee, 80))}`);
		if (task.progress) front.push(`progress: ${scalar(oneLine(task.progress.note, 300))}`);
		front.push(`tags:`, `  - ${PROJECTION_TAG}`);
		front.push(`createdAt: ${scalar(iso(task.createdAt))}`);
		front.push(`updatedAt: ${scalar(iso(task.updatedAt))}`);
		front.push(`createdOn: ${scalar(task.createdOn)}`);
		if (task.claim) {
			front.push(`claimId: ${scalar(task.claim.opId)}`);
			front.push(`claimDesk: ${scalar(task.claim.desk)}`);
			front.push(`claimExpiresAt: ${scalar(iso(task.claim.expiresAt))}`);
		}
		if (task.doneAt) front.push(`completedAt: ${scalar(iso(task.doneAt))}`);

		const body: string[] = ["", "## Description", ""];
		body.push(...quoted(task.note ?? task.title));
		if (task.progress) {
			body.push("", "## Progress", "");
			body.push(...quoted(`${task.progress.by}: ${task.progress.note}`));
		}
		body.push(
			"",
			"## Provenance",
			"",
			`Projected from this desk's own fold of the fleet board. The board's authority is the ops logs, not this file; editing it changes nothing.`,
			"",
		);
		files.push({
			path: `board/${task.taskId}.md`,
			text: ["---", ...front, "---", ...body].join("\n"),
		});
	}
	return files;
}

export type LocalView = {
	/** The sentence `board_list` gives: how much of the room this fold saw. */
	completeness: string;
	nodeId: string;
	cursorDigest: string;
	agreement: FoldAgreement;
};

/**
 * This desk's own view, and the only file here that is allowed to differ from
 * another desk's. Everything unreplicated and everything observational lives
 * in it precisely so `taskFiles` can be compared byte for byte.
 */
export function indexFile(state: Fold, view: LocalView): ProjectionFile {
	const rows = state.tasks.map((task) => {
		const status = task.done
			? `done (${oneLine(task.doneBy ?? "", 60)})`
			: task.claim
				? `claimed by ${oneLine(task.claim.by, 60)}`
				: "open";
		return `- [${task.done ? "x" : " "}] \`${task.taskId}\` **${oneLine(task.title, 160)}** — ${status}`;
	});
	const unfilable = state.tasks.filter((task) => !filableId(task.taskId)).length;
	const lines = [
		"# Fleet board",
		"",
		"This desk's view. The task files beside it are a function of the folded logs",
		"alone and are identical on every desk; this file is not, and says so.",
		"",
		`- ${view.completeness}`,
		`- ${state.tasks.length} task${state.tasks.length === 1 ? "" : "s"} from ${state.ops} op${state.ops === 1 ? "" : "s"}`,
		`- fold digest \`${state.digest}\` at cursor set \`${view.cursorDigest}\``,
		`- folded on \`${view.nodeId}\``,
	];
	if (state.torn > 0) lines.push(`- ${state.torn} line(s) mid-ship, not yet whole`);
	if (unfilable > 0) lines.push(`- ${unfilable} task(s) have an id that may not become a filename, and got no file`);
	for (const peer of view.agreement.wrong) {
		lines.push(
			`- **fold disagreement**: ${oneLine(peer.name || peer.nodeId, 60)} folded the same cursor set and got \`${oneLine(peer.digest, 64)}\``,
		);
	}
	if (view.agreement.agree.length > 0) {
		lines.push(`- ${view.agreement.agree.length} desk(s) agree with this fold`);
	}
	lines.push("", ...rows, "");
	return { path: "board.md", text: lines.join("\n") };
}

export function projection(state: Fold, view: LocalView): ProjectionFile[] {
	return [indexFile(state, view), ...taskFiles(state)];
}
