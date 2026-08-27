# Roster store — Phase 4 implementation spec

Branch: `store/roster-records`. This file is the what-to-build. The why lives
in [control-plane.md](./control-plane.md) — read "Storage: records the mesh
can replicate" and "Mobility: the agent that hops" before implementing.

## 1. Status and evidence levels

Phase 4 is **local-first**. It replaces `config.json` as the roster's source
of truth with a SQLite record store that already has the shape federation
(Phase 5) and mobility (Phase 8) need: owner-stamped records, a fencing
`ownerEpoch`, a per-owner oplog, tombstones, and epoch-segmented transcripts.
Nothing crosses the wire differently. Nothing increments an epoch. Hop,
envelope, and phone join are **not shipped** and this spec does not build them.

Every claim below is one of:

- **observed** — true of the code on this branch, with a file path cited.
- **stated** — a decision made here. Where a choice was still open, the
  conservative option is picked and marked stated. Do not reopen stated
  decisions in implementation; flag disagreement in review instead.

Decisions inherited from control-plane.md and the phase brief (do not reopen):
engine is `bun:sqlite`; record-files rejected (mobility needs atomic
multi-record commit — control-plane.md "Engine"); `ownerEpoch` stored from
slice 1 and incremented by nothing; three state classes; deletes are
tombstones; sync-later is a per-owner oplog written locally now; view state
keys on bare persona id only; migration reads `config.json` and never rewrites
or deletes it; durability rules of `src/bun/store/durable.ts` apply (damaged ≠
empty, writes refuse while damaged); tests isolate via `test/preload.ts` +
`assertDataRoot` (`src/bun/paths.ts` L65–73, `bunfig.toml`).

## 2. Glossary

One term per concept. Use these names in code and commit messages.

- **Resource** — one owner-stamped record:
  `{ kind, id, ownerNode, ownerEpoch, version, updatedAt, deleted }` plus
  three class payloads. Phase 4 registers one kind: `persona`.
- **ownerEpoch** — fencing counter on a resource. Increments only on
  ownership transfer (never in Phase 4). Merge rule: compare
  `(ownerEpoch, version)`; higher epoch wins outright, version orders edits
  within one epoch (control-plane.md "Ownership is a lease").
- **version** — per-record integer, starts at 1, bumped only when the
  **replicated** class changes.
- **oplog** — append-only table of this node's own replicated-class changes,
  with a local monotonic `seq`. Idempotent by `(kind, id, ownerEpoch,
  version)`. Phase 4 writes it; Phase 5 ships it.
- **applied cursor** — per-owner `applied_seq` bookmark a receiver keeps.
  Table exists in Phase 4, unwritten.
- **tombstone** — a resource with `deleted = 1` and a bumped version, retained
  so an offline peer can learn the delete. Never collected in Phase 4 (stated).
- **replicated** — small, machine-independent fields that go everywhere,
  always. Carried by oplog ops.
- **portable** — fields that travel with an agent on a move, not replicated
  in between.
- **machine-bound** — fields that never travel; re-derived at a destination.
- **segment** — one append-only transcript file per `(persona, ownerEpoch)`.
- **snapshot export** — plain-JSON dump of the store for hand-readability and
  recovery; never read by the app.
- **facade** — `src/bun/store/personas.ts` keeping its exported function
  shapes while its storage moves to the record store.

## 3. On-disk layout (paths under `TOAD_DATA_DIR`)

`ROOT` resolves from `TOAD_DATA_DIR` once at import (observed
`src/bun/paths.ts` L6–22). New entries marked NEW; everything not listed is
unchanged.

```
$TOAD_DATA_DIR/
  config.json                      # legacy roster. Read once by migration.
                                   # NEVER written, rewritten, or deleted again.
  config.json.bak                  # untouched (durable.ts backup)
  store.sqlite                     # NEW — the record store (+ -wal / -shm)
  store-snapshot.json              # NEW — plain-JSON export (+ .bak via saveJson)
  roster.json                      # view state: merged display order.
                                   # Bare persona ids only after SLICE-C.
  settings.json                    # lastPersonaId becomes bare id (SLICE-C)
  transcripts/<personaId>.jsonl    # legacy flat file = the epoch-1 segment,
                                   # until lazily relocated (see §8)
  transcripts/<personaId>/<epoch>.jsonl   # NEW — epoch segments
  index.sqlite                     # search index; derived, safe to delete
                                   # (observed src/bun/store/search.ts L12–16)
  node.json                        # NodeIdentity (observed src/bun/node/identity.ts L29)
  workspaces/ threads/ attachments/ cache/ run/ push/ pi/
  computers.json schedules.json    # all unchanged
```

