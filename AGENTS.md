# Working in this repository

Toad is a local-first room for a **team** of coding agents. This file is the
contract for the agent changing Toad; the [README](README.md) is the
user-facing story. The contributor depth lives in `docs/`: read
[docs/development.md](docs/development.md) (requirements, running, bundling)
and [docs/teammates.md](docs/teammates.md) (teammate model, memory,
containment) first — they answer questions you will otherwise rediscover the
hard way. Treat everything
here as good defaults, not hard rules: George's explicit request outranks any
line in this file, and if a rule fights the task in front of you, say so out
loud before breaking it.

## Vocabulary

- **you** — the agent reading this file and changing Toad. Quite possibly you
  are running *inside* Toad while you do it.
- **George** — the maintainer. Who you are talking to.
- **user** — a person running Toad to direct a team of agents.
- **teammate** — one agent in the left rail (code calls it a *persona*): a
  goal, a working directory, a capability policy, and a disposition.
- **Toad Agent** — the built-in agent, running on the pi SDK inside Toad's own
  process. What a new teammate gets by default.
- **ACP backend** — an external harness (Cursor, Claude Code, opencode, …)
  driven over the Agent Client Protocol as a child process.
- **tape** — a teammate's durable transcript. A **chapter** is one working
  context within it, closed on long idle or on request, leaving a handoff note.
- **goal** — a teammate's identity. For an ACP backend it is materialized as an
  `AGENTS.md` in *that teammate's* working directory, guarded by a
  `<!-- managed by Toad -->` marker. This file carries no marker, so Toad will
  never overwrite it. Keep it that way.
- **hutch** — the Electrobun build CLI. **Cottontail** — the runtime
  `hutch run` executes scripts under, which cannot load the built-in agent's
  dependency tree.

## The ways to hurt yourself

1. **Toad develops Toad.** The instance you are being driven from may be the
   one whose processes you are about to kill. Never kill by matched name, path,
   or port sweep — only a PID you captured at spawn. The same goes for state:
   `TOAD_DATA_DIR` overrides the data directory, and a QA instance gets its own
   scratch one rather than the live one.
2. **One dev instance per checkout.** `hutch electrobun dev` holds the sync
   lock for its lifetime — do not compose your own pipeline from `hmr` plus
   `start`, or Vite never binds 5173 and the window sits on Loading…. A second
   running instance comes from a git worktree: its own checkout, its own vite
   port, its own `TOAD_DATA_DIR`.
3. **No `vite build` underneath `dev`.** `dev`'s window is served by
   `vite preview` from the last build; rebuilding yanks its assets mid-session.
   Iterating on UI is what `dev:hmr` is for.
4. **Cottontail cannot load the pi tree.** A script that imports the built-in
   agent's dependencies must run through `hutch pm exec 'bun …'` (see the
   comments in `hutch.config.ts` for which verify scripts already do).

## Running it

```bash
hutch run dev        # build and launch
hutch run dev:hmr    # same, with hot reload for the UI — default for UI work
hutch run typecheck
hutch run verify     # drive the whole main process end to end, headlessly
```

Tools attach when a teammate starts, so in dev a change to teammate-facing
tooling reaches a running teammate on its next restart — restart the teammate,
not the app.

## Hit both kinds of agent

The most common defect shape here is a feature that works for the agent kind
you tested. Anything agent-facing needs a decision per kind — Toad Agent
(in-process, Toad owns the tools and the loop) and ACP backends (child process,
its own tools, Toad only speaks the protocol). "Not supported for ACP" is a
valid decision; silence is not. The same discipline applies to surfaces
(Electrobun desktop, iOS under Capacitor, web pairing, the computer feature)
and to reverse states: if you add a way in, add the way out and the way to see
it. A one-way door is a bug.

## Verifying

- The house idiom is a headless `verify:*` script in `scripts/`, driving the
  real main process end to end. Find the one covering your area and extend it;
  new main-process behavior ships with one. `verify` takes a backend id
  defaulting to `cursor`; `bun scripts/verify-toad.ts pi` drives Toad Agent.
- The packaged app is a different program from the source tree. Anything
  touching the built-in agent's imports must pass `hutch run verify:pi`, which
  runs a real turn from source *and* from a bundle.
- `hutch run typecheck` before calling work done. Smallest proof that the
  change works — targeted verify scripts, not everything.

## Where things live

```
src/shared/      types and the RPC contract, shared across the process boundary
src/bun/         main process: agent/ pi/ acp/ mcp/ store/ (Bun, not Cottontail)
src/mainview/    React UI
scripts/         verification harnesses and tracked-asset generators
docs/            actual docs — what a user or contributor reads today
computer/        the computer feature's own tree
notes/           gitignored — the private decision record, never published
```

`docs/` holds only what is. A doc explains the product or the tree as they
are, and a doc that drifts from the code is a bug. The decision record —
charters, phase specs, handoffs, audits — lives in `notes/`, which is
gitignored: it stays on the desk, never in the public tree, and a source
comment may name a spec but never link a path into it. The README is
user-facing; depth that serves a contributor belongs in `docs/`.

Plans, research notes, and scratch files follow the same rule — `notes/` or
outside the tree entirely. A proof worth keeping becomes a `scripts/` harness;
a decision worth keeping becomes a spec in `notes/`.

## Releases and taste

- A release is the `/release` flow: bump, changelog, test, commit, tag `v*`,
  push. The tag is the release — never pre-bump a version and then release it.
- Commits are one line that states the invariant, not the diff: *"A Windows
  tile is 256 across, because one byte cannot count higher."*
- Fight for the smallest model that makes the correct behavior unsurprising.
  Do not preserve complexity because it exists, or add machinery because it
  looks architecturally impressive.
- Comments and docs explain *why*, in sentences, and move when the code moves.
