# Plugins

A plugin is a process this desk supervises. It speaks MCP over stdio for its
tools, and holds one connection back into Toad for the room. Every teammate on
the desk can call its tools; the desk owns its logs.

The one sentence that explains the shape: **Toad stands between the plugin and
the agent.** Toad is the plugin's MCP client, and re-serves its tools to
teammates from Toad's own local HTTP endpoint, one path per teammate. The plugin
is never the agent's MCP server.

That is not decoration. For the built-in Toad Agent, Toad builds the tool array
itself and always knew what a teammate had. For an ACP backend it does not: Toad
hands over server descriptors and the backend spawns them in its own process,
reporting nothing back. Standing in the middle is what makes a plugin's tools
enumerable on *both* kinds — Toad answers `tools/list` itself, sees every
`tools/call`, and an `initialize` arriving on a teammate's own path is proof the
backend really attached rather than a hope that it did.

For Toad as an ordinary MCP client brokering other people's servers, see
[mcp.md](mcp.md). A per-session tool server with no desk presence is already
supported and is called an MCP server. A plugin is the thing that needs a desk.

## The rule this API teaches

**The log carries what must survive a dark peer. Events carry what nobody may
rely on.**

Those are the two planes a plugin gets, and choosing between them is the only
distributed-systems decision the API asks an author to make. A log is durable,
mirrored to every desk, and converges when a desk that was away comes back. An
event is a push down a live wire and nothing else: a desk that is dark misses
it, permanently, and `emit` says so by naming the desks it missed.

The board is log plus events, and it is the worked example at the end of this
file.

## A plugin is a directory

It holds `toad-plugin.json` and an executable entry point. There is no registry,
no auto-update and no network install: the install takes a path to a directory
on this desk.

```jsonc
{
  "id": "com.example.board",       // reverse-DNS, lowercase, immutable
  "version": "0.1.0",              // semver
  "name": "Board",                 // defaults to the id
  "description": "…",              // optional
  "serve": { "command": "bun", "args": ["server.ts"] },
  "tools": [
    {
      "name": "board_claim",
      "description": "Claim a task",   // the model reads this
      "inputSchema": { "type": "object", "properties": {} },
      "subagentInherits": false        // required; there is no default
    }
  ],
  "logs": ["ops"],
  "rpc": { "serves": [] },
  "events": [{ "name": "foldDigest", "payload": { "type": "object" } }],
  "grants": {
    "room": [],                        // subset of ["desks", "teammates"]
    "fleet": {
      "log": ["ops"],                  // logs this plugin owns
      "rpc": { "call": false, "serve": [] },
      "events": true,
      "blobs": false
    },
    "acceptFrom": "members"            // "members" | "none" | [nodeId, …]
  }
}
```

The `id` is the plugin's one namespace root: it names the storage directory, the
proxy URL path segment, the descriptor id, and the prefix on every log stream.
It is immutable: installing an id this desk already holds is refused, and
changing it makes a different plugin rather than a new version of one.

`acceptFrom` is the inbound gate: which desks this desk's install will answer
when their copy of the plugin calls across the wire.

### What the manifest refuses

The reader refuses rather than repairs. Every other normalizer in this tree
drops what it cannot read, because those read a file a person edits by hand and
one bad entry should cost one server. A manifest is a contract from a third
party, and half of one is a plugin whose tool list nobody agreed to.

- **`env`** — there are no plugin secrets. The only place one could land today is
  plaintext beside a sealed credential store that MCP does not use.
- **`ui`** — a plugin gets a settings row, a tool list and the plugin page. No
  panes, no custom renderer code.
- **A tool with no `subagentInherits`**, no `description`, or no `inputSchema`;
  a duplicate tool name; a name outside `[A-Za-z0-9_-]{1,60}`; an empty `tools`
  array. Toad's own tools answer the subagent question in a compile-time
  exhaustive record whose point is that adding a tool forces the decision; a
  manifest is the only place a runtime tool can be forced to answer it.
