# b03e636c — the kickoff-confirm escalation is re-armed at boot-reconcile, before any continuation nudge

Full mechanism and rationale: `8882e2ca-kickoff-confirm-window-is-announcement-only.md`'s own
"Follow-up (card `b03e636c`)" section — not restated here. This record exists because the comment
taxonomy wants one record file per id; the narrative lives on the card this one closes a residual of.

In short: `armKickoffConfirmRecheck`'s one-shot escalation timer (8882e2ca) is in-memory only and lost
across a daemon restart. This card re-arms the escalation at boot, from a durable `origin:"kickoff"`
marker on the parked `session_message_gave_up` event, evaluated BEFORE `resumeFleetOnBoot` composes any
continuation nudge — and adds a `kickoff_confirm_escalated` durable marker so the escalation itself
becomes auditable and never double-fires for the same root across repeated restarts. (Originally scoped
to taskless workers only, on the belief that `tickIdleWorkers` already covered a tasked worker's loss —
card `7970db77`, see its own section below, found that belief false and widened this to every worker.)

## Fix round (Code Review ad92070b) — two blocking Majors

1. **The immediate-park branch (`handleKickoffGiveUpExhausted`'s `else` arm — the window had already
   elapsed by park time, the COMMONEST shape for an ordinary-sized kickoff) never recorded the
   `kickoff_confirm_escalated` marker**, even though it sends the terminal notice right away. A later
   restart would re-send the same notice via `escalateParkedKickoffAtBoot` (finding the chain still
   "unresolved") AND suppress that worker's normal continuation nudge. Fixed: it now calls
   `recordKickoffConfirmEscalated(..., "immediate")` itself, widening that method's `source` union
   (renamed from `"park"` to `"immediate"` by card 397ff972's own fix round, below — both the
   immediate-park branch and the boot path are states OF a park, so "park" didn't distinguish which
   site fired).
2. **The boot path lacked the live siblings' own discriminators**, so it could strand a HEALTHY worker:
   `turnSeq` only counts COMPLETED turns, so a kickoff that DID land, whose confirming hook simply never
   arrived, reads `turnSeq:0` for the ENTIRE duration of its (possibly long) first turn — exactly like a
   genuinely dead one. A restart mid that turn would escalate "broken" AND suppress the continuation
   nudge needed to resume it. `escalateParkedKickoffAtBoot` now stands down on discriminators, the SAME
   ones its live siblings already use: a non-empty on-disk engine transcript; any `worker_report` ever
   recorded; queued pending direction in the restart intent's own `pending` snapshot (`hasQueuedPending`,
   threaded in from `resumeFleetOnBoot`) — plus two more busy signals added by card 397ff972's own fix
   round, below.

Two minors fixed alongside: `notifyManagerOfIdleWorker` now returns an `IdleWorkerNotifyOutcome`
(`"broken-spawn" | "never-completed" | "sent-other" | "none"`) so the ORIGINAL timer's fired callback
records the marker ONLY on an actual `"broken-spawn"` send (it used to record unconditionally, even when
the classifier silently no-opped or sent a differently-worded notice); and the boot escalation's
lost-draft clause is now third-person ("worker `<id>` had an unsent composer draft…"), since its
recipient is the MANAGER, not the worker that lost the draft — `DRAFT_LOSS_NOTE` is written
second-person for the opposite audience and was never meant for this call site.
`recordKickoffConfirmEscalated` also now takes the session's real `taskId` instead of hardcoding `null`.

Discriminator (a) (the transcript read) was verified to actually matter, not merely present: commenting
it out of `escalateParkedKickoffAtBoot` and rebuilding turned exactly its own test case RED (3 failing
checks, `packages/daemon/test/kickoff-confirm-boot-rearm.mjs`, case 7a) with every other case unaffected;
restoring it returned to green.

## Fix round 2 (Code Review 397ff972) — a second, independent CR reproduced the same two Majors

Three more additions, found against real dist:

