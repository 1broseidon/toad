# Housekeeping ledger — Phase 4.5

Reviewer output for [housekeeping.md](./housekeeping.md). The reviewer decides
stay and go; the operator approves the go pile; the executor only then deletes.

## 1. Status

HEAD is `e0c3456` on `mesh/housekeeping`, worktree
`/home/george/Projects/personal/toad-worktrees/housekeeping` (clean apart from
the untracked charter). The worktree's `src/` and `hack/` are byte-identical to
the main checkout at the same commit (`diff -rq`), so source findings transfer;
`docs/control-plane.md` differs (the main checkout has uncommitted edits to it),
and every doc row below is cited against the **committed** worktree copy.

Searched, symbol by symbol: `qualifyRoster`, `fetchRoster`, `SNAPSHOT_TTL`,
`personasChanged`, the `rosters` map, the sameness damper, `localSnapshot`,
`status`, `fleetRosters`, `fetchedAt`, `stateOf`, `LegacyPeerWire`,
`peerWireAccess`, `webAccess` / `webAccessFromPeer` / `deviceForPeer`,
`handleFleetPair`, `peerBroadcast` / `nodePeerBroadcast` / `broadcastNodeLinks` /
`webBroadcast`, `peerIdForLegacyToken`, `closeNodePeer`,
`closeFleetPeerSockets`, `firstHandForPeers`, every `meshCount` call site (24 of
them), and every `CONFIG_FILE` / `writeFileSync` path. Read in full:
`fleet/wire.ts`, `fleet/fleet.ts`, `fleet/sync.ts`, `fleet/metrics.ts`,
`node/server.ts`, `web/server.ts`, `web/devices.ts`, `store/migrate-config.ts`,
`store/roster.ts`, `paths.ts`, `bun/index.ts`, `hack/verify-mesh-plane.ts`, and
the relevant halves of `docs/federation.md` §6/§7/§11, `docs/control-plane.md`,
`docs/roster-store.md`.

Ran: a scripted unused-export sweep over `src/bun/{fleet,node,store,web}` and
`src/shared` (each export counted for references outside its own file); `rg`
sweeps for `TODO|FIXME|XXX|HACK|@deprecated` and for commented-out code in the
four target directories (both clean); `bun test` (**88 pass / 2 fail** — both
failures are `Cannot find module '@earendil-works/pi-coding-agent'` in
`pi/web-search.test.ts` and `pi/subagent-bg.test.ts`, caused by this worktree
having no `node_modules`, not by any candidate here); and `git log -S` / `git
show` archaeology on `e0c3456^`, `ee00e20`, `9fb8bb1`, `20c49a0` to date three
surfaces. **knip is not a dependency** (checked `package.json`) and was not
installed. `hutch run typecheck` and `hutch run verify:mesh-plane` could **not**
be run here: no `node_modules` (no `tsc`) and no built `dist/` (the mesh-plane
child dies in `startWebMode` with "The web bundle was not found"). Building
would have written files outside the one file I may touch, so I did not.

Headline: the snapshot mesh is already gone from source — `qualifyRoster`,
`fetchRoster`, `SNAPSHOT_TTL_MS`, the `rosters` map and the sameness damper have
**zero** source hits, and `personasChanged` no longer appears in `onPeerPush`,
`PEER_PUSHES`, or `firstHandForPeers`. What Phase 5 left behind is narrower than
the charter's hunt list implies: it deleted the roster **poll's caller** and left
the **responder** mounted, orphaned one metric kind, and broke one verify
harness. Separately, and against the charter's stated expectation, the
dual-transport surface is **not** dead — `hack/verify-mesh-plane.ts` pairs and
pushes over the legacy web transport end to end, and the node listener's `/ws`
was a real desktop-to-desktop path at `ee00e20`. Hunt item 2 therefore yields no
`go` rows, and hunt item 3 (`config.json` writes) yields none either: Phase 4
finished that job and `hack/verify-roster-durability.ts` guards it.

## 2. Ledger

