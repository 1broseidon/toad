import { readFileSync } from "node:fs";
import type { ElectrobunConfig } from "electrobun";
import { DESKTOP_IDENTIFIER, RELEASE_BASE_URL } from "./src/shared/release";

const version = (
	JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string }
).version;

export default {
	app: {
		name: "Toad",
		identifier: DESKTOP_IDENTIFIER,
		version,
	},
	build: {
		// Bun (not Cottontail) because the main process supervises N long-lived
		// agent subprocesses over stdio and needs Bun.spawn.
		mainProcess: "bun",
		bun: {
			entrypoint: "src/bun/index.ts",
			// Everything here besides `entrypoint` is handed to Bun.build.
			//
			// pi's HTTP dispatcher imports undici to configure proxies and timeouts.
			// Bundling npm's undici puts its full source in the app, where it
			// evaluates `new CacheStorage()` at module load and dies on a webidl
			// helper Bun does not provide. Left external, the import resolves at
			// runtime to the undici Bun already ships — which is the implementation
			// backing fetch here anyway, so it is also the one we want.
			external: ["undici"],
		},
		copy: {
			"dist/index.html": "views/mainview/index.html",
			"dist/assets": "views/mainview/assets",
			// Web mode's PWA face: the manifest and icon a phone reads.
			"dist/manifest.webmanifest": "views/mainview/manifest.webmanifest",
			"dist/toad-icon-512.png": "views/mainview/toad-icon-512.png",
			"dist/mcp-sidecar.js": "mcp/sidecar.js",
			// The licence of everything bundled here, written by
			// scripts/generate-notices.ts. Copied rather than imported so ~380 KB
			// of licence text is not also compiled into the main process, and so
			// the file a user is entitled to read exists as a file.
			"dist/third-party-notices.json": "notices/third-party.json",
			// The menu bar reads its art from the bundle at runtime, so these are
			// copied in rather than imported through the view build.
			"src/mainview/tray": "views/mainview/tray",
		},
		watchIgnore: ["dist/**"],
		mac: {
			bundleCEF: false,
			// Rendered from assets/toad-mark.svg by `node scripts/render-icons.mjs`.
			icons: "icon.iconset",
			// Secrets on the macOS runner turn these on. A Linux or unsigned
			// CI build leaves the env empty and Hutch skips both.
			codesign: Boolean(process.env.ELECTROBUN_DEVELOPER_ID),
			notarize: Boolean(
				process.env.ELECTROBUN_APPLEAPIKEY ||
					(process.env.ELECTROBUN_APPLEID &&
						process.env.ELECTROBUN_APPLEIDPASS &&
						process.env.ELECTROBUN_TEAMID),
			),
		},
		linux: {
			bundleCEF: false,
			// The same tile as the macOS dock, supplied as the PNG Linux expects.
			icon: "icon.iconset/icon_512x512.png",
		},
		win: {
			bundleCEF: false,
			// Hutch converts this PNG to an ICO, whose directory entry holds
			// each dimension in one byte — 256 is the largest a tile can be.
			icon: "icon.iconset/icon_256x256.png",
		},
	},
	runtime: {
		// Closing the window hides it — see the will-close handler in src/bun/index.ts.
		// The teammates run in this process, and they outlive the view onto them.
		exitOnLastWindowClosed: false,
	},
	release: {
		// Baked into version.json. Override with TOAD_UPDATE_BASE_URL for a
		// local file server; the default is what every installed build will
		// keep asking for.
		baseUrl: process.env.TOAD_UPDATE_BASE_URL || RELEASE_BASE_URL,
		// Full archives only. The first mac/win builds have no predecessor,
		// and the default (true) would fetch toad.team during every package.
		generatePatch: false,
	},
} satisfies ElectrobunConfig;