- **A `from`, `src`, `desk` or `node` field in a declared event payload schema**,
  at any depth. Provenance is stamped by the receiving desk and is never a field
  a plugin may set; a plugin that could assert it could become a relay for
  unsigned assertions.
- **A grant naming a log or method the manifest never declares.** That is a
  typo, not a wider grant, and this is the one moment anyone reads the file
  closely.
- An `id` that is not lowercase reverse-DNS, a `version` that is not semver, a
  missing `serve.command`.

## The manifest is the tool list

Toad answers `tools/list` from the manifest, not from the child process. Two
consequences, both deliberate:

- **A stopped plugin still has an enumerable tool list.** The teammate can see
  the tool, and calling it comes back `plugin_down` naming it — rather than the
  tool silently not existing.
- **An install is refused if the live `tools/list` disagrees with the manifest**,
  by name, in either direction. Descriptions and schemas may drift; the manifest
  wins on those. A plugin serving a different *set* would have made Toad describe
  a tool list to every teammate on the desk that was not the real one.

There is no dynamic tool registration. That rules out a legitimate plugin shape —
one tool per configured repository, per account, per discovered device, which
must instead be one tool with a parameter. Enumerability requires that Toad know
the tools without running the plugin, and the moment dynamic registration exists
the guarantee justifying this whole design is gone.

## The downward door is an ordinary MCP server

This half needs no SDK: MCP already has one in every language. Write a stdio MCP
server that serves exactly the tools the manifest declares.

Toad spawns `serve.command` with `serve.args`, with the plugin's own directory as
the working directory, and with the same login-shell PATH recovery every stdio
MCP server gets — an app launched from Finder or a `.desktop` file has almost
none of the user's PATH. Four variables are always set, and two more when the
bridge is up:

| Variable | What it is |
| --- | --- |
| `TOAD_PLUGIN_ID` | this plugin's id |
| `TOAD_PLUGIN_DIR` | the installed directory — the working directory too |
| `TOAD_PLUGIN_STORAGE` | a writable directory that belongs to this plugin |
| `TOAD_APP_VERSION` | the Toad that spawned it |
| `TOAD_BRIDGE_SOCKET` | the upward door, below |
| `TOAD_BRIDGE_TOKEN` | minted per run, revoked when the process stops |

`TOAD_PLUGIN_STORAGE` is `plugins/<id>` under the data directory and is deleted
at uninstall. A plugin's **logs do not live there**: a process that can write its
own scratch must not be able to rewrite its own log, so owned logs are kept
outside it, under `plugin-logs/`.

A plugin started by hand from a terminal gets none of these, which is a
legitimate way to inspect one. Write the server so it still answers `tools/list`
with no bridge and no storage — the board does, and says so when a tool is
called.

## The upward door is one bridge connection

Toad's bridge is the same unix socket, the same frames and the same scope
machinery the ACP sidecar uses for a teammate. One difference decides everything
else: **a plugin's scope names a plugin and no teammate.** A plugin is a
desk-level process that outlives every session, so it cannot answer for one, and
the bridge splits the two surfaces apart rather than asking each handler to
check. A plugin calling a teammate method is told a plugin may not call it.

Everything a plugin does on the fleet rides Toad's plane. The plugin never
imports the wire, never holds a link and never sees a key. That is what makes
the refusals and the provenance stamp enforceable instead of advisory: the
rejected alternative, a second socket carrying raw frames, hands a plugin author
the room's own failure detector, and a plugin that blocks or floods then takes
the mesh down with it.

`plugins/toad-plugin-sdk/bridge.ts` is the client — one dependency-free file with
no imports from the Toad tree. There is no package yet, deliberately: a file an
author reads in five minutes is worth more right now than a version number. As
written it uses Bun's socket API; underneath it the protocol is
newline-delimited JSON over the unix socket, opened with
`{"v":1,"id":1,"method":"hello","params":{"token":…}}`, which any language can
speak. `ToadBridge.connect()` answers `null` when the three variables are
missing rather than throwing.

The whole surface:

