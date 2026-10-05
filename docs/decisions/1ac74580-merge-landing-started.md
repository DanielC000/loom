# 1ac74580 — `merge_landing_started`: fired once, immediately before the one irreversible landing write

## Narrative

Split out of `e5458ccd` (scope addition #1). Before this card, `resolveStaleGenerationOwnLanding`
(sessions/service.ts) could not tell "reviewed only, confirm never invoked" from "crashed mid-confirm" —
both left a stale worker's lifecycle at a bare `merge_request` with nothing after it, and the predicate
treated both as ambiguous (attempt attribution, escalate if nothing verifies). The false-positive
specimen: worker `3a7b77c6` on card `f900237d`, reviewed 11:23Z, re-tasked 11:27Z — never confirmed at
all, yet got a `[loom:merge-orphaned] … may need to be redone` nudge.

`merge_landing_started` closes the gap. It fires exactly once per real confirm attempt — solo or batch —
immediately before the ONE irreversible write that could make a landing exist:

- **Solo** (`confirmWorkerMerge`, sessions/service.ts): right before `merge = await mergeBranch(...)` (the
  squash commit), after the gate has run, landingPin resolved, the pre-squash reviewed-tip/gate-owed
  re-checks have passed, and the mainline-move tripwire has sampled. Every refusal before this point in
  the function either mutates nothing and returns a clean, synchronous result the caller already sees
  (quarantine, dirty-tree, reviewed-tip-moved at confirm-start, stranded work, canonical-dirt/overlap,
  title-HTML-entity, owed-range refusal, mainline-watermark-unreadable, isLoomHomeOrAncestor), or — for
  the ones that DO call the shared `evt()` closure — already logs its own `merge_rejected`. A crash
  anywhere before this point lands nothing, and the row is indistinguishable from (and should be treated
  identically to) review-only: no-op, never escalate. This single placement also covers the held/owed-
  range branch landing — `resolveOwedRange`'s union-merge (`mergeMainIntoWorktree`) runs much EARLIER in
  the SAME function call, as part of admission, well BEFORE the gate and this marker; it writes the
  WORKER'S OWN WORKTREE (a merge commit there, folding main into the worker's branch), never canonical
  main, so a crash during or right after it still lands nothing on main and correctly reads as review-only.
- **Batch** (`mergeBatchTracked` → `runBatchedMerge`, git/batch-merge.ts): assembly
  (`assembleBatchBranches`) and the gate run both happen only in the disposable batch worktree, never
  touching canonical main — a crash there lands nothing for ANY candidate. The one real, atomic mutation
  for the whole batch is `fastForwardCanonicalMain`. `runBatchedMerge` takes an optional
  `onBeforeFastForward?: (landed: BatchLandedBranch[]) => void` callback (mirroring the solo path's
  existing `onMergeGateRecorded` — "notify the caller right before the irreversible git write"), called
  once, synchronously, right after `gate.passed` is confirmed and right before the `fastForwardCanonicalMain`
  call. `mergeBatchTracked` passes a callback that appends one `merge_landing_started` event per candidate
  in `landed` (never `chosen`/`dropped` — a candidate dropped during assembly, or one that never reaches
  a passing gate, never gets this marker, exactly mirroring the solo rule).

Exactly-once is structural, not merely intended: `confirmWorkerMergeTracked` dedupes through
`PendingOpRegistry.attach()`, so `confirmWorkerMerge`'s body — and this marker's single call site inside
it — runs at most once per real op; the gate's own internal single-file/transient-kill retries live
entirely inside the earlier `if (gate)` block, well before this marker's placement, so they never cause a
second emission.

## `resolveStaleGenerationOwnLanding`'s predicate (sessions/service.ts)

```
const lifecycle = this.db.listEventsForWorkerKinds(s.id, ["merge_request", "merge_landing_started", "merge_done", "merge_rejected", "merge_cancelled"]);
const latest = lifecycle[lifecycle.length - 1];
if (!latest || latest.kind === "merge_request") return "no-op";       // review-only: never reached its own landing write
if (latest.kind !== "merge_landing_started") return "no-op";          // already a decided terminal outcome
// latest.kind === "merge_landing_started" ⇒ a landing write was attempted and never resolved ⇒ attempt attribution as before
```

`reviewedTip` can no longer be read off `latest` (which may now be the `merge_landing_started` event,
carrying no `tip`) — it's re-derived from the latest `merge_request` entry specifically within the same
`lifecycle` array.

## Reader sweep (mirrors `e5458ccd`'s own branch/session/task sweep)

- **Branch-scoped** (`isBranchHeld`, `buildLatestEventSeqMap`, `listEventsForBranch`): inert by
  construction — `detail` carries no `branch` field, and none of these readers query by this kind.
- **`DURABLE_AUDIT_EVENT_KINDS`** (db.ts): INCLUDED — must survive a session's own archival/cascade; the
  whole point is to outlive it for a boot-reconcile that may run long after.
- **`ORCH_ACTIVITY_KINDS`** (orchestration/idle-watcher.ts): INCLUDED, for consistency with its merge_*
  siblings (`merge_request`/`merge_done`/`merge_rejected`/`merge_cancelled`), all of which already count
  as "manager back at the wheel."
- **`GATE_HISTORY_KINDS`** (db.ts): EXCLUDED — not a gate-run event itself; no merge_* kind is in that
  list today.