Path constants and helpers to add in `src/bun/paths.ts` (SLICE-A owns the
edit; exact shapes so SLICE-C can consume without touching the file):

```ts
export const STORE_FILE = join(ROOT, "store.sqlite");
export const STORE_SNAPSHOT_FILE = join(ROOT, "store-snapshot.json");
/** Directory of epoch segments. Sibling of the legacy flat file, never the same name. */
export function transcriptSegmentsDir(personaId: string): string; // join(TRANSCRIPTS_DIR, personaId)
export function transcriptSegmentPath(personaId: string, epoch: number): string; // join(dir, `${epoch}.jsonl`)
// transcriptPath(personaId) stays exported: it names the legacy flat file,
// which readers must keep consulting (§8).
```

`ensureLayout()` gains no new directory: segment directories are created per
persona on first append (stated).

## 4. SQLite schema

One database, `STORE_FILE`, opened with `bun:sqlite` (already proven inside
this app by the search index — observed `src/bun/store/search.ts` L1, L32).
Pragmas at open, in this order:

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;   -- stated: the roster is irreplaceable; pay the fsync
```

Then `PRAGMA quick_check` once; any answer other than `ok`, or a failure to
open the file at all, latches the store **damaged** (§5). A damaged store is
never deleted, truncated, or rewritten.

```sql
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
-- rows written in Phase 4:
--   'schema_version'     = '1'
--   'node_id'            = local NodeIdentity id, recorded at creation.
--                          Recorded, not enforced (stated; reserved for a
--                          copied-database check later).
--   'config_migrated_at' = epoch-ms string, written by migration (§7)

CREATE TABLE IF NOT EXISTS resources (
  kind        TEXT    NOT NULL,
  id          TEXT    NOT NULL,
  owner_node  TEXT    NOT NULL,
  owner_epoch INTEGER NOT NULL,
  version     INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,          -- epoch ms
  deleted     INTEGER NOT NULL DEFAULT 0, -- 0 | 1
  replicated  TEXT    NOT NULL,           -- JSON, replicated class (§6)
  portable    TEXT,                       -- JSON or NULL
  machine     TEXT,                       -- JSON or NULL; never leaves this node
  PRIMARY KEY (kind, id)
) STRICT;

CREATE TABLE IF NOT EXISTS oplog (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,  -- local order, per §2
  owner_node  TEXT    NOT NULL,
  kind        TEXT    NOT NULL,
  id          TEXT    NOT NULL,
  owner_epoch INTEGER NOT NULL,
  version     INTEGER NOT NULL,
  op          TEXT    NOT NULL CHECK (op IN ('put','tombstone')),
  payload     TEXT    NOT NULL,   -- JSON: replicated class at this version; '{}' for tombstone
  at          INTEGER NOT NULL    -- epoch ms
) STRICT;

-- The idempotency key is the record and its epoch, not the sender
-- (control-plane.md "Sync is a log, not a snapshot").
CREATE UNIQUE INDEX IF NOT EXISTS oplog_idempotent
  ON oplog (kind, id, owner_epoch, version);
CREATE INDEX IF NOT EXISTS oplog_by_owner ON oplog (owner_node, seq);

-- Phase 5's resume bookmark. Created now, written by nothing in Phase 4.
CREATE TABLE IF NOT EXISTS applied_cursor (
  owner_node  TEXT    PRIMARY KEY,
  applied_seq INTEGER NOT NULL
) STRICT;
```

Do not add other tables, columns, triggers, or kinds. No FTS, no views, no GC
job (stated: the oplog grows unbounded in Phase 4; roster mutations are small
and retention policy belongs to the sync phase).

## 5. Public TypeScript API

### 5.1 New: `src/bun/store/records.ts` (SLICE-A)

```ts
export type ResourceKind = "persona";   // the only kind Phase 4 registers

export type ResourceMeta = {
  kind: ResourceKind;
  id: string;
  ownerNode: string;
  ownerEpoch: number;
  version: number;
  updatedAt: number;
  deleted: boolean;
};

export type ResourceRecord = ResourceMeta & {
  replicated: Record<string, unknown>;
  portable: Record<string, unknown> | null;
  machine: Record<string, unknown> | null;
};

export type ResourceOp = {
  kind: ResourceKind;
  id: string;
  ownerNode: string;
  ownerEpoch: number;
  version: number;
  op: "put" | "tombstone";
  payload: Record<string, unknown>;
  at: number;
};

