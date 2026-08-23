# The Computer

Every teammate can have a computer: a containerized Linux desktop it drives
through MCP tools — screen capture with an accessibility tree, mouse and
keyboard, a browser, a shell, files. The container is the machine; the agent
is the operator.

This document is the spec. The v0 slice (a container you add to Toad as an
MCP server by hand) is built first; the app integration follows it.

## Shape

- **The image is a contract, not a binary.** Anything that serves the
  computer MCP surface over streamable HTTP on port 8787 (`/mcp`) is a valid
  computer. toad.team publishes an open-source default image; a settings field
  accepts any other image that honours the contract. Validation checks the
  contract, never the image name.
- **One container per teammate**, named `toad-computer-<personaId>`, off by
  default and switched on per teammate. The computer's MCP server joins that
  teammate's tool set through the same `mcpPolicy` routing every other server
  uses — no new protocol, no special path.
- **Distribution**: toad.computer versions and releases on its own schedule
  (`computer-v*` tags; the number of record is the Implementation stamp in
  `computer/cmd/computer-agent/serve.go`). The desktop pins one published
  tag as a dependency (`COMPUTER_VERSION` in `src/bun/computer/manager.ts`)
  and pulls it on first enable — a deliberate bump, never `latest`.
  Dev builds of Toad build the image locally from `computer/`.

## Runtimes

Docker and Podman on Linux; Docker, Podman and Apple `container` on macOS.
Detection follows the backend-registry pattern: each runtime reports
`available` or an `unavailableReason`, rootless runtimes rank first, and the
settings screen shows what was found. Toad shells out to the runtime CLI —
they agree on the `run`/`stop`/`rm`/`inspect` subset we need — and takes no
SDK dependency.

## Lifecycle

Three states, one wake path:

- **Running** — the agent is using it.
- **Stopped** (idle minutes): `stop`, not `rm`. Frees CPU and RAM — most of
  the cost — and the rw layer survives, so everything the agent installed is
  still there. Wake is `start`, about a second.
- **Hibernated** (idle days): `rm`. Frees disk. Wake is a fresh container
  plus re-provisioning (below).

Wake happens on the first tool call, from whichever state. An image upgrade
is the hibernate-wake path with a new tag — deliberately the same code.

## The computer morphs

Toad's premise is that you build your agent by talking to it; its computer
should grow the same way. The container's rootfs stays writable on purpose —
the agent installs what it needs, and light hibernation preserves it.

What survives *deep* hibernation and upgrades is the recipe, not the layer:
each teammate keeps a provision script in its workspace (the same move as
AGENTS.md), and the computer's briefing tells the agent one rule: anything
you care about lives in the workspace volume or the provision script, never
only on the machine. Fresh container → script runs → the computer grows
back. This also makes a computer portable — a teammate's rig is a script you
can hand to another teammate or publish.

## Security

The container is the security boundary, so the boundary is hardened by
default and every loosening is explicit:

- Rootless runtime preferred; non-root user inside regardless.
- `--cap-drop=ALL`, `--security-opt=no-new-privileges`, default seccomp
  profile. Never `--privileged`; the container runtime's socket is never
  mounted, and that is not a setting.
- MCP and VNC ports bind to `127.0.0.1` only, behind a bearer token Toad
  generates per container.
- Resource caps: memory, CPUs, pids (fork bombs), a sized `/dev/shm`
  (Chromium needs it), rw-layer disk quota where the storage driver allows.
- Egress open by default — an offline computer is a boring computer — with a
  per-teammate no-egress switch for sensitive work.
- The browser runs `--no-sandbox` *inside* the hardened container, and caps
  stay dropped. One strong boundary beats two weak ones; the usual advice
  (add `SYS_ADMIN` for the browser sandbox) weakens the outer wall to prop
  up the inner one, and we decline.
- Settings offer **hardened** (all of the above, the default) and
  **custom**, where each loosened knob shows its consequence in one line.
  There is no preset named "open", and reset always returns to hardened.

## Mounts

The workspace volume is always mounted; everything else is opt-in. Custom
mounts are per-teammate entries — host path → container path — read-only
unless explicitly flipped to rw. Mounts are container-create arguments, so
they survive stop, hibernation and upgrade as part of the recipe.

## The container itself (`computer/`)

One Linux desktop per teammate: Xvfb + fluxbox + x11vnc, driven by a Go
agent (`computer-agent`) that serves the MCP tools and a WebSocket VNC
bridge for the in-app screen view. The module is `toad.computer`. The
contract is what the desktop offers — cursor-agent can point at `/mcp`
with no toad.team in the loop.

toad.team is the orchestrator (wake, hibernate, proxy). It does not author
the tool list: the proxy caches the container's real `server/discover` and
`tools/list` so a session can attach before the machine is awake.

## The tool surface

Eight nouns, not fifty verbs. A tool list should be small enough for the
agent to read whole — fifty schemas crowd its context, and harnesses that
defer big tool sets hide them behind a search the agent has to guess right.
Each tool takes an `action`. There is no `desktop` argument: one container
is one machine.

- **`capture`** — see: screenshot + AT-SPI accessibility tree as structured
  text (`mode=png` for a raw image).
- **`input`** — act: mouse, keyboard, clipboard, and `batch` for short
  scripted sequences under one lock.
- **`browser`** — the managed Chromium's semantic fast path: page text with
  element refs, ref-based click/fill/select, tabs, uploads, dialogs,
  downloads. Reading `text` costs a fraction of reading pixels.
- **`shell`** — `exec` (the universal escape hatch) and `launch` for GUI
  apps.
- **`files`** — get / put / list on the MCP channel. `get` returns the
  bytes (text, or base64 if not UTF-8). `put` takes `content` in the call
  (`encoding=base64` for binary). No out-of-band URLs.
- **`windows`** — list, focus, close, maximize, tile.
- **`wait`** — verify: poll the screen for text; the third leg of
  see → act → verify.
- **`state`** — the drive lease, saved browser logins, home-dir snapshots.

Bearer authenticates the machine. `X-Computer-Holder` (or, failing that,
"anonymous") names who is driving. Mutating tools refuse with that name
when the run queue or a human-control lease is taken, and a control lease
is released only by the holder who took it.

## Integration ladder

1. **v0 (this repo, now)**: build the image from `computer/`, run it by
   hand, add it to Toad as an HTTP MCP server with the bearer token. Proves
   the contract with zero app changes.
2. **v1**: runtime detection, settings section (enable, pick runtime, pull,
   validate), per-teammate toggle, lifecycle management, token plumbing.
3. **v2**: the flourishes — live VNC pane in the app, a recent-captures
   filmstrip in the computer drawer (frames briefly lived in the transcript;
   the chat now stays at conversation altitude), provision-script UX, mounts
   editor, egress switch.
