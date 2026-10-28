# 627b38c7 — a `merge_batch` forfeits at GATE ADMISSION when main already moved, not only at the end

Before this card, `mergeBatchTracked` only discovered that canonical main had advanced since the batch was
cut at the very END of the gate — inside `fastForwardCanonicalMain`, called from `runBatchedMerge` after
the (possibly multi-minute) gate command had already run to completion. If a solo landing moved canonical
main anywhere in that window, the batch still paid for a full gate run it was always going to discard.

This card adds a SECOND check, at gate ADMISSION (inside `mergeBatchTracked`'s `runGate` closure, the
first statement of the `gateSemaphore.runExclusive` callback, before the real gate command is ever
spawned), re-reading canonical main's HEAD at that point. Admission to `GateSemaphore.runExclusive` for a
merge-kind descriptor carrying `repoPath` only happens once BOTH the cap slot and the per-repo
merge-admission guard (`activeMergeRepos`) are granted — `mergeRepoFree` refuses admission while any other
merge or worker holds the same `repoPath` — so by the time this check runs, no sibling squash can race the
read. The check reuses `fastForwardCanonicalMain` itself, never a copy: called with `targetSha ===
expectedBaseSha` it is a pure, read-only probe — the same canonical index lock, the same HEAD read + sha
compare (+ branch-divert check), short-circuiting to `{ok:true}` with zero git mutation when nothing moved
(never reaching the real `--ff-only` call).

## The false-red hazard this design avoids

A naive implementation would `return {passed:false, ...}` from the admission callback on a detected
forfeit. That return flows through the SAME `onSettle`/`beforeRelease` hook (`GateSemaphore.runExclusive`'s
fourth argument) the real gate's pass/fail result does, whose guard is `isMergeGateRed(settled) || ...`
— and `isMergeGateRed = !passed && !cancelled` would read the fabricated `passed:false` as a genuine RED
and wrongly call `recordMergeGateFailure`, feeding the merge-gate interval's `gateOwed`/
`ungatedSinceLastPass` state. An admission-time forfeit is not a test/build failure and must never do
this — the pre-existing END-of-gate forfeit never does, because in that case the gate itself genuinely
PASSED before the later fast-forward forfeited.

The fix: throw a new typed error, `BatchAdmissionForfeitError` (service.ts, local, mirrors
`GateCancelledError`'s shape), from the admission check instead of returning. `GateSemaphore.runExclusive`
documents that `beforeRelease`/`onSettle` is "Not run when the first `fn` throws (no verdict yet)" — a
throw from the very first admission attempt propagates straight past the retry chain and the onSettle
hook, hits `runExclusive`'s own `finally` (which releases the cap slot and the per-repo guard normally,
since `holdRepoGuardOnExit` was never called), and surfaces to the EXISTING `try {...} catch (err) {...}`
already wrapping the `runExclusive` call in `mergeBatchTracked`, right beside its existing
`GateCancelledError` branch.

## Scope: the sha forfeit only, not branch-divert

`fastForwardCanonicalMain` also performs a branch-divert check (the checked-out branch no longer matches
`expectedBaseBranch`) when the sha matches. This card's admission-time check deliberately does NOT act on
that outcome — a branch-divert (or any other non-`forfeited` `!ok` result, including a bare HEAD-read
failure) falls through unchanged to the real gate, exactly as it did before this card, and is still caught
by the unchanged END-of-gate `fastForwardCanonicalMain` call. Owner ruling (lead gen 451): keep this
narrowly scoped to the sha forfeit the card names; a branch-divert at admission time is a separate,
unrequested widening.

## The "skipped" verdict

The admission-forfeit branch records a `pending_gate_ops` verdict of `kind:"skipped"` (not `"pass"`/
`"fail"`) — the gate command genuinely never ran. This is the SAME no-gate-ran family `batchAllDropped`/
`batchHeadMoved`/`watermarkUnreadable` already use (card `92eeb319`), with its own `skipReason:
"forfeited-at-admission"`. Unlike those siblings, this one's `batchBranchCount` is the REAL assembled
`landedCount`, never 0 — this batch WAS fully assembled before the forfeit was detected, the same
"never falsify batchBranchCount" principle card `553ea58c` established for the end-of-gate forfeit.

Verified (grep across `sessions/service.ts`, `db.ts`, `orchestration/merge-gate-interval.ts`,
`orchestration/dist-importer-check.ts`) that the `"skipped"` verdict `kind` and the `pending_gate_ops`
table it is written to are read ONLY by `gate_status`/`gate_history` projection and display logic — the
merge-gate interval counter (`ungatedSinceLastPass`/`gateOwed`/`lastPassAt`/`lastPassSha`) lives in an
entirely separate table (`merge_gate_state`), written ONLY by explicit `recordMergeGateOutcome`/
`recordMergeGateFailure` calls, and the dist-importer advisory is fired ONLY from the solo ungated-landing
path. None of those three mechanisms read `pending_gate_ops.verdict` at all, and none of their explicit
recording calls is reachable from this admission-forfeit path (confirmed: it is gated on `result.ok` /
`result.gateFailed`, both false/absent for a `forfeited:true` result) — an admission-time forfeit is
therefore NOT counted as an ungated landing, a gated pass, or a red, by construction, not by a flag that
could be set wrong.

## Do not

- Do not return `{passed:false}` from the admission check instead of throwing — see "The false-red hazard"
  above; it would misclassify the forfeit as a genuine red via `isMergeGateRed` in the existing
  `onSettle`/`beforeRelease` hook.
- Do not widen this to act on `fastForwardCanonicalMain`'s branch-divert result at admission time — scoped
  to the sha forfeit only, by explicit owner ruling; branch-divert detection stays end-of-gate, unchanged.
- Do not fabricate a forfeit (or a pass) from a bare HEAD-read failure, a thrown `RepoQuarantinedError`/
  `CanonicalIndexLockPresentError`, or any other exception from the admission check's own
  `fastForwardCanonicalMain` call — fall through to the real gate unchanged (today's behavior), logging it.
- Do not zero `batchBranchCount` on the admission-forfeit verdict — it is the real, correct assembled
  `landedCount`; the forfeit is a separate, later fact (mirrors card `553ea58c`'s own ruling for the
  end-of-gate forfeit).
- Do not let the admission-forfeit branch in `runBatchedMerge` fall through to the generic
  `gateFailed: isMergeGateRed(gate)` computation — check `gate.detail?.forfeitedAtAdmission` FIRST and
  return the dedicated `forfeited:true` shape.
