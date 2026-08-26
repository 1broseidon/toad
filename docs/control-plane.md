# The control plane

Two desktops now link to each other, and the machinery they use was
borrowed from the phone. This document explains the mesh as it runs today,
why it saturated a LAN and crashed, and the design that replaces it.

The first half describes code at `ab030fa`. The second half is a decision:
`NodeIdentity`, `ResourceRef`, `NodeLink`, watches, and the envelope do
not exist in `src/` yet. Uncommitted work on this tree already patches
three `ab030fa` pathologies — empty-frame drop, a `peerBroadcast` split
so peers leave the phone bucket, and `listLocal*` methods that stop the
merge recursion — without implementing the target. A claim ledger at the
end separates observed from proposed.

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

Everything in this section is proposed. The shape borrows Kubernetes
*ideas* — typed resources, watches, reconciliation loops, leases,
capability-scoped authorization — and rejects its topology. There is no
central apiserver and no etcd quorum a home network cannot sustain.
Desktops stay authoritative for their own teammates; what changes is that
the link between them becomes a real protocol instead of a phone
impersonation.

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

## What dies, what takes its place

| Today (in code)                                    | Target (proposed)                          |
| -------------------------------------------------- | ------------------------------------------ |
| Desktop-as-phone credential (`webAccess` → `deviceForPeer`) | `NodeIdentity` with declared capabilities |
| One client bucket, `webBroadcast` to all `/ws`     | Per-subscriber watches                     |
| Dual transport: `/fleet/rpc` + reciprocal `/ws` pair | One `NodeLink` per pair, deterministic dialer |
| Recursive `mergePeerRecords`                        | Local-only APIs; views from a watched index |
| `nodeId/personaId` string routing and `/` echo checks | `ResourceRef` ownership; envelope source/version |
| Phone-brokered `/fleet/pair`                        | Membership as a first-class resource, no phone required |
| Per-event qualification switches in `onPeerPush`    | One envelope, applied uniformly            |

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

Target claims — node model, `ResourceRef`, `NodeLink`, envelope, watches,
leases, capability authz, the consistency choice — are **stated** design
decisions from the 2026-08-26 design session. None are in code. Any doc or
commit that describes them as existing is drift against this file.
