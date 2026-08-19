// @hutch cli=0.11.0 cottontail=0.5.0
export default {
	electrobun: {
		version: "2.0.1-beta.15",
	},
	packageManager: "bun",
	scripts: {
		install: ["hutch", "pm", "install"],
		// "pm exec" is bun's own `bun exec`, a raw shell-string runner — it does not
		// resolve or forward args to a package binary the way npm/pnpm's "exec"
		// does, so it silently mis-runs anything given more than a bare command.
		// "pm x" is `bun x` (bunx), which does resolve-and-forward correctly.
		sidecar:
			"bun build src/bun/mcp/sidecar.ts --target=bun --outfile=dist/mcp-sidecar.js",
		// vite's `emptyOutDir` wipes dist/ before writing, so the sidecar bundle
		// (also written into dist/) must be built AFTER vite build, or vite
		// deletes it before electrobun's sync/copy step ever sees it.
		start:
			"hutch electrobun sync && hutch pm x vite build && hutch run sidecar && hutch electrobun dev",
		dev:
			"hutch electrobun sync && hutch pm x vite build && hutch run sidecar && hutch electrobun dev --watch",
		"dev:hmr": ["hutch", "pm", "x", "concurrently", "hutch run hmr", "hutch run start"],
		hmr: "hutch electrobun sync && hutch pm x vite --port 5173",
		build:
			"hutch electrobun sync && hutch pm x vite build && hutch run sidecar && hutch electrobun build --env=production",
		typecheck: "hutch pm x tsc --noEmit",
		verify: "bun hack/verify-toad.ts",
		"verify:mcp": "bun hack/verify-mcp-sidecar.ts",
		// `hutch run` executes a script under Cottontail, which cannot load the
		// built-in agent's dependency tree (typebox, among others). Scripts that
		// import it therefore go through the raw shell runner so they get real Bun.
		// `verify` itself is safe: the agent factory imports that tree on demand, so
		// an ACP-only run never touches it.
		"verify:mcp-servers": "hutch pm exec 'bun hack/verify-mcp-servers.ts'",
		// Provider discovery and one complete SDK-owned key setup/logout, under a
		// temporary HOME so it cannot touch the user's credentials.
		"verify:auth": "hutch pm exec 'bun hack/verify-provider-auth.ts'",
		// The built-in agent has to survive bundling, which is a different program
		// from the one `verify` drives. See the file for what breaks and why.
		"verify:pi": "bun hack/verify-pi-bundle.ts",
		"verify:frames": "bun hack/probe-socket-write.ts",
	},
};