```ts
ToadBridge.connect(): Promise<ToadBridge | null>   // .pluginId, .nodeId
  .openLog(logId)                    → { gen, offset, streamId }
  .append(logId, line)               → { gen, offset, size }   // line is JSON'd, newline added
  .cursors(logId)                    → { self, mirrors, absent, unreachable, … }
  .read({logId, ownerNode, gen, from, len}) → { text, eof }
  .emit(name, payload, to?)          → { delivered, missed }
  .onEvent(listener)                 → unsubscribe
  .onLogChanged(listener)            → unsubscribe    // a mirror gained bytes
  .desks()                           → DeskRow[]
  .teammates()                       → { id, name, team?, backendId }[]
  .call(method, params, timeoutMs?)  → the raw frame, for anything above
  .close()
```

A refused call rejects rather than resolving to something falsy, and the message
carries the refusal's own code — `not_granted: …`, `plugin_down: …` — so the
reasons stay distinguishable all the way out to the author.

### The log — what must survive a dark peer

```
plugin.log.open({logId})                            → {gen, offset, streamId}
plugin.log.append({logId, bytes})                   → {gen, offset, size}
plugin.log.cursors({logId})                         → who is writing, and whose writing is here
plugin.log.read({logId, ownerNode, gen, from, len}) → base64 bytes, and whether that is the end
                                            push:  plugin.log.changed {streamId, from}
```

Every desk owns its own copy of each declared log and mirrors every other desk's.
A log has to be both declared in `logs` and named in `grants.fleet.log`:
declaring it is what makes the grant legal to write, and the grant is what the
gate reads. A log declared and not granted refuses at `open`, by name.

**`append` takes no owner.** Writing another desk's mirror is not something this
API can express, which is exactly how transcript replication gets its
first-hand-ness: Toad stamps the writer from the authenticated link, and the
writer cannot forge it. A line is at most 64 KiB; a read is at most 256 KiB and
defaults to 64.

This is transcript replication with one key replaced. The key was
`(ownerNode, personaId, epoch)` under `replicas/`; it is now
`(ownerNode, streamId, gen)` under `streams/`, and a teammate's tape is the
first client of it, under `streamId = persona:<id>`. A plugin log's stream id is
`plugin:<pluginId>/<logId>`. Everything the tape learned came along unchanged:
fingerprinted cursors, because a byte count cannot see a rewrite that lands at
the same size; refuse-with-the-truth so the sender re-aims instead of the holder
guessing content into a mirror; owner-instructed reset only; one serialized lane
per (peer, stream).

Two things about the exchange are worth knowing because they are easy to get
wrong. A **live append is held back until the peer has said where its mirror
is** — until then the local offset is a guess, and the guess is wrong for every
peer that was dark; the catch-up the cursor exchange enqueues reads the segment
at task time, so nothing written in that window is lost. A peer that never
answers is not cut off forever: after ten seconds this falls back to shipping
blind and letting the refusal path re-aim. And a desk **asks for
the logs of every plugin it runs itself**, holdings or not: what the *other* desk
runs arrives on the capability advertisement, which is later than the link, so
waiting for it would make a desk that joins a room late depend on the owner
writing another line before it ever saw the log.

The third key component is called `gen` and never `epoch`. A persona's epoch
means *ownership* and rotates on a hop; a plugin log has no ownership epoch. It
gets a generation minted when the log is opened, bumped only when the bytes
behind it are gone — the counter outlives an uninstall precisely so a reinstall
does not write generation 1 into a mirror still holding the last life's
generation 1 on a desk that was dark through it. There is no rotate call.

`plugin.log.cursors` is how a fold reports its own completeness, and it names
two different kinds of incompleteness. `absent` is a desk that runs the plugin
and whose writing is not here at all. `unreachable` is a desk whose writing *is*
here but which cannot be reached right now — held is not caught up, and a mirror
of a dark desk is exactly as old as the moment the wire went.

Both lists are built from the capability advertisements this desk has heard, so
a desk whose advertisement never arrived is not counted as a writer at all.
Completeness is honest about what this desk knows, which is not the same as
being honest about the room.