export type ApplyResult =
  | { applied: true; seqs: number[] }
  | { applied: false; reason: "stale" | "damaged" | "invalid"; opIndex?: number };

/** True when the db failed to open or quick_check. Reads answer empty; writes throw. */
export function storeDamaged(): boolean;

export function getRecord(kind: ResourceKind, id: string): ResourceRecord | undefined;

export function listRecords(
  kind: ResourceKind,
  opts?: { includeTombstones?: boolean },   // default false
): ResourceRecord[];

/** The record's ownerEpoch; 1 when the record does not exist. */
export function currentEpoch(kind: ResourceKind, id: string): number;

/**
 * Local mutation. One transaction: upsert the row, and — only when
 * `replicated` is present in the patch — bump version and append an oplog op.
 * Portable/machine-only patches touch updated_at but neither version nor
 * oplog, so private churn never changes a teammate's replicated identity
 * (control-plane.md "The replicated set is the whole document").
 * Creating: version 1, ownerEpoch 1, ownerNode = local node id.
 * Throws when the store is damaged.
 */
export function putLocal(
  kind: ResourceKind,
  id: string,
  patch: {
    replicated?: Record<string, unknown>;   // full class value, not a diff
    portable?: Record<string, unknown> | null;
    machine?: Record<string, unknown> | null;
  },
): ResourceRecord;

/**
 * One transaction: set deleted = 1, bump version, append a 'tombstone' op
 * with payload {}. Clears portable and machine (released state); keeps the
 * last replicated JSON on the row (stated). Throws when damaged.
 */
export function tombstoneLocal(kind: ResourceKind, id: string): void;

/**
 * RESERVED — nothing calls this in Phase 4. It exists so Phase 5 (sync) and
 * Phase 8 (handover) inherit the transaction shape instead of inventing it.
 *
 * One transaction, all-or-none:
 *   for each op: fence-compare against the current row —
 *     (op.ownerEpoch, op.version) already ≤ current  → op is a duplicate/stale
 *       of applied history: if the oplog_idempotent index already holds it,
 *       skip it (idempotent success); otherwise reject the whole batch as
 *       "stale" with its opIndex;
 *     greater → upsert row from op (put: replicated := payload; tombstone:
 *       deleted := 1) and INSERT the op into oplog.
 *   Malformed op → "invalid". Damaged store → "damaged", nothing written.
 * This is also the handover shape: a move is a batch of ops that all land or
 * none do (control-plane.md "What a move is").
 */
export function applyRemoteOps(ops: ResourceOp[]): ApplyResult;

/**
 * RESERVED read for Phase 5: this owner's ops after seq, ascending.
 */
export function oplogAfter(
  ownerNode: string,
  afterSeq: number,
  limit?: number,
): Array<ResourceOp & { seq: number }>;

