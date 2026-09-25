# 975c774b — a merge gate's verdict must describe a commit, not a worktree that was dirty or changed under it

## Do not

- Do not cache a `confirmWorkerMerge` verdict (pass OR fail) produced while the worker's worktree was dirty before the gate spawned or changed across it: it is classified `"worktree-dirty"` and is in `NEVER_CACHED_OUTCOMES`. "Unstamping" `gatedIdentity` alone is NOT enough — the registry falls back to the pre-forward `verdictIdentity` when the stamp is absent, so the classification veto is the load-bearing half.
- Do not squash a PASS whose worktree stamp changed across the run: refuse it (`gate_worktree_dirty`) before `beginSquash`. `mergeBranch` squashes the branch REF, so a pass earned by uncommitted files would land a commit that never passed.
- Do not invent a second definition of dirt: the check reuses `computeWorktreeGateStamp` / `gateStampsDiffer` (the same daemon-noise-filtered view `run_gate` and the reuse check use).
- Do not move the stamps out of `captureGatedTip` / the `runGateSeq` wrapper: every link (attempt 1, transient, single-file, resumed) spawns through them, so a new link cannot forget the check.

## Why

The gate runs IN the worker's live worktree (`runGateSeq(effectiveGate, worktreePath, ...)`); the worker's own pty is deliberately left alive across the gate (@decision 864e79fe); and before this card only the branch REF was stamped (`captureGatedTip`, `confirmGatedIdentity`). A live worker's uncommitted edit could flip the verdict and be discarded afterwards, leaving the verdict cached under an unchanged tip (fail), or squash a tip that only passed with the edit present (pass). Hermetic repro: `packages/daemon/test/merge-confirm-dirty-gate-verdict-cache.mjs` (RED on the pre-fix source: 12 assertions, its clean-tree controls green).

## Shape

Stamp right before each spawn (`captureGatedTip`), compare at settle (`runGateSeq` wrapper). Already dirty before a spawn → `GateWorktreeDirtyError`, caught at the `runExclusive` catch, refused up front, gate never spawned. Dirt at settle (or an unreadable stamp — fail closed) → `gateWorktreeChanged`: a FAIL keeps its rejection but goes unstamped and flagged, a PASS is refused. Both carry `gateWorktreeDirty:{phase,detail}` and classify `"worktree-dirty"`.

Retry links (Code Review on bc2f718a): once ANY link's gate has run in this op (`gateHasRun`), a later link's dirty pre-check is `during-gate`, not `before-gate` — it falls through with attempt 1's verdict, kill classification and `build_gate` row intact (refusing outright erased a gate that really ran). The flag is reset ONLY at the start of the transient link (it re-runs the WHOLE gate, so it can vouch for a now-clean tree); it stays sticky for the single-file and resumed links, which cover part of the suite. A tree already dirty, or unreadable, at confirm time is refused before the queue turn; the in-lane check is the backstop for edits arriving during the wait.

Scope of the confirm-time refusal: it is confined to paths that will actually SPAWN a gate. The dirt is recorded at the reuse decision but acted on only after the inert-skip decision (`!reuseResult && !inertSkip`): an inert (docs-only) merge runs no gate, so it has no verdict to contaminate and its squash reads commits, so it merges its committed content exactly as before this card (pinned by scenario `(DIRTY)` in `merge-gate-inert-diff.mjs`). A transient link whose pre-check throws never ran, so `gateRetried` is cleared and the rejection reads "retry not run: the worktree was dirty when it was about to start" (`retryNotRun:"worktree-dirty"` on the `merge_rejected` row) instead of "retried once, still failed".

A CLEAN head move (a commit landing mid-gate) is deliberately NOT flagged: 8b1fb28f's `confirmGatedIdentity` owns it (re-call re-gates, announced as identity-mismatch; pinned by `merge-confirm-verdict-cache.mjs`). Adjacent, unfixed: a PASS with a mid-gate commit still squashes that ungated commit.

## Known limit

A start/settle stamp cannot see an edit created AND removed entirely inside the gate window. Closing that needs the gate to run against an immutable snapshot (a clean checkout of the tip) or continuous sampling — neither was built; do not read this check as proving the gate saw exactly the committed tree.

## Measured false-positive source

`pnpm build` in a worker worktree leaves no non-ignored file (`git status --porcelain` identical before and after). The test suite's own writes into the worktree were not measured beyond that; a gate that leaves an un-ignored file would refuse its own pass, by design.
