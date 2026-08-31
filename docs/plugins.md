# Plugins

A plugin is a process this desk supervises, speaking MCP over stdio, whose
tools every teammate on the desk can call.

The one sentence that explains the shape: **Toad stands between the plugin and
the agent.** Toad is the plugin's MCP client, and it re-serves the plugin's
tools to teammates from its own local HTTP endpoint, one path per teammate. The
plugin is never the agent's MCP server.

That is not decoration. For the built-in Toad Agent, Toad builds the tool array
itself and always knew what a teammate had. For an ACP backend it does not: Toad
hands over server descriptors and the backend spawns them in its own process,
reporting nothing back. Standing in the middle is what makes a plugin's tools
enumerable on *both* kinds — Toad answers `tools/list` itself, sees every
`tools/call`, and an `initialize` arriving on a teammate's own path is proof the
backend really attached rather than a hope that it did.

For Toad as an ordinary MCP client brokering other people's servers, see
[mcp.md](mcp.md). A plugin is the thing that needs a desk; a per-session tool
server with no desk presence is already supported and is called an MCP server.

## What a plugin is

A directory holding `toad-plugin.json` and an executable entry point. No
registry, no auto-update, no network install.

```jsonc
{
  "id": "com.example.board",      // reverse-DNS, immutable, the one namespace root
  "version": "0.1.0",
  "name": "Board",
  "serve": { "command": "bun", "args": ["server.ts"] },
  "tools": [
    {
      "name": "board_claim",
      "description": "Claim a task",   // the model reads this
      "inputSchema": { "type": "object", "properties": {} },
      "subagentInherits": false        // required; there is no default
    }
  ],
  "logs": [],
  "rpc": { "serves": [] },
  "events": [],
  "grants": {
    "room": ["desks"],
    "fleet": { "log": [], "rpc": { "call": false, "serve": [] }, "events": false, "blobs": false },
    "acceptFrom": "none"
  }
}
```

`serve` is spawned with the same login-shell PATH recovery stdio MCP servers
get, with the plugin's directory as its working directory, and with
`TOAD_PLUGIN_ID`, `TOAD_PLUGIN_DIR`, `TOAD_PLUGIN_STORAGE` and
`TOAD_APP_VERSION` in its environment.

The fleet grants are declared and validated but nothing reads them yet: the
node-transport patterns are a later phase. They are in the manifest now so an
install written today is not re-negotiated when they land, and so the "what may
this plugin reach" list has something honest to say.

### What the manifest refuses

- **`env`** — v1 ships no plugin secrets. The only place one could land today is
  plaintext beside a mature sealed credential store that MCP does not use.
- **`ui`** — a plugin gets a settings row, a tool list and the plugin page. No
  panes, no custom renderer code.
- **A `from`, `src`, `desk` or `node` field in any declared payload schema**, at
  any depth. Provenance is stamped by the receiving desk and is never a field a
  plugin may set; a plugin that could assert it could become a relay for
  unsigned assertions.
- **A tool with no `subagentInherits`.** Toad's own tools answer the same
  question in a compile-time exhaustive record, whose point is that adding a
  tool forces the decision. A manifest is the only place a runtime tool can be
  forced to answer it.
- **A grant naming a log or method the manifest never declares.** That is a typo,
  not a wider grant, and this is the one moment anyone reads the file closely.

## The manifest is authoritative

Toad answers `tools/list` from the manifest, not from the child process. Two
consequences, both deliberate:

- **A stopped plugin still has an enumerable tool list.** The teammate can see
  the tool, and calling it comes back `plugin_down` naming it — rather than the
  tool silently not existing.
- **An install is refused if the live `tools/list` disagrees with the manifest**,
  by name, in either direction. A plugin serving something else would have made
  Toad describe a tool list to every teammate on the desk that was not the real
  one.

There is no dynamic tool registration. That rules out a legitimate plugin shape
— one tool per configured repository, per account, per discovered device, which
must instead be one tool with a parameter. The trade is deliberate:
enumerability requires that Toad know the tools without running the plugin, and
the moment dynamic registration exists the guarantee justifying this whole
design is gone.

## Lifecycle

`installed → running | stopped | failed`, with a required reason on every state.

