import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync } from "node:fs";

/**
 * Renders the Toad mark into a macOS .iconset and the menu-bar template images.
 *
 * `iconutil` wants exact pixel sizes, and downsampling one big render blurs the
 * small ones — so each size is rendered on its own at native resolution.
 *
 * The dock tile is drawn here rather than left to the OS: .iconset artwork is
 * used as-is, so the rounded square, its inset, and the background are ours to
 * supply. Proportions follow Apple's grid — the tile is 80% of the canvas with
 * a corner radius just over a fifth of its width.
 */

const ROOT = "/Users/gdikeakos/Projects/active/toad";
const ICONSET = `${ROOT}/icon.iconset`;
const TRAY = `${ROOT}/src/mainview/tray`;

/**
 * The mark, cropped to its own ink.
 *
 * The 64-square the mark is authored in has air above and below it, so scaling
 * that box inside the tile leaves the art looking shrunken. The viewBox here is
 * the content's real bounds — 4..60 across, 19.5..48 down — so the percentage
 * below means what it says.
 */
const MARK = (fill) => `
	<svg viewBox="4 19.5 56 28.5" width="64%" style="display:block">
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

const tile = (size) => `<!doctype html>
<html><body style="margin:0;width:${size}px;height:${size}px;background:transparent">
	<div style="
		position:absolute; inset:9%;
		background:linear-gradient(oklch(17% 0.008 250), oklch(12% 0.005 250));
		border-radius:22.4%;
		display:flex; align-items:center; justify-content:center;
		box-shadow: inset 0 ${size / 256}px 0 0 oklch(34% 0.03 150 / 0.55);
	">${MARK("oklch(76% 0.17 142)")}</div>
</body></html>`;

/* The menu bar tints template images itself, so this one is pure black on
 * transparent — any colour in it would be thrown away. */
const template = (size) => `<!doctype html>
<html><body style="margin:0;width:${size}px;height:${size}px;background:transparent">
	<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center">
		<svg viewBox="4 19.5 56 28.5" width="100%" style="display:block">			<mask id="p" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
				<rect width="64" height="64" fill="#fff"/>
				<rect x="14.5" y="28" width="11" height="4" rx="2" fill="#000"/>
				<rect x="38.5" y="28" width="11" height="4" rx="2" fill="#000"/>
			</mask>
			<g mask="url(#p)" fill="#000">
				<rect x="4" y="30" width="56" height="18" rx="6"/>
				<circle cx="20" cy="30" r="10.5"/>
				<circle cx="44" cy="30" r="10.5"/>
			</g>
		</svg>
	</div>
</body></html>`;

const SIZES = [
	["icon_16x16.png", 16],
	["icon_16x16@2x.png", 32],
	["icon_32x32.png", 32],
	["icon_32x32@2x.png", 64],
	["icon_128x128.png", 128],
	["icon_128x128@2x.png", 256],
	["icon_256x256.png", 256],
	["icon_256x256@2x.png", 512],
	["icon_512x512.png", 512],
	["icon_512x512@2x.png", 1024],
];

mkdirSync(ICONSET, { recursive: true });
mkdirSync(TRAY, { recursive: true });

const browser = await chromium.launch({
	executablePath:
		"/Users/gdikeakos/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell",
});

async function shoot(html, size, out) {
	const page = await browser.newPage({
		viewport: { width: size, height: size },
		deviceScaleFactor: 1,
	});
	await page.setContent(html);
	const buf = await page.screenshot({ omitBackground: true });
	writeFileSync(out, buf);
	await page.close();
}

for (const [name, size] of SIZES) await shoot(tile(size), size, `${ICONSET}/${name}`);
// Menu bar art is measured in points; @2x is what actually gets shown.
await shoot(template(18), 18, `${TRAY}/trayTemplate.png`);
await shoot(template(36), 36, `${TRAY}/trayTemplate@2x.png`);

await browser.close();
console.log(`Wrote ${SIZES.length} icons to icon.iconset and 2 tray templates.`);
