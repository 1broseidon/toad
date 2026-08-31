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
		// The other half of the tree: scripts/ and every *.test.ts, which the
		// first pass excludes. Bun strips types, so a harness whose production
		// signature moved under it still runs green and wrong until something
		// happens to exercise the changed path — which is how `Deps.threadRead`
		// went missing from a dozen of them unnoticed. Kept beside `typecheck`
		// rather than folded into it: one gates the app, this gates the proofs.
		"typecheck:scripts": "hutch pm x tsc --noEmit -p tsconfig.scripts.json",
		verify: "bun scripts/verify-toad.ts",
		"verify:mcp": "bun scripts/verify-mcp-sidecar.ts",
		// `hutch run` executes a script under Cottontail, which cannot load the
		// built-in agent's dependency tree (typebox, among others). Scripts that
		// import it therefore go through the raw shell runner so they get real Bun.
		// `verify` itself is safe: the agent factory imports that tree on demand, so
		// an ACP-only run never touches it.
		"verify:mcp-servers": "hutch pm exec 'bun scripts/verify-mcp-servers.ts'",
		// Every silent absence, named. Both agent kinds, against the tools that
		// exist today: the compatibility deny, the Windows allowlist, a policy
		// naming a deleted server, a server that will not start, search switched
		// off. A tool that is not there has to say why, or it is the bug again.
		"verify:tool-ledger": "hutch pm exec 'bun scripts/verify-tool-ledger.ts'",
		// A plugin from install to uninstall: the manifest is authoritative and a
		// live tools/list that disagrees refuses the install; one registration
		// reaches Toad Agent and reaches an ACP backend that is NOT on the
		// sidecar allow-list; the proxy's initialize is what turns "handed over"
		// into "verified"; a stopped plugin names the tool instead of losing it.
		"verify:plugin-tools": "hutch pm exec 'bun scripts/verify-plugin-tools.ts'",
		// The sessions a plugin is FOR, which are not the one a human types into:
		// the turn a teammate answers another agent's DM in, and the subagent it
		// hands work to. A real ACP child dials the descriptors it is handed —
		// the seam every earlier plugin proof scripted past — and a real pi
		// subagent calls the tool it inherited.
		"verify:plugin-attach": "hutch pm exec 'bun scripts/verify-plugin-attach.ts'",
		"verify:plugin-log": "hutch pm exec 'bun scripts/verify-plugin-log.ts'",
		// The board's lease semantics across two real desks — release, reclaim and
		// the progress renewal that changes the other desk's answer — plus the
		// brainfile projection each desk writes with its own filesystem.
		"verify:plugin-board": "hutch pm exec 'bun scripts/verify-plugin-board.ts'",
		// The claims the whole plugin design was argued on, in one run: Toad knows
		// the tool NAMES on both agent kinds; a tool that did not load is absent
		// with the cause, provoked for real twice; two desks partition, both claim
		// the same task and converge on one winner with the loser told; a reclaim
		// decided by two numbers in the log and no clock; writing another desk's
		// log having no expressible shape. It ends by running the tape's own gate
		// — replicas.test.ts and verify-transcripts.ts, unchanged — because a
		// plugin API is not worth destabilising the thing Toad is for.
		"verify:plugin": "hutch pm exec 'bun scripts/verify-plugin.ts'",
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
		// The room's certificate authority, on real HTTPS doors: one root, a leaf
		// under it that openssl verifies, a desk whose address moves keeping the
		// root byte-identical so trust already installed survives, a second desk
		// the same file opens, and a desk that cannot open the root serving
		// self-signed rather than going dark. Every key a named-curve key.
		"verify:room-ca": "bun scripts/verify-room-ca.ts",
		"verify:federation": "bun scripts/verify-federation.ts",
		"verify:mesh-closure": "bun scripts/verify-mesh-closure.ts",
		"verify:membership": "bun scripts/verify-membership.ts",
		// The client seat: an outside MCP agent joining the room the way a phone
		// does. Two desks, a real HTTPS door and a real MCP client — the
		// enrollment code gates registration and is worthless spent or expired,
		// the seat replicates so the desk that never showed a code still honours
		// it, a real teammate answers and its own tape names the agent and the
		// desk it came in through, and the owner can narrow or revoke a
		// connected agent mid-session.
		"verify:mcp-seat": "bun scripts/verify-mcp-seat.ts",
		// The other door onto that seat: 127.0.0.1 in the clear, for an agent
		// running on this very machine. Node ignores the OS trust store, so the
		// room's CA never removed the per-client act for the clients we actually
		// use; loopback does, because there is no network to keep a secret from.
		// Proven with a stock client that cannot open the https door at all —
		// and the 0.0.0.0 plain door still refuses every part of the seat.
		"verify:seat-loopback": "bun scripts/verify-seat-loopback.ts",
		"verify:capabilities": "bun scripts/verify-capabilities.ts",
		// Provider keys on the plane: opt-in replication, one sealed box per
		// desk, revocation as a fact, and a teardown that reports a dark desk
		// as pending rather than done.
		"verify:credentials": "bun scripts/verify-credentials.ts",
		// A phone's address on the plane: registered on its pairing desk,
		// sealed to every other, pruned as a fact the owner publishes, and
		// withdrawn through a teardown that waits on a dark desk. The APNs
		// signing key rides the credential path beside it, because an address
		// you cannot post to is not reach.
		"verify:push": "bun scripts/verify-push.ts",
		// Three desks and a fake Apple with a listener each, so the port a post
		// arrives on names the desk that sent it: one event is one post, the
		// prune starts as a real `BadDeviceToken` rather than an injected fact,
		// and the pane each desk would draw is checked against what that desk
		// would actually do.
		"verify:push-plane": "bun scripts/verify-push-plane.ts",
		// The persona hop: one teammate, one tape, moving between desks.
		"verify:hop": "bun scripts/verify-hop.ts",
		"verify:update": "bun scripts/verify-update.ts",
		// A schedule's two ends: one line in, and nothing out when the user
		// asked a job to stay out of the chat.
		"verify:scheduled-quiet": "bun scripts/verify-scheduled-quiet.ts",
		// A thread bubble's two ticks, including the one that has to travel
		// back from the desk that asked, and who a thread says is working in it.
		"verify:peer-receipts": "bun scripts/verify-peer-receipts.ts",
		// An agent's ring on its own message: the closed set, the structural
		// rate guard, and the user's hand taking one off again. Through the
		// package manager, because it reads the pi wrappers' inheritance table
		// and Cottontail cannot load that tree.
		"verify:ring": "hutch pm exec 'bun scripts/verify-ring.ts'",
		// The other half of the ring: that the mark outlives the screen. Two
		// desks on the real node plane — the intent crosses as bytes and as
		// meaning, the clearing crosses too, and both survive the restart
		// compaction that rewrites the segment underneath the mirror.
		"verify:ring-plane": "bun scripts/verify-ring-plane.ts",
		// The licence policy refusing a real copyleft fixture, and the build
		// wiring that gets the generated notices into the bundle.
		"verify:notices": "bun scripts/verify-notices.ts",
		// Native shell: Vite bundle into dist/, then Capacitor copies it into ios/.
		// Live reload on a phone: TOAD_CAP_LIVE=http://<lan>:5173 hutch run ios
		ios: "hutch pm x vite build && bun x cap sync ios",
	},
};