A plugin runs **per desk, not per session**: a log has exactly one writer per
desk, RPC needs an answerer when no teammate is running, and enumeration needs a
tool list that exists before any session starts. Per-teammate identity rides the
proxy URL path and a per-teammate bearer token instead.

A crash restarts with backoff (2s → 30s, ×1.6, jittered). Three crashes inside a
minute stops it and leaves it stopped rather than competing with the room; the
last 200 stderr lines are on its page. Installing or uninstalling restarts every
running teammate, because a session's tool array is fixed when it is created — a
crash does not, because the descriptor and the tool list are unchanged by it.

Toad is on the hot path for every plugin tool call, so a slow plugin would
otherwise occupy capacity Toad's own tools share: calls are capped at four in
flight per plugin and time out after sixty seconds, each refusing with a
sentence rather than hanging the teammate.

## The way in, the way out, the way to see it

**Settings → Plugins.** Point it at a directory and choose *Read it*: Toad
validates the manifest and shows every tool and everything the plugin asks to
reach, evaluated by the same function that will enforce it. Nothing is installed
until you agree. Installing spawns the process once, compares the live tool list
against the manifest, and refuses on any mismatch.

Uninstalling stops the process, drops the descriptor, deletes the plugin's own
storage, and **reports which teammates lost tools, by name** — a teardown is a
look, not a promise.

Plugins are installed and removed at the desk. A paired phone can read the list;
it cannot change it, because installing names a directory on the desk and spawns
a process there.

## One decision function

`pluginMay(scope, action, target)` answers every question about what a plugin
may do, and there are exactly three callers: the gate that refuses a tool call,
the pane that lists what a plugin may reach, and the preview in the install
dialog. Prediction that can drift from enforcement will drift, and the drift is
invisible until it is a lie in a system prompt.

Refusals are distinguishable and each names a plugin and a cause:
`plugin_absent`, `plugin_down`, `not_declared`, `not_granted`, `refused`.

Policy itself is thin in v1: the grants agreed to at install are the whole
policy, and grants are per desk. A room-level model sits above this later.

## The tool ledger

Separate from plugins, and the reason they are built this way.

Every teammate has a ledger of what tools it got, from where, and — for anything
absent — why. It is under **Settings → a teammate → Tools → What it actually
has**, and it is built when the session starts, from the same arrays the session
hands the agent.

A row is `{name, source, origin, state, reason, at}` where `reason` is required
in **every** state. That is the whole design. Tools vanishing silently is the
worst failure this project has shipped, three times in three disguises, and
every one of them was an absence with an optional explanation nobody filled in:

- pi reads a supplied tool list twice — once as the built-ins to start active,
  once as an allowlist it also applies to custom tools. A Windows list naming
  five built-ins therefore deleted every tool Toad supplies, silently, while the
  system prompt went on promising them.
- An ACP backend not on the tested compatibility list got `{attach: false}` with
  no reason, so its teammate had no Toad tools and nothing said so.
- An MCP server id left in a teammate's policy after the server was deleted is
  dropped on the floor — deliberately, so deleting a server does not break every
  teammate that referenced it, but with nothing naming what went.

The three states are honest about how much Toad knows:

| state | means |
| --- | --- |
| `verified` | Toad watched the agent take it — it built the array, or it served the `tools/list` |
| `declared` | Toad handed it over and cannot see what happened next |
| `absent` | it is not there, and `reason` says why |

`declared` is the ACP condition and it is not a failure: a backend spawning its
own stdio MCP servers genuinely does not report back. It is also why a plugin's
descriptor points at a Toad-owned endpoint — that is the one thing Toad *can*
watch, so a plugin's rows go from `declared` to `verified` the moment the
backend really attaches.

## Verifying

- `hutch run verify:tool-ledger` — every silent-absence site, on both agent
  kinds, against the tools that exist today.
- `hutch run verify:plugin-tools` — a plugin from install to uninstall: a
  manifest mismatch refusing the install, one registration reaching Toad Agent
  and an ACP backend that is *not* on the sidecar allow-list, the proxy's
  `initialize` promoting the ledger, a stopped plugin naming the tool it took
  away, and an uninstall reporting what it did.

`scripts/plugin-fixture/` is the plugin those harnesses install: an ordinary MCP
stdio server and nothing else, which is the claim the design rests on.