**No ordering across logs is supplied.** The board writes its own Lamport stamp
in about twenty lines; shipping ordering here would be the special case that
proves an API wrong. No compaction and no retention either: a year-old log
re-ships whole to a newly installed desk, and every desk stores every line
forever.

### Events — what nobody may rely on

```
plugin.event.emit({name, payload, to?})  → {delivered: [nodeId], missed: [nodeId]}
                                  push:  plugin.event {from, fromName, name, payload}
```

Two lists rather than one boolean, because "some desk got it" and "the desk you
care about got it" are different facts. **Loss is total and permanent.** A dark
desk misses the event; there is no store-and-forward anywhere in this tree and
the API says so rather than implying delivery on reconnect. `to` narrows the
emission to named desks; without it every fleet peer is a target.

`from` is stamped by the receiving desk from the authenticated peer and arrives
as a sibling of `payload`, never a field inside it — which is why the manifest
validator refuses a payload schema that declares one.

### Room facts

`plugin.desks()` answers `{nodeId, name, self, linked, stale, plugins}` per desk;
`plugin.teammates()` answers `{id, name, team?, backendId}`. Each is behind its
own grant, and neither exposes a raw store. A plugin that does not need them
should not ask: the board asks for neither, because `plugin.log.cursors` already
names the desks it cannot see.

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
touching the wire, so a plugin cannot discover its grants by watching refusals
arrive.

## What a plugin cannot do

- **Call another desk.** `plugin.rpc.*` does not exist. `grants.fleet.rpc` is
  declared, validated, judged by the permission function and drawn on the plugin
  page, and **nothing consumes it**. It is in the manifest so an install written
  today is not re-negotiated when it lands.
- **Move bytes.** There is no blob store. `grants.fleet.blobs` is in exactly the
  same position as RPC: declared, judged, drawn, inert. A log line is capped at
  64 KiB, which is the API saying a log is not the way to move a file.
- **Be configured, or hold a secret.** No `env` block, no credential store, and
  no per-teammate settings. A plugin's only inputs are its tool arguments, its
  own storage directory and whatever its author put in its directory.
- **Draw anything.** No panes, no custom React, no renderer code.
- **Write another desk's log**, or assert who something came from.
- **Register a tool at runtime**, or vary its tool list per teammate: every
  teammate on the desk gets every installed plugin's descriptor, outside the
  per-teammate MCP policy, the same way the computer does.
- **Add a record kind.** The record plane is a closed union of six and a plugin
  cannot extend it. Two desks concurrently claiming the same record from the same
  epoch both compute the same version, neither wins, and each treats the other's
  op as a replay of its own — permanent silent disagreement, which is exactly the
  board's hardest operation. The log plane is the extension point; the record
  plane is not.
- **Reach a dark desk.** No relay, no store-and-forward. Both are surfaced
  honestly — `linked` on `plugin.desks()`, `absent` and `unreachable` on
  `plugin.log.cursors` — and neither is solved.
- **Be installed from anywhere but a directory on the desk**, or from a phone: a
  paired phone can read the plugin list and is refused the preview, install,
  uninstall, start and stop.

## Lifecycle

`installed | running | stopped | failed`, with a reason on every state that is
never empty.

A plugin runs **per desk, not per session**: a log has exactly one writer per
desk, and enumeration needs a tool list that exists before any session starts.
Per-teammate identity rides the proxy URL path and a per-teammate bearer token
instead.

Plugins come up with the desk, without being awaited — a plugin that hangs on
boot must not hold the window. A crash restarts with backoff (2s → 30s, ×1.6,
jittered). Three crashes inside a minute stops it and leaves it stopped rather
than competing with the room; the last 200 stderr lines are kept and the most
recent 40 of them are on its page.
Installing or uninstalling restarts every ready teammate, and queues the restart
for one that is mid-turn, because a session's tool array is fixed when it is
created. A crash does not restart anybody: the descriptor and the tool list are
unchanged by it.