A. **Two more stand-down discriminators**, same shape as fix round 1's three: the PERSISTED `w.busy`,
   and `hasBusyAtCapture` — the RestartResumeEntry's OWN captured `busy` flag (restart.ts:79), a SECOND,
   INDEPENDENT busy signal threaded in from `resumeFleetOnBoot`'s own call site (`e.busy`). Reproduced
   against real dist: a resume entry with `busy:true` still got wrongly escalated (worker queue empty,
   one broken-spawn notice) without this check — covered by test case (8b), the exact reproduction
   shape (session row itself `busy:false`, only the captured flag set). All checks in
   `escalateParkedKickoffAtBoot` are now ordered cheapest-first, with the disk-reading transcript check
   LAST: taskId/parentSessionId guard → turnSeq → persisted busy → captured busy → queued pending →
   worker_report (DB query) → transcript (disk I/O).
B. **A park whose own notice the live path already suppressed as moot
   (`detail.noticeSuppressed:true`, `suppressMootParkNotice`'s own mechanism — e.g. superseded by a
   newer directive) must never be resurrected at boot.** `escalateParkedKickoffAtBoot` now stands down
   on that flag too, right after finding the parked chain. Covered by test case (9).
C. **Test (3)'s old `continuationCount === 0` check (filtering the MANAGER's own queue for "Continue
   your assigned task" text) could never fail** — that text never routes to the manager at all, only to
   the worker. Dropped; the real assertion (the worker's own queue is empty) already covers it.

## Do not

- Do not call `notifyManagerOfIdleWorker`/`pastBrokenSpawnHoldoff` from the boot escalation path
  (`escalateParkedKickoffAtBoot`) — both key their holdoff off the LIVE pty's `liveStartedAt`, which a
  fresh resume just reset to "now"; calling them here reads as "not past the holdoff yet" and silently
  suppresses the notice. Use the dedicated `buildKickoffNeverConfirmedBrokenMsg` wording instead.
- Do not compute the boot escalation AFTER `resumeFleetOnBoot`'s continuation nudge (or after
  `replayPending`'s own drain) — the nudge draining can itself start the worker's first turn, flipping
  `turnSeq`/`hasFirstTurnStarted` true and permanently hiding that the ORIGINAL kickoff never landed.
  Decide from the persisted pre-resume row, first.
- ⛔ **SUPERSEDED by card `7970db77` (see its own section below) — do NOT re-add a `taskId` bail.** This
  used to claim `tickIdleWorkers` already covered a tasked worker's loss. FALSE — see that card's own
  section for the reachability evidence. Code Review correction: a double notice DOES exist after this
  widening (a boot escalation suppresses the continuation nudge, so the worker never starts a turn, and
  `tickIdleWorkers` later independently classifies it `broken-spawn` on its own periodic cadence) — but
  this is AT PARITY with the live immediate-park path's own pre-existing behavior (same unread marker,
  same residual), not a new regression; see the card's own section for why no classifier fix belongs here.
- Do not key the boot re-arm on `turnSeq === 0` alone, with no marker check and no discriminator check —
  a kickoff still mid its give-up ladder (not yet parked) also reads `turnSeq === 0`, and so does a
  HEALTHY worker mid (or just past) a long first turn the kickoff genuinely landed for; arming the
  escalation on `turnSeq === 0` alone would fire on either.
- Do not skip any of the discriminators (persisted busy / captured busy-at-capture / queued pending /
  any worker_report / non-empty transcript) when adding any future boot-reconcile escalation of this
  shape — `turnSeq:0` is NOT sufficient evidence of "never confirmed" on its own; see the Fix rounds
  above for the incidents this closes.
- Do not reorder the discriminator checks without keeping the disk-reading transcript read LAST — it is
  the most expensive of the set, and the cheap field/param reads should rule out the common case first.
- Do not resurrect a parked chain whose own notice the live path already marked
  `detail.noticeSuppressed:true` — that decision (duplicate-parked / superseded-by-newer-directive /
  confirmed-after-park) was already made; boot must honor it, not override it.
- Do not add `origin:"kickoff"` to `handleGiveUpExhausted`'s (the GENERIC, non-kickoff) give-up events —
  additive to the kickoff path only, by design; the generic path is untouched.
- Do not skip appending `kickoff_confirm_escalated` from ANY of the three sites that can send the
  terminal notice (the immediate-park branch, the original timer, or boot) — all three must record it,
  or a later restart can re-send the same notice for a root that was already escalated.
