# b798e706 — Admission-time re-derivation of a queued merge's gate base

## Narrative

`gateBaseMainHead` (the canonical main sha a merge's tree was unioned against) is captured at the pre-admission union-merge, or, on the preLanded path, a plain HEAD read. The gap to this op being ADMITTED past the gate semaphore is the queue wait — unbounded at `maxConcurrentGates` > 1. Before this card, a queued merge ran its full gate against that pre-queue base and self-aborted at squash time (`gateBaseInvalidated:true`) the moment main had moved AT ALL during the wait, forcing a manager re-confirm that re-paid the entire gate cost. `reunionAtAdmission` closes the common case: re-checked the instant the op is admitted (top of `fn`, before the gate spawns) — unmoved main is a no-op, byte-identical to before; if moved, re-union against the fresh tip and advance `gateBaseMainHead` to what was actually unioned. Decided ONLY WHEN MOVED: `mergeMainIntoWorktree` short-circuits to two cheap git reads when nothing changed but IS a real write otherwise, so the common uncontended case touches nothing.

Scoped to the union producer only (`!preLanded`): the preLanded producer's `gateBaseMainHead` pairs with `gateBaseBranchHead` (a narrower proof) to keep a pure re-confirm idempotent, and re-unioning there would defeat skipping the union (protecting `ALREADY_MERGED` classification). The worktree is reaped first (best-effort, same guard as the pre-gate union reap) — an escaped watcher/build child re-attached during the wait would otherwise fail this write with a spurious EPERM, misreported as a git failure.

A CONFLICTING re-union throws `AdmissionReunionFailedError` — caught alongside `GateCancelledError`, rejecting with a defined outcome (`[loom:merge-rejected]` + `merge_rejected`) rather than vanishing silently or proceeding on stale content; squash is never reached. It mirrors `GateCancelledError`'s shape and differs from `gateBaseInvalidated` (a benign staleness race reported at squash time, see [[eda70da6-gate-base-re-verification-and-the-toctou-closed-squash-target]]) — a real git failure hit while CLOSING the gap, not the staleness itself. Its rejection wording (Code Review finding) must not blame "main advanced" for a non-conflict failure: only `union_conflict_at_admission` proves a content collision; `union_merge_failed_at_admission` covers everything else `mergeMainIntoWorktree` can fail on (a failed HEAD/merge-state read, or the write erroring for an unrelated reason, e.g. a lock the reap missed) — asserting causation there would misattribute the failure.

Residual race, documented not closed (mirrors the reuse path's own TOCTOU note elsewhere in this method): a landing at the exact admission instant, before the gate's own squash-lock acquisition, can still invalidate the base. `requireCanonicalHead`'s in-lock re-check at squash time catches that window fail-closed, as always; this only shrinks the stale-base window for causes OTHER than a same-repo sibling's own squash (below).

**What this does NOT close, at the time it landed** (full walkthrough: [[92e960d1-per-repo-merge-admission-guard]], same gap from the semaphore side): the per-repo admission guard used to free the MOMENT a running merge's gate settled, before that merge's own squash — a same-repo sibling B, admitted right after A's gate settles, could read main as a no-op (A hasn't squashed yet), run its own gate, then see A's squash land mid-run, reaching squash-lock with a `gateBaseMainHead` never re-checked past admission — `requireCanonicalHead` still self-aborted as before. This card closed main moving during the wait for any OTHER reason (an out-of-band/GitWriter commit, queueing noise, an already-landed sibling squash) — not the sibling-squash race, which needed holding the guard across the squash phase too: closed for real by `c24dd48a` (`holdRepoGuardOnExit`/`beginSquash`/`endSquash`), now invoked on a passing gate.

Applied identically on the auto-retry: a separate, later admission whose per-repo guard is released and re-acquired between attempts, so `reunionAtAdmission` runs independently rather than trusting the first attempt's value. Timing-profile note for `gate_queue`/`idleMs` readers: this runs INSIDE the gate's slot, before `runGateSeq` is invoked, so `idleMs` can already grow right after admission with no gate-step output yet — expected, bounded by this function's own git calls; read a small, non-growing `idleMs` as this window, not a stall.

## Do not

- Do not hold the lock across the gate run, or re-run the gate once admitted — in-admission re-check + re-union is the intended shape.
- Do not re-union unconditionally — only when main actually moved; the common case stays a no-op write-wise.
- Do not re-union on the preLanded producer — its `gateBaseMainHead`/`gateBaseBranchHead` pairing keeps a pure re-confirm idempotent.
- Do not assert "main advanced" as cause of a `union_merge_failed_at_admission` rejection — only `union_conflict_at_admission` earns it.
- Do not treat this as closing the same-repo-sibling-squash race — needed the later `c24dd48a` fix.

## Consequences

A queued merge no longer pays a full gate run against a base invalidated by ordinary main movement during the wait (other than the sibling-squash case, closed by `c24dd48a`). A failing re-union always produces a defined rejection, never a silent vanish or proceed on stale content.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts`: `AdmissionReunionFailedError`'s class doc (~1751), the "ADMISSION-TIME RE-DERIVATION" block above `reunionAtAdmission` (~12446), "REAP BEFORE THIS SECOND UNION TOO" (~12529), "REJECT-ON-ADMISSION-REUNION-FAILURE" (~12653), and the retry site's pointer (~13139), as of this tranche's HEAD before extraction. Condensed, not verbatim: lines joined into paragraphs, comment markers stripped, no wording changed beyond joining.
