# 0d372516 — a failed batch rollback aborts the whole assembly, but is NEVER the same signal as `quarantined`

Found during Full review lane 1 (card `2785fbc2`, M3): `landBranchCommitsIndividually`'s `rollback()`
helper (`git/batch-merge.ts`) only promoted a failed `reset --hard batchHeadBefore` to a typed abort signal
for `RepoQuarantinedError`/an unconfirmed tree-kill. Any OTHER reset failure (a plain timeout, a Windows
file lock, a `CanonicalGitRefusal`) fell into a generic catch that only *sometimes* re-probed the tree, and
even when it did, left no typed flag — just a string folded into `reason`. `assembleBatchBranches` only
stops its loop on a typed `quarantined` flag, so this failure class was pushed to `dropped` and the loop
`continue`d onto the next candidate against a worktree never actually verified clean. If an earlier
candidate had already landed, `runBatchedMerge` would then proceed straight to `runGate` against that
unverified base.

The fix adds a second, parallel typed signal — `rollbackUnverified` — set whenever the post-rollback
probe (HEAD/dirty/CHERRY_PICK_HEAD) cannot confirm the worktree is back at `batchHeadBefore`, run
UNCONDITIONALLY after any non-quarantine-worthy `reset --hard` outcome (whether or not it threw — a
non-throwing reset is not itself proof the tree is clean).

## Do not

- Do not conflate `rollbackUnverified` with `quarantined` anywhere in this chain (`LandResult` →
  `BatchAssembleResult` → `runBatchedMerge`'s return). They carry different consequences downstream:
  `quarantined` means the CANONICAL repo may still be under mutation, so `mergeBatchTracked`
  (`sessions/service.ts`) deliberately starts NO per-candidate fallback and leaves the batch worktree on
  disk for a human. `rollbackUnverified` means only this ONE, about-to-be-discarded batch worktree is in
  an unverified state. Precisely: the batch worktree shares canonical's ref/object store (same `.git`),
  but every mutating git call in the assembly path (`boundedMergeGit(batchWorktreePath, deps)` /
  `killableCanonicalRaw(batchWorktreePath, ...)`) targets ONLY that worktree's own branch
  (`loom/batch-${opId}`, cut from its own throwaway taskId) — never mainline, the canonical checkout, or
  its index — and `fastForwardCanonicalMain` (the one call that does touch canonical) is never reached
  once this flag is set. So `runBatchedMerge` must return a plain `ok:false` (no `quarantined`) for this
  case, letting `mergeBatchTracked`'s existing generic `if (!result.ok)` branch run the REAL per-candidate
  solo fallback over every original candidate — exactly like an ordinary RED gate or forfeit.
- Do not skip the post-rollback verification just because `reset --hard` itself didn't throw — a
  "successful" reset call is not proof the tree is clean; always verify HEAD/dirty/CHERRY_PICK_HEAD
  against `batchHeadBefore` regardless of whether the call threw.
- Do not route `rollbackUnverified` through `assembleBatchBranches`'s ordinary per-candidate `continue` —
  it must stop the whole loop immediately, like `quarantined`, since no candidate landed after this point
  can be trusted against an unverified base.

## Round 2 (Code Review 17c760cc) — the gate-op tombstone must settle honestly, not bare

Round 1 shipped `rollbackUnverified` all the way to `runBatchedMerge`'s `ok:false` return, but
`mergeBatchTracked`'s own `onSettle` (sessions/service.ts) never learned about it: it only recognizes a
no-gate-ran outcome via `batchAllDropped` (`!batchGateRan && result.landed.length === 0`). A
rollback-unverified batch with `landed.length > 0` (an earlier candidate landed before the one whose
rollback failed) wrote a BARE settled row — no verdict, no reason — contradicting the tombstone's own
"every exit settles it" comment. And with `landed.length === 0`, `batchAllDropped` fires instead and
`gate_status` falsely reports `skipReason:"all-candidates-dropped"` (implying every candidate was simply
dropped at assembly and individually confirmed), when in fact assembly ABORTED early and the remaining
candidates were never even attempted.

The fix adds a typed `RunBatchedMergeResult.assemblyAborted: "rollback-unverified"` field (never inferred
from `reason` text) and a dedicated `onSettle` branch, checked BEFORE the `batchAllDropped` check so it
wins regardless of `landed.length`: `kind:"skipped"`, `skipReason:"assembly-aborted-rollback-unverified"`,
`batchBranchCount:0`, `batchLanded:false`.

## Do not (2)

- Do not let a new no-gate-ran batch outcome reuse `batchAllDropped`'s `skipReason:"all-candidates-dropped"`
  — that string specifically means every candidate was dropped (never attempted together at all); an
  assembly abort stopped the loop EARLY, so some candidates may be entirely unaccounted for, not just
  dropped.
- Do not gate the new `onSettle` branch on `result.landed.length === 0` — `assemblyAborted` can fire with
  candidates already landed in the (discarded) batch worktree; check the typed field directly, and check
  it before `batchAllDropped` so it is never shadowed.
