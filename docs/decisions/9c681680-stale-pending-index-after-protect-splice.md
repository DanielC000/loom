# 9c681680 — `clearTokenFromPendingIndices` re-resolves every pending index fresh, never a stale precomputed one

QUESTION from Code Reviewer `3696bd80` (review of `58957b1e`, gen 436) — investigate-first, required
checkpoint confirmed before any edit, then fixed with the Lead's approval.

## The hazard

`clearTokenFromPendingIndices` (`packages/daemon/src/git/merge-quarantine.ts`) precomputed a plan keyed
by literal array INDEX, then mutated `pendingUnresolvedQuarantines` in a loop using those SAME stale
index numbers (`pendingUnresolvedQuarantines[idx]`) — never re-resolved via `indexOf`, unlike
`clearMergeQuarantineByKey`'s own sibling pending loop (fixed by `07e3ad30` to snapshot wrapper OBJECTS
and resolve `indexOf` fresh at mutation time).

The "remove" branch's own self-splice (`pendingUnresolvedQuarantines.splice(idx, 1)`) is safe in
isolation — descending processing order means it only ever removes an index ABOVE every not-yet-processed
target, per the function's own inline comment. But `deleteMergeQuarantineLatchByKey`, called from that
SAME branch for each owned armed key, can reach `protectOccupantContentBeforeDelete`'s own "both
`atFilenameIdx` and `atFinalBasenameIdx` match, same identity" branch — a REAL, already-exercised code
path (in the deliberately-mismatched-identity shape, by `merge-quarantine-cd5a3cf9-identity-gate.mjs`'s
own SCENARIO 4) — which does `pendingUnresolvedQuarantines.splice(atFinalBasenameIdx, 1)` at an
INDEPENDENT array position. When that splice lands BELOW a second, not-yet-processed target index, every
later iteration reads the WRONG, shifted wrapper under the FIRST wrapper's stale precomputed plan.

## Confirmed repro

