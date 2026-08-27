import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { electrobunViteAliases } from "./.hutch/devkit/api/config/electrobun-vite";

// The one number the desktop releases under, handed to the view so a bundle
// can say which build it came from without a second copy drifting behind.
const { version } = JSON.parse(
	readFileSync(resolve(__dirname, "package.json"), "utf8"),
) as { version: string };

export default defineConfig({
	plugins: [react()],
	define: {
		__TOAD_VERSION__: JSON.stringify(version),
	},
	resolve: {
		alias: electrobunViteAliases(resolve(__dirname, ".hutch/devkit")),
	},
	root: "src/mainview",
	// noVNC uses top-level await, which the dep pre-bundler's es2020 target
	// rejects; leave it as native ESM and let the (modern) webview handle it.
	optimizeDeps: {
		exclude: ["@novnc/novnc"],
	},
	build: {
		outDir: "../../dist",
		emptyOutDir: true,
		target: "es2022",
	},
	server: {
		port: 5173,
		strictPort: true,
	},
});