**Every state change writes the ledger, in the plugin's own words.** "Not
running" is equally true of a plugin stopped from its page, one that crashed
twice in ten seconds, and one that started fine and then turned out to serve a
different tool list — three different things for a teammate to know, so the row
carries the state reason rather than a sentence that fits every failure. The last
of those matters most: a live `tools/list` that disagrees with the manifest stops
the plugin *and* clears the rows Toad wrote when it last started, because a stale
`verified` is Toad going on saying a tool is there after learning it is not.

Toad is on the hot path for every plugin tool call, so a slow plugin would
otherwise occupy capacity Toad's own tools share: calls are capped at four in
flight per plugin and time out after sixty seconds, each refusing with a sentence
rather than hanging the teammate. A plugin that does not answer `initialize`
within fifteen seconds does not start.

Refusals are distinguishable and each names a plugin and a cause — `plugin_absent`,
`plugin_down`, `not_declared`, `not_granted`, `refused`, and from the call path
`busy` and `failed`. On a tool call they come back as an MCP tool error rather
than a protocol error, so the model reads the sentence and decides what to do,
the way it reads any other tool failure.

## One decision function

`pluginMay(scope, action, target)` answers every question about what a plugin may
do, and there are exactly three callers: the gate that refuses a tool call, the
pane that lists what a plugin may reach, and the preview in the install dialog.
It takes its facts rather than fetching them, which is what lets the dialog judge
a manifest that is not installed yet. Prediction that can drift from enforcement
will drift, and the drift is invisible until it is a lie in a system prompt.

Policy itself is thin: the grants agreed to at install are the whole policy, and
grants are per desk. Each desk decides what it runs, and there is no room-level
view of who may run what.

## The way in, the way out, the way to see it

**Settings → Plugins.** Point it at a directory and choose *Read it*: Toad
validates the manifest and shows every tool and everything the plugin asks to
reach, evaluated by the same function that will enforce it. Nothing is installed
until you agree. Installing spawns the process once, compares the live tool list
against the manifest, and refuses on any mismatch — and an install that fails
leaves nothing behind.

The page carries state and its reason, the tool list with each tool's subagent
answer, the "May reach" list with a stated yes or no per row, the logs this desk
owns and mirrors with byte counts, the desks that run this plugin and whether
they are reachable, and the last stderr lines.

Uninstalling stops the process, revokes its bridge token, drops the descriptor,
deletes the plugin's storage, deletes every log it owned here and every mirror
this desk held of another desk's copy, asks the room to drop their mirrors of
this desk's copy — and **reports what it actually did**: which teammates lost
tools, which logs went, which desks confirmed and which have not been heard from.
A teardown is a look, not a promise. What it deliberately does not delete is the
generation counter: a desk that was dark through the uninstall still holds the
old bytes, and a reinstall must not write into them.

Nothing retries the desks that were not heard from, and the unconfirmed set is
not written down. A desk that was dark keeps its mirror, and nothing asks it
again when it comes back.

## Which desks have which plugins

`DeskCapabilities` carries `plugins: [{id, version, state}]` and a `format`
marker. The marker is the point: an advertisement is rebuilt field by field and
unknown fields are dropped, so without it a desk too old to advertise plugins
would be indistinguishable from a desk that has none — and a hop would refuse
with a reason that is false. With it, the reason is "that desk is too old to
say". The advertisement is rewritten when a plugin changes, not only on the
five-minute sweep.

`Persona.plugins` is a teammate's *requirement*, and it is replicated, for the
reason already written beside `harnessOverride`: any desk may be asked what would
run this teammate elsewhere. The matching ladder reports a `plugins` rung whether
or not the teammate needs one, and a failure there vetoes the whole resolution
however well the harness climb matched — no different harness fixes a missing
plugin. A hop refuses and names it. A version difference never refuses; the
destination's version runs.

Nothing in Settings sets that requirement today. It reaches the record through
`updatePersona`, and a teammate that has one restarts when it changes.

## The tool ledger

Separate from plugins, and the reason they are built this way.

Every teammate has a ledger of what tools it got, from where, and — for anything
absent — why. It is under **Settings → a teammate → Tools → What it actually
has**, built when the session starts from the same arrays the session hands the
agent, and it outlives the session, because "why does this teammate not have that
tool" is usually asked after the teammate has been stopped again.

