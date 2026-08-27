# Developing Toad

The contributor's guide: what you need, how to run it, and where things are.
The working contract for changes — footguns, verification, taste — is
[AGENTS.md](../AGENTS.md); read that first. The teammate model, memory, and
containment story is [teammates.md](teammates.md).

## Requirements

- macOS, Linux, or Windows
- [Bun](https://bun.sh) 1.3+
- [Hutch](https://hutch.blackboard.sh) (the Electrobun build CLI)
- For **Toad Agent**: a supported subscription or model provider key. Configure
  one under Settings → Agents → Configure. Toad also reads
  `~/.pi/agent/auth.json` when you already have one, and otherwise uses its own
  copy under the app's data directory.
- For an **ACP teammate**: that agent's CLI on your PATH. These are optional;
  Toad Agent is what a new teammate gets by default.

```bash
curl -fsSL https://hutch.blackboard.sh/hutch/install.sh | sh
```

## Running it

```bash
bun install
hutch run dev        # build and launch
hutch run dev:hmr    # same, with hot reload for the UI
hutch run verify     # drive the whole main process end to end, headlessly
hutch run verify:pi  # the built-in agent, from source and from a bundle
hutch run verify:mcp-servers   # MCP settings → routing → a tool the model calls
hutch run verify:auth          # isolated provider key setup and logout
hutch run typecheck
```

`verify` takes a backend id, defaulting to `cursor`; `bun scripts/verify-toad.ts pi`
drives the same suite against Toad Agent. `verify:pi` exists because the packaged
app is a different program from the source tree — see
[A word on bundling](#a-word-on-bundling).

One runtime footgun: `hutch run <script>` executes under Cottontail, which
cannot load the built-in agent's dependency tree. Scripts that touch it go
through the raw shell runner to get real Bun. `verify` itself is unaffected,
because the agent factory loads that tree on demand rather than at import.

## A word on bundling

Toad ships as one bundled file, and the built-in agent has two things in it a
bundler cannot follow: `undici`, whose npm build dies on load under Bun, and
pi's OAuth flows, which are loaded through a computed import specifier on
purpose so Node-only login code stays out of browser builds. Both worked from
source and failed only in the packaged app; the OAuth one failed *quietly*,
because a failed model call comes back as a stop reason on an assistant message
rather than a thrown error, so the app looked healthy and simply never
answered.

`undici` is marked external, so it resolves to the one Bun already ships. The
OAuth flows are registered statically. `hutch run verify:pi` runs a real turn
twice, once from source and once from a bundle built the same way electrobun
builds the app, because these are two different programs and only one of them
is the one you ship.

## Layout

```
src/
  shared/        types and the RPC contract, shared across the process boundary
  bun/           main process
    agent/       the session contract both kinds of agent implement
    pi/          Toad Agent: model runtime, session, tool translation
    acp/         registry, containment check, session, supervisor
    mcp/         MCP servers (global registry + routing), and teammate tools
    store/       personas (+ AGENTS.md) and transcripts
  mainview/      React UI
scripts/         verification harnesses and tracked-asset generators
specs/           implementation specs — the decision record
```

`src/bun` runs on Bun rather than Electrobun's default Cottontail runtime,
because the main process supervises N long-lived subprocesses over stdio and
needs `Bun.spawn` — and now also because Toad Agent's sessions run in that
process rather than beside it.
