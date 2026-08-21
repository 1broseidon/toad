import type { ElectrobunConfig } from "electrobun";

export default {
	app: {
		name: "Toad",
		identifier: "sh.toad.desktop",
		version: "0.1.0",
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
			"dist/mcp-sidecar.js": "mcp/sidecar.js",
			// The menu bar reads its art from the bundle at runtime, so these are
			// copied in rather than imported through the view build.
			"src/mainview/tray": "views/mainview/tray",
		},
		watchIgnore: ["dist/**"],
		mac: {
			bundleCEF: false,
			// Rendered from assets/toad-mark.svg by `node hack/render-icons.mjs`.
			icons: "icon.iconset",
		},
		linux: {
			bundleCEF: false,
		},
		win: {
			bundleCEF: false,
		},
	},
	runtime: {
		// Closing the window hides it — see the will-close handler in src/bun/index.ts.
		// The teammates run in this process, and they outlive the view onto them.
		exitOnLastWindowClosed: false,
	},
	release: {
		// First local 0.1.0: there is no previous published bundle to diff
		// against. The default is true, and with an empty baseUrl the stable
		// packager waits on that fetch instead of finishing.
		generatePatch: false,
	},
} satisfies ElectrobunConfig;
