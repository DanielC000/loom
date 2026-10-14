# 92eeb319 — a `merge_batch` op's durable tombstone is minted at the TOP of its closure, before any work; an all-dropped batch settles `"skipped"`, never a bare row

## Narrative

Filed by lead `gen 373` (2026-09-25) from Code Reviewer `f28cb9be`'s review of `42daa283`. The reviewer's
M1 repro re-fired `merge_batch` after a retain; the re-fire dropped BOTH candidates at assembly (one an
empty cherry-pick, one an unresolvable tip) and never reached `runGate` at all, so its own per-branch
`worker_merge_confirm` fallback ran instead. `gate_status(<that opId>)` still read `state:"never_existed"`
even though the op had demonstrably existed and done work — because the op's durable `pending_gate_ops`
row (the tombstone card `be260976` introduced) was, at the time, minted only once the batch actually
reached the `runGate` closure. A batch whose candidates are all dropped never reaches that point, so it
was never resolvable at all.

Introduced by commit `5bf39d97f` ("mint the batch tombstone up front so gate_status resolves an
all-dropped merge_batch"), landed as part of this card alongside `a657a37c` on 2026-09-26.

## Decision

The tombstone (`this.db.insertPendingGateOp(...)`, `sessions/service.ts`'s `mergeBatchTracked`) is minted
**once, at the very top of the op's closure** — before the worktree is cut, before assembly, before the
watermark-pin read, before `runGate` is ever reached. Every exit path of the closure settles it:
`onSettle` fires on every completion and either writes the real `batchGateVerdict` (when `runGate`
genuinely ran) or **synthesizes** one for every no-gate-ran exit, keyed by `skipReason`:

- `"all-candidates-dropped"` — every candidate was dropped together during assembly and never reached
  `runGate`; each went to its own `worker_merge_confirm` fallback instead (read that op's own
  `gate_status` for whether it landed).
- `"assembly-aborted-rollback-unverified"` (card `0d372516`, round 2) — assembly stopped EARLY because a
  candidate's own post-rollback probe could not confirm the worktree was clean; some candidates may never
  have been attempted at all, which is why this is a distinct reason from the one above, not a variant of
  it.
- `"watermark-unreadable"` (card `ba663984`, round 3) — the stored mainline-watermark record failed to
  parse or its read threw, refusing the whole batch before any worktree is even cut.
- `"canonical-index-lock-present"` (card `e7a88047`) — the same pre-cut-refusal shape, for a
  `.git/index.lock` already present in the canonical repo.

Each of these settles as `outcome:"skipped"` (never `"pass"`/`"fail"` — no gate ever ran) with
`batchBranchCount:0, batchLanded:false`. `admittedAt`/`totalDurationMs` are stamped from this top-of-closure
mint instant, so for a batch op they now also cover the worktree cut and assembly, not just the gate
itself — `gate_history`'s own `durationMs`/`steps` (the gate run) and `admissionWaitMs` (semaphore
hand-off → admission) are unaffected by this and stay scoped to the gate alone.

`surfacedPending` is set `false` on this tombstone, deliberately: `reconcileOrphanedGateOps` only acts on
rows that are `surfaced_pending=1`, and a surfaced "merge" row takes the merge-orphaned branch, which
nudges `worker_merge_confirm` — wrong advice for a batch op with no single worker/branch. A crash between
mint and settle does not leave the row pending forever either: `reconcileUnsurfacedPendingGateOps` (card
`7239c712`) marks it `orphaned-by-restart` at the next boot; the only cost is that no nudge is pushed for
it.

## Do not

- Do not mint a `merge_batch` op's `pending_gate_ops` row anywhere but the top of its closure, before any
  worktree cut, assembly, or gate call — minting it later (e.g. only inside the `runGate` closure) leaves
  an all-dropped batch permanently unresolvable by `gate_status` (`never_existed`), the exact defect this
  card fixed.
- Do not add a new pre-worktree-cut (or pre-gate) early exit to `mergeBatchTracked` without also adding its
  own branch to `onSettle`'s verdict synthesis — a settle with no matching branch writes a **bare row**
  (`batchGateVerdict` stays `undefined`), which `db.ts`'s own `PendingGateOpVerdict.skipReason` doc calls
  out as the exact violation `ba663984`'s round 3 had to fix after missing it for the watermark-unreadable
  refusal.
- Do not map any of these no-gate-ran outcomes to `"pass"` — `"skipped"` is a distinct outcome
  (`a228dfb5`'s rule, extended here to the batch's own no-gate-ran shapes); the candidates' own solo
  `worker_merge_confirm` ops may still have landed independently of this batch op, so read each one's own
  `gate_status` rather than inferring success or failure from the batch op's outcome.
- Do not fold `"all-candidates-dropped"` and `"assembly-aborted-rollback-unverified"` into one `skipReason`
  — the first means every candidate was attempted together and dropped; the second means assembly stopped
  EARLY, so some candidates may never have been attempted at all. Check `batchAssemblyAborted` BEFORE
  `batchAllDropped` in `onSettle` (round 2) so the narrower case is never shadowed.
- Do not set `surfacedPending:true` on this tombstone to make it "more visible" — it would route a batch
  op through the merge-orphaned-branch boot-reconcile path, which assumes a single worker/branch and gives
  wrong advice for a batch.

## Related

`be260976` (introduced the durable tombstone itself, at its original, later mint point) · `42daa283` (the
review whose specimen surfaced this gap) · `0d372516` (the assembly-aborted-rollback-unverified sibling
reason) · `ba663984` (the watermark-unreadable pre-cut refusal, and round 3's "never a bare row" fix).
