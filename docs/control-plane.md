# The control plane

Two desktops now link to each other, and the machinery they use was
borrowed from the phone. This document explains the mesh as it runs today,
why it saturated a LAN and crashed, and the design that replaces it.

The first half describes code at `ab030fa`. The target is being built in
slices. Shipped so far: the storm-stop; a stable signed desktop
`NodeIdentity`; local signed admissions; an always-on node listener; mDNS
discovery; incoming Accept/Deny; an address/token path; and one
deterministically dialed, bidirectional `NodeLink` per pair, where both ends
prove their Ed25519 identity against a fresh nonce before serving RPC or
observations and every post-handshake frame carries a strict sequence and a
pair-secret HMAC. That link is still a bridge over `fleet.json`, pairwise
bearer tokens, and the routed RPC surface — not the final envelope,
replicated membership, or watches.

**Order of work from 2026-08-26.** Storage comes next, then federation and
the envelope; the phone's join moved behind both. Two reasons, both in
[Storage](#storage-records-the-mesh-can-replicate). Every remaining piece
of the target — replicated membership, watches, resource versions,
local-only reads — is a claim about records, and today there are no
records, only one file rewritten whole; building the envelope over that
file would mean building it twice. And the roster is meant to become mobile,
not merely shared: an agent should be able to hop to another machine, work,
and hop back, or move permanently, or have work spread across machines.
That is a storage requirement before it is a protocol one, and parts of it
— a fencing epoch, an owner-free key, epoch-segmented history — cannot be
retrofitted without a migration that endangers the state being moved. A
claim ledger at the end separates observed, implemented, and proposed.

## Today: a desktop is a phone with extra steps

Each desktop is fully authoritative for its own teammates. The fleet layer
(`src/bun/fleet/fleet.ts`) was designed for two jobs — presence snapshots
and one-message delivery — and grew a third: showing a peer's teammates as
first-class, chattable personas. The third job is what strains the design,
because it was built by making each desktop a *device* of the other.

**Pairing needs a phone.** The phone officiates: it asks desktop A for an
invite (an origin plus a short-lived code), hands both to desktop B, and B
claims at A's `/fleet/pair`. Each side stores the other in `fleet.json`
with pairwise bearer tokens — `callToken` to present, `acceptToken` to
verify. Two desktops alone in a room cannot link.

**Every pair runs two transports.** Peers speak `/fleet/rpc` — HTTP POST,
bearer auth, seven methods (`status`, `deliver`, `createTeammate`,
`readTranscript`, `readThread`, `notify`, `webAccess`); the module comment
still says two, which dates from before the surface grew. For live
interaction, each desktop calls `webAccess`, receives a device token that
`deviceForPeer` files in `web.json` beside the phones, and dials a standing
`PeerWire` WebSocket to the peer's `/ws` (`src/bun/fleet/wire.ts`). Both
sides do this, so a pair normally holds two reciprocal sockets, each
carrying the full phone RPC surface plus every push.

**All clients share one bucket.** `send()` in `src/bun/index.ts` delivers
each push to the desktop webview and to `webBroadcast()`
(`src/bun/web/server.ts`), which writes the frame to every `/ws` client it
has — phones and peer desktops alike. There is no subscription; a peer
desktop hears everything a phone hears, whether or not it mirrors the
event.

**The loop brake is a string check.** When a push arrives over a
`PeerWire`, `onPeerPush` qualifies bare persona ids as `nodeId/personaId`,
drops ids that already contain a `/` (someone else's rebroadcast), and
re-emits through the same `send()` — which broadcasts it right back to the
peer it came from. For transcript and session events the `/` check
terminates the echo after one round. For `peerActivityChanged` and
`schedulesChanged` it does not: qualified entries are filtered out but the
*empty* record `{}` and empty list `[]` are still emitted, so each desktop
answers the other's empty frame with its own, forever. `personasChanged`
survives only because a JSON-sameness damper (commit `f2a1163`) stops
publishing rosters that did not change.

**Merged reads recurse.** `listPreviews` and `listPeerActivity` answer by
merging local records with the peer's, via `mergePeerRecords` calling the
same method on the peer. The peer's handler is the same merged handler, so
it calls back, and the mutual recursion unwinds only when the nested calls
hit `mergePeerRecords`' 4-second timeout. The answer is eventually right;
the cost is a timeout-bounded call storm on every roster read.

### What it cost

On 2026-08-26, with one desktop pair linked and sessions active, this
machine's mesh moved roughly 22.8 GB one way and 31.8 GB the other, held
the Bun worker at 70–94% CPU, and ended in a segmentation fault inside Bun
1.3.13's FFI threadsafe-callback path (`/tmp/toad-launch.log`). After a
restart the idle mesh sat near 1.8% CPU with near-zero traffic — the loops
need live events to feed on, which is exactly why they ship: a quiet mesh
looks healthy.

Two dampers exist and both are patches, not design: the `personasChanged`
sameness check above, and the native-menu rebuild being skipped when its
inputs did not change (and skipped entirely on Linux, where Electrobun's
GTK menu wrappers are no-ops — `refreshMenu` still runs, `setApplicationMenu`
returns early). Every other event class relies on the `/` check or on
nothing.

## Target: federated ownership

This section remains the target. Identity, desktop admission, and the
deterministic bidirectional `NodeLink` transport now exist; resource
references, the common envelope, replicated membership, watches,
reconcilers, and leases remain proposed.
The shape borrows Kubernetes *ideas* — typed resources, watches,
reconciliation loops, leases, capability-scoped authorization — and
rejects its topology. There is no central apiserver and no etcd quorum a
home network cannot sustain. Desktops stay authoritative for their own
teammates; what changes is that the link between them becomes a real
protocol instead of a phone impersonation.

**Every participant is a Node.** Desktop and mobile carry the same
identity shape — a `NodeIdentity` — and differ only in declared
capabilities:

| Node    | Capabilities                              |
| ------- | ----------------------------------------- |
| desktop | `admin` + `executor` + `store` + `gateway` |
| mobile  | `endpoint` + `admin-client` + `observer`  |

A phone may hold admin *authorization* — the right to change membership or
settings — without being a store or a consensus voter. Authorization and
storage stop being the same axis.

**The phone joins the plane, not a computer.** Admission is a room-level
act by an admin node. Scanning a desktop QR is only a transport to that
admin; it must not mint a second identity or a second membership. Two
desktops or five is the same join. After admission the phone holds one
`NodeIdentity` and one membership record.

**v1 grant is a desktop allow-list.** The admin names which owner nodes
the endpoint may list and open. That projection is the phone's room view.
It is not yet a capability on every `ResourceRef`, and it is not a
guarantee that an allowed desktop's agents cannot reach a hidden one.

**Later: agent fan-out is not the list filter.** A phone granted only the
Linux desktop can still ask a Linux teammate to deliver to a Mac teammate
if those nodes already share a `NodeLink`. Visibility on the phone and
authority between executors are different axes. Closing that path needs
owner-scoped commands or an explicit inter-node grant — not another
client-side hide. This remains an open design item; do not treat v1
allow-list as isolation.

**Every mutable resource has one owner.** A resource is addressed as a
`ResourceRef { kind, id, ownerNode }`, and the owner is data, not a prefix
parsed out of a string. Today's `nodeId/personaId` convention — where
`parseRemoteTarget` splits an id to decide routing and a `/` in a string
decides loop termination — dies as a mechanism. It may survive as display.

**Replicate the map, not the territory.** Nodes replicate membership,
ownership records, and lightweight resource versions. Transcripts,
attachments, and session state stay on their owner and are fetched on
demand. The 22.8 GB day is impossible by construction when the replicated
set is small and versioned.

**Reads are local-only.** A node's API answers from its own store and its
replicated index, never by fanning a call to peers inside a handler.
Cluster-wide views (the merged roster, previews, activity) are assembled
by the caller once, or served from an index kept current by watches. The
recursive merge dies with the merged endpoint.

**Events go to subscribers.** A node watches the resources it cares about
and receives only those changes. No global broadcast to peers, no
rebroadcast of a peer's events, and no echo filter — a watch delivers a
change exactly once because the subscription says so, not because a string
check caught the second copy.

**One link, one envelope.** A pair of nodes holds one authenticated
`NodeLink`, dialed by whichever side a deterministic rule picks, replacing
today's two reciprocal phone-token sockets plus the HTTP surface. Every
frame carries the same envelope: source node, destination, kind,
correlation id, idempotency key, and an optional resource version. Loop
prevention, retry safety, and staleness detection become envelope
properties instead of per-event switch cases.

**Consistency is chosen, not assumed.** Two admin desktops cannot be both
partition-safe and strongly consistent for concurrent membership changes;
that is a CAP fact, not an implementation gap. The design must pick one of
two honest options: signed membership events with deterministic conflict
resolution (last-writer or a defined precedence, applied identically on
both sides after a partition heals), or a third voter to break ties. A
mobile node is not a voter unless it is reliably online, which today it is
not. This is the one open decision the rest of the design does not force.

## Storage: records the mesh can replicate

The roster is the first resource that has to become federated, and it is
the one the current store cannot express. `config.json` is a single
document holding every teammate of this desktop, rewritten whole on every
mutation, with no owner and no per-record version. Five consequences
follow, and each one blocks a piece of the target above.

**There is nothing to address.** Replication needs a record with an owner
and a version so a receiver can decide whether a change is new. A persona
has `updatedAt` (wall clock) and, for remote ones, a `node` — assigned by
the reader while qualifying, not carried by the record. Ownership is a
string prefix invented at the boundary, which is exactly the mechanism the
target retires.

**The replicated set is the whole document.** `publishPersonas` sends
`mergedPersonas()` — full `Persona` objects, including `cwd`,
`mcpPolicy`, `subagents`, `computer`, and `sessionCheckpoints` — to every
peer and every `/ws` client. A filesystem path and a list of local MCP
server ids mean nothing on another machine, and shipping them makes the
identity of a teammate change whenever its private state does. The
receiving damper compares whole records, so private churn re-triggers the
merged publish and its menu rebuild.

**Deletes leave no trace.** `deletePersona` filters the array. A peer that
was offline for the delete has no way to learn it happened; the next
snapshot it receives simply lacks the row, which is indistinguishable from
a roster it has not heard about yet.

**Every write is the whole roster.** A session checkpoint after a turn
rewrites all teammates. That is a wide blast radius for a narrow change —
demonstrated on 2026-08-26, when one bad write replaced the entire roster.

**A peer's roster is not stored at all.** It lives in the `rosters` map in
`wire.ts`, rebuilt from a full snapshot on link-up. Restart the app and the
room is empty until a peer speaks.

### The shape that replaces it

**One record per resource, owner-stamped.** Every replicated record
carries `{ kind, id, ownerNode, ownerEpoch, version, updatedAt, deleted }`.
`ownerNode` is data, not a parsed prefix — `ResourceRef` arriving as
storage rather than as a wire convention.

**Ownership is a lease with a fencing token.** A desktop is authoritative
for the teammates it currently holds, but — see
[Mobility](#mobility-the-agent-that-hops) — it does not hold them forever.
So ownership is not a fixed property of a record; it is a claim carried by
`ownerEpoch`, a counter that increments on every transfer. Two rules follow
and they are the whole merge:

- **Compare `(ownerEpoch, version)`.** A higher epoch wins outright; within
  one epoch, the current owner's `version` orders its own edits.
- **A node may only write records it owns at the highest epoch it knows.**
  A machine that was partitioned and lost a teammate meanwhile finds its
  writes fenced out on reconvergence, rather than merged into a fork.

Without the epoch, "higher version wins" silently permits split brain: two
machines both believing they own an agent, both running a session, both
appending to a transcript. The epoch is cheap and it is the one field that
cannot be retrofitted safely later, because the migration that adds it is
itself a window in which two owners can disagree. It goes in from the
first slice even though nothing increments it yet.

**Three classes of state, not two.** The single most consequential
distinction in the design, because it decides both what crosses the wire
continuously and what a hop has to carry:

| Class | Fields | Rule |
| --- | --- | --- |
| **Replicated** | `id`, `ownerNode`, `ownerEpoch`, `version`, `name`, `goal`, `team`, `face`, `backendId`, `modelId`, `deleted` | Small, machine-independent, everywhere, always |
| **Portable** | `mcpPolicy`, `webSearchPolicy`, `subagents`, `computer` settings, transcript, threads, workspace contents | Travels with the agent on a move; not replicated in between |
| **Machine-bound** | `cwd`, `sessionCheckpoints`, `modeId`, computer container and token, MCP server instances | Never travels; re-derived at the destination |

Presence — session state, activity, previews — is in none of them. It is
watch traffic, not a record, fetched or subscribed rather than stored as
roster truth.

The machine-bound row is where the interesting constraint lives. An ACP
`sessionCheckpoint` is opaque to everything except the harness that issued
it on the machine that ran it; a Cursor session id means nothing to the
Cursor on another laptop. So a hop can never carry live harness context.
What it carries is the transcript, and the destination reconstructs from
that — which is exactly the mechanism already specified in
[followups.md](./followups.md) for resuming after an interruption. A hop is
an interruption with a change of address, and it should reuse that path
rather than invent a second one.

**Deletes are tombstones.** `deleted: true` with a version, retained long
enough for an offline peer to learn it, then collected.

**Sync is a log, not a snapshot.** Each owner appends its own changes to an
oplog with a monotonic sequence. A node remembers `applied[ownerNode]` and,
when a link comes up, asks only for what it has not seen; afterwards single
ops arrive as they happen. `personasChanged`-with-the-whole-roster dies
here, along with the sameness damper that exists to survive it. Ops are
idempotent by `(kind, id, ownerEpoch, version)` — note the key is the
record and its epoch, not the node that sent it, so an op about an agent
that has since hopped is still recognised as the same op.

**v1 replicates only first-hand records.** A node ships records it owns and
does not relay a third node's, so no transitive gossip and no fan-out
amplification. Relay becomes possible later precisely because records carry
their owner.

**Local view state stays local, keyed by persona id alone.** This desk's
interleave (`roster.json`) and `lastPersonaId` are properties of the
looking, not of the looked-at, so they keep living here. They must key on
the bare persona id and resolve the owner through the record — never on
`nodeId/personaId`. An owner-qualified key is a latent bug the moment an
agent hops: the display order and the reopened teammate would both point at
an address that no longer holds them.

### Mobility: the agent that hops

Not being built yet, and the storage layer still has to be chosen for it,
because three of its requirements cannot be added afterwards without a
migration that risks the very state it moves. The intended behaviours are:
an agent hops to another machine, works, and hops back; an agent moves
permanently; and work is spread across machines when a task can be handed
over through git or a similar shared artifact.

**What a move is.** Three commits that must all land or none: bump
`ownerEpoch` and set `ownerNode` to the destination; hand over the portable
class; release the source's machine-bound state (session, container, lease).
A move that half-lands is precisely split brain or a lost agent — the two
failures the epoch exists to make impossible. **Atomic multi-record commit
is therefore a hard requirement of the store**, not a convenience.

**History spans owners.** A transcript is append-only, but after a hop it
has been appended to from two machines. Rewriting or shipping the whole
file on every move gets slower exactly as an agent becomes well-used, so
history is stored as epoch segments — one append-only segment per
`(persona, ownerEpoch)`, written only by the machine that held the agent
then, assembled in order on read. Nothing is rewritten, a partitioned
machine's segment stays valid history for the epoch it belongs to, and an
old segment can be fetched on demand instead of carried. This changes the
on-disk transcript layout, which is why it belongs in the storage slice
rather than after it.

**Load balancing needs claims, not just presence.** Handing a task to
whichever machine is free means a work record with a lease and an expiry, so
a claim by a machine that then dies is reclaimable. Presence answers who is
idle; the lease is what makes the assignment safe. Nothing to build now, but
it is another transactional, TTL-bearing record — same requirement as above.

**Invariants to hold from today, so the option stays open.** Each of these
is cheap now and expensive later:

- Never key anything by owner: not a table, not a filename, not a directory,
  not a display order, not a cache.
- Never assume a record's owner is stable for its lifetime; routing tables
  and memoised lookups must be invalidated by epoch.
- Never put an absolute path in a replicated record.
- Never treat a harness session id as portable.
- Carry `ownerEpoch` from the first slice, unused.

### Engine

Mobility settles what was an open question. The move above is a
multi-record transaction with a fencing token, and load balancing adds
leases with expiries; a directory of JSON files cannot commit that
atomically without a journal — that is, without writing a transaction log
by hand, badly, in the one code path where a bug means two copies of an
agent running at once.

*SQLite via `bun:sqlite`* is therefore the choice, not merely the
recommendation. It is already in the runtime with no new dependency. A
`resources` table plus an append-only `oplog` gives ordering, range scans by
sequence, real transactions for a handover, and watches as a tail on the
log. Two costs are paid deliberately rather than discovered: it has to
survive the Electrobun bundle — proved by a `hack/verify` script before
anything depends on it, the way `verify-pi-bundle` guards the agent — and
it is not hand-readable, so the store exports a plain-JSON snapshot on a
schedule and `AGENTS.md` keeps materialising each teammate's name and goal
in its workspace, which is what made the 2026-08-26 recovery possible.

*Record files* remain the honest alternative only for as long as agents
never move. They are recorded here as rejected, with that as the reason.

**Migration is one-way and paranoid.** Read `config.json`, write records,
and leave the old file untouched until the app has run once against the new
store. The old file remains the fallback for one release. Given the
incident that opened this work, no migration step may delete or rewrite the
only copy of a roster.

### Durability rules the new store inherits

Shipped ahead of the redesign, and non-negotiable in it
(`src/bun/store/durable.ts`):

- Writes are atomic: temp file, `fsync`, rename. A truncated file is not a
  reachable state.
- A backup mirrors the last content that went live, so recovery loses
  nothing rather than one write.
- An unreadable record is *damaged*, never *empty*. Reads may answer empty;
  writes refuse, because the alternative is persisting an erasure.
- Test isolation is set in a preload, before any module can resolve the
  real data directory, and a mismatch throws instead of writing.

## What dies, what takes its place

| Today (in code)                                    | Target (proposed)                          |
| -------------------------------------------------- | ------------------------------------------ |
| Desktop-as-phone credential (`webAccess` → `deviceForPeer`) | `NodeIdentity` with declared capabilities |
| One client bucket, `webBroadcast` to all `/ws`     | Per-subscriber watches                     |
| Dual transport: `/fleet/rpc` + reciprocal `/ws` pair | One `NodeLink` per pair, deterministic dialer |
| Recursive `mergePeerRecords`                        | Local-only APIs; views from a watched index |
| `nodeId/personaId` string routing and `/` echo checks | `ResourceRef` ownership; envelope source/version |
| Phone-brokered `/fleet/pair`                        | Membership as a first-class resource, no phone required |
| One web credential per desktop in `toad-instances`  | One mobile node; admin grant of which desktops it may list |
| Per-event qualification switches in `onPeerPush`    | One envelope, applied uniformly            |
| `config.json` rewritten whole, no owner or version  | Owner-stamped records with per-record versions |
| Whole-roster `personasChanged` snapshots            | Per-owner oplog, synced by sequence         |
| Deletes that vanish from an array                   | Tombstones an offline peer can still learn   |
| Peer rosters held only in `wire.ts` memory          | Replicated records that survive a restart    |
| A teammate permanently belonging to one desktop     | Ownership as a lease, transferable by epoch  |
| `transcripts/<id>.jsonl` written by one machine      | Epoch segments, assembled across owners      |

Elevated to first-class concepts: node identity, capabilities, membership,
resource references, ownership and leases, the envelope, local-only APIs,
watches, resource versions, reconcilers, authorization, and per-node
metrics — the missing instrument that let a 22 GB day pass unnoticed until
the crash.

The gateway (remote reachability) is a separate system; its relationship
to pairing and push is covered in [push.md](./push.md).

## Claim ledger

Current-system claims, verified against `ab030fa`:

| Claim | Level | Source |
| --- | --- | --- |
| Desktops authoritative for own teammates | observed | `fleet.ts` L14–36 |
| Phone brokers pairing; pairwise tokens in `fleet.json` | observed | `fleet.ts` L157–247 |
| `/fleet/rpc` has seven methods; comment says two | observed | `fleet.ts` L275–382 |
| Peer gets device token via `webAccess`/`deviceForPeer` | observed | `fleet.ts` L368–378, `web/devices.ts` L132–144 |
| Each desktop dials `PeerWire` to peer's `/ws`; two sockets per pair | observed | `wire.ts` L159–195, L48–56 |
| `send()` fans to webview + `webBroadcast`; broadcast hits all clients | observed | `index.ts` L154–158, `web/server.ts` L378–386 |
| `onPeerPush` qualifies, drops `/`-ids, re-emits via `send` | observed | `wire.ts` L239–294 |
| Empty `peerActivityChanged` `{}` / `schedulesChanged` `[]` still emitted | observed | `wire.ts` L269–287 |
| Empty-frame emissions loop between two desktops | derived | emit path re-enters `send` → `webBroadcast` → peer, no damper on these events |
| `mergePeerRecords` recurses peer-to-peer until 4s timeouts | observed structure, derived behavior | `wire.ts` L416–439, `index.ts` L758–783 |
| `personasChanged` sameness damper | observed | `wire.ts` L243–253, commit `f2a1163` |
| Menu rebuild skipped on same inputs; native menus no-op on Linux | observed | `index.ts` L455–475, `menu.ts` L23–28, L57 |
| SIGSEGV in Bun 1.3.13 | observed | `/tmp/toad-launch.log` (panic line) |
| ~22.8 GB / ~31.8 GB moved; 70–94% CPU; ~1.8% idle after restart | stated | session observation, 2026-08-26; not reproducible from the repo |

Implemented first-slice claims on the current working tree:

| Claim | Level | Source |
| --- | --- | --- |
| Desktop identity is an Ed25519 keypair with the existing install id | observed | `src/bun/node/identity.ts` |
| Membership admissions are signed locally and stored in `nodes.json` | observed | `src/bun/node/membership.ts` |
| `_toad-node._tcp.local` discovery carries no token or roster | observed | `src/bun/node/discovery.ts` |
| Nearby requests require remote Accept/Deny; advanced tokens are single-use | observed | `src/bun/node/admission.ts`, `src/bun/fleet/fleet.ts` |
| Node peers use the always-on node listener and do not appear in Linked devices | observed | `src/bun/node/server.ts`, `src/bun/web/devices.ts` |
| Direct admission, denial, mDNS, peer wire, and advanced token are exercised with two processes | observed | `hack/verify-node-admission.ts` |
| Exactly one side dials each admitted pair and both sides issue RPC on that socket | observed | `src/bun/node/link.ts`, `src/bun/fleet/wire.ts` |
| Both ends answer a fresh nonce with their admitted Ed25519 key before the link becomes ready | observed | `src/bun/node/link.ts` |
| Post-handshake frames carry a strict sequence and pair-secret HMAC for integrity and replay rejection | observed | `src/bun/node/link.ts`, `src/bun/fleet/fleet.ts` |
| The two-process harness proves one dialer, one incoming/outgoing socket pair, bidirectional RPC/push, and reconnect | observed | `hack/verify-node-admission.ts` |

Data-safety claims, verified on the current tree:

| Claim | Level | Source |
| --- | --- | --- |
| A test's fixture personas replaced the live roster on 2026-08-26 | observed | `config.json` mtime and contents; `async-jobs.test.ts` fixture |
| `ROOT` resolves at import, so a later `TOAD_DATA_DIR` is ignored | observed | `src/bun/paths.ts` L6–22; `pi/subagent.ts` L19 static import chain |
| Roster writes are atomic and keep the last live content as a backup | observed | `src/bun/store/durable.ts`, `hack/verify-roster-durability.ts` |
| A damaged roster is recovered from backup, or held and never overwritten | observed | `src/bun/store/personas.ts`, `hack/verify-roster-durability.ts` |
| Tests cannot reach the real data directory | observed | `bunfig.toml`, `test/preload.ts`, `assertDataRoot` |

`ResourceRef`, the common envelope, replicated membership, watches,
leases, capability authorization, removal of the transitional HTTP/bearer
surface, and the multi-writer consistency choice remain **stated** design
decisions from the 2026-08-26 session.

The implementation order set on 2026-08-26: **(1)** owner-stamped records
with the three-class split, a fencing `ownerEpoch`, epoch-segmented
history, and a per-owner oplog; **(2)** federation and the common envelope
over those records; **(3)** mobile as one plane member with an
admin-granted desktop allow-list. The phone's join is unchanged in design
and only later in sequence — its allow-list still does not constrain
agent-to-agent delivery across already-linked owners, which stays a later
stated item.

Agent mobility — hop, permanent move, load balancing — is **stated** and
deliberately unbuilt. It is recorded here because it is the requirement
that decided the storage engine and three otherwise-optional fields; the
storage slice must leave it reachable without a second migration. Any doc
that describes any of this as shipped is drift against this file.