/** Writes STORE_SNAPSHOT_FILE via saveJson (atomic + .bak). */
export function exportSnapshot(): void;
```

Implementation notes (stated):

- The module opens lazily on first use, like `open()` in
  `src/bun/store/search.ts` L29–50. No exported `openStore`.
- `putLocal` builds a `ResourceOp` and runs it through the same internal
  transaction code as `applyRemoteOps`, so the fenced-apply path is exercised
  from day one even though no remote calls it.
- `ownerNode` comes from `nodeIdentity().id` (observed
  `src/bun/node/identity.ts` L80–90; it preserves the install id, L41).
  Import it lazily (dynamic import, cached) to avoid pulling
  `web/devices` into the store's static graph.
- `exportSnapshot()` runs after every committed local mutation and once at
  open (stated; the roster is small, `saveJson` is atomic —
  `src/bun/store/durable.ts` L72–98). Snapshot shape:
  `{ version: 1, exportedAt, nodeId, resources: ResourceRecord[] }` including
  tombstones and all three classes. The app never reads it back.
- Damaged-store errors must name the file and the recovery move, mirroring
  the tone of `personas.ts` L89–92: restore `store.sqlite` by hand or move it
  aside; moving it aside triggers re-migration from the frozen `config.json`.

### 5.2 Kept exactly: `src/bun/store/personas.ts` exports (SLICE-B)

Signatures observed at `src/bun/store/personas.ts` L97–243; callers across
`src/bun/index.ts`, `mcp/bridge.ts`, `acp/*`, `fleet/fleet.ts`, `schedule.ts`,
`push/notify.ts`, `computer/proxy.ts` must compile unchanged:

```ts
export function listPersonas(): Persona[];
export function getPersona(id: string): Persona | undefined;
export function createPersona(draft: PersonaDraft): Persona;
export function reorderPersonas(ids: string[]): Persona[];
export function updatePersona(id: string, patch: Partial<Persona>): Persona;
export function checkpointSession(id: string, backendId: string, sessionId: string): Persona;
export function clearCheckpoint(id: string, backendId: string, onlyIf?: string): void;
export function deletePersona(id: string): void;
export function materializeWorkspace(persona: Persona): void;
```

Behavior changes hidden behind those shapes:

- Storage is the record store; `config.json` is never written again.
- `deletePersona` calls `tombstoneLocal` (plus the existing `removeComputer`
  side effect, observed L212). `listPersonas`/`getPersona` exclude tombstones.
- `checkpointSession` / `clearCheckpoint` / `modeId` / `cwd` updates are
  machine-class writes: no version bump, no oplog row.
- `reorderPersonas(ids)` no longer rewrites stored rows. Local order becomes
  view state (§9): it calls `mergeRosterRank(ids)` (§5.3) and returns
  `listPersonas()`. Contract preserved from L130–135: listed ids are ranked,
  forgotten ids keep their relative place after them. Stated: this is the one
  deliberate semantics-preserving storage move; order was already declared
  per-desk view state in control-plane.md "Local view state stays local".
- Existing normalization (mcpPolicy, computer, subagents, checkpoint
  filtering, `lastSessionId` fold — observed L53–78) moves to migration
  (read-once) and to facade assembly of `Persona` from a record.
- `materializeWorkspace` (AGENTS.md with the Toad marker, observed L215–243)
  stays byte-for-byte.
- The `unreadable`-latch behavior (reads answer empty, writes throw — observed
  L37, L86–95) is preserved with the store's damaged latch as its source.

### 5.3 Kept + extended: view-state modules (SLICE-C)

`src/bun/store/roster.ts` — keep `rosterOrder()`, `saveRosterOrder(ids)`,
`applyRosterOrder(personas)` (observed L17–36); add:

```ts
/**
 * Merge a partial ranking into roster.json: listed ids (bare, deduped) first
 * in the given order, then previously ranked ids not listed, old relative
 * order kept. Used by reorderPersonas.
 */