- Do not record `kickoff_confirm_escalated` from the timer's fired callback unconditionally — gate it on
  `notifyManagerOfIdleWorker`'s own returned outcome being exactly `"broken-spawn"`; that classifier can
  no-op entirely or send a differently-worded notice, and recording regardless would mark a root
  "escalated" when nothing was ever sent.
- Do not reuse the second-person `DRAFT_LOSS_NOTE` verbatim for a notice sent to the MANAGER — it is
  written for the worker that lost the draft; the boot escalation's recipient is the manager, so its own
  draft clause must be third-person.
- Do not backfill `origin:"kickoff"` onto a pre-upgrade parked event — it has no marker and correctly
  gets no re-arm; that is the accepted, documented behavior for history predating this card.
- ⛔ **SUPERSEDED by card `7970db77` (see its own section below) — do NOT read this as "nothing to re-arm
  on the crash path."** This used to cite `recoverCrashOrphanedWorkers`'s taskless exclusion as a reason
  there was nothing to re-arm there AT ALL. The exclusion (taskless workers only) is still true, but it
  was over-generalized — a TASKED worker holding the identical marker is fully reachable there. Card
  `7970db77` now calls `escalateParkedKickoffAtBoot` from that per-worker loop too.

## Card 7970db77 — the tasked-worker gap on BOTH boot paths, and the fix

Code Review `58d52c66` (of `3d72900f`) flagged that `escalateParkedKickoffAtBoot` was called only from
`resumeFleetOnBoot`, never from `recoverCrashOrphanedWorkers` — the crash/OS-service/clean-stop path
every non-self-host install actually takes — and asked whether a TASKED crash-orphaned worker could hold
a parked kickoff and be silently resumed+nudged there, hiding the escalation.

**Reachability, proven both by code trace and a hermetic probe (RED):** `deriveCrashOrphanedWorkers`
(`orchestration/crash-orphaned-workers.ts`) excludes only TASKLESS workers (`!w.taskId` — see its own
"TASKLESS intentionally excluded" comment); a tasked worker holding a parked-kickoff marker is a fully
valid candidate. `recoverCrashOrphanedWorkers`'s per-worker loop branched only on `workerParked`
(rate-limit hold) and `w.awaitingReview` (a done/blocked report) — a parked-kickoff worker has neither
(it never reported), so it fell straight into the unconditional generic
`[loom:crash-recovered] ... continue your assigned task` nudge, with NO check analogous to the
manager-level `escalateDeferredManagerKickoffAtBoot` call a few lines below it. A probe built a manager
plus two tasked workers — one holding the exact `session_message_gave_up{outcome:"parked",
origin:"kickoff"}` marker `handleKickoffGiveUpExhausted`'s park branch writes, one a plain control with
no such marker — and ran both through the real `deriveCrashOrphanedWorkers`/`recoverCrashOrphanedWorkers`:
both were derived as candidates, and both received the BYTE-IDENTICAL generic nudge, with zero
`kickoff_confirm_escalated` record for the marked worker.

**Why `tickIdleWorkers` never actually substituted (Code Review correction — the real cause):** the
generic continuation nudge above, once delivered and MCP-seen, starts the worker's FIRST real turn before
`tickIdleWorkers` ever gets a chance to classify it — the EXACT race this card's own "Do not" list already
named for the other two consumers of this escalation, just unguarded for this third one. Once that
happens, `classifyIdleWorker`'s `broken-spawn` branch (gated on `!hasFirstTurnStarted`) can never fire
again for this worker, and any later `tickIdleWorkers` nudge is at best the generic "finished a turn and
is idle but did NOT call worker_report" fallthrough — which asserts a false "finished a turn" premise and
gives the manager zero indication this worker's first turn was actually a vague, context-free re-nudge
rather than its real assigned-task kickoff. It is the continuation nudge consuming the evidence that
defeats `tickIdleWorkers`, not a gap in what `classifyIdleWorker` can see.

