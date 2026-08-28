// @hutch cli=0.22.0 cottontail=0.5.0
export default {
	electrobun: {
		version: "2.0.1-beta.22",
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
		// The licences of everything in the bundle. Not optional and not
		// advisory: this exits non-zero on a dependency whose licence the
		// project does not expect, so an unreviewed one stops the build here
		// rather than shipping inside a binary.
		notices: "bun scripts/generate-notices.ts",
		// vite's `emptyOutDir` wipes dist/ before writing, so the sidecar bundle
		// and the notices file (also written into dist/) must be built AFTER
		// vite build, or vite deletes them before electrobun's sync/copy step
		// ever sees them.
		start:
			"hutch electrobun sync && hutch pm x vite build && hutch run sidecar && hutch run notices && hutch electrobun dev",
		// On Linux the views:// page can open a host WebSocket that never
		// connects, so every RPC sits forever and the window says Loading….
		// Serving the built view over localhost lets the socket complete.
		preview:
			"./node_modules/.bin/vite preview --port 5173 --strictPort --host 127.0.0.1",
		dev:
			"hutch electrobun sync && hutch pm x vite build && hutch run sidecar && hutch run notices && ./node_modules/.bin/concurrently --kill-others-on-fail \"./node_modules/.bin/vite preview --port 5173 --strictPort --host 127.0.0.1\" \"hutch electrobun dev --watch\"",
		// One sync, then Vite and Electrobun together. Do not compose
		// `hutch run hmr` with `hutch run start`: both call `electrobun sync`,
		// `electrobun dev` holds that lock for its lifetime, Vite never binds
		// 5173, and the window sits on Loading….
		"dev:hmr":
			"hutch electrobun sync && hutch run sidecar && hutch run notices && ./node_modules/.bin/concurrently --kill-others-on-fail \"./node_modules/.bin/vite --port 5173 --strictPort --host 127.0.0.1\" \"hutch electrobun dev --watch\"",
		hmr: "./node_modules/.bin/vite --port 5173 --strictPort --host 127.0.0.1",
		build:
			"bun scripts/verify-pi-patch.ts && hutch electrobun sync && hutch pm x vite build && hutch run sidecar && hutch run notices && hutch electrobun build --env=stable",
		typecheck: "hutch pm x tsc --noEmit",
		verify: "bun scripts/verify-toad.ts",
		"verify:mcp": "bun scripts/verify-mcp-sidecar.ts",
		// `hutch run` executes a script under Cottontail, which cannot load the
		// built-in agent's dependency tree (typebox, among others). Scripts that
		// import it therefore go through the raw shell runner so they get real Bun.
		// `verify` itself is safe: the agent factory imports that tree on demand, so
		// an ACP-only run never touches it.
		"verify:mcp-servers": "hutch pm exec 'bun scripts/verify-mcp-servers.ts'",
		// Provider discovery and one complete SDK-owned key setup/logout, under a
		// temporary HOME so it cannot touch the user's credentials.
		"verify:auth": "hutch pm exec 'bun scripts/verify-provider-auth.ts'",
		// The built-in agent has to survive bundling, which is a different program
		// from the one `verify` drives. See the file for what breaks and why.
		"verify:pi": "bun scripts/verify-pi-patch.ts && bun scripts/verify-pi-bundle.ts",
		"verify:pi-patch": "bun scripts/verify-pi-patch.ts",
		"verify:pi-isolation": "bun scripts/verify-pi-isolation.ts",
		"verify:pi-subagent": "hutch pm exec 'bun scripts/verify-pi-subagent.ts'",
		"verify:child-env": "bun scripts/verify-child-env.ts",
		"verify:frames": "bun scripts/probe-socket-write.ts",
		"verify:computer-driver": "bun scripts/verify-computer-driver.ts",
		"verify:computer-handshake": "hutch pm exec 'bun scripts/verify-computer-handshake.ts'",
		// Data safety: a damaged roster is recovered or held, never overwritten.
		"verify:roster-durability": "bun scripts/verify-roster-durability.ts",
		"verify:store-bundle": "bun scripts/verify-store-bundle.ts",
		"verify:web-pair": "bun scripts/verify-web-pair.ts",
		"verify:web-live": "bun scripts/verify-web-live.ts",
		"verify:mesh-plane": "bun scripts/verify-mesh-plane.ts",
		"verify:mesh-metrics": "bun scripts/verify-mesh-metrics.ts",
		"verify:node-admission": "bun scripts/verify-node-admission.ts",
		"verify:node-tls": "bun scripts/verify-node-tls.ts",
		"verify:federation": "bun scripts/verify-federation.ts",
		"verify:mesh-closure": "bun scripts/verify-mesh-closure.ts",
		"verify:membership": "bun scripts/verify-membership.ts",
		"verify:capabilities": "bun scripts/verify-capabilities.ts",
		"verify:update": "bun scripts/verify-update.ts",
		// The licence policy refusing a real copyleft fixture, and the build
		// wiring that gets the generated notices into the bundle.
		"verify:notices": "bun scripts/verify-notices.ts",
		// Native shell: Vite bundle into dist/, then Capacitor copies it into ios/.
		// Live reload on a phone: TOAD_CAP_LIVE=http://<lan>:5173 hutch run ios
		ios: "hutch pm x vite build && bun x cap sync ios",
	},
};