export function mergeRosterRank(ids: string[]): void;
```

All three functions normalize to bare ids (§9). `src/bun/store/settings.ts` —
keep `getLastPersonaId` / `setLastPersonaId` signatures (observed L87–93);
`setLastPersonaId` stores the bare id. `src/bun/store/transcript.ts` — keep
`append`, `load`, `preview`, `recentMessages`, `allMessages`, `compact`
signatures (observed L14–161); internals per §8.

## 6. Persona → three classes, field by field

Source of truth for fields: `Persona` in `src/shared/types.ts` L13–69. Class
assignments follow the table in control-plane.md "Three classes of state, not
two"; rows it does not name are marked stated.

| `Persona` field | Class | Notes |
| --- | --- | --- |
| `id` | record key | Bare UUID (observed `randomUUID()`, personas.ts L107). Never `nodeId/personaId`. |
| `node?` | **not stored** | Reader-assigned qualification for remote teammates (observed `qualifyRoster`, `src/bun/fleet/wire.ts` L300–308). Local records never carry it. |
| `name` | replicated | |
| `goal` | replicated | |
| `face` | replicated | |
| `team` | replicated | |
| `backendId` | replicated | |
| `modelId` | replicated | Per control-plane table. |
| `deleted` (new meta) | replicated meta | The tombstone flag; not a `Persona` field. |
| `createdAt` | replicated | Stated: not in the control-plane table; it is machine-independent identity, so it rides in the replicated JSON. |
| `updatedAt` | record meta | The `updated_at` column; set on every put of any class. |
| `mcpPolicy` | portable | Ids of local MCP servers mean nothing remotely; travels on a move only. |
| `webSearchPolicy` | portable | |
| `subagents` | portable | |
| `computer` (`PersonaComputer` settings) | portable | User intent travels. The container, token, and activity live in `computers.json` (observed `src/bun/paths.ts` L28) — machine-bound and out of this store. |
| `cwd` | machine-bound | Absolute path; never in a replicated record (control-plane.md invariants). |
| `modeId` | machine-bound | Per control-plane table. |
| `sessionCheckpoints` | machine-bound | Harness session ids are not portable (control-plane.md machine-bound row). |
| `lastSessionId` | **not stored** | Legacy field, folded into `sessionCheckpoints` during the migration read exactly as personas.ts L71–77 does today. |

Facade assembly: `Persona = { id, ...replicated, ...portable, ...machine }`
with `createdAt` from replicated and `updatedAt` from meta; tombstones
excluded. `updatePersona(patch)` splits the patch by this table and issues one
`putLocal` (one transaction) carrying only the classes that changed.

## 7. Migration algorithm

Runs inside the persona facade at first store use. Idempotent, one-way,
paranoid. **No step writes, rewrites, or deletes `config.json` — ever.**

1. Open the store (§4). If damaged: latch, skip migration entirely; facade
   reads answer empty, writes throw. `config.json` untouched.
2. If `meta.config_migrated_at` exists → done; skip to normal operation.
3. Load `config.json` via `loadJson` (observed `src/bun/store/durable.ts`
   L59–69, with `.bak` fallback).
   - `damaged: true` → **refuse**: do not write `meta`, do not insert rows,
     latch facade writes off (same refusal text pattern as personas.ts
     L89–92). Retry naturally on next launch.
   - `value: null` (file absent) → empty roster: write
     `meta.config_migrated_at` in a transaction; done.
4. Normalize each persona exactly as the current `read()` does (personas.ts
   L53–78): `normalizePolicy`, `normalizeComputer`,
   `normalizePersonaSubagents`, checkpoint filtering, `lastSessionId` fold.
5. Single transaction: for each persona, insert its `resources` row (`kind`
   `'persona'`, `owner_node` = local node id, `owner_epoch` 1, `version` 1,
   classes split per §6) and one `oplog` `put` op (payload = replicated
   class); then insert `meta.config_migrated_at`. Any throw rolls back the
   whole transaction, leaving zero rows and no meta — the next launch retries.
6. After commit: `exportSnapshot()`.
7. `config.json` and `config.json.bak` stay on disk, frozen. Recovery story
   (stated): deleting `store.sqlite` re-runs this migration from the frozen
   file; post-migration edits are then recovered by hand from
   `store-snapshot.json`. Config array order is not migrated into the store —
   ordering is view state (§9); on a roster that was never dragged,
   `createdAt` order reproduces the array order (personas.ts appends on
   create, L124).

Transcript relocation is **not** part of this migration; it is lazy (§8).

## 8. Transcript segment layout and read/write rules

Today: one flat append-only JSONL per persona,
`transcripts/<personaId>.jsonl` (observed `src/bun/paths.ts` L96–98,
`src/bun/store/transcript.ts` L14–17). Target: one segment per
`(persona, ownerEpoch)` at `transcripts/<personaId>/<epoch>.jsonl`, epoch as
plain decimal, ordered numerically on read (stated naming).

Rules:

- **The legacy flat file is the epoch-1 segment.** Readers treat
  `transcripts/<id>.jsonl`, when present, exactly as if it were
  `transcripts/<id>/1.jsonl`. Its bytes are never rewritten by migration.
- **Lazy relocation, rename only.** Before the first `append` (or `compact`)
  for a persona whose flat file still exists: `mkdirSync` the segment dir,
  `renameSync` flat → `<dir>/1.jsonl`. Rename is atomic on the same
  filesystem and rewrites nothing. If both flat file and `1.jsonl` somehow
  exist, refuse to append for that persona (damaged-style hold; stated —
  never guess which is truth).
- **Write rule.** `append(personaId, event)` appends to the segment for
  `currentEpoch("persona", personaId)` (from `records.ts`; 1 when the record
  is absent, which covers the pre-migration window). In Phase 4 that is
  always 1. A node may append only to the segment of an epoch at which it is
  the owner — vacuously true in Phase 4; write the epoch lookup anyway.
- **Read rule.** `load()` concatenates all segments ascending by epoch
  (legacy flat file counting as epoch 1), then applies the existing
  supersede-by-id fold (observed transcript.ts L19–40) across the whole
  concatenation. `preview` / `recentMessages` / `allMessages` treat the
  segment list as one logical file: start the tail window at the end of the
  highest-epoch non-empty segment and walk backward into earlier segments
  only while the window is unsatisfied, preserving the existing bounded-read
  behavior (observed L45–150).
- **`compact()` may rewrite only the current-epoch segment owned by this
  node.** Older-epoch and foreign segments are immutable history
  (control-plane.md "History spans owners"). In Phase 4 everything is epoch
  1, so post-relocation behavior matches today's.
- **Search stamp.** `src/bun/store/search.ts` stamps freshness by
  `transcriptPath` size/mtime (observed L52–57). SLICE-C updates `fileStamp`
  to stat the active segment path (falling back to the legacy flat file), and
  may force a one-time reindex; the index is derived and safe to rebuild
  (observed L12–16).

## 9. Owner-free key audit

Every grep hit in this worktree where a persisted or in-memory key embeds an
owner (`nodeId/personaId`) or a `/`-check stands in for ownership. "Fix"
means Phase 4 changes it; "keep" means it is wire/UI routing that Phase 4
explicitly leaves alone (in-memory or outbound only — the rule is that no
owner-qualified key may be **persisted**).

| Hit | What it is | Disposition |
| --- | --- | --- |
| `src/bun/index.ts` L755–763 | `setPersonaOrder` passes the merged (qualified) id list to `saveRosterOrder`, persisting `nodeId/personaId` into `roster.json` | **Fix (SLICE-C):** `saveRosterOrder` strips to bare ids before writing; `rosterOrder()` strips-and-dedupes on read so legacy files heal on next save. No `index.ts` edit needed. |
| `src/bun/store/roster.ts` L17–36 | rank map keyed by stored (possibly qualified) ids | **Fix (SLICE-C):** `applyRosterOrder` ranks by bare id — strip a `/`-prefix from each candidate's id before lookup, so qualified merged rows still sort. |
| `src/bun/index.ts` L990–992 | `setActivePersona` stores the incoming id raw via `setLastPersonaId`; the webview sends qualified ids for remote teammates (`src/mainview/App.tsx` L704) | **Fix (SLICE-C):** `setLastPersonaId` in `settings.ts` strips to the bare id. Read path unchanged: `getLastPersonaId` handler already drops ids that fail `getPersona` (observed `index.ts` L999–1004), so remote reopen stays unsupported exactly as today. |
| `src/bun/store/settings.ts` L23, L45–48, L87–93 | `lastPersonaId` field itself | **Fix (SLICE-C):** same as above; legacy qualified values normalize on read. |
| `src/bun/fleet/fleet.ts` L696–699 | `remoteTargetId` / `parseRemoteTarget` — the `nodeId/personaId` convention | **Keep.** Routing mechanism; dies with the envelope, not in Phase 4. |
| `src/bun/fleet/wire.ts` L146–148, L277–312, L320–378, L417–435, L442–446 | `rosters` / `lastSessions` maps keyed by nodeId and qualified ids; qualification and `/`-filters | **Keep.** In-memory wire state; Phase 4 leaves NodeLink and `personasChanged` snapshots unchanged. Must not be persisted. |
| `src/bun/index.ts` L598, L1007 | `parseRemoteTarget` / `includes("/")` routing switches | **Keep.** Routing, not storage. |
| `src/bun/mcp/bridge.ts` L641, L677, L753, L836 | `parseRemoteTarget` on delivery targets | **Keep.** Routing. |
| `src/bun/push/notify.ts` L133–146 | `qualified = \`${authority}/${personaId}\``; push `threadId` / `collapseId` | **Keep.** Outbound notification keys, not stored records. Revisit with the envelope. |
| `src/mainview/App.tsx` L704 | push-open resolves `${node}/${personaId}` | **Keep.** UI routing into the existing merged roster. |