A row is `{name, source, origin, state, reason, at}` where `reason` is required
in **every** state. That is the whole design. Tools vanishing silently is the
worst failure this project has shipped, three times in three disguises, and every
one of them was an absence with an optional explanation nobody filled in:

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
watch, so a plugin's rows go from `declared` to `verified` the moment the backend
really attaches, and back to `absent` naming the cause when the plugin stops.

## The board, and what it is an example of

`plugins/board/` is a task board every desk in the room shares. It is in the tree
because it is the harnesses' own fixture rather than a sketch, and because a
plugin API is the one surface that cannot be quietly refactored later — it was
written against this API to find out whether the API is any good.

Seven tools — `board_create`, `board_claim`, `board_progress`, `board_release`,
`board_reclaim`, `board_complete`, `board_list` — one log, `ops`, and exactly two
grants: `fleet.log: ["ops"]` and `fleet.events`. No RPC, no blobs, not even
`room.desks`, and the plugin page says each of those as a stated no. That last one
is the interesting refusal: the completeness sentence names the desks it cannot
reach, and it gets those names from `plugin.log.cursors`, which already has to
know who is writing. A grant held and never used is a grant the example teaches
people to ask for.

### N single-writer logs and a local fold

There is no shared board. Every desk owns exactly one log, mirrors every other
desk's, and folds all of them the same way. Coordination is a sort:

```
cursors = plugin.log.cursors({logId: "ops"})   // one entry per writer held here
lines   = read each, stamped with the owner Toad supplies
sort by (lamport, desk, opId)                  // identical on every desk
reduce  -> tasks
```

`lamport` is `1 + the highest seen across every log this desk has folded`, which
the board writes itself. `desk` is the tie-break, and it is the one field in the
whole model a writer cannot forge — Toad stamps the owner of the log on read, a
log has exactly one writer, and the parser overwrites whatever the line claimed.

`board_claim` is the contentious operation and the reason the pattern earns its
place. Two desks claim at once, both lines exist in different logs, every desk
folds both and the lowest `(lamport, desk)` wins. The loser learns it lost when
its mirror catches up. No coordinator, no lock, no leader election — and it
resolves correctly while a desk is dark, converging when the log arrives.

Two tool calls can be in flight in one plugin process, so the board serializes
read-decide-append-reread. The total order survives interleaving, but a desk
whose own stamps do not increase is not keeping a Lamport clock; it is keeping a
suggestion.

### Nothing here reads a clock

`desk` is authority, so every rule that says "only the holder may do this" —
`board_release`, `board_progress`, `board_complete` on a claimed task — is written
against `desk` and never against the claimant's name, which is a string an agent
typed.

Staleness is the same discipline applied to time. A `reclaim` names the claim it
supersedes and carries `assertedAt`; the fold accepts it iff
`reclaim.lamport > claim.lamport` **and** `claim.expiresAt < reclaim.assertedAt`
— both numbers being values in the log. Every desk reads the same two numbers and
reaches the same verdict under any clock skew whatsoever. The reclaiming desk's
clock decides only *when* it writes, which is liveness and never truth.

`board_progress` renews the claim by the same act, and the renewal is a
`Math.max`, so a progress line that arrives out of order cannot shorten a live
claim. That is what keeps the renewed expiry independent of arrival order, which
is what keeps a later reclaim decidable identically everywhere.

### It reports its own completeness

`board_list` ends with a line like

```
showing 1 of 2 writers — Bo's desk is not reachable from here, so its "ops" is not held
```

rather than showing part of the room in silence. Both kinds of incompleteness
reach that sentence: a writer whose log is not here at all, and a writer whose
log is here but who cannot be reached, so anything it has written since is not
held.

Task text in a tool result was written by agents on other desks, so it is fenced:
one bounded line per field, control characters gone, inside a marked block a
preamble names as data.

### The fold digest carries the cursor set

After each fold the plugin emits a `foldDigest` event: the sha256 of the ordered
op ids it folded, **and** the sha256 of the cursor set it folded them from.

