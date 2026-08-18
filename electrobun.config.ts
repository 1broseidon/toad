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
		},
		copy: {
			"dist/index.html": "views/mainview/index.html",
			"dist/assets": "views/mainview/assets",
			"dist/mcp-sidecar.js": "mcp/sidecar.js",
		},
		watchIgnore: ["dist/**"],
		mac: {
			bundleCEF: false,
		},
		linux: {
			bundleCEF: false,
		},
		win: {
			bundleCEF: false,
		},
	},
	runtime: {
		exitOnLastWindowClosed: true,
	},
} satisfies ElectrobunConfig;