Already owner-free, verified: transcript filenames (bare persona id, paths.ts
L96–98 — layout changes for epochs but the key stays bare), `threads/`
`threadKey a~b` of bare ids (paths.ts L121–125), `attachments/<personaId>`
(L107–111), `workspaces/<personaId>` (L113–115), search `index.sqlite`
`persona_id` columns (search.ts L34–48).

## 10. Verify gates (binary, runnable)

Each gate is a command that exits 0 or fails. Run all before declaring a
slice done.

1. **`bun scripts/verify-roster-durability.ts`** (hutch script
   `verify:roster-durability`, observed `hutch.config.ts` L59). SLICE-D
   extends the existing script (observed `scripts/verify-roster-durability.ts`)
   to the store era. Must assert, in a temp `TOAD_DATA_DIR`:
   - a fixture `config.json` migrates: personas listable, `config.json`
     byte-identical before/after (hash compare), oplog has one `put` per
     persona at `(epoch 1, version 1)`;
   - a damaged `config.json` (no `.bak`) blocks migration; writes refuse;
     the file is left byte-identical;
   - a damaged `store.sqlite` (garbage bytes): reads answer empty, every
     facade write throws, the file is left byte-identical;
   - `deletePersona` leaves a tombstone row and a `tombstone` op; the persona
     is gone from `listPersonas()`;
   - checkpoint/clearCheckpoint round-trips without adding oplog rows;
   - `store-snapshot.json` exists and parses;
   - the existing import-order trap check (`ensureLayout` throws on a late
     `TOAD_DATA_DIR`) stays.
