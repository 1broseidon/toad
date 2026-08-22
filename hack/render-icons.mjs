import { chromium } from "playwright-core";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Renders the Toad mark into a macOS .iconset, the iOS app icon, and the
 * status-icon art.
 *
 * `iconutil` wants exact pixel sizes, and downsampling one big render blurs the
 * small ones — so each size is rendered on its own at native resolution.
 *
 * The dock tile is drawn here rather than left to the OS: .iconset artwork is
 * used as-is, so the rounded square, its inset, and the background are ours to
 * supply. Proportions follow Apple's grid — the tile is 80% of the canvas with
 * a corner radius just over a fifth of its width.
 *
 * Takes an optional group to render — `mac`, `ios`, or `tray`. Chrome renders
 * text and gradients a little differently between versions, so re-running the
 * whole set on a new machine rewrites every file; naming one group keeps a
 * change to the iOS icon out of the committed macOS art.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const ICONSET = `${ROOT}/icon.iconset`;
const TRAY = `${ROOT}/src/mainview/tray`;
const XCASSETS = `${ROOT}/ios/App/App/Assets.xcassets`;
const IOS = `${XCASSETS}/AppIcon.appiconset`;
const MARK_SET = `${XCASSETS}/LaunchMark.imageset`;

/** How wide the launch-screen mark sits, in points — about a third of a phone. */
const LAUNCH_MARK_PT = 120;

const only = process.argv[2];
const wants = (group) => !only || only === group;

/**
 * The mark, cropped to its own ink.
 *
 * The 64-square the mark is authored in has air above and below it, so scaling
 * that box inside the tile leaves the art looking shrunken. The viewBox here is
 * the content's real bounds — 4..60 across, 19.5..48 down — so the percentage
 * below means what it says.
 */
const MARK = (fill, width = "64%") => `
	<svg viewBox="4 19.5 56 28.5" width="${width}" style="display:block">
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

const ACCENT = "oklch(76% 0.17 142)";

const tile = (size) => `<!doctype html>
<html><body style="margin:0;width:${size}px;height:${size}px;background:transparent">
	<div style="
		position:absolute; inset:9%;
		background:linear-gradient(oklch(17% 0.008 250), oklch(12% 0.005 250));
		border-radius:22.4%;
		display:flex; align-items:center; justify-content:center;
		box-shadow: inset 0 ${size / 256}px 0 0 oklch(34% 0.03 150 / 0.55);
	">${MARK(ACCENT)}</div>
</body></html>`;

/*
 * The iOS home-screen tile: the same art, full bleed.
 *
 * iOS masks the corners itself and reads no alpha, so drawing our own rounded
 * square inside a transparent canvas — what the dock tile does — would leave a
 * dark ring around a smaller icon. The gradient runs edge to edge instead, and
 * the mark keeps the same share of the visible tile as it has on the desktop.
 */
const iosTile = (size) => `<!doctype html>
<html><body style="margin:0;width:${size}px;height:${size}px">
	<div style="
		position:absolute; inset:0;
		background:linear-gradient(oklch(17% 0.008 250), oklch(12% 0.005 250));
		display:flex; align-items:center; justify-content:center;
		box-shadow: inset 0 ${size / 256}px 0 0 oklch(34% 0.03 150 / 0.55);
	">${MARK(ACCENT)}</div>
</body></html>`;

/*
 * The status icon: the bare mark on transparent, no tile behind it.
 *
 * One flat colour, because that is all a panel can use. The macOS menu bar
 * tints a template image itself and only reads the alpha, so black is written
 * there and any colour would be thrown away. Linux and Windows tint nothing —
 * see src/bun/panel-ink.ts — so each ink is rendered as its own file and picked
 * at runtime.
 */
const flat = (size, fill) => `<!doctype html>
<html><body style="margin:0;width:${size}px;height:${size}px;background:transparent">
	<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center">
		${MARK(fill, "100%")}
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
mkdirSync(IOS, { recursive: true });
mkdirSync(MARK_SET, { recursive: true });

/*
 * playwright-core ships no browser of its own, and nobody should have to run
 * `playwright install` to change a logo. Any Chrome on the machine renders this
 * identically, so take the first one there is — overridable, because the one
 * you want is not always the one found first.
 */
const CHROMES = [
	process.env.TOAD_CHROMIUM,
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/Applications/Chromium.app/Contents/MacOS/Chromium",
	"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
	"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];
const executablePath = CHROMES.find((p) => p && existsSync(p));
if (!executablePath) throw new Error("No Chrome found. Set TOAD_CHROMIUM to one.");

const browser = await chromium.launch({ executablePath });

async function shoot(html, size, out, { opaque = false } = {}) {
	const page = await browser.newPage({
		viewport: { width: size, height: size },
		deviceScaleFactor: 1,
	});
	await page.setContent(html);
	const buf = await page.screenshot({ omitBackground: !opaque });
	writeFileSync(out, buf);
	await page.close();
}

if (wants("mac"))
	for (const [name, size] of SIZES) await shoot(tile(size), size, `${ICONSET}/${name}`);

/* One 1024 is the whole iOS set — the asset catalog has taken a single size
 * since Xcode 14 and downsamples the rest at build time. */
if (wants("ios")) {
	await shoot(iosTile(1024), 1024, `${IOS}/AppIcon-512@2x.png`, { opaque: true });
	/* The launch mark is `flat`: iOS composites it over the colour named in
	 * UILaunchScreen, and centres it at its own size rather than scaling it to
	 * the screen — so the 1x edge is the width the mark actually wants to be. */
	for (const [scale, name] of [
		[1, "mark.png"],
		[2, "mark@2x.png"],
		[3, "mark@3x.png"],
	]) {
		const px = LAUNCH_MARK_PT * scale;
		await shoot(flat(px, ACCENT), px, `${MARK_SET}/${name}`);
	}
}

if (wants("tray")) {
	// Menu bar art is measured in points; @2x is what actually gets shown.
	await shoot(flat(18, "#000"), 18, `${TRAY}/trayTemplate.png`);
	await shoot(flat(36, "#000"), 36, `${TRAY}/trayTemplate@2x.png`);
	/* Panels elsewhere are sized by the desktop and scale whatever they are given,
	 * so there is one file per ink, rendered large enough to come down cleanly to
	 * the 16px Windows asks for and the ~22px a Linux panel usually is. */
	await shoot(flat(44, "#fff"), 44, `${TRAY}/trayWhite.png`);
	await shoot(flat(44, "#000"), 44, `${TRAY}/trayBlack.png`);
}

await browser.close();
console.log(`Wrote ${only ?? "all"} icons.`);
