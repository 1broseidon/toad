/**
 * Checks the contrast of the text pairings the palette promises.
 *
 * The tokens are authored in OKLCH, where lightness is perceptual and says
 * nothing directly about WCAG's ratio — so "L88 versus L19 is obviously fine" is
 * a guess. This converts and measures.
 *
 *   bun scripts/contrast-check.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync(join(import.meta.dir, "../tokens.css"), "utf8");

/** Every `--name: oklch(...)` in the token file, alpha ignored. */
function tokens(): Map<string, [number, number, number]> {
	const found = new Map<string, [number, number, number]>();
	const pattern = /--([\w-]+):\s*oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)/g;
	for (const [, name, l, c, h] of css.matchAll(pattern)) {
		found.set(name, [Number(l) / 100, Number(c), Number(h)]);
	}
	return found;
}

/** OKLCH to sRGB, via OKLab and linear RGB. */
function toSrgb([L, C, H]: [number, number, number]): [number, number, number] {
	const a = C * Math.cos((H * Math.PI) / 180);
	const b = C * Math.sin((H * Math.PI) / 180);

	const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
	const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
	const s_ = L - 0.0894841775 * a - 1.291485548 * b;
	const [l, m, s] = [l_ ** 3, m_ ** 3, s_ ** 3];

	return [
		4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
		-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
		-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
	];
}

/** WCAG relative luminance from linear-light RGB. */
function luminance(linear: [number, number, number]): number {
	const [r, g, b] = linear.map((v) => Math.max(0, Math.min(1, v))) as [number, number, number];
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a: string, b: string): number {
	const map = tokens();
	const one = map.get(a);
	const two = map.get(b);
	if (!one || !two) throw new Error(`unknown token: ${!one ? a : b}`);
	const [x, y] = [luminance(toSrgb(one)), luminance(toSrgb(two))];
	return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** [foreground, background, floor, what it is] */
const PAIRS: [string, string, number, string][] = [
	["color-ink", "color-said-me", 4.5, "your own message"],
	["color-ink", "color-said-them", 4.5, "a teammate's message"],
	/* Not a text pairing: the two voices are both dark now, and the whole point
	 * is that they still read as two. A ratio this low is a surface difference
	 * rather than a contrast requirement — it is here so that nudging either
	 * bubble's lightness cannot quietly collapse them into one. */
	["color-said-me", "color-said-them", 1.35, "one voice beside the other"],
	["color-ink", "color-paper-4", 4.5, "an inline code chip"],
	["color-ink-2", "color-said-them", 4.5, "a quote in a message"],
	["color-ink-3", "color-said-them", 4.5, "a table heading"],
	["color-ink", "color-paper", 4.5, "body text on the page"],
	["color-ink-3", "color-paper", 4.5, "a timestamp"],
	["color-ink-3", "color-paper-4", 4.5, "the active roster row"],
	["color-accent", "color-said-them", 4.5, "a link in a message"],
	["color-accent-ink", "color-accent", 4.5, "a primary button"],
	// Non-text: a control's edge only has to be found, not read.
	["color-rule-strong", "color-paper", 3, "a field border"],
];

// Every identity hue carries the same initial, so every one has to hold it.
for (let n = 1; n <= 7; n++) {
	PAIRS.push(["face-ink", `face-${n}`, 4.5, `the initial on face ${n}`]);
}

let failures = 0;
for (const [fg, bg, floor, what] of PAIRS) {
	const value = ratio(fg, bg);
	const ok = value >= floor;
	if (!ok) failures++;
	const mark = ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
	console.log(`${mark} ${value.toFixed(2)}:1 (needs ${floor}) — ${what}`);
}

console.log(
	failures === 0 ? "\n\x1b[32mcontrast holds\x1b[0m" : `\n\x1b[31m${failures} pairing(s) too faint\x1b[0m`,
);
process.exit(failures === 0 ? 0 : 1);
