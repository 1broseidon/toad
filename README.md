# Toad

A desktop shell for a **team** of coding agents.

Most agent UIs give you one conversation with one assistant. Toad gives you a
left rail of teammates, each with its own identity, its own working directory,
and its own durable transcript — all driven over the
[Agent Client Protocol](https://agentclientprotocol.com) (ACP).

Toad is a **client**, not a harness. It does not own a model, an agent loop, a
tool set, or your credentials. It supervises agents that already have all of
those, which is why it needs no API keys and no OAuth flow: `cursor-agent`,
`opencode`, and GitHub Copilot each bring their own auth.

## Requirements

- macOS, Linux, or Windows
- [Bun](https://bun.sh) 1.3+
- [Hutch](https://hutch.blackboard.sh) (the Electrobun build CLI)
- At least one ACP backend on your PATH. `cursor-agent` is the default.

```bash
curl -fsSL https://hutch.blackboard.sh/hutch/install.sh | sh
```

## Running it

```bash
bun install
hutch run dev        # build and launch
hutch run dev:hmr    # same, with hot reload for the UI
hutch run verify     # drive the whole main process end to end, headlessly
hutch run typecheck
```

## How a teammate is defined

A teammate ("persona") is four independent axes:

| Axis | Stored as | Reaches the agent via |
| --- | --- | --- |
| Identity | `goal` | `AGENTS.md` written into the working directory |
| Workspace | `cwd` | the `cwd` argument to `session/new` |
| Capability | MCP servers | inherited from the backend's own config |
| Disposition | `modelId`, `modeId` | `session/set_model`, `session/set_mode` |

Identity works this way because ACP has no system-prompt parameter. `AGENTS.md`
is a channel agents already read, which makes the working directory *be* the
persona rather than just bookkeeping. Toad only overwrites files that carry its
own marker, so a hand-written `AGENTS.md` in a real repository is safe.

Disposition is switchable mid-conversation, because the model and mode lists
arrive from the agent at session creation and are re-applied on restart.

## Two kinds of memory

Toad keeps its own append-only JSONL transcript per teammate, folded on load so
that a tool call which moves from `pending` to `completed` collapses to one
entry rather than growing forever.

That is **not** the same as the agent remembering. On restart Toad calls
`session/load` (or `session/resume` where supported) and tells you which
happened: *Restored* means the agent genuinely recalls the conversation,
*Fresh* means you are looking at saved history the agent has never seen.
Replay during `session/load` is suppressed, otherwise every restart would
duplicate the entire history into the transcript.

## Backends

The backend list is data, not code: it comes from the
[ACP registry](https://github.com/agentclientprotocol/registry) (39 agents at
time of writing), cached for a day, merged with a probe for locally installed
binaries. A local binary is always preferred, since it carries your existing
login.

Verified working here: **Cursor** (27 models, 3 modes, `session/load` restores
real context). **GitHub Copilot** 1.0.80 completes an ACP handshake via
`npx @github/copilot@1.0.80 --acp` — note that versions below 1.0 have no
`--acp` at all.

## A word on containment

Toad renders permission requests as first-class, non-dismissable transcript
entries. But it does not get to decide whether the agent asks. That is the
backend's configuration. If Cursor is set to `approvalMode: "unrestricted"`,
the agent edits and executes without asking and Toad's prompt never fires — so
Toad detects this and says so on session start.

**The per-teammate working directory is a starting point, not a sandbox.**

## Layout

```
src/
  shared/        types and the RPC contract, shared across the process boundary
  bun/           main process
    acp/         registry, containment check, session, supervisor
    store/       personas (+ AGENTS.md) and transcripts
  mainview/      React UI
hack/            throwaway verification scripts
```

`src/bun` runs on Bun rather than Electrobun's default Cottontail runtime,
because the main process supervises N long-lived subprocesses over stdio and
needs `Bun.spawn`.
