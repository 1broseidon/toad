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
`TOAD_APP_VERSION` in its environment — plus `TOAD_BRIDGE_SOCKET` and
`TOAD_BRIDGE_TOKEN`, which are the upward door described in
[the room](#the-room-a-plugin-can-reach) below. The token is minted per run and
revoked when the process stops.

`grants.fleet.rpc` and `grants.fleet.blobs` are declared, validated and shown,
and **nothing reads them**: RPC and content-addressed blobs are a later phase.
They are in the manifest now so an install written today is not re-negotiated
when they land. `grants.fleet.log` and `grants.fleet.events` are live.

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

## The room a plugin can reach

A plugin has two doors and both already existed. **Downward** it is an MCP stdio
server and Toad is its client. **Upward** it holds one connection on Toad's own
bridge — the same unix socket, the same frames and the same scope machinery the
ACP sidecar uses for a teammate, with one difference that decides everything
else: **a plugin's scope names a plugin and no teammate.** A plugin is a
desk-level process that outlives every session, so it cannot answer for one, and
the bridge splits the two surfaces apart rather than asking each handler to
check.

Everything a plugin does on the fleet rides Toad's plane. The plugin never
imports the wire, never holds a link, never sees a key. That is what makes the
refusal and the provenance stamp enforceable instead of advisory — the rejected
alternative, a second socket carrying raw frames, hands a plugin author the
room's own failure detector, and a plugin that blocks or floods then takes the
mesh down with it.

`plugins/toad-plugin-sdk/bridge.ts` is the client: one dependency-free file with
no imports from the Toad tree. There is no package yet, deliberately — a file an
author reads in five minutes is worth more right now than a version number.

### An owned append-only log

```
plugin.log.open({logId})                            → {gen, offset, streamId}
plugin.log.append({logId, bytes})                   → {gen, offset, size}
plugin.log.cursors({logId})                         → who is writing, and whose writing is here
plugin.log.read({logId, ownerNode, gen, from, len}) → bytes
                                            push:  plugin.log.changed
```

Every desk owns its own copy of each declared log and mirrors every other
desk's. **`append` takes no owner.** Writing another desk's mirror is not
something this API can express, which is exactly how transcript replication gets
its first-hand-ness — Toad stamps the writer from the authenticated link and the
writer cannot forge it.

This is transcript replication with one key replaced. The key was
`(ownerNode, personaId, epoch)` under `ROOT/replicas`; it is now
`(ownerNode, streamId, gen)` under `ROOT/streams`, and a teammate's tape is the
first client of it under `streamId = persona:<id>`. Everything the tape learned
came along unchanged: fingerprinted cursors, because a byte count cannot see a
rewrite that lands at the same size; refuse-with-the-truth so the sender re-aims
instead of the holder guessing content into a mirror; owner-instructed reset
only; one serialized lane per (peer, stream).

The third key component is called `gen` and never `epoch`. A persona's epoch
means *ownership* and rotates on a hop; a plugin log has no ownership epoch. It
gets a generation minted when the log is opened, bumped only when the bytes
behind it are gone — the counter outlives an uninstall precisely so a reinstall
does not write generation 1 into a mirror still holding the last life's
generation 1 on a desk that was dark through it.

**No ordering across logs is supplied.** The board writes its own Lamport stamp
in about twenty lines and the file-mirror needs none; shipping ordering here
would be the special case that proves an API wrong. No compaction and no
retention either: a year-old log re-ships whole to a newly installed desk, and
every desk stores every line forever.

### Fire-and-forget events

```
plugin.event.emit({name, payload, to?})  → {delivered: [nodeId], missed: [nodeId]}
                                  push:  plugin.event {from, fromName, name, payload}
```

Two lists rather than one boolean, because "some desk got it" and "the desk you
care about got it" are different facts. **Loss is total and permanent.** A dark
desk misses the event; there is no store-and-forward anywhere in this tree and
the API says so rather than implying delivery on reconnect.

`from` is stamped by the receiving desk from the authenticated peer and arrives
as a sibling of `payload`, never a field inside it — which is why the manifest
validator refuses a payload schema that declares one.

### Room facts

`plugin.desks()` and `plugin.teammates()`, each behind its own grant. Names,
reachability and installed plugins; never the raw stores.

### On the wire

`FLEET_METHODS` gains exactly one entry for the whole plugin system, `plugin`,
whose params are `{pluginId, kind, body}`. The plugin's identity is a field and
never part of a method name: peer methods resolve against the app's own RPC
handler map, so the peer namespace is already flat and already global, and a
`plugin:<id>/<method>` string would be one typo from shadowing
`updateAppSettings`. A field cannot be.

Four gates on the receiving desk, each naming a desk, a plugin and a cause: an
authenticated admitted peer (true before anything here runs), `plugin_absent`,
`refused` (`grants.acceptFrom`), and `not_granted` for a log this install never
declared. The sending side asks the same function about its own grants before
touching the wire.

### What is not built

`plugin.rpc.*` — pattern 1 — **does not exist**. Neither proof example needed
it: the board is log plus events, and the file-mirror is log plus blobs plus
RPC, which arrives with the blobs. Content-addressed blobs do not exist either.
Both are declared in the manifest and refused at the door.

## The room learns which desks have what

`DeskCapabilities` carries `plugins: [{id, version, state}]` and a `format`
marker. The marker is the point: an advertisement is rebuilt field by field and
unknown fields are dropped, so without it a desk too old to advertise plugins
would be indistinguishable from a desk that has none — and the hop would refuse
with a reason that is false. With it, the reason is "that desk is too old to
say".

`Persona.plugins` is a teammate's requirement, and it is **replicated**, for the
reason already written beside `harnessOverride`: any desk may be asked what
would run this teammate elsewhere. The matching ladder reports a `plugins` rung
whether or not the teammate needs one, and a failure there vetoes the whole
resolution however well the harness climb matched — no different harness fixes a
missing plugin. A version difference never refuses; the destination's version
runs.

The teammate's *configuration* for a plugin is a different thing and stays
portable. The requirement is identity; the config is baggage.

## The board, and what it is an example of

`plugins/board/` is a task board every desk in the room shares. It is in the
tree because it is the harnesses' own fixture rather than a sketch, and because
a plugin API is the one surface that cannot be quietly refactored later — it was
written against this API to find out whether the API is any good.

It grants `fleet.log` and `fleet.events` and **nothing else**. No RPC, no blobs,
not even `room.desks`, and the plugin page says each of those as a stated no.
That last one is the interesting refusal: the completeness sentence names the
desks it cannot reach, and it gets those names from `plugin.log.cursors`, which
already has to know who is writing. A grant held and never used is a grant the
example teaches people to ask for.

### N single-writer logs and a local fold

There is no shared board. Every desk owns exactly one log, `ops`, mirrors every
other desk's, and folds all of them the same way. Coordination is a sort:

```
cursors = plugin.log.cursors({logId: "ops"})   // one entry per writer held here
lines   = read each, stamped with the owner Toad supplies
sort by (lamport, desk, opId)                  // identical on every desk
reduce  -> tasks
```

`lamport` is `1 + the highest seen across every log this desk has folded`, which
the board writes itself: the log plane supplies no ordering across streams, and
shipping some would have been the special case that proves an API wrong. `desk`
is the tie-break, and it is the one field in the whole model a writer cannot
forge — Toad stamps the owner of the log on read, a log has exactly one writer,
and `parseLog` overwrites whatever the line claimed.

`board_claim` is the contentious operation and the reason the pattern earns its
place. Two desks claim at once, both lines exist in different logs, every desk
folds both and the lowest `(lamport, desk)` wins. The loser learns it lost when
its mirror catches up. No coordinator, no lock, no leader election — and it
resolves correctly while a desk is dark, converging when the log arrives. That
is the case the record plane cannot answer at all: two desks claiming the same
record from the same epoch both compute `(E+1, 1)`, `wins()` says neither beats
the other, and each treats the other's op as a replay of its own.

### Nothing here reads a clock

`desk` is authority, so every rule that says "only the holder may do this" —
`board_release`, `board_progress`, `board_complete` on a claimed task — is
written against `desk` and never against the claimant's name, which is a string
an agent typed.

Staleness is the same discipline applied to time. A `reclaim` names the claim it
supersedes and carries `assertedAt`; the fold accepts it iff
`reclaim.lamport > claim.lamport` **and** `claim.expiresAt < reclaim.assertedAt`
— both numbers being values in the log. Every desk reads the same two numbers
and reaches the same verdict under any clock skew whatsoever. The reclaiming
desk's clock decides only *when* it writes, which is liveness and never truth.

`board_progress` renews the claim by the same act, and the renewal is a
`Math.max`, so a progress line that arrives out of order cannot shorten a live
claim. That is what keeps the renewed expiry independent of arrival order, which
is what keeps a later reclaim decidable identically everywhere.

### It reports its own completeness

`board_list` answers "showing 3 of 4 writers; Mac mini's board is not reachable
from here" rather than three tasks and a silence. `plugin.log.cursors` names
which owners this desk holds and which desks run the plugin without their
writing having arrived, and the difference is a sentence. Under a real partition
the record plane converges silently wrong; the board *knows* it is partial.

Task text in a tool result is written by agents on other desks, so it is fenced:
one bounded line per field, control characters gone, inside a marked block a
preamble names as data.

### The fold digest, and why it carries a cursor set

After each fold the plugin emits a `foldDigest` event: the sha256 of the ordered
op ids it folded, **and** the sha256 of the cursor set it folded them from.

The second half is what makes the first half mean anything. Two desks always
disagree while one is behind — constantly, and correctly — so a bare digest
comparison is noise that trains you to ignore the one signal that matters. Same
cursor set and a different digest has no benign reading: one of the two folds is
wrong, and a wrong fold is the failure that would otherwise rot invisibly. A
peer that reports a digest and states no cursor set is counted as wrong too,
rather than ignored, because silence about the thing that makes a claim
checkable is not reassurance.

### The projection is a pure function, and that is the safety property

task-15's non-negotiable is that the local brainfile markdown is a PM-side
projection on one machine and never fleet authority. Here that is a fact about
the code rather than a rule anyone has to remember: `plugins/board/project.ts`
is a pure function from a fold to a list of files, and the plugin writes them
with its own `writeFileSync`. Toad is not involved, holds no copy, and offers no
way to read one desk's projection from another — so the projection cannot become
a coordination path however badly a later change wants it to.

It comes in two halves on purpose:

- `board/<taskId>.md` is a function of the fold alone, so two desks holding the
  same bytes write **byte-identical** files. Nothing local reaches this half.
  The frontmatter uses brainfile's own names — `id`, `title`, `column`,
  `status`, `assignee`, `progress`, `createdAt`, `updatedAt`, `tags` — so
  brainfile-core's pure domain logic can be pointed at these files without a
  translation layer. Every scalar goes through JSON, which YAML 1.2 is a
  superset of, so a title cannot smuggle a second field.
- `board.md` is this desk's own view — completeness, the cursor set, who
  disagrees — and is expected to differ. Putting all of it in one clearly
  marked file is what keeps the deterministic half checkable.

A task id folded out of another desk's log is bytes another agent wrote, so it
is checked before it becomes a filename; a task whose id would escape the
directory gets no file and the index says how many did.

## The way in, the way out, the way to see it

**Settings → Plugins.** Point it at a directory and choose *Read it*: Toad
validates the manifest and shows every tool and everything the plugin asks to
reach, evaluated by the same function that will enforce it. Nothing is installed
until you agree. Installing spawns the process once, compares the live tool list
against the manifest, and refuses on any mismatch.

Uninstalling stops the process, revokes its bridge token, drops the descriptor,
deletes the plugin's own storage, deletes every log it owned here and every
mirror this desk held of another desk's copy — and **reports what it actually
did**: which teammates lost tools, which logs went, and which desks' mirrors
went with them. A teardown is a look, not a promise.

What it deliberately does not delete is the generation counter, for the reason
above: a desk that was dark through the uninstall still holds the old bytes, and
a reinstall must not write into them.

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
- `hutch run verify:plugin-log` — three real desks running the board over real
  node links: a log the manifest never declared refused by name, an owned log
  reaching every desk, a desk that was genuinely off the wire claiming the same
  task as another and the whole room converging on one winner, `board_list`
  naming the writer it cannot see, an event reported missed at a dark desk, a
  fold disagreement crossing the wire and changing what a tool says, and an
  uninstall naming the mirrors it dropped.
- `hutch run verify:plugin-board` — two real desks and the board's lease
  semantics: a claim released only by the desk holding it, a task another desk
  cannot close out from under it, a reclaim refused against a live claim and
  accepted against an expired one with both desks agreeing, a progress renewal
  crossing the wire and changing the *other* desk's answer to the same reclaim,
  each desk writing its own brainfile markdown with its own filesystem and the
  task files matching byte for byte, and two converged desks reporting the same
  fold at the same cursor set.
- `bun test plugins/board/` — the board's algorithm and its projection where
  they are decidable: pure functions over bytes three desks would hold.
  Concurrent claims, a reclaim under deliberately skewed clocks, a torn tail, a
  forged `desk` field being ignored, a renewal that cannot be shortened by
  arrival order, a digest judged against its cursor set, a title that cannot
  forge a table row or a YAML field, and a task id that cannot escape a
  directory.
- `hutch run verify:capabilities` — the plugins rung, including a desk too old
  to say.

`scripts/plugin-fixture/` is the plugin the tool harnesses install: an ordinary
MCP stdio server and nothing else, which is the claim the design rests on.
`plugins/board/` is the fleet one, and it is a real plugin rather than a fixture
— seven tools, one log, and no grants beyond the two it uses.