- **`REPORT_RESOLVED_EVENT_KINDS`** (orchestration/report-resolution.ts): EXCLUDED — starting a landing
  write does not resolve "awaiting review"; only a real `merge_done` does (mirrors `merge_rejected`/
  `merge_cancelled`'s own exclusion there).
- **`EVENT_TRIGGER_EVENT_KINDS`** (shared/types.ts): EXCLUDED — routine bookkeeping, not an
  attention-worthy signal for a user automation (same posture as `merge_done`/`merge_cancelled`'s own
  exclusion).
- **`web/src/lib/attention.ts`'s `latestMerge` map** (`lib/fleet.ts`'s `buildLatestMergeMap`): CHECKED, not
  changed — it was ALREADY a fixed kind allowlist (`merge_request`/`merge_done`/`merge_rejected` only,
  filtering on `e.kind !==` each of those) before this card, so `merge_landing_started` is excluded by
  construction with zero web source changes. `packages/web/test/fleet.mjs` gained a regression-PIN test
  proving this (a stale generation's `merge_landing_started` never wins the key over a live current
  generation's `merge_request`) — it exists to catch a future WIDENING of that allowlist, not a bug this
  card fixed.
- **`auditReplay.tsx`'s `detailLine`/`eventTone`**: this ONE file DID change — given a one-line
  `detailLine` case (so the kind doesn't render blank) and added to `eventTone`'s amber set (in-flight,
  like its `merge_request` sibling).

## Pre-change DB (accepted gap, no backfill)

A row that was ALREADY sitting at "merge_request, nothing after" at the moment this code first boots has
no way to retroactively prove whether it was genuinely review-only or crashed after its own landing write
— no `merge_landing_started` was ever written for it either way, since the code that would have written
it didn't exist yet. Such a row is (mis)classified as review-only and skipped, rather than
attempted-attribution/escalated: a legacy row that genuinely crashed AFTER its own squash/fast-forward is
now no-op'd instead of attributed. Accepted rather than building migration/backfill machinery — mirrors
`e5458ccd`'s own "do not add a new app_meta tracking key" posture — because the blast radius is small: if
anything actually landed, Pass A's independent trailer-based detection already finds it regardless of
this card; if nothing landed, there's nothing to recover either way, only a missed advisory nudge. Bounded
to rows already ambiguous at the moment this code first deploys; every confirm attempt from that point on
always writes `merge_landing_started` (or a terminal event) before any landing write can occur.

**Edge case — crash, restart, then `worker_merge` reviews the SAME worker again before it's re-tasked:**
X's lifecycle becomes `[merge_request, merge_landing_started, merge_request]` — a later `merge_request`
appended AFTER the marker from the crashed attempt. The predicate reads `lifecycle`'s LAST entry, so this
later `merge_request` wins and the row reads as review-only again, no-op. This is correct by construction,
not a special case needing its own code: a human re-reviewing X is a real signal that supersedes the
stale, unresolved landing attempt — the SAME "latest wins" rule `21b53e6a`'s own decided-outcome check
already relies on (a `merge_cancelled` after a `merge_request` wins the same way).

## Known residual (not fixed in this branch — follow-up card `b4080777`)

A REFUSED batch fast-forward (`fastForwardCanonicalMain` returns `ok:false` — forfeited, diverted,
unverified, quarantined) leaves every candidate in that batch's `landed` set carrying its own
`merge_landing_started` with no terminal event yet, since `onBeforeFastForward` fires BEFORE the
fast-forward's own outcome is known (it has to, by construction — the marker must precede the write it's
named for). If that candidate is then re-tasked before a batch retry or solo fallback ever files a
terminal event for it, a later `resolveStaleGenerationOwnLanding` pass can still raise a false
`[loom:merge-orphaned]` on it — the exact failure mode this card otherwise removes, re-opened narrowly on
this one path. Not a regression (pre-card, the SAME row would have escalated too, just via the older,
cruder `hasMergeRequest`-only check) — a genuine residual gap this card does not close. Left for
follow-up card `b4080777` rather than fixed here, since closing it properly needs either a terminal event
on every batch-FF-refusal path per candidate, or widening the predicate's attribution attempt to try
harder on this specific shape — both out of scope for this round.

## Do not

- Do not emit `merge_landing_started` any earlier than the one irreversible landing write (the solo
  squash's `mergeBranch` call, or the batch's `fastForwardCanonicalMain` call) — an earlier emission
  re-creates the exact false "may need to be redone" escalation this card exists to remove (a crash
  before the write lands nothing, and is indistinguishable from review-only).
- Do not stamp a `branch` field on this event's `detail` — it must stay inert to every branch-scoped
  reader by construction, never by reader-side filtering.
- Do not read `reviewedTip` off `lifecycle`'s LAST entry once this kind exists — re-derive it from the
  latest `merge_request` entry specifically.
- Do not add this kind to `REPORT_RESOLVED_EVENT_KINDS` or `GATE_HISTORY_KINDS` — starting a landing write
  resolves nothing and runs no gate.
- Do not build backfill/migration machinery for the pre-change gap above — it is an accepted, bounded,
  one-time gap, not a defect to close.

Tests (only files this branch actually changed or added): `packages/daemon/test/worktree-recycle-alias-
protection.mjs` (modified — new fixture Y: review-only-never-confirmed; the marker added to every
pre-existing crashed-after-landing-write fixture, M/N/Q/R/S/T/U/V/W/X; N's idempotence assertion
corrected; unchanged decided-outcome controls P/O untouched), `packages/daemon/test/merge-landing-started-
emission.mjs` (new — exactly-once solo+batch, two refusal-writes-nothing shapes, the pre-squash
reviewed-tip-moved refusal with its own RED/GREEN placement proof, and an assembly-dropped-candidate
batch case), `packages/web/test/fleet.mjs` (modified — the `buildLatestMergeMap` regression-pin case).
`boot-reconcile*.mjs`/`batch-merge*.mjs`/`merge-confirm-verdict-cache*.mjs` were run directly as part of
the DoD (unaffected by this card, listed for the record) — not changed by this branch.
