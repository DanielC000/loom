# e5458ccd — boot-reconcile attributes a stale generation's own landing by CONTENT, never by the shared branch

## Narrative

Predecessor `21b53e6a` (round 2, Code Review `620da79c`) removed an earlier DB-only attribution attempt
for a stale generation's own unresolved `merge_request`, for two reasons (Majors #1/#2, recorded in that
card's own decision record): the trailer-matching tip could diverge from what actually landed whenever
main moved (a union merge, or a HELD branch's owed range), and on every BATCH landing (no trailer at
all); and the DB-only `merge_done` it filed carried the SHARED branch name, leaking into every reader
keyed on that branch and blind to generation (`isBranchHeld`, `buildLatestEventSeqMap`). That round left
attribution as a tracked follow-up — this card.

## Mechanism

`SessionService.resolveStaleGenerationOwnLanding` (sessions/service.ts) now attempts attribution before
falling back to the existing one-shot escalation:

1. **Candidate discovery** (`findAllLandedTrailerCommits`, git/worktrees.ts): every commit on main
   carrying a `Loom-Worker-Branch: <branch>` trailer, newest-first, with NO early break on the first/
   newest match (the shared branch name can carry more than one generation's own landing) and NO
   re-task guard (that guard assumes the branch still names the candidate's own live state, which is
   false here — the branch now belongs to a different generation).
2. **Solo-squash / union-chain verification**: for a candidate carrying `Loom-Landed-Tip` (a solo squash),
   `verifyReviewedTipChain` is called DIRECTLY against the stale row's own recorded `merge_request.detail.tip`
   — never via `reviewedTipVerdict`, which resolves the LATEST merge_request by branch name and would
   silently verify the CURRENT generation's own tip instead of the stale row's. `extraUnionBases` is always
   `[]`: no owedBase is persisted on `merge_request`, so a branch HELD at the stale row's own confirm time
   is a documented, accepted gap — it fails this check and escalates rather than risking a wrong attribution.
3. **Batch / no-Loom-Landed-Tip content match**: `recordedTipContentLanded` (git/worktrees.ts), the
   sha-parameterized sibling of `branchContentLandedInCommit` — diffs the stale row's own recorded tip
   against the candidate's own `Loom-Worker-Base` trailer (the landed base, a real commit sha — see
   `d62dad73`), never the LIVE branch ref (which now belongs to the current generation). Covers a real
   batch landing (every worker commit cherry-picked individually, no `Loom-Landed-Tip` at all) and a
   legacy pre-`cc9bce38` solo squash missing the trailer.
4. **The marker**: a successful attribution appends ONE `merge_done` event, `workerSessionId: <stale row's
   own id>`, `detail: { branch: null, repoKey, reconciled: true, staleGenerationAttributed: true,
   attributedLandedSha }`. `detail.branch` is deliberately `null`, never the shared branch string.

## Why `detail.branch: null` is sufficient — the full reader sweep