Built a hermetic repro (4-entry array, 2 real clear targets at indices [1,2], a foreign identity Z
squatting both the armed key's own physical file AND its own canonical pending-divert name). Processing
the higher index first self-splices it out, then its own armed-key cleanup unions Z's two records
(correctly) and splices one of them out at index 0 — shifting the lower, not-yet-processed target down to
index 0, and the merged Z record down to index 1. The loop then reads the merged Z record instead of the
real target under the real target's own stale plan.

**Observed, pre-fix:** the real clear target was SILENTLY NEVER LIFTED (its own slot, now unreachable by
index, was never revisited) — a token-clear call that reported no error nonetheless left its own real
target fully quarantined. Z — a wholly unrelated identity, never a target of this clear — had its own
correctly-held quarantine DESTROYED as collateral: spliced out of the pending array AND swept from disk
(`sweepOwnLatchFileUnlessOwnedElsewhere`), unrecoverable even by reboot. This is worse than `07e3ad30`'s
own hazard (an in-process-only read inconsistency) — here the loss is durable.

**Second confirmed shape (the card's own secondary question):** with the misrouted plan a "reduce"
instead of "remove", and the misrouted wrapper ALSO a genuine reference twin (armed at its own
independent key), the reduce branch's own armed-key WRITE loop — per `64283e06`'s own posture ("ROUTED,
DEFENSIVE... unreachable today ONLY because the caller's own identity-scan already catches any active
twin first") — genuinely fires for it, reached through a wrapper `clearMergeQuarantineByToken`'s own
twin-filter never vetted (confirmed via a non-throwing `fs.openSync` intercept on the twin's own
armed-key latch path: 0 intercepts post-fix, a real intercept pre-fix).

## The fix

Mirrors `07e3ad30` exactly: the pre-pass's plan is keyed by wrapper OBJECT (`Map<PendingUnresolvedQuarantine,
...>`), never by index. The target wrappers are snapshotted once, before any mutation. In the mutating
loop:
- The "remove" branch resolves its own splice index via `pendingUnresolvedQuarantines.indexOf(pending)`
  fresh, immediately before the one splice call that uses it — a `-1` logs loudly (`console.error`),
  mirroring `07e3ad30`'s own "Do not" rule, never a silent no-op.
- The "reduce" branch needs no index at all: it mutates `pending.entry`/`pending.sourceFile` IN PLACE
  (mirroring `clearMergeQuarantineByKey`'s own reduce branch, decisions `64119847`/`b47cf261`) rather than
  reassigning `pendingUnresolvedQuarantines[idx]` — there is no stale-idx hazard left to close for this
  branch once the array itself is never written through an index here.

## The triage-note finding (Code Reviewer `0d6d8001`, review of `b47cf261`)

A separate, pre-existing, fail-CLOSED asymmetry: `clearMergeQuarantineByKey`'s own tied-twin "reduce"
branch called `rewriteOrphanLatchFilesAfterPartialClear(updated, …)` on write success — the STALE,
pre-union `updated` local variable — while its sibling `clearTokenFromPendingIndices` passes
`written.entry` (the ACTUAL write target) at its own equivalent call. After `b47cf261`, memory holds
`writtenTwin.entry`, not `updated` — so an orphan file reachable ONLY through `writtenTwin.entry`'s own
disk-unioned `orphanLatchFiles` (never present on `updated`, computed before any union) was never
narrowed by this sweep, keeping the just-dropped overlap token on disk. Tombstones are in-memory only, so
after a restart a cleared token could re-arm from that stale orphan file — a DELAYED lift, never a false
lift.

**Fix:** pass `writtenTwin.entry` when truthy, else `updated` — exactly mirroring the sibling's own call.

## Do not

- Do not key a pending-array mutation loop's own plan, or its own removal index, by a LITERAL INDEX
  number computed before the loop starts — a protect call reached from this same loop's own "remove"
  branch can splice an UNRELATED entry out of the array mid-loop, at a position that shifts every later,
  not-yet-processed index onto a DIFFERENT wrapper. Key the plan by wrapper OBJECT and resolve any index
  this loop still needs via `indexOf` fresh, immediately before the one call that uses it — exactly
  `07e3ad30`'s own rule, generalized to this sibling function.
- Do not assume "descending processing order" alone makes a pending-loop's own stale index safe — it
  only protects against THIS loop's own self-splice (which always removes the CURRENT, already-reached
  index); it does nothing against an INDEPENDENT splice a protect call triggers at some other position in
  the same array, which can land below a not-yet-processed target regardless of processing order.
- Do not assume `64283e06`'s "ROUTED, DEFENSIVE... unreachable today" posture for a reduce branch's own
  armed-key write loop stays true under every future change to the SAME function — it was unreachable
  specifically because the caller's own twin-filter was trusted to vet every index this loop would ever
  see; an index-shift bug silently broke that trust without touching the filter itself. Re-verify the
  underlying assumption, not just the filter's own code, before relying on "unreachable" language again.
- Do not reassign `pendingUnresolvedQuarantines[idx] = {...}` in a function that mutates a SNAPSHOTTED
  wrapper object by reference — mutate the wrapper's own fields in place instead (`pending.entry = ...`),
  mirroring `clearMergeQuarantineByKey`'s own reduce branch (`64119847`/`b47cf261`); this removes the
  index-staleness hazard for that branch entirely rather than merely working around it.
- Do not pass a reduce branch's own stale, pre-union local variable to
  `rewriteOrphanLatchFilesAfterPartialClear` — pass whatever `writePendingDivertFile` ACTUALLY wrote
  (`writtenTwin.entry`, falling back to the stale variable only when the write itself failed), or an
  orphan file reachable solely through the union's own `orphanLatchFiles` is silently never narrowed.

## Verification

- `merge-quarantine-9c681680-stale-index-shift-guard.mjs` — SCENARIO 1 (the primary hazard: real target
  silently unlifted, unrelated identity destroyed in-memory and on disk) and SCENARIO 2 (the active-twin
  sub-case: the armed-key write loop reached via the shift, detected via a non-throwing `fs.openSync`
  intercept). Proven RED-before (6 real `FAIL`s across both scenarios, including the SCENARIO 2 intercept
  count) / GREEN-after / byte-identical restore via `negative-control.mjs --ref HEAD`.
- `merge-quarantine-9c681680-reduce-branch-orphan-rewrite-target.mjs` — the triage-note finding (a tied
  twin's own stale-marked sourceFile unions in a foreign `orphanLatchFiles` reference `updated` never
  carried; the folded orphan file's own on-disk tokens survive stale pre-fix, are correctly narrowed
  post-fix, confirmed durable across a real reboot). Proven RED-before / GREEN-after / byte-identical
  restore via `negative-control.mjs --ref HEAD`.
- Also fixed in passing (nitpicks from the same review): `2dd97aaa`'s own record merged two overlapping
  Do-not bullets about this exact `writeMergeQuarantineLatch`/`writePendingDivertFile` split into one, and
  dropped a stale "see the Follow-up section below" pointer (the auto-injected guard extract carries only
  the Do-not section, which sits ABOVE any Follow-up section, so the pointer was dead text at the one
  place a reader actually sees it). `merge-quarantine-58957b1e-armed-latch-stale-mark-union.mjs`'s own two
  "*** THE BUG ***"-labelled in-memory checks were relabelled "(invariant)" (confirmed, via
  `negative-control.mjs --ref 935cb1824~1`, that both PASS even pre-fix — they exercise the IN-MEMORY
  reduction, a separate code path from the ON-DISK union this card's sibling fixes) and its header's
  "SCENARIO 3" was renamed (it names a third, NOT-independently-reproduced site — no test block exists for
  it). That same test's `freshRepo()`, and `merge-quarantine-b47cf261-reduce-branch-twin-resync.mjs`'s own
  `freshDir()`, now `registerForCleanup` every directory they mint instead of leaking it.
