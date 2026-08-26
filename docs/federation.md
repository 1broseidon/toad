# Federation — Phase 5 implementation spec

Branch: `mesh/federation`. This file is the what-to-build. The why lives in
[control-plane.md](./control-plane.md) — read "One link, one envelope" and
"Storage: records the mesh can replicate" (especially "Sync is a log, not a
snapshot" and "v1 replicates only first-hand records") before implementing.
[roster-store.md](./roster-store.md) §12 lists what Phase 4 left on the wire;
that list is this phase's starting debt.

## 1. Status and evidence levels

Phase 5 replicates **persona records** between admitted node pairs over the
existing `NodeLink`, inside the existing HMAC-sealed frame body. After it
ships: a link-up catches a peer up from a durable per-owner cursor; single
ops flow live as they commit; a restart shows the whole room from the local
store without a peer speaking; and the whole-roster `personasChanged`
snapshot, its sameness damper, the in-memory `rosters` map, and the leftover
`/fleet/rpc` status polls are gone. Membership replication, watches for
presence, phone join (Phase 6), web-mode removal (Phase 7), and hop
(Phase 8) are **not shipped** and this spec does not build them.

Every claim below is one of:

- **observed** — true of the code on this branch (or of the live pair on
  2026-08-26), with a file path or source cited.
- **stated** — a decision made here or inherited. Do not reopen stated
  decisions in implementation; flag disagreement in review instead.

Decisions inherited from control-plane.md, roster-store.md, and the phase
brief (do not reopen):

- Engine is `bun:sqlite`; records exist (`src/bun/store/records.ts`). No
  second store for peers — remote records land in the same `resources` table.
- `ownerEpoch` is stored and compared (`wins()`, records.ts L308–312);
  nothing in Phase 5 increments it. Hop is Phase 8.
- v1 replicates only first-hand records: a node ships records it owns and
  never relays a third node's. No gossip.
- Deletes are tombstones (records.ts L536–564); sync must ship them. No
  tombstone collection and no oplog GC in Phase 5 (stated — carried forward
  from roster-store.md §4; roster mutations are small).
- View state (`roster.json`, `lastPersonaId`) stays bare persona ids
  (roster-store.md §9).
- Tests isolate via `test/preload.ts` + `assertDataRoot`; never touch the
  real data dir. Damaged ≠ empty; never overwrite a damaged store.
- `NodeLink` stays one dialer, mutual Ed25519, HMAC frames
  (`src/bun/node/link.ts`). No second desktop transport. The envelope rides
  inside the existing secure body — not a second socket.
- Web mode / 4680 stays for phones and the leftover `openRemoteDesktop`.
  NodeLink must not require it (observed 2026-08-26: web access off on the
  Mac, NodeLink kept working; `listDevices` hides desktop rows and NodeLink
  never mints a `web.json` device).
- The CAP/voter decision for membership replication stays open and out of
  scope. This phase federates roster records, not membership.
- `config.json` is frozen — never rewritten or deleted.
- `nodeId/personaId` string routing survives in UI/MCP/notify. Phase 5 wraps
  new frames in an envelope without forcing callers off qualified ids.
- No Electrobun rebuild as a spec gate; the two-process bun harness is
  enough.

Live facts this spec designs against (observed 2026-08-26, live pair):
Linux `79fce114ba448245` and Mac `a2acf8785099e4d7` are linked with
`transport: "node"`; Linux holds 7 personas, Mac holds 4; the merged room is
11. Three ESTAB sockets exist between them: one NodeLink plus two leftover
`/fleet/rpc` status polls — the polls are what §6 kills.

## 2. Glossary

One term per concept. Use these names in code and commit messages.

- **envelope** — the one typed value new inter-node frames carry:
  `{ v, src, dst, kind, payload }` (§3). Rides as the `env` member of the
  existing secure NodeLink body.
- **sync.hello** — envelope kind sent by a node when a link comes up:
  "of your first-hand ops, I have applied through seq N". Opens a ship
  session in the other direction.
- **sync.ops** — envelope kind carrying a batch of the sender's first-hand
  ops, ascending by the sender's local `seq`.
- **first-hand op** — an oplog row whose `ownerNode` is the shipping node's
  own id. The only thing a node ever ships (stated, control-plane.md "v1
  replicates only first-hand records").
- **applied cursor** — the durable per-owner bookmark in the
  `applied_cursor` table (records.ts L170–173): the highest of that owner's
  seqs this node has applied. Phase 4 created the table with zero helpers;
  Phase 5 adds them (§8.1) and writes it.
- **ship cursor** — in-memory, per link session: the highest own seq already
  sent to one peer. Initialised from the peer's `sync.hello`, dies with the
  session.
- **catch-up** — draining `oplogAfter(localNodeId(), shipCursor, …)` in
  batches until empty, right after a `sync.hello` arrives.
- **live ops** — the same drain, re-run when a local commit appends oplog
  rows. Catch-up and live share one code path.
- **ship session** — the lifetime of one authenticated link
  (handshake to disconnect). Ship cursors reset with it; applied cursors do
  not.
- **remote record** — a `resources` row whose `ownerNode` is not this node.
  Written only by `applyRemoteOps`, never by `putLocal`.
- **facade filter** — `listPersonas`/`getPersona` answering only
  locally-owned records (§5.2), so remote records never leak into local-only
  code paths.
- **merged room** — `mergedPersonas()` in `src/bun/index.ts` L529–531:
  local personas plus wire-qualified remote personas, unchanged in shape.

## 3. Envelope schema

New file `src/bun/node/envelope.ts` (SLICE-B). Exact types:

```ts
import type { ResourceOp } from "../store/records";

/** An op as shipped: the owner's oplog row, seq included so the
 *  receiver can advance its applied cursor. */
export type SyncOp = ResourceOp & { seq: number };

type EnvelopeBase = {
	/** Envelope version. Literal 1. Required. */
	v: 1;
	/** Sender's NodeIdentity id. Required; must equal the link's peer id. */
	src: string;
	/** Receiver's NodeIdentity id. Required; must equal the local id. */
	dst: string;
	/**
	 * Correlation id, reserved for future request/response kinds
	 * (control-plane.md "One link, one envelope"). Both Phase 5 kinds are
	 * one-way and never set it. Optional.
	 */
	corr?: string;
};

export type Envelope =
	| (EnvelopeBase & { kind: "sync.hello"; payload: { cursor: number } })
	| (EnvelopeBase & { kind: "sync.ops"; payload: { ops: SyncOp[] } });

/** Structural check only: shape, kinds, integer cursor ≥ 0, non-empty ops
 *  array with each op passing the same shape rules records.ts enforces.
 *  Sender/receiver identity is the caller's check, not this one. */
export function isEnvelope(value: unknown): value is Envelope;
```

What is deliberately **not** in the envelope (stated):

- No frame-level idempotency key. For `sync.ops` the idempotency key is
  per-op — `(kind, id, ownerEpoch, version)` — enforced by the store
  (control-plane.md "Sync is a log, not a snapshot"; observed
  `oplog_idempotent` index, records.ts L166–168, and the quiet-replay path,
  records.ts L323–336). A frame key would be a second, weaker key.
- No `resourceVersion` field; ops carry their own `ownerEpoch`/`version`.
- No auth material. The NodeLink session already authenticates both ends
  (mutual Ed25519 handshake + per-frame HMAC and strict seq, link.ts
  L133–234, L326–379). `src`/`dst` are routing sanity, not proof.

How it rides (SLICE-B, `src/bun/node/link.ts`):

- The `Frame` type (link.ts L29–47) gains one optional member:
  `env?: Envelope`. An envelope frame's secure body is `{ env }` and nothing
  else — never combined with `id`/`method`/`push`.
- `NodeLink` gains a send method mirroring `push()` (link.ts L283–291):

```ts
/** Sends one envelope on the authenticated link. False when not up. */
envelope(env: Envelope): boolean;
```

- The constructor (link.ts L77–91) gains a ninth, **optional** parameter
  `onEnvelope?: (env: Envelope) => void`, appended after `onDown`, so
  `wire.ts` compiles unchanged until SLICE-C passes it.
- `receive()` routes it: after `openSecure` returns a body (link.ts
  L175–190), `if (body.env) { this.onEnvelope?.(body.env); return; }` —
  checked **before** the RPC `id`/`method` branches. A body with `env` set
  never reaches the RPC or push branches.

Ordering and loss are the link's existing properties, not new ones
(observed): frames carry a strict sequence and any gap or MAC failure closes
the socket (link.ts L337–379), the dialer reconnects with backoff (L406–413),
and a new session re-handshakes. So within one ship session envelopes arrive
in send order or the session dies; there is **no per-frame retransmit**. The
retry story is reconnect → fresh `sync.hello` → catch-up from the durable
cursor, with per-op idempotency absorbing the overlap (§4.5).

## 4. Sync protocol

New file `src/bun/fleet/sync.ts` (SLICE-B) owns everything below. It talks
to the store through §8.1 and to links through `envelope()` /
`onEnvelope`. It never opens a socket, never touches HTTP, and never ships
an op whose `ownerNode` is not the local node.

### 4.1 Link-up: both directions start with hello

When a NodeLink reaches `up` (the existing `onUp` callback, wired in
`wire.ts` L199–222), each side — independently — stamps presence
(`markSeen`, §4.6) and sends:

```
{ v: 1, src: <me>, dst: <peer>, kind: "sync.hello",
  payload: { cursor: appliedCursor(<peer>) } }
```

`appliedCursor` answers 0 when the owner was never synced (§8.1). A node
whose store is damaged sends **no** hello — it cannot apply what would come
back — and, because damaged reads answer empty (records.ts L443–454,
L583–596), it also has nothing to ship when the peer's hello arrives. A
damaged node is silently inert on the sync plane; the link itself stays up
for RPC.

### 4.2 On hello: open a ship session and drain

Receiving `sync.hello` from peer P:

1. Validate: `isEnvelope`, `src === P` (the authenticated link's peer id),
   `dst === localNodeId()`. Anything else: drop the frame,
   `meshCount("syncDrop", kind)`. Never close the link over a bad envelope —
   HMAC already proved the peer; a malformed envelope is version skew or a
   bug, and closing would turn it into a reconnect storm.
2. Set P's ship cursor to `payload.cursor`. **Reset rule:** if that cursor
   is greater than this node's own highest first-hand seq, set the ship
   cursor to 0 instead — the peer knew a previous store of ours (the store
   was moved aside and re-migrated, restarting `AUTOINCREMENT`), and the only
   honest answer is the whole history again. Idempotent replay makes the
   resend cheap (§4.5).
3. Drain: repeatedly `oplogAfter(localNodeId(), shipCursor, 200)` (observed
   signature, records.ts L583–596; 200 is the stated batch limit,
   `SYNC_BATCH_LIMIT`), send each non-empty batch as one `sync.ops`
   envelope, advance the ship cursor to the batch's last seq, stop when a
   read comes back empty.
4. Mark P **live**: subsequent local commits ship as they happen (§4.3).

The drain must be re-entrant-safe: a commit notification arriving while a
drain is in flight re-runs the drain after it finishes rather than
interleaving batches out of order (one boolean per peer).

### 4.3 Live ops

`records.ts` notifies after a committed local write that appended oplog rows
(`onOplogAppended`, §8.1 — fired by `putLocal`/`tombstoneLocal` only, never
by `applyRemoteOps`). On each notification, `sync.ts` re-runs the §4.2 drain
for every live peer. Because the drain reads from the ship cursor, a
notification is only a doorbell — no op is ever sent from the notification's
own payload, so a missed doorbell costs latency, not correctness.

Loop prevention is structural, not a string check: a node ships only
first-hand ops (`oplogAfter` filters by `owner_node`; the doorbell only
rings for local writes), so an applied remote op is never re-shipped, and a
relayed third-node op cannot exist. The `/`-check dampers exist for the
push mirror, which §6 removes for rosters.

### 4.4 On sync.ops: apply, cursor, publish

Receiving `sync.ops` from peer P:

1. Validate as §4.2 step 1, **plus**: every `op.ownerNode === src`. An op
   about anyone else's records is a first-hand violation (a relay); drop the
   whole frame, `meshCount("syncDrop", "sync.ops")`.
2. Apply the batch with `applyRemoteOps(ops)` — the reserved API, called
   unchanged (records.ts L573–580). Outcomes (`ApplyResult`, records.ts
   L58–60):
   - **`applied: true`** — advance the durable cursor:
     `setAppliedCursor(P, ops.at(-1)!.seq)`. If any op was genuinely new
     (`seqs.length > 0`) and its kind is `persona`, call the roster publish
     hook (§4.6). `meshCount("syncApply", "sync.ops")`.
   - **`reason: "stale"`** — the all-or-none batch was refused because one
     op is behind this node's row *and* absent from this node's oplog
     (observed refusal path, records.ts L323–336). Fall back to per-op
     application: `applyRemoteOps([op])` for each op in order; ops
     individually refused as stale are skipped and counted
     (`meshCount("syncDrop", "stale-op")`); then advance the cursor to the
     frame's last seq anyway. Skipping is safe because only the owner ever
     writes its records' versions — a local row that is *ahead* of the
     owner's op can only have gotten there from the same owner, so the op is
     history this node has already superseded. Never re-request it: a
     refused stale op would refuse forever and wedge the cursor.
   - **`reason: "invalid"`** — a malformed op survived `isEnvelope` (should
     be unreachable; `isEnvelope` mirrors `validOp`, records.ts L290–306).
     Drop the frame, count it, do not advance the cursor.
   - **`reason: "damaged"`** — the local store latched damaged. Drop the
     frame, count it, and mark P's inbound sync dead for this session so
     later frames are dropped without touching the store. Do not close the
     link; do not write anything (durability rule).
3. Stamp presence: call the `markSeen(P)` hook (§4.6) — this replaces the
   `lastSeenAt` writes the dying HTTP poll used to make (observed fleet.ts
   L512–516).

**Cursor durability is deliberately not atomic with the apply.** The apply
commits, then the cursor is written. A crash between the two re-delivers the
same ops next session, and every one of them replays quietly (§4.5). This is
what lets `applyRemoteOps` stay byte-for-byte unchanged.

The cursor is written with plain overwrite, not `max()`: within a session
frames arrive in seq order (link property, §3), and across sessions the §4.2
reset rule can legitimately move an owner's seqs *backwards* after a store
rebuild.

### 4.5 Idempotency, retries, and the three gates

- **Idempotent by op key.** `(kind, id, ownerEpoch, version)` — the record
  and its epoch, not the sender. A re-applied op that is already in the
  oplog answers success with no new row and no row change (observed,
  records.ts L323–336: `seen` → `{}`). So: a dropped link mid-batch, a
  crash before the cursor write, or a full history resend after a store
  rebuild all converge to the same rows. This is the "a dropped and retried
  frame changes nothing twice" gate, mechanised.
- **No acks, no polls, no heartbeats.** The receiver persists its own
  cursor; the sender learns where to resume from the next session's hello.
  An idle mesh sends zero sync envelopes — the "idle traffic stays flat"
  gate has nothing to damp because nothing repeats.
- **Restart independence.** Applied records are `resources` rows; the room
  is read from them (§5). The "restart shows the room" gate does not depend
  on any peer speaking.

### 4.6 Module wiring

`sync.ts` is initialised once with two hooks and is otherwise pull-only:

```ts
export function initSync(input: {
	/** Re-publishes the merged roster after remote persona ops applied.
	 *  Wire passes the same publishPersonas it already holds
	 *  (wire.ts L152–166). */
	publishRoster(): void;
	/** Stamps fleet.json lastSeenAt for one peer (§8.3). */
	markSeen(nodeId: string): void;
}): void;

/** Peer link came up: send our hello, await theirs. */
export function syncLinkUp(
	peerId: string,
	link: { envelope(env: Envelope): boolean },
): void;

/** Peer link dropped: forget the ship session (cursors stay durable). */
export function syncLinkDown(peerId: string): void;

/** Every inbound envelope from wire.ts's onEnvelope. */
export function receiveEnvelope(peerId: string, env: unknown): void;

/** For tests and the verify harness. */
export function syncSnapshot(): Array<{
	nodeId: string;
	applied: number;         // durable applied cursor for that owner
	shipped: number | null;  // ship cursor, null before their hello
	live: boolean;
}>;
```

Sync runs **only** over NodeLink. Legacy-transport wires (`LegacyPeerWire`,
wire.ts L39–141) have no envelope path and get none; the consequence for
their rosters is §6.5.

## 5. What lands locally, and how the room survives a restart

### 5.1 Same table, same reserved API — picked and stated

A remote op lands in the **same `resources` table via `applyRemoteOps`**,
exactly as reserved (records.ts L573–580 has zero callers today; SLICE-B/C
give it its first). No peer table, no mirror file, no second store. A remote
persona is a `resources` row whose `owner_node` is the peer's id; its
`replicated` JSON is the op payload; `portable` and `machine` are `NULL`
(only the replicated class ever crosses the wire — the op payload *is* the
replicated class, observed putLocal op construction, records.ts L501–511).

### 5.2 The facade filter (personas.ts)

`src/bun/store/personas.ts` stays local-only — the facade still returns
local `Persona`s and remote qualification stays a wire concern. Two
functions change internally, signatures untouched:

- `listPersonas()` (observed L251–254) filters to
  `record.ownerNode === localNodeId()`.
- `getPersona(id)` (observed L256–260) answers `undefined` for a record
  owned elsewhere.

This filter must merge **in the same PR as the wire cutover** (SLICE-C),
because the moment the first remote op applies, an unfiltered
`listPersonas()` would hand remote teammates to every local-only path: the
startup transcript-compaction loop and `search.sync` (index.ts L162–177),
`localSnapshot()` (fleet.ts L359–372), `localPreviews()` (index.ts
L539–546), and `materializeWorkspace` would mint workspaces for teammates
that live on another machine. Everything else in the facade — writes,
migration, guardWrite (L228–242) — is untouched; `putLocal` can only ever
write locally-owned rows anyway.

### 5.3 remotePersonas() reads the store

`remotePersonas()` keeps its export and shape (wire.ts L446–451) but its
source moves from the in-memory `rosters` map to the store:

- For each fleet peer, in `listFleetPeers()` order (fleet.ts L146–154),
  take `listRecords("persona")` rows with `ownerNode === peer.id` and
  `deleted === false` — skipping owners that are not current fleet peers.
- Assemble each into a `Persona` exactly as the boundary always has:
  `id = remoteTargetId(ownerNode, record.id)` (fleet.ts L694–697),
  `node = { id: ownerNode, name: peer.name }`, and the **replicated fields
  only** — `name`, `goal`, `face`, `team`, `backendId`, `modelId`,
  `createdAt` (the replicated key list, personas.ts L73–81). Required
  `Persona` fields that are not replicated get inert placeholders (stated):
  `cwd: ""`, `mcpPolicy` from `normalizePolicy(undefined)`,
  `sessionCheckpoints: []`, `updatedAt` from record meta.

This is a visible change, accepted deliberately: today's snapshot mirror
ships whole `Persona`s including the peer's `cwd` and `mcpPolicy`
(control-plane.md "The replicated set is the whole document" — the exact
over-sharing the target retires). A remote teammate's settings sheet shows
placeholders for machine-bound fields; mutations still route to the owner
via the unchanged `updatePersona` route (wire.ts L456–476) and the owner's
answer comes back whole and qualified.

### 5.4 Restart, addressing, and routing — unchanged shapes

- `mergedPersonas()` (index.ts L529–531) is untouched: it still merges
  `listPersonas()` and `remotePersonas()` through `applyRosterOrder`. After
  a restart the remote half now answers from `resources` rows, so **the room
  is present before any peer speaks** — the Phase 5 headline gate.
- Chat still routes: remote ids remain `nodeId/personaId`; `ROUTED` methods
  still ride `parseRemoteTarget` to the owner (wire.ts L525–554); MCP
  delivery (`mcp/bridge.ts`), notify keys, and `App.tsx` push-open are
  untouched (the keep rows of roster-store.md §9).
- View state keeps bare ids: `roster.json` and `lastPersonaId` normalize to
  bare ids already (Phase 4, roster-store.md §5.3/§9), and
  `applyRosterOrder` ranks qualified merged rows by their stripped bare id —
  so this desk's drag order of remote teammates survives restart with no new
  code. `getLastPersonaId` still drops non-local ids (index.ts L1004–1009);
  remote reopen stays unsupported exactly as today.
- Presence is not a record: `lastSessions` (wire.ts L148–150) stays
  in-memory, so after a restart remote teammates read `stopped` until the
  link returns and the existing per-teammate `getSessionInfo` refresh in
  `onWireUp` (wire.ts L281–294) runs — same as today's behavior on wire
  drop.
- Revoke cleans up: `revokeFleetPeer` (fleet.ts L156–166) additionally calls
  `purgeOwner(peerId)` (§8.1) so a revoked desktop's records, applied ops,
  and cursor leave the store in one transaction. Re-admission re-syncs from
  cursor 0. This is the one sanctioned deletion from the oplog, and it
  refuses the local owner.

## 6. What dies

1. **Whole-roster `personasChanged` between desktops.** The
   `"personasChanged"` case leaves both sides of the push mirror: the
   receive switch in `onPeerPush` (wire.ts L319–333) and the send filter —
   the entry in `PEER_PUSHES` (wire.ts L390–399) and its case in
   `firstHandForPeers` (wire.ts L413–418). `send()` (index.ts L184–198)
   then never hands a roster to `peerBroadcast`, `nodePeerBroadcast`, or
   `broadcastNodeLinks`. Phones are unaffected: `webBroadcast` still carries
   `personasChanged` to every web client unconditionally.
2. **The sameness damper.** The JSON-compare guard inside that case
   (wire.ts L326–329, commit `f2a1163`) dies with the case. Nothing replaces
   it; the oplog does not repeat, so there is nothing to damp.
3. **The in-memory `rosters` map** (wire.ts L146–147) — it dies. Its three
   remaining readers move to the store: `remotePersonas()` (§5.3), the
   `onWireUp` session refresh and `onDown` stopped-emission (wire.ts
   L189–197, L272–298), and `peerOwningThreadKey` (wire.ts L620–630), which
   matches a thread key's bare side against remote-owned records instead.
   The `listPersonas` snapshot pull in `onWireUp` (wire.ts L276–280) dies
   with it — `sync.hello` is the new link-up truth. `qualifyRoster` (wire.ts
   L300–308) loses its callers and is deleted; `qualifySession` stays.
4. **The leftover `/fleet/rpc` status polls — killed in this phase.**
   `fetchRoster`, the `cache` map, and `SNAPSHOT_TTL_MS` (fleet.ts L43,
   L490–527) are deleted. `fleetRosters()` (fleet.ts L530–542) keeps its
   export, its async signature, and the `FleetNodeRoster` answer shape, but
   answers locally: teammates from remote-owned records (name, team, goal
   truncated to 200, backendId, face from the replicated class; state from
   `remoteSessionState`), `online` from the wire's `up` flag (via a lazy
   `require("./wire")`, the same cycle-avoiding pattern records.ts uses for
   identity, records.ts L128–133), `fetchedAt: Date.now()`. The mainview's
   20-second `api.fleetRoster()` poll (App.tsx L574–598) is **not** edited;
   it becomes a purely local read, and the two idle ESTAB sockets it kept
   alive on the live pair die. `lastSeenAt` maintenance moves to the sync
   plane via `markFleetPeerSeen` (§8.3).
5. **Legacy-transport roster mirroring** (stated). With the
   `personasChanged` case and the `rosters` map gone, a legacy-row peer
   (`fleet.json` entry without `transport: "node"`) no longer contributes
   teammates to the merged room; its `LegacyPeerWire` stays connected for
   the delivery-era surface, and `fleetRosters()` lists it with empty
   teammates until it is re-admitted as a node. The live pair has zero
   legacy rows (observed 2026-08-26), so no running mesh loses anything.

## 7. What stays

Everything here is out of Phase 5's blast radius. "Stays" means either
*keeps working unchanged* or *stays unbuilt*.

| Stays | Where | Note |
| --- | --- | --- |
| NodeLink handshake, HMAC, strict seq, deterministic dialer | `link.ts` L49–234, L326–379 | envelope is additive; §3 |
| fleet.json pairwise tokens as the `/node/link` upgrade gate | `node/server.ts` L92–100, `authenticateFleetPeer` fleet.ts L351–357 | unchanged |
| `/fleet/rpc` claim/legacy surface: `deliver`, `createTeammate`, `readTranscript`, `readThread`, `notify`, `webAccess`, pairing | fleet.ts L378–486, L545–692; `node/server.ts` L82–91 | one-shot HTTP calls stay; only the *status poll* dies |
| `webAccess` / `openRemoteDesktop` / `/ws` on 4680; phone web mode | index.ts L679–701, fleet.ts L468–482, web server | deletion is Phase 7; NodeLink does not require them (observed) |
| Hop / `ownerEpoch` increment | nowhere | stays unbuilt; Phase 8 |
| Phone join | nowhere | stays unbuilt; Phase 6 |
| Relay of a third node's records | nowhere | stays unbuilt; §4.4 actively refuses it |
| Non-roster push mirror: `transcriptAppended/Updated`, `streamDelta`, `sessionInfoChanged`, `faceProgress`, `peerActivityChanged`, `schedulesChanged` cases and their `/` filters | wire.ts L334–387, L419–438 | presence/watch traffic, not records; watches are a later phase |
| `mergePeerRecords`, `routeRemotePersonas`, `routePersonaOrder`, `lastSessions` | wire.ts L148–150, L456–612 | routing and presence, untouched |
| `remoteTargetId` / `parseRemoteTarget` | fleet.ts L694–703 | the qualified-id convention survives this phase |
| `mergedPersonas` / `publishPersonas` / `send()` and all of `index.ts` | index.ts L184–198, L529–536 | **zero edits to index.ts** — a deliberate slice boundary |
| Mainview (`App.tsx`, `rpc.ts`), MCP bridge, push notify keys | keep rows, roster-store.md §9 | untouched |

## 8. File-level API

### 8.1 `src/bun/store/records.ts` — additions (SLICE-A)

Called unchanged (do not edit their bodies): `applyRemoteOps`, `oplogAfter`,
`putLocal`, `tombstoneLocal`, `listRecords`, `getRecord`, `storeDamaged`,
`currentEpoch` (records.ts L436–596). Add:

```ts
/** This node's identity id, as records are stamped with it (the private
 *  ownerNode() at L128–133, exported). */
export function localNodeId(): string;

/** Durable per-owner bookmark (applied_cursor table, L170–173).
 *  0 when unset; 0 when the store is damaged (reads answer empty). */
export function appliedCursor(ownerNode: string): number;

/** Plain overwrite (§4.4 — resets can move it down). One row, one
 *  statement. Throws the standard refusal when the store is damaged. */
export function setAppliedCursor(ownerNode: string, seq: number): void;

/**
 * Fired after a committed LOCAL write that appended oplog rows — i.e. from
 * putLocal and tombstoneLocal only, with the rows they appended.
 * applyRemoteOps never fires it: that is the structural loop brake (§4.3).
 * Multiple listeners allowed; errors in a listener are swallowed.
 */
export function onOplogAppended(
	listener: (ops: Array<ResourceOp & { seq: number }>) => void,
): void;

/**
 * Revoke cleanup (§5.4): one transaction deleting this owner's resources
 * rows, oplog rows, and applied_cursor row. Throws if ownerNode is the
 * local node — a node never erases its own history — or if the store is
 * damaged. The one sanctioned deletion from the append-only oplog.
 */
export function purgeOwner(ownerNode: string): void;
```

### 8.2 `src/bun/node/envelope.ts` (new) and `link.ts` — SLICE-B

Exactly the §3 types, `isEnvelope`, the `Frame.env` member, the optional
`onEnvelope` ninth constructor parameter, and `envelope(env): boolean`.
Nothing else in `link.ts` changes: handshake, HMAC, seq, reconnect, `call`,
`push`, `status` are byte-for-byte.

### 8.3 `src/bun/fleet/sync.ts` (new) — SLICE-B

Exactly §4.6. Also owns the new `MeshKind` members `"syncShip"`,
`"syncApply"`, `"syncDrop"` added to the union in `src/bun/fleet/metrics.ts`
L3–13 (the union is the only edit there).

### 8.4 `src/bun/fleet/wire.ts` and `fleet.ts` — SLICE-C

`wire.ts` edits (each is a §5/§6 item, listed here as the diff surface):

- `initPeerWires` additionally calls
  `initSync({ publishRoster: input.publishPersonas, markSeen: markFleetPeerSeen })`.
- NodeLink construction (L199–222) passes the new trailing argument:
  `(env) => receiveEnvelope(peer.id, env)`; `onUp` additionally calls
  `syncLinkUp(peer.id, wire)`; `onDown` additionally `syncLinkDown(peer.id)`.
- Delete: `rosters` map, `personasChanged` cases (both directions),
  `qualifyRoster`, the `onWireUp` snapshot pull. Rewrite `remotePersonas`,
  `peerOwningThreadKey`, the `onWireUp`/`onDown` roster reads per §5.3/§6.3.

`fleet.ts` edits:

- Delete `fetchRoster`, `cache`, `SNAPSHOT_TTL_MS`; rewrite `fleetRosters`
  per §6.4 (same export, same `FleetNodeRoster[]` promise).
- `revokeFleetPeer` additionally calls `purgeOwner(id)` before returning
  true (§5.4).
- Add:

```ts
/** Stamps lastSeenAt for one peer row, called from the sync plane on
 *  link-up and on each applied sync frame. Same write the HTTP poll made
 *  (previously fleet.ts L512–516). */
export function markFleetPeerSeen(id: string): void;
```

`personas.ts` edit: the §5.2 facade filter, nothing else.

## 9. Implementer slices

Exactly four. File ownership is exclusive: a slice must not edit another
slice's files. Shared contracts are §3, §4.6, and §8 — code to the spec, not
to a sibling's branch. `src/bun/index.ts`, `src/shared/*`, `test/preload.ts`,
`bunfig.toml`, and everything under `src/mainview/` are forbidden to **all**
slices.

### SLICE-A — store cursor API (hard; opus/sol)

`localNodeId`, `appliedCursor`, `setAppliedCursor`, `onOplogAppended`,
`purgeOwner` per §8.1, plus tests.

- **Owns:** `src/bun/store/records.ts`, `src/bun/store/records.test.ts`
  (extend).
- **Forbidden:** everything else — in particular `personas.ts`, `link.ts`,
  `wire.ts`, `fleet.ts`, `hack/`, `hutch.config.ts`.
- **Depends on:** nothing. Start immediately.
- **Done when:** `bun test src/bun/store/records.test.ts` passes covering:
  cursor 0-default / set / overwrite-downward / damaged behavior
  (`appliedCursor` answers 0, `setAppliedCursor` throws); re-applying an
  identical op batch answers `{ applied: true, seqs: [] }` with row and
  oplog counts unchanged; `onOplogAppended` fires with seqs for `putLocal`
  and `tombstoneLocal` and never for `applyRemoteOps`; `purgeOwner` removes
  exactly one owner's rows/ops/cursor and refuses the local owner.
  `hutch run typecheck` passes.
- **Must not invent:** changes to `applyRemoteOps`/`oplogAfter`/`putLocal`
  bodies or signatures; new tables, kinds, or pragmas; GC; epoch increments;
  any wire or network code.

### SLICE-B — envelope + sync engine (hard; opus/sol)

§3 and §4 whole: `envelope.ts`, the `link.ts` additions, `sync.ts`, metrics
kinds.

- **Owns:** `src/bun/node/envelope.ts` (new), `src/bun/node/link.ts`,
  `src/bun/fleet/sync.ts` (new), `src/bun/fleet/sync.test.ts` (new),
  `src/bun/fleet/metrics.ts` (the `MeshKind` union only).
- **Forbidden:** `records.ts`, `personas.ts`, `wire.ts`, `fleet.ts`,
  `node/server.ts`, `hack/`, `hutch.config.ts`.
- **Depends on:** SLICE-A merged (`localNodeId`, cursors, doorbell).
- **Done when:** lands compile-green with **zero callers** — `onEnvelope` is
  optional, nothing imports `sync.ts` yet, and
  `bun hack/verify-node-admission.ts` still passes untouched. `bun test
  src/bun/fleet/sync.test.ts` passes using one real store plus a fake link
  (an object capturing `envelope()` calls) and fabricated ops from a
  fictional owner, covering: hello at cursor 0 drains full history in
  ≤200-op batches ascending; hello above our max seq resets to 0 and
  re-ships; valid `sync.ops` applies and advances the durable cursor; wrong
  `src`, wrong `dst`, relayed `ownerNode`, and malformed frames are dropped
  and counted with the cursor unmoved; a stale batch falls back per-op,
  skips the stale op, and still advances the cursor; a doorbell during a
  drain does not reorder batches. `hutch run typecheck` passes.
- **Must not invent:** acks, heartbeats, retransmits, or any periodic frame;
  envelope kinds beyond the two; compression; shipping any class but the op
  payload; edits to handshake/HMAC/seq logic; calls into `wire.ts`.

### SLICE-C — wire and facade cutover (mechanical; grok/sonnet)

§5.2–§5.4, §6, §8.4: the store-backed boundary, the deletions, the wiring.

- **Owns:** `src/bun/fleet/wire.ts`, `src/bun/fleet/fleet.ts`,
  `src/bun/store/personas.ts` (the §5.2 filter only),
  `src/bun/store/personas.test.ts` (extend).
- **Forbidden:** `records.ts`, `link.ts`, `envelope.ts`, `sync.ts`,
  `metrics.ts`, `node/server.ts`, `mcp/bridge.ts`, `push/notify.ts`,
  `hack/`, `hutch.config.ts`.
- **Depends on:** SLICE-B merged. Sync stays dark until this slice: no
  envelope flows before `wire.ts` passes `onEnvelope`, and this same slice
  ships the facade filter — so no remote record can land before
  `listPersonas` knows to exclude it (§5.2's hazard list).
- **Done when:** extended `personas.test.ts` proves the filter: after
  `applyRemoteOps` inserts a foreign-owned record, `listPersonas()` and
  `getPersona()` exclude it while `listRecords` still shows it, and
  `remotePersonas`-shape assembly fields match §5.3. Greps prove the
  deaths: no `personasChanged` in `PEER_PUSHES`/`onPeerPush`/
  `firstHandForPeers`, no `rosters` map, no `fetchRoster`. `hutch run
  typecheck` passes with `index.ts` and `mainview/` byte-identical.
  `bun hack/verify-node-admission.ts` still passes.
- **Must not invent:** edits to `index.ts` (the merged room, `send()`, and
  every RPC handler must survive unmodified); changes to the non-roster
  `onPeerPush` cases or `mergePeerRecords`; qualified ids in any persisted
  file; a replacement damper; legacy-wire envelope support.

### SLICE-D — two-process verify harness (mechanical; grok/sonnet)

Ships §10's G3 and the hutch entry.

- **Owns:** `hack/verify-federation.ts` (new), `hutch.config.ts` (add
  `"verify:federation": "bun hack/verify-federation.ts"` only).
- **Forbidden:** everything under `src/`.
- **Depends on:** SLICE-A and SLICE-B for the engine steps; the full-room
  steps need SLICE-C. If C is not merged yet, land the harness with the
  C-dependent steps behind a clearly named `--engine-only` flag and remove
  the flag when C merges.
- **Done when:** `bun hack/verify-federation.ts` exits 0 asserting every G3
  step, from a clean checkout, with no GUI and no Electrobun build.
- **Must not invent:** new store or sync APIs (drive only §8 exports plus
  the existing control-server pattern of `hack/verify-node-admission.ts`
  L19–125); assertions about the Electrobun app build; edits to
  `test/preload.ts` or `bunfig.toml`; a live Mac.

**Suggested merge order: A → B → C → D.** A is pure store and unblocks
everything. B lands dark (zero callers) so the tree never runs half a
protocol. C flips the mesh over in one PR — envelopes start flowing in the
same change that filters the facade and deletes the snapshot path, so there
is no window where remote records land unfiltered or where two roster
systems run at once. D last because its strongest assertions need the
cutover.

## 10. Verify gates (binary, runnable)

Each gate is a command that exits 0 or fails. No gate requires a GUI, a
live Mac, or an Electrobun build. In-process tests use one store under the
preload isolation (a second in-process store is impossible — `ROOT` and the
db handle resolve once per process, records.ts L105–107, paths import), so
cross-node behavior in-process uses fabricated foreign-owner ops, and true
two-store behavior uses two processes.

1. **`bun test src/bun/store`** — SLICE-A's done-when list, plus the Phase 4
   suites staying green.
2. **`bun test src/bun/fleet/sync.test.ts`** — SLICE-B's done-when list
   (fake link, fabricated owner).
3. **`bun hack/verify-federation.ts`** (hutch `verify:federation`) — two
   child processes with isolated `TOAD_DATA_DIR`s, paired over the
   address/token path and linked, following the parent/child control-server
   pattern of `hack/verify-node-admission.ts`. Asserts, in order:
   1. **Converge.** Each child creates two personas via the facade; both
      stores end holding all four records; each child's `remotePersonas()`
      answers two qualified rows with `node` set.
   2. **Restart shows the room.** Kill child A. Restart child B as a fresh
      process on the same data dir, with A still down. B's
      `remotePersonas()` still answers A's two teammates and
      `fleetRosters()` lists A `online: false` with teammates present —
      the room came from replicated records, not from a peer's push. This
      also proves the poll is dead: the answer arrived with zero HTTP,
      because there was nobody to poll.
   3. **Live op.** Restart A; after re-link, A renames a persona; B's
      record reaches the bumped version without any relink. Then A calls
      `checkpointSession` (machine-class): B receives **zero** sync
      envelopes for it — private churn does not cross the wire.
   4. **Tombstone.** A deletes a persona; B's row shows `deleted: true`
      and the teammate leaves B's `remotePersonas()`.
   5. **Dropped and retried changes nothing twice.** Record B's oplog row
      count and per-record versions; force-drop the link
      (`closeNodePeer`, node/server.ts L191–198); wait for reconnect and
      the fresh hello/catch-up; assert both counts byte-identical.
   6. **Idle stays flat.** After convergence, a 10-second quiet window:
      each child's envelope counter and received-push log show zero
      `sync.ops` and zero `personasChanged` arriving from the peer. There
      is no damper left to credit.
4. **`hutch run typecheck`** (`hutch pm x tsc --noEmit`, hutch.config.ts
   L36) — every caller of the kept surfaces compiles; `index.ts` unedited.
5. **`bun hack/verify-node-admission.ts`** (hutch `verify:node-admission`,
   hutch.config.ts L65) — the Phase 3 harness still passes: admission,
   deterministic dialer, handshake, reconnect are undisturbed.

Mapping to the control-plane Phase 5 gate: restart-shows-room = G3.2;
idle-flat-no-damper = G3.6 (+ G3.3's checkpoint half); retried-frame-idempotent
= G3.5 with the store-level halves in G1 (replay batch) and G2 (stale
fallback).

## 11. What Phase 5 explicitly does not change

- `src/bun/index.ts` — byte-identical. `send()`, `mergedPersonas`,
  `publishPersonas`, every RPC handler including `fleetRoster`,
  `openRemoteDesktop`, and the remote-delete route.
- `NodeLink` security: handshake, nonce proof, HMAC, strict seq,
  deterministic dialer, reconnect backoff (link.ts). The envelope is a new
  body member, not a new mechanism.
- `/fleet/pair`, admission, discovery, membership, `fleet.json` token
  minting; the `/node/link` upgrade gate.
- The `/fleet/rpc` one-shot surface and its HTTP callers: `deliverToPeer`,
  `forwardNotify`, `readPeerTranscript`, `readPeerThread`,
  `createTeammateOnPeer`, `peerCall`, `webAccessFromPeer`. Only the status
  poll (`fetchRoster`) dies.
- `webAccess`, `deviceForPeer`, the 4680 listener, `/ws`, phone web mode,
  `openRemoteDesktop` — Phase 7's problem.
- The non-roster push mirror and its qualification (wire.ts L334–387),
  `mergePeerRecords`, `routeRemotePersonas`, `routePersonaOrder`,
  `lastSessions`, `remoteTargetId`/`parseRemoteTarget`.
- Phone join (Phase 6), hop and every `ownerEpoch` increment (Phase 8),
  relay/gossip, watches, leases, membership replication and the CAP/voter
  choice — stated open, untouched.
- The store schema: no new tables, columns, or kinds; `applyRemoteOps`,
  `oplogAfter`, `putLocal`, `tombstoneLocal` bodies and signatures; the
  migration; `config.json` (frozen); oplog retention (none — tombstones and
  ops are still never collected, stated).
- View-state files and their bare-id rule (`roster.json`, `settings.json`),
  transcript segments, threads, attachments, workspaces, schedules,
  computers.
- `src/shared/types.ts` (`Persona`, `FleetNodeRoster`), `src/shared/rpc.ts`,
  all of `src/mainview/` including the 20-second `fleetRoster` poll (which
  becomes a local read), `mcp/bridge.ts`, `push/notify.ts`.
- `durable.ts`, `test/preload.ts`, `bunfig.toml`, `assertDataRoot`,
  AGENTS.md materialisation.
