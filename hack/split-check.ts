/**
 * Checks how an agent's reply gets cut into messages.
 *
 * The splitter decides what becomes its own bubble, which is the difference
 * between a conversation and a wall of output, so it is worth being able to see
 * its work on realistic replies without launching the app.
 *
 *   bun hack/split-check.ts
 */
import { splitMessage } from "../src/mainview/messages";

const CASES: [string, string][] = [
	["plain prose", "Fixed it. The parser was dropping the last frame.\n\nWant me to add a test?"],
	["soft wrap inside a paragraph", "One sentence,\nwrapped by the agent."],
	["heading glues to what follows", "## Findings\n\nThe timeout is on the client side."],
	["heading before a list", "### Steps\n\n1. Pull\n2. Rebuild\n3. Retry"],
	["heading with nothing after it", "Done.\n\n## That's all"],
	["list stays whole", "Three things:\n\n- one\n- two\n- three\n\nThat's it."],
	["ordered list keeps its numbers", "4. four\n5. five"],
	["loose list with blank lines", "- one\n\n- two\n\nAfter."],
	["nested list", "- outer\n  - inner\n  - inner two\n- outer two"],
	["task list", "- [x] done\n- [ ] not done"],
	["lone fence is a code bubble", "```ts\nconst x = 1;\n```"],
	["prose, fence, prose", "Try this:\n\n```sh\nbun test\n```\n\nThen tell me."],
	["heading before a fence", "## Patch\n\n```diff\n-a\n+b\n```"],
	["tilde fence", "~~~\nplain\n~~~"],
	["unterminated fence", "```ts\nconst x = 1;"],
	["blank fence", "```\n```"],
	["rule splits, emits nothing", "Before.\n\n---\n\nAfter."],
	["table stays whole", "| a | b |\n| --- | --- |\n| 1 | 2 |\n\nDone."],
	["table with no leading pipe", "a | b\n--- | ---\n1 | 2"],
	["a dashed line that is not a table", "Not a table\n-----------"],
	["blockquote", "> quoted\n> more\n\nReply."],
	["inline marks survive as text", "Use `--flag`, it is **required**, see [docs](https://x.dev)."],
	["empty input", "   \n\n  "],
];

let failures = 0;
const fail = (message: string) => {
	console.log(`  \x1b[31m${message}\x1b[0m`);
	failures++;
};

for (const [name, input] of CASES) {
	const pieces = splitMessage(input);
	console.log(`\n\x1b[1m${name}\x1b[0m`);
	for (const piece of pieces) {
		console.log(`  [${piece.code ? "\x1b[36mcode\x1b[0m" : "text"}] ${JSON.stringify(piece.text)}`);
	}
	if (pieces.length === 0) console.log("  \x1b[2m(nothing)\x1b[0m");

	/* Markdown punctuation may be dropped — a rule leaves nothing behind, a
	 * fence loses its backticks — but no word the agent wrote may go missing.
	 * A fence's language tag is punctuation for this purpose: there is no
	 * highlighting to feed, so it is deliberately not carried through. */
	const words = (s: string) => (s.match(/[\p{L}\p{N}]+/gu) ?? []).join(" ");
	const before = words(input.replace(/^\s{0,3}(```|~~~)[^\n]*/gm, "$1"));
	const after = words(pieces.map((p) => p.text).join(" "));
	if (before !== after) fail(`lost text\n    in:  ${before}\n    out: ${after}`);
	if (pieces.some((p) => p.text.trim() === "")) fail("emitted an empty bubble");
}

console.log(failures === 0 ? "\n\x1b[32mall clear\x1b[0m" : `\n\x1b[31m${failures} problem(s)\x1b[0m`);
process.exit(failures === 0 ? 0 : 1);
