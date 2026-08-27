# Housekeeping — Phase 4.5 charter

Write a stay/go ledger for dead remnants of systems Phase 4 and Phase 5
replaced. Do not implement. Do not invent a third mesh. The reviewer
decides; the executor only deletes what the ledger marks `go` after the
operator says yes.

This file is the bounds. The ledger is
[housekeeping-ledger.md](./housekeeping-ledger.md). If a sentence here
and a later phase doc disagree, this file wins for 4.5.

## 1. Status

Phases 1–5 are on `main` at `e0c3456`. The live pair replicates first-hand
roster ops over NodeLink. The next *feature* phase is the phone joining
the plane (Phase 6). This slice is not that. It is the cleanup that
federation was not allowed to do: `index.ts` and `src/mainview/` were
byte-identical in Phase 5 by slice boundary, not because they were clean.

Risk class is **R5** (destructive structural). Anvil sweep protocol:
detect, categorise, plan, **stop for approval**, then execute. The
executor does not start until the operator approves the ledger.

## 2. Glossary

One term per concept. Use these spellings in the ledger.

| Term | Meaning |
| --- | --- |
| **stay** | Live. Has a caller on a shipped path (desktop NodeLink, phone web mode, tests that still assert a live contract). Do not delete. |
| **go** | Dead. No live caller. Safe to delete in this slice. |
| **later** | Still used, or reserved for a named later phase. Not dead. Do not delete here. |
| **out-of-scope** | Real, but not this mesh. UX on other branches, hop, watches-as-design, CAP/voter. Leave it. |
| **caller** | A production path, a phone path, or a test that asserts a contract we still keep. A comment is not a caller. A stale doc is not a caller. |
| **old system** | A mechanism Phase 4 or 5 replaced: whole-roster snapshots, in-memory peer rosters, HTTP status polls, desktop-as-phone credentialing *for desktop peers*, `config.json` as the write store. |
| **surface** | Something a caller can observe: RPC, HTTP route, export, settings key, on-disk file, metric kind. |

Verdicts are exclusive. `stay` is not `later`. If it is reserved for Phase
7, the verdict is `later`, not `stay`.

## 3. Gold trace

```text
Candidate: src/bun/fleet/wire.ts qualifyRoster
Question: who still calls it?
Evidence: rg qualifyRoster → definition only; Phase 5 spec said callers die
          with the personasChanged snapshot (stated in federation.md §6).
          Confirm against e0c3456 source before copying the spec.
If no callers and no test asserts it: go.
If a test still imports it to assert snapshot merge: the test is go too,
or the function is stay — decide from the contract, not the test.
Write:
| qualifyRoster | go | observed | wire.ts L… definition; zero callers | R5 | executor | delete function + any snapshot-only test |
```

Copy that row shape. Do not copy that verdict unless the tree still
matches.

## 4. What this slice is allowed to touch

Hunt these areas. The list is a search order, not a go list.

1. Snapshot-era roster remnants: `personasChanged` whole-roster publish,
   in-memory `rosters` map, `qualifyRoster`, `fetchRoster`, `SNAPSHOT_TTL`,
   sameness damper that existed only to survive snapshots.
2. Dual-transport remnants that existed only to make a desktop look like a
   phone to another desktop. The phone's own `/ws` / 4680 / web mode is
   **later** (Phase 7), not go.
3. `config.json` *write* paths that Phase 4 replaced. The file itself stays
   on disk (frozen fallback). Do not delete or rewrite the live file.
4. Unused exports, unused internals, commented-out blocks, and
   TODOs without owner and condition, inside `src/bun/fleet/`,
   `src/bun/node/`, `src/bun/store/`, `src/bun/web/` only as they relate
   to the old systems above.
5. Tests and `scripts/verify-*` assertions that still require deleted
   snapshot/poll behavior.
6. Docs that still describe killed systems as current
   (`specs/control-plane.md` first half is known drift; classify, do not
   rewrite the whole target design).

## 5. Locked later — the reviewer cannot flip these to go

These have live callers or a named later phase. Verdict is `later` (or
`stay` if the reviewer proves a live caller and no later-phase owner).
Never `go`.

| Surface | Why |
| --- | --- |
| Phone web mode, listener 4680, `/ws` | Phones still join this way. Phase 7 retires it. |
| `webAccess`, `deviceForPeer`, `openRemoteDesktop` | Same. Phase 7. |
| `/fleet/rpc` one-shots still invoked: `deliver`, `notify`, `createTeammate`, `readTranscript`, `readThread`, pairing | Live delivery surface. Kill only a method the reviewer proves has zero callers. |
| `fleet.json` pairwise tokens as the `/node/link` upgrade gate | Live admission. |
| Non-roster push mirror (`transcript*`, `streamDelta`, `sessionInfoChanged`, `faceProgress`, `peerActivityChanged`, `schedulesChanged`) | Presence. Watches replace it later, not in 4.5. |
| `mergePeerRecords` | Recursive, ugly, still the preview/activity merge. Later. |
| `remoteTargetId` / `parseRemoteTarget` / `nodeId/personaId` in UI | Phase 5 wrapped around it. ResourceRef retires it later. |
| Phone join (Phase 6), hop / `ownerEpoch` increment (Phase 8) | Unbuilt. Out-of-scope. |
| Relay of a third node's records, membership CAP/voter, oplog GC | Stated open. Out-of-scope. |
| Other-agent UX on `ux/*` branches | Not this mesh. Out-of-scope. |
| Live data dir (`~/.local/share/toad`, Mac equivalent) | Never touch. |
| `config.json` bytes on disk | Frozen. Classify unused *code* that writes it; do not delete the file. |