2. **`bun scripts/verify-store-bundle.ts`** (new hutch script
   `"verify:store-bundle": "bun scripts/verify-store-bundle.ts"`). Proves
   `bun:sqlite` survives the same bundling pipeline `verify-pi-bundle`
   guards (observed `scripts/verify-pi-bundle.ts` L70–88): run
   `scripts/probe-store.ts` from source, then
   `bun build scripts/probe-store.ts --target=bun --external undici --outfile <tmp>/probe.js`
   and run the bundle. The probe: temp `TOAD_DATA_DIR`, open store, `putLocal`
   two records, `tombstoneLocal` one, `applyRemoteOps` a stale op (must
   refuse), reopen, assert rows and oplog. This proves the `bun build
   --target=bun` pipeline only. **It does not prove the Electrobun app build**
   (`hutch run build`); do not claim that unless someone runs it.
3. **`bun test src/bun/store`** — unit tests under the preload isolation
   (`bunfig.toml`, `test/preload.ts`); includes SLICE-D's
   `store-safety.test.ts`: a stale-epoch `applyRemoteOps` is refused; a
   damaged db is not overwritten; `setLastPersonaId("node/abc")` and
   `saveRosterOrder(["node/abc", "local"])` persist bare ids only (no `/` in
   the written JSON).
4. **`hutch run typecheck`** (`hutch pm x tsc --noEmit`, observed
   `hutch.config.ts` L36) — proves every existing caller of the §5.2 facade
   compiles unchanged.

## 11. Implementer slices

Exactly four. File ownership is exclusive: a slice must not edit another
slice's files. Shared contracts are the signatures in §5 — code to the spec,
not to a sibling's branch.

### SLICE-A — store engine (hard; opus/sol)

Build `records.ts` per §4–§5.1: open + pragmas + damaged latch, schema
creation, `putLocal` / `tombstoneLocal` routed through the same fenced
transaction as `applyRemoteOps`, `listRecords` / `getRecord` /
`currentEpoch` / `oplogAfter`, snapshot export.

- **Owns:** `src/bun/store/records.ts` (new),
  `src/bun/store/records.test.ts` (new), the `src/bun/paths.ts` additions in
  §3 (constants + segment-path helpers, exactly as specified — nothing else
  in that file).
- **Forbidden:** `personas.ts`, `transcript.ts`, `roster.ts`, `settings.ts`,
  `search.ts`, `index.ts`, anything under `fleet/`, `scripts/`,
  `hutch.config.ts`.
- **Done when:** `bun test src/bun/store/records.test.ts` passes covering:
  create/update/tombstone round-trip; portable/machine writes bump neither
  version nor oplog; replicated writes bump both; `oplog_idempotent` rejects
  a duplicate insert; `applyRemoteOps` all-or-none on a mixed batch; snapshot
  file parses. `hutch run typecheck` passes.
- **Must not invent:** kinds beyond `persona`; watch/subscribe APIs; oplog GC
  or tombstone collection; anything that increments `ownerEpoch`; any network
  or wire code; extra tables or pragmas.

### SLICE-B — persona facade + migration (hard; opus/sol)

Rewrite `personas.ts` internals onto the store keeping §5.2 shapes; implement
the §7 migration; split/assemble `Persona` per §6.

- **Owns:** `src/bun/store/personas.ts`, `src/bun/store/migrate-config.ts`
  (new — the §7 algorithm), `src/bun/store/personas.test.ts` (new).
- **Forbidden:** `records.ts`, `transcript.ts`, `roster.ts` (call
  `mergeRosterRank` per §5.3; do not implement it), `settings.ts`,
  `index.ts`, `fleet/`, `scripts/`, `hutch.config.ts`, `src/shared/rpc.ts`.
- **Depends on:** SLICE-A merged. (Until SLICE-C lands, `reorderPersonas` may
  temporarily call the existing `saveRosterOrder` — acceptable interim,
  remove when `mergeRosterRank` exists.)
- **Done when:** `bun test src/bun/store/personas.test.ts` passes covering:
  migration from a fixture `config.json` (byte-identical after), damaged
  config refusal, create/update/delete/checkpoint round-trips, tombstone
  exclusion from `listPersonas`, `lastSessionId` fold, AGENTS.md
  materialisation unchanged. `hutch run typecheck` passes — no caller edited.
