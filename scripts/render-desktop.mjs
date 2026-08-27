import { chromium } from "playwright-core";
import { writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Renders the computer's desktop wallpaper: the Toad mark, low contrast,
 * centred on paper. One image, committed into computer/rootfs so the
 * Dockerfile can copy it without a build-time browser.
 *
 * The palette is the app's own (tokens.css), pre-resolved from oklch to the
 * sRGB hex a PNG can carry: paper #040405, ink #edeef0. The mark sits at 8%
 * ink over paper — present when you look, invisible when you're working.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const OUT = `${ROOT}/computer/rootfs/wallpaper.png`;

const WIDTH = 1920;
const HEIGHT = 1080;

/* Same geometry as the mark in render-icons.mjs: the viewBox is the art's
 * real bounds so the width below means what it says. Opacity goes on the
 * svg, not the fill — the mark is overlapping shapes, and per-shape alpha
 * would print the seams. */
const MARK = (fill, opacity) => `
	<svg viewBox="4 19.5 56 28.5" width="440" style="display:block;opacity:${opacity}">
		<mask id="p" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
			<rect width="64" height="64" fill="#fff"/>
			<rect x="14.5" y="28" width="11" height="4" rx="2" fill="#000"/>
			<rect x="38.5" y="28" width="11" height="4" rx="2" fill="#000"/>
		</mask>
		<g mask="url(#p)" fill="${fill}">
			<rect x="4" y="30" width="56" height="18" rx="6"/>
			<circle cx="20" cy="30" r="10.5"/>
			<circle cx="44" cy="30" r="10.5"/>
		</g>
	</svg>`;

const page_html = `<!doctype html>
<html><body style="margin:0;width:${WIDTH}px;height:${HEIGHT}px;background:#040405;
	display:flex;align-items:center;justify-content:center">
	${MARK("#edeef0", 0.08)}
</body></html>`;

/* The repo is developed on more than one OS; take the first browser that
 * exists rather than hardcoding one machine's cache path. */
const candidates = [
	process.env.PLAYWRIGHT_CHROMIUM,
	"/usr/bin/google-chrome",
	"/usr/bin/chromium",
	"/snap/bin/chromium",
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);
const executablePath = candidates.find((p) => existsSync(p));
if (!executablePath) {
	console.error("no chromium found — set PLAYWRIGHT_CHROMIUM");
	process.exit(1);
}

const browser = await chromium.launch({ executablePath });
const page = await browser.newPage({
	viewport: { width: WIDTH, height: HEIGHT },
	deviceScaleFactor: 1,
});
await page.setContent(page_html);
writeFileSync(OUT, await page.screenshot());
await browser.close();
console.log(`wrote ${OUT}`);