| Candidate | Verdict | Evidence | Citation | Risk | Owner | Executor action |
| --- | --- | --- | --- | --- | --- | --- |
| `handleFleetRpc` `case "status"` (the roster-poll responder) | go | Caller + replacement: zero callers anywhere (`rg '"status"'` returns this arm only); its only caller `fetchRoster` was deleted by Phase 5, which named the poll dead, and §7's surviving-method list omits `status`. Replaced by `fleetRosters()` reading replicated records. | `src/bun/fleet/fleet.ts:403-404`; `docs/federation.md:453` ("killed in this phase"), `docs/federation.md:483` ("only the *status poll* dies") | R4+R5 | executor | Delete the `case "status"` arm from `handleFleetRpc` |
| `localSnapshot()` | go | Quasi-dead: sole caller is the `status` arm above; the export sweep flags it as the only *function* in the four directories with zero references outside its own file. | `src/bun/fleet/fleet.ts:370-383`; called only at `fleet.ts:404` | R5 | executor | Delete `localSnapshot` and the then-unused `listPersonas` import at `fleet.ts:14` |
| `Deps.stateOf` (fleet dependency) | go | Quasi-dead: its only consumer is `localSnapshot`; nothing else in `src/` reads it. Excess-property checking makes the five provider sites a required part of the same edit. | declared `src/bun/fleet/fleet.ts:94`, consumed only at `fleet.ts:379` | R5 | executor | Drop `stateOf` from `Deps` and from all five `initFleet` callers (`src/bun/index.ts:337`, `hack/verify-mesh-plane.ts:99`, `hack/fleet-node.ts:25`, `hack/verify-node-admission.ts:51`, `hack/verify-federation.ts:74`) |
| `MeshKind` member `"wireCall"` | go | Caller: zero production emitters. All 24 `meshCount(` call sites in `src/` were enumerated; none passes `"wireCall"` (the only dynamic one, `web/server.ts:424`, is typed to `webBroadcast\|peerBroadcast`). It counted the snapshot-era `wire.call("listPersonas")` pull; `git log -S` dates it to `20c49a0` and `e0c3456^` already had no emitter. | `src/bun/fleet/metrics.ts:12` | R2 | executor | Remove the `"wireCall"` member from the `MeshKind` union |
| `hack/verify-mesh-metrics.ts` `wireCall` emit + assertion | go | Quasi-dead with the union member above: the harness is the only writer of the kind, so it asserts a counter production never increments. | `hack/verify-mesh-metrics.ts:30`, `:40` | R2 | executor | Delete the `wireCall` `meshCount` line and its `check(...)` assertion |
| `hack/verify-mesh-plane.ts` `listPersonas` readiness gate | go | Doc/test: the gate waits for `listPersonas` to cross the wire, but `e0c3456` deleted that pull from `onWireUp` (`git show e0c3456^:src/bun/fleet/wire.ts` L276 has `wire.call("listPersonas", {})`; the current `onWireUp` calls only `getSessionInfo`) and did **not** touch this harness (`git show --stat e0c3456`). In `src/bun/fleet/` `listPersonas` now appears only inside `localSnapshot`, itself `go`. | `hack/verify-mesh-plane.ts:228` (gate), `:71` (stub); `src/bun/fleet/wire.ts:282-297` | R3 | executor | Replace the `listPersonas` readiness gate with a method that still crosses the wire (`getSessionInfo`, already stubbed at `:72`), or drop the gate and rely on the aggregate step |
| `FleetNodeRoster.fetchedAt` | go | Caller: written once, read nowhere. No consumer in `src/mainview/`, `src/bun/mcp/bridge.ts`, or any test reads the field; it is a poll-freshness stamp from the snapshot era. | declared `src/shared/types.ts:650`, written `src/bun/fleet/fleet.ts:531`, mirrored in the harness type `hack/verify-federation.ts:229` | R3 | executor | Remove `fetchedAt` from the type, from the `fleetRosters()` literal, and from the harness mirror type |
| `docs/control-plane.md` claim row "`/fleet/rpc` HTTP still polls each origin" | go | Doc: sits under "Data-safety claims, verified on the current tree" and cites `fleet.ts` `fetchRoster`, which does not exist at `e0c3456`. Describes a killed system as current. | `docs/control-plane.md:461` | R1 | executor | Rewrite the row to state the poll is gone, or cut it |
| `docs/control-plane.md` preamble + "Today" heading | go | Doc: L3–5 says the document "explains the mesh as it runs today" and L33 heads the section "Today:", while L7 anchors the same prose to `ab030fa`. The section's claims (one shared `/ws` bucket, the sameness damper, recursive `mergePeerRecords`) were killed in `20c49a0` and `e0c3456`. | `docs/control-plane.md:3-5`, `:33` | R1 | executor | Retitle the section and preamble to name `ab030fa` as past, leaving the section body and the target design untouched |
| `qualifyRoster` | stay | Absent: zero source hits; already deleted by Phase 5. Charter's gold-trace verdict does not apply to this tree. | `rg qualifyRoster src/` → no matches (docs only: `docs/roster-store.md:372`) | R0 | — | |
| `fetchRoster`, `SNAPSHOT_TTL_MS`, the `cache` map | stay | Absent: zero source hits; deleted by Phase 5 per `federation.md` §6.4. | `rg 'fetchRoster\|SNAPSHOT_TTL' src/` → no matches | R0 | — | |
| In-memory `rosters` map | stay | Absent: `wire.ts` keeps only `lastSessions`; no `rosters` map exists. | `src/bun/fleet/wire.ts:149-152` | R0 | — | |
| `personasChanged` sameness damper | stay | Absent: no JSON-compare guard remains, and `sync.ts` records why none is needed ("an idle mesh sends nothing at all, which is why there is no damper to write"). | `src/bun/fleet/sync.ts:14-22` | R0 | — | |
| `personasChanged` peer-to-peer case | stay | Absent from `onPeerPush`, `PEER_PUSHES`, and `firstHandForPeers`; a live harness step asserts it never crosses. | `src/bun/fleet/wire.ts:303-406`; guard at `hack/verify-federation.ts:490-495` | R0 | — | |
| `send("personasChanged", mergedPersonas())` | stay | Caller: the local publish to this desktop's webview and its phones — `webBroadcast` carries it unconditionally, and the mainview subscribes. Not the killed desktop-to-desktop snapshot. | `src/bun/index.ts:535`; consumer `src/mainview/useToad.ts:236` | R0 | — | |
| `hack/verify-federation.ts` G3.6 no-`personasChanged` guard | stay | Contract: a live negative assertion protecting the Phase 5 kill. Deleting it would let the snapshot case return unnoticed. | `hack/verify-federation.ts:490-495` | R0 | — | |
| `LegacyPeerWire` | later | Caller: `hack/verify-mesh-plane.ts` pairs two children with `initFleet` given **no** `nodeOrigin`, so invites advertise `httpOrigin`, pairing lands on the web server's legacy `/fleet/pair`, rows are written without `transport: "node"`, and the legacy wire carries the harness's push assertions. Phase 5 also keeps it deliberately. | `src/bun/fleet/wire.ts:43-145`, `:223-231`; harness `hack/verify-mesh-plane.ts:98-109`, `:254-319`; `docs/federation.md:466-472` | R0 | — | |
| `peerWireAccess` legacy branch, `FleetPeer.webToken` / `webOrigin` | later | Caller: the branch that mints and caches the phone-shaped credential for a legacy row, exercised by the same harness. Helper of a locked surface. | `src/bun/fleet/fleet.ts:618-626`, fields at `:57-59` | R0 | — | |
| `webAccess` RPC arm, `webAccessFromPeer`, `deviceForPeer` | later | Locked later (Phase 7) **and** independently live: `openRemoteDesktop` calls `webAccessFromPeer`, and `hack/verify-web-pair.ts` asserts `deviceForPeer` credentials are revoked with the peer. | `src/bun/fleet/fleet.ts:479-493`, `:670-680`; `src/bun/index.ts:682`; `src/bun/web/devices.ts:135-154`; `hack/verify-web-pair.ts:32-37` | R0 | — | |
| `peerBroadcast` and the `fleetPeerId` audience split | later | Caller: the only fan-out that reaches a socket with `fleetPeerId !== null` — which is exactly the window `openRemoteDesktop` opens (it loads the peer's app with a `deviceForPeer` token, so `webBroadcast` deliberately excludes it). Removing it would silence the remote-desktop window. | `src/bun/web/server.ts:396-407`, `:250`; `src/bun/index.ts:194`; `src/bun/index.ts:679-701` | R0 | — | |
| Node listener `/ws`, `peerIdForLegacyToken`, the `peers` set, `nodePeerBroadcast` | later | Contract: zero in-tree dialers today, **but** `git show ee00e20:src/bun/fleet/fleet.ts` shows `peerWireAccess` then returning `{origin: peer.origin, token: peer.callToken}` for a `transport: "node"` peer, which dialled this very route with a `fleet.json` token. It **was** a shipped desktop live path, so the charter's mounted-route guard forbids `go`; it is the same admission material as the locked `/node/link` gate. Phase 7 retires it with the dual transport. | `src/bun/node/server.ts:35-43`, `:23`, `:101-107`, `:200-209`; history `ee00e20` | R0 | — | |
| `handleFleetPair` legacy default (`transport = "legacy"`) | later | Caller: mounted on the web server without the `"node"` argument, and the mesh-plane harness pairs through it. | `src/bun/fleet/fleet.ts:280-283`; `src/bun/web/server.ts:196`; `hack/fleet-node.ts:39` | R0 | — | |
| `fleetRosters()`, `online`, `FleetTeammate` | stay | Caller: three live readers — the `fleetRoster` RPC, the MCP bridge twice, and a federation harness step asserting `online: false` with teammates present. | `src/bun/fleet/fleet.ts:508-533`; `src/bun/index.ts:677`; `src/bun/mcp/bridge.ts:538`, `:588`; `hack/verify-federation.ts:357-366` | R0 | — | |
| `App.tsx` 20-second `fleetRoster` poll | stay | Caller: now a local read, but still the **only** transport for peer reachability — no push reports a wire going up or down, so `online` would freeze without it. Phase 5 left it deliberately. | `src/mainview/App.tsx:574-598`; `docs/federation.md:461-465` | R0 | — | |
| `mergePeerRecords`, `lastSessions`, `remoteTargetId` / `parseRemoteTarget`, `mergedPersonas`, `openRemoteDesktop`, non-roster push mirror | later | Locked later by charter §5; each also verified to have live callers in `wire.ts`, `index.ts`, and the mesh-plane harness. | `src/bun/fleet/wire.ts:576-601`, `:152`, `:363-372`; `src/bun/fleet/fleet.ts:683-691`; `src/bun/index.ts:529-536`, `:679-701`, `:860-881` | R0 | — | |
| `config.json` write paths | stay | Absent: no code writes `config.json`. `migrate-config.ts` reads once and never writes back; the only `writeFileSync` in `personas.ts` (`:416`) writes `AGENTS.md`. Two harnesses assert the file is byte-identical after migration and after `createPersona`. | `src/bun/store/migrate-config.ts:8-23`, `:97`; `src/bun/store/personas.ts:405-421`; `hack/verify-roster-durability.ts:187`, `:202` | R0 | — | |
| TODOs without owner/condition, commented-out blocks in the four target dirs | stay | Absent: the `TODO\|FIXME\|XXX\|HACK\|@deprecated` sweep returns one prose hit outside scope (`pi/subagent.ts:256`), and the commented-out-code sweep returns nothing. | `rg` over `src/bun/{fleet,node,store,web}` → no matches | R0 | — | |
| `docs/roster-store.md` `qualifyRoster` / snapshot references | stay | Doc: historically scoped (a Phase 4 "what this phase does not change" record), and reviewer rule §8 forbids rewriting this file in 4.5. Drift is recorded here instead: `:372` cites `qualifyRoster` as `observed` at lines that no longer exist. | `docs/roster-store.md:372`, `:487`, `:644-645` | R0 | — | |
| `docs/control-plane.md` `ab030fa` claim table | stay | Doc: explicitly anchored — "Current-system claims, verified against `ab030fa`" — so the rows below it are history, not current-state claims. | `docs/control-plane.md:416-433` | R0 | — | |
| `docs/control-plane.md` target sections | stay | Doc: describes the target that is still the plan (`ResourceRef`, envelope, watches, leases). Charter forbids refreshing design that still stands. | `docs/control-plane.md:100-413`, `:467-470` | R0 | — | |
| Orphaned `isSafeLink` doc comment in `index.ts` | out-of-scope | Real defect — the allow-list docblock sits above `reactionSnippet` while `isSafeLink` is undocumented at `:240` — but it is not a remnant of an old system, and charter §4.4 scopes comment cleanup to the four `src/bun` subdirectories. | `src/bun/index.ts:210-221` vs `:240-246` | R0 | — | |
| Type-only exports unused outside their file (`FleetPeer`, `MeshEvent`, `MeshKind`, `NodeLinkSocket`, `MembershipAdmission`, `PersonaClasses`, `ResourceKind`, `ResourceMeta`, `ApplyResult`, `ThreadPreview`, `WebDevice`) | out-of-scope | Sweep result: all are types used internally as annotations for exported values; none is a snapshot/poll/dual-transport remnant. Not this mesh. | export sweep over `src/bun/{fleet,node,store,web}` | R0 | — | |
| Phone web mode, 4680, `/ws` on the web server; phone join; hop / `ownerEpoch`; relay; membership CAP/voter; oplog GC; other-agent UX on `ux/*`; live data dir; `config.json` bytes | out-of-scope | Locked by charter §5 as later or unbuilt; no reviewer finding disturbs them. | `docs/housekeeping.md:87-100` | R0 | — | |

## 3. Go pile, grouped by file

Nine `go` rows across seven files. One owner at a time; do not touch adjacent
`stay` code in these files.

**`src/bun/fleet/fleet.ts`**
1. Delete the `case "status"` arm of `handleFleetRpc` (`:403-404`).
2. Delete `localSnapshot()` (`:370-383`).
3. Delete the now-unused `listPersonas` import (`:14`). Keep the `FleetTeammate`
   import at `:6` — `fleetRosters` still uses it at `:527`.
4. Drop `stateOf` from `Deps` (`:94`).
5. Remove `fetchedAt: Date.now()` from the `fleetRosters()` literal (`:531`).

**`src/bun/fleet/metrics.ts`**
6. Remove the `"wireCall"` member from `MeshKind` (`:12`).

**`src/shared/types.ts`**
7. Remove `fetchedAt` from `FleetNodeRoster` (`:650`).

**`src/bun/index.ts`**
8. Remove the `stateOf:` property from the `initFleet({...})` call (`:337`).
   Nothing else in this file changes.

**`hack/verify-mesh-metrics.ts`**
9. Delete the `wireCall` `meshCount` line (`:30`) and its `check(...)` (`:40`).

**`hack/verify-mesh-plane.ts`**
10. Remove the `stateOf:` property (`:99`).
11. Replace the `listPersonas` readiness gate (`:228`) with `getSessionInfo`
    (already stubbed at `:72`), or delete the gate.

**`hack/verify-federation.ts`, `hack/verify-node-admission.ts`, `hack/fleet-node.ts`**
12. Remove the `stateOf:` property at `verify-federation.ts:74`,
    `verify-node-admission.ts:51`, `fleet-node.ts:25`, and remove `fetchedAt`
    from the harness mirror type at `verify-federation.ts:229`.

**`docs/control-plane.md`**
13. Rewrite or cut the `fetchRoster` claim row (`:461`).
14. Retitle the L3–5 preamble and the L33 heading to name `ab030fa` as past.
    Do not touch `:100-413` or `:416-433`.

## 4. Do not touch

The charter's locked-later list stands in full: phone web mode / 4680 / the web
server's `/ws`; `webAccess`, `deviceForPeer`, `openRemoteDesktop`; the
`/fleet/rpc` one-shots `deliver`, `notify`, `createTeammate`, `readTranscript`,
`readThread`, and pairing; `fleet.json` pairwise tokens as the `/node/link`
upgrade gate; the non-roster push mirror; `mergePeerRecords`; `remoteTargetId` /
`parseRemoteTarget` and `nodeId/personaId` in the UI; Phase 6 phone join; Phase 8
hop; CAP/voter and oplog GC; other-agent UX on `ux/*`; the live data dir; and the
`config.json` bytes on disk.

Added by this review:

- **The node listener's `/ws` cluster** — `peerIdForLegacyToken`, the `peers`
  set, the non-`nodeLink` websocket branches, and `nodePeerBroadcast`
  (`src/bun/node/server.ts:23`, `:35-43`, `:101-107`, `:110-156`, `:200-209`).
  Zero in-tree dialers, but it was a shipped desktop-to-desktop path at
  `ee00e20`, so the mounted-route guard forbids `go`.
- **`LegacyPeerWire` and the whole legacy pairing/credential chain** —
  `peerWireAccess`'s legacy branch, `FleetPeer.webToken` / `webOrigin`,
  `webAccessFromPeer`, the `webAccess` arm, and `handleFleetPair`'s legacy
  default. `hack/verify-mesh-plane.ts` exercises all of it end to end.
- **`peerBroadcast` and the `fleetPeerId` audience split** — the remote-desktop
  window's only push feed.
- **The `App.tsx` 20-second `fleetRoster` poll** — the only transport for peer
  `online`.
- **`docs/roster-store.md`** — do not edit at all. Its drift is recorded in the
  ledger, per reviewer rule §8.
- **`docs/control-plane.md:100-413` and `:416-433`** — target design and an
  explicitly `ab030fa`-anchored claim table.
- **`docs/federation.md`** — do not edit. §6.5's "`LegacyPeerWire` stays" and
  §7's stays table were confirmed against source, not merely copied.

## 5. Verification

All existing commands. No new harness is needed: the `status` arm has no test
covering it, so deleting it leaves no hole in an existing contract.

Run before and after, and compare:

1. `hutch run typecheck` — the load-bearing gate. Six of the nine `go` rows are
   type-visible (the `Deps.stateOf` removal fails loudly at all five
   `initFleet` sites if any is missed; the `fetchedAt` and `MeshKind` removals
   likewise). **Not verified by the reviewer** — this worktree has no
   `node_modules`, so run `hutch pm install` first or work in the main checkout.
2. `bun test` — baseline at `e0c3456` is **88 pass / 2 fail**, both failures
   being `Cannot find module '@earendil-works/pi-coding-agent'` from absent
   `node_modules`. With dependencies installed, expect zero failures and no new
   ones. Covers `fleet/sync.test.ts`, `store/records.test.ts`,
   `store/personas.test.ts`, `store/roster.test.ts`, `store/store-safety.test.ts`.
3. `hutch run verify:mesh-metrics` — directly edited by go rows 4, 5, 9.
4. `hutch run verify:mesh-plane` — directly edited by go rows 10, 11, and the
   guard on every `later` legacy-transport surface. **Requires a built `dist/`**
   (`hutch pm x vite build`); the reviewer could not run it. This is the one
   command that must be made to pass from a genuinely failing start.
5. `hutch run verify:federation` — edited by go row 12; guards the Phase 5
   contract including the no-`personasChanged` step and `fleetRosters`
   `online: false`.
6. `hutch run verify:node-admission` — edited by go row 12; guards `/node/link`,
   the dialer, and `closeNodePeer`.
7. `hutch run verify:web-pair` — untouched by the pile but adjacent: guards
   `deviceForPeer` credential revocation, a `later` surface next to the edits.
8. `hutch run verify:roster-durability` — guards the frozen `config.json`
   claims this ledger relies on.
9. `hutch run verify:store-bundle` and `hutch run verify` — broad regression.

If a `go` row breaks a `stay` contract, revert that row and re-file it as `stay`
with the new evidence, per charter §9.

## 6. Unknowns

Off the go pile. Do not guess.

1. **Does `hutch run verify:mesh-plane` fail today?** Resolved after the
   executor run: **yes, and not only at the gate.** The gate was retargeted
   to `getSessionInfo` as instructed. Instrumentation showed zero RPC calls
   of any kind at wire-up. Production `onWireUp` (`wire.ts:282-297`) only
   probes `getSessionInfo` per `remoteOwnedRecords(nodeId)`, and this
   harness never writes a persona into the store (`listPersonas` returns
   `[]`). The old `listPersonas` gate was equally already-broken at
   `e0c3456`. Teaching the harness to create records, or rewriting
   `onWireUp`, is outside the go pile. Leave the retarget; do not force a
   pass.
2. **Mixed-version peers and the `status` arm.** Removing it makes a peer still
   running `≤ e0c3456^` receive `400 unknown method` from its roster poll. I
   verified in-tree callers only; I cannot inspect another machine's build. The
   degradation should be graceful (that peer's own roster view goes stale), and
   Phase 5 already accepted it by deleting the caller — but if the operator runs
   a mixed pair, this row should wait until both desks are on `e0c3456`.
   **Resolving this "no" does not change the pile; resolving it "a live
   mixed-version peer exists" moves rows 1–3 to `later`.** This is the only
   unknown that would change the pile.
3. **Typecheck and `wireCall`'s exact death date.** `git log -S` attributes
   `"wireCall"` to `20c49a0` alone, yet `e0c3456^` already had no emitter — the
   removal likely rode a rename the pickaxe did not follow. The e0c3456 fact
   (zero emitters) is observed and sufficient; the date is not.
4. **`fetchedAt` consumers outside this repo.** Zero readers in-tree, but it is
   an over-the-wire field a phone build could in principle read. No iOS/native
   source in `src/mainview/` or `ios/` reads it; I did not audit shipped phone
   binaries.