- **Must not invent:** new `Persona` fields; RPC or wire changes; dual-writes
  to `config.json` (it is frozen); any read of `store-snapshot.json`; epoch
  increments.

### SLICE-C — transcript epoch segments + owner-free keys (mechanical; grok/sonnet)

Implement §8 in `transcript.ts` and the §9 "Fix" rows in `roster.ts` /
`settings.ts`; add `mergeRosterRank`; fix the search stamp.

- **Owns:** `src/bun/store/transcript.ts`, `src/bun/store/roster.ts`,
  `src/bun/store/settings.ts`, `src/bun/store/search.ts` (only `fileStamp`
  and reindex-on-mismatch mechanics), `src/bun/store/transcript.test.ts`
  (new).
- **Forbidden:** `records.ts`, `personas.ts`, `paths.ts` (SLICE-A ships the
  helpers; consume them), `index.ts`, `fleet/`, `scripts/`, `hutch.config.ts`.
- **Depends on:** SLICE-A for `currentEpoch` and the segment-path helpers.
  The §9 key normalization (roster.json / lastPersonaId) has no dependency —
  start it immediately.
- **Done when:** `bun test src/bun/store/transcript.test.ts` passes covering:
  legacy flat file reads as epoch 1; lazy relocation by rename (bytes
  identical after move); append lands in `<dir>/1.jsonl`; `load` folds across
  segments; `preview`/`recentMessages` walk segments newest-first; `compact`
  touches only the current segment; roster.json and settings.json never
  persist a `/`-qualified id and legacy qualified entries normalize on read.
  `hutch run typecheck` passes.
- **Must not invent:** epoch increments or multi-owner segments (everything
  is epoch 1 in Phase 4); changes to wire qualification (`wire.ts`,
  `fleet.ts`, `notify.ts`, `App.tsx` are keep-rows in §9); new transcript
  event kinds; segment compaction across epochs.

### SLICE-D — verify scripts + wiring + safety tests (mechanical; grok/sonnet)

Ship the §10 gates.

- **Owns:** `scripts/verify-roster-durability.ts` (extend),
  `scripts/verify-store-bundle.ts` (new), `scripts/probe-store.ts` (new),
  `hutch.config.ts` (add `verify:store-bundle` only),
  `src/bun/store/store-safety.test.ts` (new).
- **Forbidden:** everything under `src/bun/store/` except the test file
  above; `index.ts`; `fleet/`; `paths.ts`.
- **Depends on:** SLICE-A (engine checks, bundle probe, stale-epoch and
  damaged-db tests run against `records.ts` directly). The migration and
  facade sections of the durability script additionally need SLICE-B — land
  the script in two commits if B is not merged yet.
- **Done when:** gates 1–3 of §10 exit 0; gate 2 refuses a stale epoch and
  passes from both source and bundle.
- **Must not invent:** claims about the Electrobun app build (`hutch run
  build` is not run by these gates); new store APIs (test only what §5
  exports); changes to `test/preload.ts` or `bunfig.toml`.

Suggested merge order: A → (B and C in parallel) → D finishes last.

## 12. What Phase 4 explicitly does not change

- `config.json` bytes — frozen after migration; never rewritten or deleted.
- The wire: `NodeLink`, `PeerWire`, whole-roster `personasChanged` snapshots
  and their sameness damper, all qualification in `src/bun/fleet/wire.ts`,
  `remoteTargetId`/`parseRemoteTarget` in `src/bun/fleet/fleet.ts`.
- `mergedPersonas()` / `remotePersonas()` (`src/bun/index.ts` L525–527):
  they keep reading local records through the same facade shapes as today.
- Hop / move / load-balance execution, the envelope, watches, phone join,
  relaying third-node records — **not shipped**; this store only leaves them
  reachable. `ownerEpoch` is stored and compared but incremented by nothing;
  `applyRemoteOps` / `oplogAfter` / `applied_cursor` have zero callers.
- Push notification keys (`src/bun/push/notify.ts`) and mainview routing
  (`src/mainview/App.tsx`).
- `src/shared/types.ts` `Persona` shape and the RPC surface
  (`src/shared/rpc.ts`).
- `durable.ts`, `test/preload.ts`, `bunfig.toml`, `assertDataRoot`.
- Threads, attachments, workspaces, schedules, computers layouts.
- AGENTS.md materialisation (kept, in the facade).
