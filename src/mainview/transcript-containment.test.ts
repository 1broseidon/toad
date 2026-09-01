import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The two rules that keep the conversation from scrolling sideways.
 *
 * This is a guard, not a rendering proof — nothing here can tell you what the
 * window looks like. What it can tell you is that the two structural rules are
 * still in the stylesheet and still attached to the element they were written
 * for, which is the failure that actually happened: a card overflowed, the
 * transcript's undeclared `overflow-x: auto` turned the whole chat into a
 * left-right pannable surface, and nothing in the tree said it must not.
 *
 * Both are load-bearing for a surface no test can see, and both are one line
 * long, which is exactly the kind of line that gets tidied away by someone who
 * cannot see what it was holding up.
 */

const here = new URL(".", import.meta.url).pathname;
const css = readFileSync(join(here, "index.css"), "utf8");
const transcript = readFileSync(join(here, "components", "Transcript.tsx"), "utf8");

/** The declarations of one class rule, by its exact selector. */
function ruleBody(selector: string): string {
	const at = css.indexOf(`\n\t${selector} {`);
	expect(at, `no rule for \`${selector}\``).toBeGreaterThan(-1);
	const open = css.indexOf("{", at);
	const close = css.indexOf("}", open);
	return css.slice(open + 1, close);
}

describe("the transcript column cannot scroll sideways", () => {
	test("the scroller carries the class the rule is written for", () => {
		expect(transcript).toContain("transcript-scroll");
		// The bug: `overflow-y: auto` alone computes the other axis to `auto`.
		expect(transcript).toContain("overflow-y-auto");
	});

	test("and the rule shuts the other axis", () => {
		expect(ruleBody(".transcript-scroll")).toMatch(/overflow-x:\s*(clip|hidden)/);
	});
});

describe("an attention card's answers fit the card", () => {
	test("the ask and hand-to-human cards share one action row", () => {
		// Two cards, one class: a fix applied to only one of them is the shape
		// this whole task came from.
		expect(transcript.split('<div className="ask-actions">').length - 1).toBe(2);
	});

	test("its buttons may give, against `.btn`'s shrink-0 everywhere else", () => {
		const body = ruleBody(".ask-actions > button");
		// All three matter: shrink so the line can give, min-width so the shrink
		// is not floored at the label's own min-content, white-space so the label
		// then wraps inside the button rather than overflowing it.
		expect(body).toMatch(/flex-shrink:\s*1/);
		expect(body).toMatch(/min-width:\s*0/);
		expect(body).toMatch(/white-space:\s*normal/);
	});

	test("nothing in the row is pinned to a width", () => {
		expect(ruleBody(".ask-actions")).not.toMatch(/(^|[^-])width:\s*(?!auto)\d/);
	});
});

describe("the ring is paint", () => {
	test("it draws on the bubble's edge and nowhere else", () => {
		const body = ruleBody(".bubble-line[data-ring] .bubble");
		expect(body).toMatch(/box-shadow/);
		// The row wash and the eyebrow were the loud parts; they do not come back.
		expect(css).not.toContain("--ring-wash");
		expect(css).not.toContain("ring-eyebrow");
	});

	test("each intent paints in its own family and only its own", () => {
		for (const [attr, family] of [
			["", "accent"],
			['="warn"', "warn"],
			['="danger"', "danger"],
		] as const) {
			const body = ruleBody(`.bubble-line[data-ring${attr}]`);
			expect(body).toContain(`--ring-edge: var(--color-${family}-edge)`);
			// One intent, one colour: no second token layered on top.
			expect(body.match(/var\(--color-/g)?.length).toBe(1);
		}
	});
});
