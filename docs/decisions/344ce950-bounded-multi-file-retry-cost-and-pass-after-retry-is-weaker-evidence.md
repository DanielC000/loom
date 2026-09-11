# 344ce950 — the single-file retry exists to avoid re-running the whole suite by hand, and a pass-after-retry is weaker evidence than a clean pass

## Narrative

The single-file retry (later extended to a bounded multi-file retry by card 67030bb9 — see that
card's own record, `docs/decisions/67030bb9-retrywarning-three-cases-corrected-present-on-fail-too.md`)
exists because of a MEASURED source of waste in the merge pipeline: a merge-gate failure narrowed to
a small set of identifiable, re-runnable test files that then pass together in isolation used to cost
a full second run of the WHOLE suite — the manager's only alternative was to re-fire
`worker_merge_confirm` by hand instead of the daemon retrying the narrow failure itself. Per card
67030bb9's own investigation, a MULTI-file failure used to be refused this retry OUTRIGHT, regardless
of whether every file in it would pass alone — the old `identifyRetriableTestFile` required exactly
one failing file.

THE NON-NEGOTIABLE PART (card 344ce950 §3): a pass-after-retry is WEAKER evidence than a clean pass —
an order-dependent or cross-test-pollution bug can pass in isolation and fail in the full suite, which
is exactly the class this single-file retry would otherwise mask. `retriedFile`/`retryPassed`
(stamped on the same `build_gate` event, and on the method's own return —
`ConfirmMergeResult.retryPassed`) are the ONLY thing keeping such a bug visible; the retry's result is
absorbed into `gateResult.passed` for the squash decision, but that stamping never erases the fact
that a retry happened. The single-file retry itself is never looped — it runs exactly once regardless
of outcome.

## Do not

- Do not treat a pass-after-single-file-retry as equivalent to a clean pass — a bug that only
  reproduces under full-suite conditions (ordering/pollution) can pass in isolation; keep
  `retriedFile`/`retryPassed` stamped so the weaker evidence stays visible downstream, never silently
  promote it to an unqualified pass.
- Do not loop the single-file retry more than once, regardless of outcome.
- Do not assume a multi-file failure can never use this retry — that was the old, now-replaced
  posture (see card 67030bb9's own record for the bounded multi-file design that replaced it).

## Source

Inline comments in `packages/daemon/src/sessions/service.ts`, `confirmWorkerMerge`'s BOUNDED
MULTI-FILE RETRY block (as of the tranche-50 worktree's HEAD before this extraction; current line
numbers, main moves under every tranche): the intro's cost/motivation clause (~12758-12762) and THE
NON-NEGOTIABLE PART clause (~12938-12945). Condensed and reworded, not verbatim.
