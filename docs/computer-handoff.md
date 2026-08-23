# Computer integration — handoff

State of the work as of 2026-08-20, for whoever picks this up (likely a
Claude Code session outside Toad). Read `docs/computer.md` first — it is the
spec this work implements. This file is what's done, what's broken, and what
to build next.

## Done and verified

- **`computer/`** — toad.computer, Go module `toad.computer`. Two external
  deps (`modelcontextprotocol/go-sdk` v1.7.0, `gorilla/websocket`).
  Env prefix is `TOAD_COMPUTER_*`, runtime dir `/tmp/toad-computer`.
- **Bearer auth restored** in `computer/cmd/computer-agent/serve.go`
  (`tokenAuth`): earlier fleet builds stubbed it out in favour of k8s network policy.
  `TOAD_COMPUTER_TOKEN` set → `Authorization: Bearer <token>` required on
  everything but `/health`; unset → open (QA mode, what's running now).
- **Image builds**: `docker build -t toad-computer:dev computer/`.
  Gotchas already fixed: NodeSource Node 22 (bookworm's 18 is under
  Playwright's floor), `rm -rf /tmp/*` tolerating root-owned npm droppings,
  xterm in a late layer.
- **`hack/verify-computer.ts`** — 17 checks, all passing against the
  hardened run shape (`--cap-drop=ALL --security-opt no-new-privileges
  --memory 2g --pids-limit 512 --shm-size 1g`, ports on 127.0.0.1).
  Browser confirmed working inside that shape (`navigate` + `page_text`).
- A QA container `toad-computer-test` runs on this machine: MCP at
  `127.0.0.1:18787/mcp` (tokenless), VNC view-only at `127.0.0.1:15999`.
  Note: an older `toad-desktop` container also exists on some machines,
  publishing 8787/5999 on 0.0.0.0 with no auth — should be stopped or rebound.

## Solved: http MCP server never reached a claude-acp session

Root cause (found 2026-08-20 by running the `session/load` repro): ACP's
schema requires `headers` on http MCP server entries — `zMcpServerHttp` in
`@agentclientprotocol/sdk` declares `headers: z.array(zHttpHeader)`, not
optional — and the adapter validates incoming `session/new`/`session/load`
params with `vecSkipError(zMcpServer)`, which **silently filters out** any
entry failing the union. Toad sent `headers: undefined`, so the http entry
failed both union branches (no `headers` for http, no `command` for stdio)
and was dropped before the adapter's `createSession` ever saw it. Nothing
was logged on either side; the spawned CLI simply got no `--mcp-config`.

Notes from the diagnosis:

- The load/resume path was never specially broken. With `headers: []` both
  `session/new` and `session/load` deliver the tools (the agent called
  `mcp__Toad-Desktop__capture` on both paths).
- The earlier "adapter exonerated" repro that seemed to work with
  `{type:"http", name, url}` and no headers does not reproduce; treat it as
  unreliable memory. Ground truth came from watching the spawned CLI's
  argv: without headers there is no `--mcp-config` at all, with `headers:
  []` the Toad-Desktop entry appears.
- The related shape suspicion was confirmed the other way around too: the
  adapter does `server.headers.map(e => [e.name, e.value])`, so a
  `Record<string,string>` would also fail the schema (and be dropped, not
  throw — vecSkipError eats it).

Fixed in `src/bun/acp/session.ts` (`mcpServers()`): the http branch now
always sends `headers` as an array of `{name, value}` pairs, converting
from the settings' `Record<string,string>` (empty array when unset).

Regression check: `hack/verify-acp-load-mcp.ts` — drives the bare adapter
through both phases (session/new, then a fresh process doing
resume-or-load) with the computer attached as an http server, and requires
the agent to actually call a Toad-Desktop tool in each. Run with the QA
container up:
`TOAD_COMPUTER_URL=http://127.0.0.1:18787 bun hack/verify-acp-load-mcp.ts`

## Next: the two external pieces

1. **Auth capability on Toad's MCP client side.** Toad's settings UI has no
   way to attach credentials to an http MCP server. Needed: bearer token
   header support (the computer's contract) and OAuth for third-party
   servers. The `McpServerConfig` http variant already carries `headers` —
   the UI never exposes it, and see the shape bug above before using it.
   With this, the QA container goes back to tokenless-never mode.

2. **Computers as a first-class Toad capability — built (2026-08-20), UI
   pending.** `src/bun/computer/` now holds the whole capability:
   - `runtime.ts` — docker/podman/apple-container detection, backend-registry
     style, rootless ranked first, probes timeboxed.
   - `store.ts` — derived per-persona state (`computers.json`): bearer token
     (generated once, outlives the container so hibernate-wake keeps working)
     and lastUsedAt for the timers.
   - `manager.ts` — the one wake path (`ensureComputer`): inspect → recreate
     on image change (upgrade = hibernate-wake with a new tag) → create with
     the hardened flags + workspace mount at `/home/agent/workspace` → start
     if stopped → wait /health → run `computer-provision.sh` from the
     workspace on fresh containers. Idle sweeper: `stop` after minutes, `rm`
     after days (env-overridable via TOAD_COMPUTER_IDLE_STOP_MS /
     TOAD_COMPUTER_HIBERNATE_MS; image via TOAD_COMPUTER_IMAGE).
   - `proxy.ts` — the injected URL points at a localhost proxy, not the
     container: every request wakes the machine from whichever state, then
     forwards. That is what makes lazy wake work when sessions connect
     before the container exists, and it survives the random host port
     changing across restarts. Requires the same bearer token the container
     enforces.
   - `descriptor.ts` + `resolveMcpServers` — the computer rides along
     outside `mcpPolicy` (a policy of `none` still includes it), so both
     ACP sessions and the built-in agent pick it up with no extra wiring.
   - `Persona.computer` (`{enabled, image?}`) is settable today through the
     existing updatePersona RPC or config.json; disable stops the
     container, teammate delete removes it and forgets the record.
   - Gotcha fixed on the way: the container image was not restart-safe —
     stale `/tmp` X locks made init drift to display :100/port 8788 after
     `docker stop`/`start`. entrypoint.sh now clears runtime state and pins
     `--display 99`.

   Proof: `bun hack/verify-computer-capability.ts` (18 checks: detection,
   injection, 401 without token, cold create + provision, idle stop, wake
   keeping the rw layer, hibernate rm, wake re-provisioning, delete
   cleanup). Needs `toad-computer:dev` built locally.

   UI surfaces (built and validated in-app 2026-08-20): "Enable computer"
   with an info link (docs placeholder toad.computer/docs) on the
   new-teammate form, and a Computer toggle in teammate settings → Tools,
   above the MCP servers and outside the policy. Confirmed live: enabling
   the toggle and restarting the session gives the agent its own
   `toad-computer-<personaId>` container with the full tool surface —
   the restart is expected, since tools are fixed when a session starts.

   The screen surface (built 2026-08-20, verified by
   `hack/verify-computer-screen.ts`, 9 checks): the container serves
   `GET /screenshot` (PNG, behind the token) and its `/vnc` websockify
   bridge is now interactive (x11vnc `-viewonly` became opt-in via
   TOAD_COMPUTER_VNC_VIEWONLY). Toad's proxy bridges
   `/computer/<id>/vnc?token=` WebSockets to the container with the
   Authorization header re-attached on the inside leg — browsers cannot
   send WS headers, hence the query token. In the app: a computer icon in
   the chat header (only when enabled) opens a right drawer — live
   screenshot refreshed every 5s, state (running/asleep/hibernated),
   image/runtime/last-used — and clicking the screenshot opens a full
   noVNC pane with control; opening the screen is the one act that wakes
   an asleep machine, a glance never does. noVNC needed
   `optimizeDeps.exclude` + `build.target: "es2022"` in vite.config.ts
   (top-level await).

   The tool surface: eight nouns only — capture, input, browser, shell,
   files, windows, wait, state — see docs/computer.md §The tool surface.
   No granular flag, no `desktop` argument, files stay on the MCP channel.
   go-sdk 1.7.0 serves `server/discover` + `tools/list` with SEP-2549
   `ttlMs`/`cacheScope`; toad.team caches that blob by image tag so a
   session can attach before the machine is awake.

   The desktop (same day): Toad-branded — wallpaper with the
   mark (rendered by hack/render-desktop.mjs, owned by entrypoint.sh
   because fluxbox runs `background: none` everywhere and would never set
   it), toad-dark fluxbox style on the app palette, "toad | ready" dock,
   styled xterm via Xresources, toad-browser wrapper sharing the agent's
   Chromium profile, dev CLIs added (git, ripgrep, jq, tree, less).
   Gotcha for posterity: a fluxbox rootCommand under `background: none`
   silently never runs; and the toolbar's clock/workspace cells need their
   own texture keys or they render compiled-in grey.

   All three verify batteries pass on the final image:
   hack/verify-computer.ts (18, grouped contract),
   hack/verify-computer-screen.ts (9), hack/verify-computer-capability.ts
   (18, lifecycle).

   Hand-to-human (2026-08-20): a teammate that hits something only a person
   can do calls the `request_human` teammate tool (reason + timeout). A
   card lands in its conversation — "needs your hands" — with Open the
   computer (straight into the VNC pane), Done, and Dismiss; the tool call
   BLOCKS until the card is answered or expires, so the agent's turn
   resumes with the outcome. One pending card per teammate (a newer
   request supersedes). Pieces: src/bun/computer/handoff.ts (pending map +
   transcript events, `human_action` kind), bridge method `request_human`,
   card in Transcript.tsx, answerHumanAction RPC. Timeout plumbing that
   made blocking survivable: the sidecar's flat 20s bridge timeout became
   per-method (request_human gets its asked timeout + margin;
   message_teammate got 10min — it was silently capped at 20s before), and
   ACP spawns set MCP_TOOL_TIMEOUT=660000 for claude's MCP client.
   Verified by hack/verify-human-handoff.ts (13 checks: answer, dismiss,
   expiry, supersession, persona isolation).

   The bot-experience cut (2026-08-21, from agent feedback): capture
   frames land in the computer drawer's filmstrip as thumbnails (proxy
   watches `capture` go by, fetches `?w=640&format=jpeg`, pushes into a
   per-persona ring of 10 the drawer polls via `computerFrames`; frames
   originally went to the transcript as `computer_frame` events — the
   renderer for those stays for old conversations, but the chat now stays
   at conversation altitude and the drawer is the window onto the hands,
   which also keeps a subagent's captures out of the chat); a connected
   VNC viewer freezes the agent's
   mutating input automatically (presence counted at the container's
   /vnc bridge — the reader goroutine must close the TCP leg or an idle
   screen never releases presence); and three identical clicks on a
   still frame return a stuck warning in the tool result (frame hash is
   RGB-only — X11's fourth pixel byte is undefined and hashes noise; the
   click count and frame-stability check are separate so the cursor
   arriving in frame doesn't buy the loop a free spin). Tool
   descriptions now route: web through `browser`, native through
   `capture`+`input`. Verified by hack/verify-computer-feedback.ts (9).

   Still to build (the v1/v2 remainder): app-level settings — runtime
   pick/validate section, image override UI, mounts editor, egress switch —
   plus a transcript screenshot affordance. Dev note: use
   `hutch run dev:hmr` for UI work (vite serves source, HMR live); never
   run `vite build` while the old `dev` script's preview-from-dist is up —
   rebuilding dist under it crashes the app. The electrobun watcher can
   silently stop rebuilding src/bun changes — if build/…/app/bun/index.js
   stops tracking your edits, restart dev:hmr rather than trusting it.

## Useful commands

```sh
# rebuild image
docker build -t toad-computer:dev computer/

# run hardened (tokenless QA)
docker run -d --name toad-computer-test \
  --cap-drop=ALL --security-opt no-new-privileges \
  --memory 2g --pids-limit 512 --shm-size 1g \
  -p 127.0.0.1:18787:8787 -p 127.0.0.1:15999:5999 \
  toad-computer:dev

# prove the contract
TOAD_COMPUTER_URL=http://127.0.0.1:18787 bun hack/verify-computer.ts

# drive the bare ACP adapter (the repro harness lives in chat history;
# the shape that worked):
#   initialize → session/new {cwd, mcpServers:[{type:"http",name,url}]}
#   → prompt "call the capture tool from Toad-Desktop"
```
