/**
 * Where one message ends and the next begins.
 *
 * An agent hands over a whole reply at once. A conversation is made of separate
 * messages, so something has to decide where to cut, and that decision is what
 * makes a transcript read like someone talking rather than a page of output.
 * It lives on its own because it is pure text in, pure text out — see
 * `hack/split-check.ts`.
 */

export type Piece = { text: string; code: boolean };

/**
 * Markdown flattened to the single line a roster row can hold.
 *
 * An agent's reply often opens with a heading, a bullet, or a fence, and the
 * raw source of any of those reads as punctuation soup at 11px. Lossy on
 * purpose: this is a glance at what was said, not the thing itself.
 */
export function plainOf(source: string): string {
	return source
		.replace(/^\s{0,3}(```|~~~).*$/gm, "") // fence delimiters, keeping the body
		.replace(/^\s{0,3}#{1,6}\s+/gm, "") // heading hashes
		.replace(/^\s{0,3}>\s?/gm, "") // quote marks
		.replace(/^\s*([-*+]|\d{1,9}[.)])\s+/gm, "") // list markers
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // links and images, keeping the text
		.replace(/[*_~`]/g, "") // emphasis and code marks
		.replace(/\s+/g, " ")
		.trim();
}

const FENCE = /^\s{0,3}(```|~~~)/;
const HEADING = /^\s{0,3}#{1,6}\s/;
const RULE = /^\s{0,3}([-*_])[ \t]*(\1[ \t]*){2,}$/;
const ITEM = /^\s*([-*+]|\d{1,9}[.)])\s/;
const QUOTE = /^\s{0,3}>/;
const CONTINUATION = /^\s+\S/;

/**
 * Cuts an agent's reply into the messages it would have sent one at a time.
 *
 * The unit is the markdown block, because that is what a person's message
 * boundary actually is. A paragraph goes alone. A list, a table, a quote and a
 * fence each stay whole, since half a table says nothing. A heading joins the
 * block below it — someone writing "**Findings**" above a paragraph is sending
 * one message, not two. A horizontal rule sends nothing and just closes the one
 * in progress, which is roughly what it was drawn for.
 *
 * This is also the seam where a block could become something richer than text
 * later; a table rendered from markdown is the simplest version of that.
 */
export function splitMessage(source: string): Piece[] {
	const lines = source.replace(/\r\n?/g, "\n").split("\n");
	const pieces: Piece[] = [];

	/* A heading waiting for something to introduce. */
	let lead: string[] = [];
	/* The paragraph being accumulated. */
	let held: string[] = [];

	const emit = (body: string) => {
		const text = body.trim();
		if (!text) return;
		const intro = lead.join("\n");
		lead = [];
		pieces.push({ text: intro ? `${intro}\n\n${text}` : text, code: false });
	};

	/** Ends the paragraph in progress, if there is one. */
	const breath = () => {
		const body = held.join("\n");
		held = [];
		emit(body);
	};

	/** Nothing followed the heading, so it speaks for itself. */
	const orphanLead = () => {
		if (lead.length === 0) return;
		const intro = lead.join("\n");
		lead = [];
		pieces.push({ text: intro, code: false });
	};

	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!;

		if (FENCE.test(line)) {
			breath();
			/* A fenced block becomes a bubble that is entirely code, so a heading
			 * above it cannot ride along and goes out on its own first. */
			orphanLead();
			const marker = line.trim().slice(0, 3);
			const body: string[] = [];
			index++;
			while (index < lines.length && !lines[index]!.trimStart().startsWith(marker)) {
				body.push(lines[index]!);
				index++;
			}
			const code = body.join("\n").replace(/\s+$/, "");
			if (code) pieces.push({ text: code, code: true });
			continue;
		}

		if (RULE.test(line)) {
			breath();
			orphanLead();
			continue;
		}

		if (HEADING.test(line)) {
			breath();
			orphanLead();
			lead.push(line.trim());
			continue;
		}

		if (line.trim() === "") {
			breath();
			continue;
		}

		if (QUOTE.test(line)) {
			breath();
			const block: string[] = [];
			while (index < lines.length && (QUOTE.test(lines[index]!) || lines[index]!.trim() !== "")) {
				block.push(lines[index]!);
				index++;
			}
			index--;
			emit(block.join("\n"));
			continue;
		}

		if (ITEM.test(line)) {
			breath();
			const block: string[] = [];
			while (index < lines.length) {
				const next = lines[index]!;
				const blank = next.trim() === "";
				/* A blank line inside a list is only a gap if the list carries on
				 * past it; otherwise it is the end. */
				if (blank && !ITEM.test(lines[index + 1] ?? "") && !CONTINUATION.test(lines[index + 1] ?? ""))
					break;
				if (!blank && !ITEM.test(next) && !CONTINUATION.test(next)) break;
				block.push(next);
				index++;
			}
			index--;
			emit(block.join("\n"));
			continue;
		}

		if (isTableStart(line, lines[index + 1])) {
			breath();
			const block: string[] = [];
			while (index < lines.length && lines[index]!.includes("|")) {
				block.push(lines[index]!);
				index++;
			}
			index--;
			emit(block.join("\n"));
			continue;
		}

		held.push(line);
	}

	breath();
	orphanLead();
	return pieces;
}

/** A row of cells is only a table once the divider under it says so. */
function isTableStart(line: string, next: string | undefined): boolean {
	if (!line.includes("|") || !next) return false;
	return next.includes("-") && /^[\s|:-]+$/.test(next);
}

/**
 * When something was said, at the grain a roster row has room for.
 *
 * The phone's rows carry these the way a messages app does: a moment ago is
 * "now", the same hour is minutes, the same day is hours, the same week is
 * the day's name, and anything older is a date. Nothing live updates them —
 * a row repaints when its preview changes, which is also when the answer
 * changes enough to matter.
 */
export function timeAgoShort(at: number, now = Date.now()): string {
	const delta = now - at;
	if (delta < 60_000) return "now";
	if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m`;
	if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h`;
	if (delta < 7 * 86_400_000) {
		return new Date(at).toLocaleDateString(undefined, { weekday: "short" });
	}
	return new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
