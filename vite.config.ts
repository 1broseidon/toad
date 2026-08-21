import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { electrobunViteAliases } from "./.hutch/devkit/api/config/electrobun-vite";

export default defineConfig({
	plugins: [react()],
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
