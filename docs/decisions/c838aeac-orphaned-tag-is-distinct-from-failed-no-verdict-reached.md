# c838aeac — `[loom:gate-orphaned]`/`[loom:merge-orphaned]` is a DISTINCT tag from FAILED — no verdict was ever reached

## Narrative

Card c838aeac: when `reconcileOrphanedGateOps`'s durable-history recovery (see
`docs/decisions/7d492f8b-find-gate-op-events-is-an-unindexed-boot-only-scan.md`, §2) finds no
recoverable audit trail at all for a restart-orphaned row, that genuinely-unrecoverable branch is tagged
`[loom:gate-orphaned]`/`[loom:merge-orphaned]` — a DISTINCT signal from `[loom:gate-failed]`/
`[loom:merge-failed]` — because NO verdict was ever reached; the row never ran to completion in any
observable way. The old behavior reused the FAILED tag for this branch, which reads to a worker/manager
as "your gate/merge ran and failed" when the true state is "no gate/merge verdict exists at all, re-fire
it" — the exact "no verdict" vs "a verdict I didn't like" confusion this fix closes (`db.ts`'s
`pending_gate_ops` schema comment already names `orphaned-by-restart` as a non-verdict STATE; this closes
the gap between that state and the NOTICE TEXT describing it). The recovered-verdict branch is UNCHANGED
by this — it still emits the real `[loom:gate-done]`/`[loom:gate-failed]`/`[loom:gate-cancelled]`/
`[loom:merge-failed]`/`[loom:merge-cancelled]` vocabulary whenever a genuine verdict WAS recovered, so a
real failure still reads as a real failure. The nudge text also no longer asserts "daemon restart killed
this run" (an unverified mechanism this daemon never actually confirmed) — it states plainly that the
outcome could not be recovered, and invites a re-run.

## Do not

- Do not reuse the FAILED tag/vocabulary for a row with no recoverable verdict — "no verdict exists" and
  "a verdict came back failing" are different facts and need different tags, or a worker/manager reads a
  never-run op as a real failure.
- Do not assert a specific cause ("daemon restart killed this run") in an orphaned-tag nudge — this
  daemon never actually verifies that mechanism; state the honest limit (outcome unrecoverable) instead.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts`, above `reconcileOrphanedGateOps`: lines
6432-6443, as of main `055e96ce`. Relocated by card `c7ca6c08` (tranche 16); no wording changed, wrapped
source lines joined into a flowing paragraph and the `*` comment markers stripped.