**A separate, now-named residual (NOT fixed by this card):** `classifyIdleWorker` itself has zero
awareness of `session_message_gave_up`/`origin:"kickoff"` or `kickoff_confirm_escalated` at all. Once
this fix suppresses the continuation nudge (so the worker never starts a turn), the worker sits with
`hasFirstTurnStarted:false` indefinitely — so `tickIdleWorkers`'s own periodic cadence will, once
`BROKEN_SPAWN_HOLDOFF_MS` passes, independently classify it `broken-spawn` and send its OWN
`[loom:worker-spawn-broken]` notice, a SECOND notice for the same root the boot escalation already sent.
This is a real double notice, but it is AT PARITY with the live immediate-park path's own pre-existing
behavior (`handleKickoffGiveUpExhausted`'s immediate branch already has this exact residual today, for
ANY worker whose kickoff parks immediately and then never starts — `kickoff_confirm_escalated` was never
read by `classifyIdleWorker` before this card either) — not a regression this card introduces. Making
`classifyIdleWorker` consult `kickoff_confirm_escalated` is a real fix, but out of scope here; it belongs
on its own card.

**The fix:** `escalateParkedKickoffAtBoot` no longer bails on `w.taskId` (every other discriminator was
already role/task-agnostic), and is now called from BOTH boot paths — the restart-intent path
(`resumeFleetOnBoot`'s worker branch, unchanged call site, now reaching a wider set of workers) and the
crash path (`recoverCrashOrphanedWorkers`'s per-worker loop, a new call, inserted BEFORE the generic
continuation nudge, same ordering discipline as the manager-level call and as `3d72900f`). The crash
path's `hadUnsentDraft` is always `false` (no `RestartIntent` exists on this path, so there is no
composer-dirty capture to forward — mirrors `escalateDeferredManagerKickoffAtBoot`'s own default). The
busy-at-capture discriminator reuses `3d72900f`'s existing pre-flip busy map, generalized from
manager-only (`busyAtCrashByManagerId`) to any session id (`busyAtCrashBySessionId`, built once in
`index.ts` from the same `recovered` snapshot) rather than adding a second, parallel map.

Tests: `packages/daemon/test/kickoff-confirm-boot-rearm.mjs` case (2a) flips from a negative control
("tasked worker is never re-armed") to a positive one, plus an end-to-end (2a-e2e) and a without-marker
control (2a-control) on the restart-intent path; `packages/daemon/test/crash-orphaned-workers.mjs`'s new
section (16) proves the same shape end-to-end through the real `recoverCrashOrphanedWorkers` — escalates
exactly once with no continuation nudge (16a), a marker-less control is unaffected (16b), every
discriminator stands down including the renamed busy-at-crash map now keyed by the worker's own id (16c-g,
with a without-capture negative control for 16d; (16c) itself is a UNIT check only, not a crash-path
reachability claim — see its own test comment), and two simulated crashes in a row don't double-fire
(16h).

## Code Review round 3 — a blocking cross-manager/worker collision

B1 (blocking, probe-confirmed): the new worker-level escalation's own notice (`enqueueSystemNudge(w.
parentSessionId, ...)`) durably persists a `session_message_queued` row ADDRESSED TO THE MANAGER whenever
it can't deliver live. `recoverCrashOrphanedWorkers`'s manager-level call used to re-read `hasQueuedPending`
LIVE, AFTER the per-worker loop ran — so the worker's own crash-path escalation could poison the manager's
UNRELATED `hasQueuedPending` discriminator, silently standing down `escalateDeferredManagerKickoffAtBoot`
for a manager whose OWN kickoff was independently deferred-dropped and who also happens to parent a
crash-orphaned tasked worker with a parked kickoff. Fixed: the manager's `hasQueuedPending` is now
snapshotted ONCE, before the per-worker loop runs, and that snapshot (never a live re-read after) is what
the manager-level call consumes. Test (FF) in `manager-kickoff-giveup-dropped.mjs` combines both markers
on one manager+worker pair and asserts BOTH escalate — proven RED against the pre-fix tip (by reverting
just this discriminator's snapshot) and GREEN after restoring it.

N1: the crash path's own notify call (`escalateParkedKickoffAtBoot`'s `enqueueSystemNudge`) passed a
hardcoded `taskId: null`; now passes `w.taskId ?? null`, for parity with the live path's identical call
(`handleKickoffGiveUpExhausted`).
