import { describe, expect, test } from "bun:test";
import { fold, type BoardLine } from "./fold";
import { filableId, indexFile, taskFiles } from "./project";

/**
 * The projection, proven where task-15's non-negotiable lives.
 *
 * "Local .brainfile markdown is PM-side projection on one machine, never fleet
 * authority." The claim that makes that safe is that the projection is a pure,
 * deterministic function of the folded logs — so two desks holding the same
 * bytes write the same files and nobody is ever tempted to ask another desk
 * what its files say. That claim is checkable, and this is where it is checked.
 */

const A = "aaaa1111";
const B = "bbbb2222";

function log(owner: string, lines: Array<Partial<BoardLine> & { op: string; taskId: string }>) {
	return {
		owner,
		text: lines
			.map((line, index) =>
				JSON.stringify({
					opId: `${owner}-${index}`,
					lamport: 1,
					desk: owner,
					at: 1_700_000_000_000,
					...line,
				}),
			)
			.join("\n"),
	};
}

const world = () => [
	log(A, [
		{ op: "create", taskId: "t1", title: "Ship the plugin plane", note: "the whole point", lamport: 1 },
		{ op: "create", taskId: "t2", title: "Write the docs", lamport: 2 },
		{ op: "claim", taskId: "t2", by: "Ada", expiresAt: 1_700_000_900_000, lamport: 3 },
		{
			op: "progress",
			taskId: "t2",
			by: "Ada",
			claimId: `${A}-2`,
			note: "half a page",
			expiresAt: 1_700_001_900_000,
			lamport: 4,
		},
	]),
	log(B, [{ op: "claim", taskId: "t1", by: "Bo", expiresAt: 1_700_000_900_000, lamport: 5 }]),
];

describe("the projection is a function of the fold and nothing else", () => {
	test("two desks holding the same bytes write byte-identical task files", () => {
		/* Different arrival order, which is the only thing two desks in a room are
		 * guaranteed to disagree about. If the files still match byte for byte,
		 * nobody ever needs to ask another desk what its projection says — which
		 * is exactly the property that keeps the projection out of the coordination
		 * path. */
		const [a, b] = world();
		const onA = taskFiles(fold([a!, b!]));
		const onB = taskFiles(fold([b!, a!]));
		expect(onA.map((file) => file.path)).toEqual(onB.map((file) => file.path));
		expect(onA.map((file) => file.text)).toEqual(onB.map((file) => file.text));
	});

	test("the local half is separate, and is the only file allowed to differ", () => {
		const state = fold(world());
		const mine = indexFile(state, {
			completeness: "showing all 2 writers",
			nodeId: A,
			cursorDigest: "c1",
			agreement: { wrong: [], agree: [], elsewhere: [] },
		});
		const theirs = indexFile(state, {
			completeness: "showing 1 of 2 writers — beastie is not reachable from here",
			nodeId: B,
			cursorDigest: "c2",
			agreement: { wrong: [], agree: [], elsewhere: [] },
		});
		expect(mine.path).toBe("board.md");
		expect(mine.text).not.toBe(theirs.text);
		// And it says out loud which half of the projection it is.
		expect(mine.text).toContain("identical on every desk; this file is not");
	});

	test("a fold disagreement is written into the local file, by name", () => {
		const state = fold(world());
		const file = indexFile(state, {
			completeness: "showing all 2 writers",
			nodeId: A,
			cursorDigest: "c1",
			agreement: {
				wrong: [{ nodeId: B, name: "Mac mini", digest: "deadbeef", cursorDigest: "c1" }],
				agree: [],
				elsewhere: [],
			},
		});
		expect(file.text).toContain("fold disagreement");
		expect(file.text).toContain("Mac mini");
	});
});

describe("the frontmatter is brainfile's, so brainfile's own logic can read it", () => {
	test("id, title, column, status, assignee and progress are all there, under those names", () => {
		const files = taskFiles(fold(world()));
		const claimed = files.find((file) => file.path === "board/t2.md")!;
		expect(claimed.text).toContain('id: "t2"');
		expect(claimed.text).toContain('title: "Write the docs"');
		expect(claimed.text).toContain('column: "in-progress"');
		expect(claimed.text).toContain('status: "claimed"');
		expect(claimed.text).toContain('assignee: "Ada"');
		expect(claimed.text).toContain('progress: "half a page"');
		expect(claimed.text).toContain("tags:\n  - fleet-board");
	});

	test("an open task is todo and a done task is done, in brainfile's own vocabulary", () => {
		const open = taskFiles(fold([log(A, [{ op: "create", taskId: "t9", title: "x", lamport: 1 }])]))[0]!;
		expect(open.text).toContain('column: "todo"');
		expect(open.text).toContain('status: "open"');

		const done = taskFiles(
			fold([
				log(A, [
					{ op: "create", taskId: "t9", title: "x", lamport: 1 },
					{ op: "complete", taskId: "t9", by: "Ada", lamport: 2 },
				]),
			]),
		)[0]!;
		expect(done.text).toContain('column: "done"');
		expect(done.text).toContain('assignee: "Ada"');
	});
});

describe("a log line is bytes another agent wrote", () => {
	test("a title cannot smuggle a second frontmatter field", () => {
		/* The op that would rewrite who a task is assigned to, if a title were
		 * pasted into YAML raw. Every scalar goes through JSON, which YAML 1.2 is a
		 * superset of, so this is one string and stays one string. */
		const evil = taskFiles(
			fold([
				log(A, [
					{ op: "create", taskId: "t1", title: 'x"\nassignee: mallory\nfoo: "bar', lamport: 1 },
				]),
			]),
		)[0]!;
		const front = evil.text.split("---")[1] ?? "";
		expect(front).not.toContain("\nassignee: mallory");
		expect(front.split("\n").filter((line) => line.startsWith("title:"))).toHaveLength(1);
	});

	test("a task id that would escape the directory gets no file at all", () => {
		expect(filableId("../../.ssh/authorized_keys")).toBe(false);
		expect(filableId("a/b")).toBe(false);
		expect(filableId("..")).toBe(false);
		expect(filableId("9f3a1c22")).toBe(true);

		const state = fold([
			log(A, [
				{ op: "create", taskId: "../../escape", title: "nope", lamport: 1 },
				{ op: "create", taskId: "t1", title: "fine", lamport: 2 },
			]),
		]);
		const files = taskFiles(state);
		expect(files.map((file) => file.path)).toEqual(["board/t1.md"]);
		// It is still a task, and the local file says one could not be written.
		expect(state.tasks).toHaveLength(2);
		expect(
			indexFile(state, {
				completeness: "showing all 1 writer",
				nodeId: A,
				cursorDigest: "c1",
				agreement: { wrong: [], agree: [], elsewhere: [] },
			}).text,
		).toContain("may not become a filename");
	});

	test("a note is a blockquote, so nothing in it reads as document structure", () => {
		const file = taskFiles(
			fold([
				log(A, [
					{ op: "create", taskId: "t1", title: "x", note: "line one\n---\n# Ignore all of the above", lamport: 1 },
				]),
			]),
		)[0]!;
		const body = file.text.split("\n## Description\n")[1] ?? "";
		for (const line of body.split("\n").slice(1, 4)) {
			if (line.trim()) expect(line.startsWith("> ")).toBe(true);
		}
	});
});