The second half is what makes the first half mean anything. Two desks always
disagree while one is behind — constantly, and correctly — so a bare digest
comparison is noise that trains you to ignore the one signal that matters. Same
cursor set and a different digest has no benign reading: one of the two folds is
wrong, and a wrong fold is the failure that would otherwise rot invisibly. A peer
that reports a digest and states no cursor set is counted as wrong too, rather
than ignored, because silence about the thing that makes a claim checkable is not
reassurance.

The disagreement shows in `board_list` and in the desk's own `board.md`. It is
not on Toad's plugin page.

### The projection is a pure function

The board writes brainfile-shaped markdown into its own storage directory with
its own `writeFileSync`. Toad is not involved, holds no copy, and offers no way
to read one desk's projection from another — so the projection cannot become a
coordination path however badly a later change wants it to.

It comes in two halves on purpose:

- `board/<taskId>.md` is a function of the fold alone, so two desks holding the
  same bytes write **byte-identical** files. Nothing local reaches this half. The
  frontmatter uses brainfile's own names — `id`, `title`, `column`, `status`,
  `assignee`, `progress`, `createdAt`, `updatedAt`, `tags` — so brainfile-core's
  pure domain logic can be pointed at these files without a translation layer.
  Every scalar goes through JSON, which YAML 1.2 is a superset of, so a title
  cannot smuggle a second field.
- `board.md` is this desk's own view — completeness, the cursor set, who
  disagrees — and is expected to differ. Putting all of it in one clearly marked
  file is what keeps the deterministic half checkable.

A task id folded out of another desk's log is bytes another agent wrote, so it is
checked before it becomes a filename; a task whose id would escape the directory
gets no file and the index says how many did.

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
  reaching every desk, a desk genuinely off the wire claiming the same task as
  another and the whole room converging on one winner, an event reported missed
  at a dark desk, a fold disagreement crossing the wire and changing what a tool
  says, and an uninstall naming the mirrors it dropped.
- `hutch run verify:plugin-board` — two real desks and the board's lease
  semantics: a claim released only by the desk holding it, a task another desk
  cannot close out from under it, a reclaim refused against a live claim and
  accepted against an expired one with both desks agreeing, a progress renewal
  crossing the wire and changing the *other* desk's answer to the same reclaim,
  each desk writing its own markdown with its own filesystem and the task files
  matching byte for byte.
- `bun test plugins/board/` — the board's algorithm and its projection where they
  are decidable: pure functions over bytes three desks would hold. Concurrent
  claims, a reclaim under skewed clocks, a torn tail, a forged `desk` field being
  ignored, a renewal that cannot be shortened by arrival order, a digest judged
  against its cursor set, a title that cannot forge a table row or a YAML field,
  and a task id that cannot escape a directory.
- `hutch run verify:plugin` — the claims the whole design was argued on, and the
  harness that should go red first if any of the above stops being true. A
  plugin's tools named on **both** agent kinds under the different names each
  really sees; a plugin that refuses to start and one whose live tool list
  disagrees, each leaving every teammate's ledger naming the tool and the cause;
  two partitioned desks claiming the same task and converging on the winner the
  harness computed itself from `(lamport, desk)`; the real fold handed a clock
  that throws, and folded again a decade out in both directions, to show only
  in-log values decide; an append and a wire delta naming another desk five
  different ways and changing nothing. It ends by running `replicas.test.ts` and
  `verify-transcripts.ts` and checking both are byte-identical to the branch
  point — the gate that says a plugin API was not bought by destabilising the
  tape.
- `hutch run verify:capabilities` — the plugins rung, including a desk too old to
  say.

`scripts/plugin-fixture/` is the plugin the tool harnesses install: an ordinary
MCP stdio server and nothing else, which is the claim the design rests on.
`scripts/plugin-probe/` is the harness's hand inside a plugin — one tool that
forwards a raw bridge frame and hands the answer back, which is the only way to
ask what the transport does with a field a plugin author added by hopeful
analogy, from where a plugin actually stands. `plugins/board/` is a real plugin
rather than a fixture.