**Branch-scoped readers** (would alias the current generation if the real branch name were ever written —
excluded by construction, since a `null` branch never equals a real branch string, no reader code changes
needed): `Db.listEventsForBranch` (db.ts) — backs `isBranchHeld`'s retain/release scan (service.ts); `Db.
latestEventSeqForBranch` (db.ts, currently zero live callers); `Db.buildLatestEventSeqMap` (db.ts) — explicitly
`continue`s on a null `detail.branch` at the SQL/map-build level, not merely by convention — feeds Pass A's
`finalizedElsewhere` check and Pass A2's `hasTerminal`.

**Session-scoped readers** (correctly, desirably see the new marker — this is what makes the attribution
idempotent and resolves the stale row's own bookkeeping): `Db.buildWorkerEventPresenceMap` — keyed first by
`workerSessionId`; within the stale row's own entry, `mergeDoneKeys` gains the `(taskId, null)` key, which is
EXACTLY the key Pass A's own `alreadyFinalized` check already tests for a legacy no-branch row
(`sessions/service.ts`) — this is the idempotency mechanism: the next boot hits `alreadyFinalized &&
!worktreeOnDisk` and `continue`s immediately, never re-entering the stale-generation branch, no new app_meta
state needed. `Db.listEventsForWorker(id).some(kind==='merge_done')` raw scans — `worker_revive`'s own-landing
gate (now correctly allows reviving the stale row's transcript), `finishAlreadyMerged`'s `alreadyFinalizedBefore`
and `finalizeMerge`'s `hadPriorMergeDone` (both only ever reached BY those functions, which this attribution
path never calls for a stale row — inert here by construction, not coincidence). `report-resolution.ts`'s
`REPORT_RESOLVED_EVENT_KINDS`/`deriveAwaitingReview` — operates over one worker's own chronological events;
correctly resolves the stale row's own `worker_report(done)` out of "awaiting review" once it finds the
null-branch merge_done after it. `orchestration/idle-watcher.ts`'s `ORCH_ACTIVITY_KINDS` — counts
`managerSessionId` activity; the append uses the stale row's `parentSessionId`, so this registers as manager-
lineage activity. Accepted side effect, not a bug.

**Task-scoped readers** (the manager's own review concern, since the stale row shares its `taskId` with the
current generation by construction — a re-task is dispatched onto the SAME task). **Round 2 correction (Code
Review 72b64bc9, item 2): the original sweep below was INCOMPLETE** — it covered the daemon's own
`orchestration_events` readers but missed a task-keyed reader in the WEB package. The one authoritative "is
the task done" signal in the DAEMON is the `tasks` table's own `columnKey`/`mergedSha` columns, written ONLY
inside `finalizeMerge` (sessions/service.ts) — which this attribution path never calls for a stale row (same
Do-not as `21b53e6a`). `events_search`/`listOrchestrationEventsBounded`/`countOrchestrationEventsBounded`
(db.ts) DO filter by `task_id` directly, but they back only the read-only, human/agent-initiated forensics
tool `events_search` — showing the stale row's own null-branch attribution there alongside the current
generation's events is correct, desired forensic transparency, not a decision-driving leak. `gate_history`'s
`GATE_HISTORY_KINDS` (db.ts) does not include `merge_done` at all. `worker_list`'s `reportedProjection`
(mcp/orchestration.ts) is called per worker ROW (`w.id`), never deduped or grouped by `taskId` across rows.

**The reader the original sweep missed: `web/src/lib/attention.ts`'s `latestMerge` map.** It is keyed
`e.taskId || e.workerSessionId || e.id` over EVERY `merge_request`/`merge_done`/`merge_rejected` event across
every live manager's fetched stream, sorted chronologically — so a boot-time stale-generation attribution
`merge_done` (later than the current generation's own still-pending `merge_request`, since attribution runs
at a LATER boot) overwrites that key, and the current generation's live "MERGE REQUEST — awaiting review"
item (built from `latestMerge.values()`, ~line 308) silently stops surfacing for the rest of that task's
life. Fixed by skipping any `merge_done` carrying `detail.staleGenerationAttributed` when building the map
(~line 201), so it can never win that key over the current generation's own event. `auditReplay.tsx`'s
`detailLine` (~line 50) showed a blank line for this event's empty `branch` field — cosmetic, fixed to show
`attributedLandedSha` instead when present.

Verified in `worktree-recycle-alias-protection.mjs` fixtures M/Q (see "Tests" below): `listEventsForBranch
(branch, 'merge_done')` returns ONLY the current generation's own event, and `task.mergedSha` reflects only
the current generation's landing.

## Scope addition #2 — Pass A2 generation-blindness

Pass A2 (the pre-squash-era dangling-merge resolver) was itself generation-blind: a stale row sharing a
worktreePath with the current generation, with its own `merge_request` and a task that's independently
terminal (e.g. the current generation reported `noChanges:true` and a human moved the card), could reach A2's
own `merge_done` emission — keyed on `detail.branch: s.branch`, the SHARED branch — exactly the aliasing shape
this card's own attribution path exists to avoid. Fixed with the SAME `currentGenerationIds` check Pass A
already computes once per boot: A2 now skips any row that is not the current-generation owner (or a recycle-
lineage ancestor) of its own worktreePath, before any of A2's own qualifying checks run. Belt-and-suspenders
in most cases (Pass A, which runs first in the same boot, has usually already attributed or escalated the
row), but load-bearing for exactly the "current generation never filed its own merge_request" shape A2 itself
exists to catch.

## Round 2 (Code Review 72b64bc9, REQUEST-CHANGES)

1. **BLOCKING — scan the stored mainline watermark ref, never bare "HEAD".** The candidate scan called
   `findAllLandedTrailerCommits(…, "HEAD", …)`, unlike Pass A's own squash lookup (which resolves the
   watermark via `resolveMainlineWatermarkRef`/`mainlineRefCache` and SKIPS outright on an unreadable or
   unresolvable watermark — `docs/decisions/77b8319b-*.md`). A canonical checkout diverted off mainline
   could make a non-mainline trailer commit verify. Fixed: `attributeStaleGenerationOwnLanding` now
   resolves the SAME watermark via the SAME cache (threaded in from Pass A as parameters) before scanning,
   and returns `null` (escalate) on `"unreadable"` or an unresolvable ref — never falls back to bare
   "HEAD" either.
2. Web `attention.ts`/`auditReplay.tsx` — see the task-scoped-readers section above (corrected in place).
3. **`recordedTipContentLanded` diffs from the real merge-base, not `recordedBase` directly.**
   `recordedBase` is main's tip AT LANDING TIME, which can be ahead of X's own fork point if main moved in
   between — the original two-dot diff surfaced main's own unrelated changes too, so attribution only
   succeeded when main hadn't moved at all. Fixed to diff from `merge-base(recordedTip, recordedBase)`.
4. **Verify candidates OLDEST-first**, not newest-first, so `attributedLandedSha` can never name a
   coincidental later match over this worker's own true landing.
5. Fixture S now asserts Y's own worktree-GC'd/branch-reclaimed facts explicitly, not only the aggregate
   counts.

## Accepted gaps (carried forward from `21b53e6a`, and new)

- A stale generation whose branch was HELD at its OWN confirm time (an owed-range union) is not
  auto-attributed — no owedBase is persisted on `merge_request`, so `extraUnionBases` is always `[]`;
  escalates instead of risking a wrong attribution.
- A stale generation's genuinely pre-trailer-era landing (the original shape Pass A2 exists for) is not
  auto-attributed by this card's own candidate discovery (which only ever finds `Loom-Worker-Branch`
  trailer commits); escalates instead.
- A confirm-START signal to distinguish "review-only, never confirmed" from "crashed mid-confirm" (so the
  `[loom:merge-orphaned]` nudge stops false-firing on a worker whose review a manager simply looked at and
  re-tasked without ever confirming) is tracked as its own follow-up card, split out by the reviewing
  manager rather than built here.

## Do not

- Do not call `reviewedTipVerdict` (or any resolver that finds the LATEST `merge_request` by branch name)
  for a stale row's own attribution — it would silently verify the CURRENT generation's own tip. Call
  `verifyReviewedTipChain` directly against the stale row's own recorded tip.
- Do not use `branchContentLandedInCommit` (or any content check parameterized on the live branch NAME) for
  a stale row — the branch now belongs to a different generation. Use `recordedTipContentLanded`, which
  takes two already-resolved commit shas and never reads the branch ref.
- Do not ever write a stale generation's own attribution `merge_done` with `detail.branch` set to the real,
  shared branch name — always `null`. This is the ONE thing that keeps every branch-scoped reader
  (`isBranchHeld`, `buildLatestEventSeqMap`, `listEventsForBranch`) from aliasing the current generation's
  bookkeeping; see the reader sweep above before adding a new branch-scoped reader of `merge_done`.
- Do not add a new app_meta "attributed" tracking key for this outcome — the existing `alreadyFinalized`
  early-out (matching a null-branch `merge_done` via `workerEventPresenceKey(taskId, null)`) already makes
  this one-shot; a second tracking mechanism would be redundant state to keep in sync.
- Do not let Pass A2 process a row without first checking `currentGenerationIds` — a stale row reaching
  A2's own `merge_done` emission writes `detail.branch: s.branch`, the shared branch, unconditionally.

Tests: `packages/daemon/test/worktree-recycle-alias-protection.mjs` fixtures M (solo-squash/union-chain
attribution, now resolved instead of escalated — also the resolver proof for `deriveAwaitingReview` and
the task/branch-scoped-reader-safety checks), Q (batch-landing content-match attribution), R (two trailer
commits share the branch name — the all-candidates scan must not stop at the first/newest, unrelated
match), S (Pass A2 stale-row skip — scope addition #2), and N/P (unchanged controls: unattributable and
already-decided stale rows still escalate / no-op exactly as before).
