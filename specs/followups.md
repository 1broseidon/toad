# Follow-ups (v1.1+)

Filed during the v1 ship week. Not blockers. Build after Friday.

## Resume from interruption (best-efforts)

**Problem.** A restart or ACP disconnect kills an agent mid-turn. The agent
comes back blank: the transcript has the half-finished turn, but nobody looks
at it, so the user re-explains and the work restarts from zero. The expired
permission cards (fixed in 381ecc0) were one instance of this class — the
class itself is bigger.

**Goal.** On wake, an agent detects its own unfinished business from the
transcript and resumes it best-efforts, saying what it's resuming. "Best
efforts" is the contract: no guarantees across a backend that lost its session,
no pretending state exists that doesn't.

**Signals already persisted** (the raw material is there):
- Transcript tail: a turn opened but never closed — no `thinking → idle`
  transition on the last turn before shutdown.
- Peer threads: `finishMarkers` / failed markers that never resolved
  (see `src/bun/acp/peers.ts`).
- Permission expiry stamps from 381ecc0 — an `expired` card on an otherwise
  open turn is a strong resume hint.
- Chapters: notes on the open chapter (`docs/chapters.md`) as human-legible
  state.
- Schedule jobs that fired while the app was down.

**Tiers** (fall through in order):
1. **Transcript-only** — always available. Inject a resume preamble as the
   first notice on wake: "You were interrupted during X — here's the last
   state," reconstructed from the transcript tail. The agent reads its own
   history and continues.
2. **Harness resume** — when the ACP backend supports session resumption
   (provider-dependent; check per-backend capability, don't assume), hand the
   harness its own session handle back and let it restore richer state than
   the transcript knows.
3. **Ask the user** — when the tail is ambiguous (two open turns, or the last
   action was user-initiated cancel), a card: resume, or start clean?

**Guardrails.**
- Crash-loop breaker: if the app restarted N times within M minutes, do NOT
  auto-resume — surface a card instead, or we resume into the crash that
  killed us.
- Resume is additive: it must never block startup or the next user message.
- One resume per interrupted turn, max — not a retry loop.

**Sizing guess:** tier 1 is a startup pass sibling to permission reconciliation
(`src/bun/index.ts:83-96` pattern) plus a preamble notice — S/M. Tier 2 is
per-backend and needs a capability flag — M/L, investigate first.

## Teams nits (from af2fea0 review)

- Case-variant team labels (`Reds` vs `reds`) make two sidebar sections but
  one routing team — normalize on save and display.
- `notePick` fires before delivery, so rotation advances on a bounce — move
  after successful deliver.
- `teams.json` never prunes stale persona ids / dissolved teams.
- `list_teammates` tool description doesn't mention teams exist.

## ACP follow-ups (from 381ecc0 review)

- Backend crash (`watchExit`) leaves permissions unsettled for up to 10 min —
  add `settleAllPermissions("cancelled")` in `watchExit`.
- Peer "waiting" marker not reset when a permission settles — cosmetic, but
  visible.