A helper used only by a locked surface is `later`, not `go`.

## 6. First-principles tests (reviewer)

For each candidate, answer in this order. Skip a later test only when an
earlier one already decides.

1. **Caller test.** `rg` the symbol and every alias. Count production
   callers, phone-path callers, and tests. Zero callers → continue. Any
   live caller → `stay` or `later`.
2. **Replacement test.** Did Phase 4 or 5 ship a replacement that now
   answers the same question? If yes and the old path is uncalled → `go`.
   If yes and the old path still answers a *different* remaining question
   (delivery, phone, presence) → `later`.
3. **Contract test.** If this is a public surface (RPC, HTTP method,
   settings key, metric kind), removing it is R4/R5. `go` only with
   observed zero callers *and* a named replacement or a proof it was
   never mounted.
4. **Quasi-dead test.** A helper called only by something already `go`
   is `go`. Do not leave a ladder with no wall.
5. **Doc test.** A paragraph that describes a killed system as current
   is `go` (rewrite or cut that paragraph). A paragraph that describes
   the target is `stay`. Do not "refresh" design that is still the plan.

Evidence levels: `observed`, `derived`, `stated`, `absent`. A spec
sentence from `federation.md` is `stated` until the reviewer confirms it
against `e0c3456` source. Do not copy Phase 5 "what stays" as if it were
a 4.5 stay list — that table was a slice boundary, not a cleanliness
proof.

Detection: TypeScript first, then `rg`. If `knip` is already a project
dependency, run it. Do not add knip (or any dependency) in this slice.
Do not install new tools.

## 7. Ledger format

Write [housekeeping-ledger.md](./housekeeping-ledger.md) only. No other
files. Use this table and nothing looser:

```markdown
| Candidate | Verdict | Evidence | Citation | Risk | Owner | Executor action |
```

- **Candidate** — symbol, file, or named paragraph.
- **Verdict** — exactly one of `stay`, `go`, `later`, `out-of-scope`.
- **Evidence** — the test that decided it, one sentence.
- **Citation** — `file:line` or `rg` result. No citation → no row.
- **Risk** — R0–R5 from Anvil. Deletion of source is R5. Removal of a
  mounted HTTP method is R4+R5.
- **Owner** — `executor` for `go`; `—` otherwise.
- **Executor action** — imperative, one clause, file-scoped. Empty if
  not `go`.

After the table:

1. **Go pile** — grouped by file, so the executor can take exclusive
   ownership without overlap.
2. **Do not touch** — the locked later list plus any extra the reviewer
   found.
3. **Verification** — exact commands the executor must pass
   (`hutch run typecheck`, the existing verify scripts that still apply,
   and any test file the go pile edits). Do not invent a new harness
   unless a deleted contract leaves a hole in an existing one.
4. **Unknowns** — rows the reviewer could not decide. Verdict stays
   off the go pile. Do not guess.

## 8. Reviewer rules

- Read-only except `specs/housekeeping-ledger.md`.
- Do not commit. Do not push. Do not edit production code.
- Do not fight the other agent's UX.
- Do not start Phase 6, 7, or 8 under a cleanup name.
- Do not reopen hop, CAP/voter, or watches-as-design.
- Do not rewrite `specs/federation.md` or `specs/roster-store.md` except
  to mark a specific sentence as drift in the ledger.
- If two candidates share a file, still one row each. The executor
  groups by file later.

## 9. Executor rules (for after approval)

The executor is not launched until the operator approves the go pile.
Then:

- Only delete rows marked `go`.
- One file owner at a time. Do not "while I'm here" adjacent stay code.
- Do not add features, refactors, or new dependencies.
- Re-run the reviewer's verification list. If a go row breaks a stay
  contract, revert that row and mark it `stay` with the new evidence.
- Do not commit unless the operator asks.

## 10. Closing contract

A 4.5 success is a smaller tree that still boots the live pair, still
answers the phone, still passes typecheck and the Phase 3 / Phase 5
harnesses, and no longer contains an uncalled remnant of the snapshot
mesh. A 4.5 failure is a missing phone path or a deleted one-shot that
still had a caller.

The reviewer decides stay and go. The operator approves the go pile.
The executor only then deletes.
