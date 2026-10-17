# b03e636c — the kickoff-confirm escalation is re-armed at boot-reconcile, before any continuation nudge

Full mechanism and rationale: `8882e2ca-kickoff-confirm-window-is-announcement-only.md`'s own
"Follow-up (card `b03e636c`)" section — not restated here. This record exists because the comment
taxonomy wants one record file per id; the narrative lives on the card this one closes a residual of.

In short: `armKickoffConfirmRecheck`'s one-shot escalation timer (8882e2ca) is in-memory only and lost
across a daemon restart. A taskless worker has no periodic fallback for that loss (a tasked worker does
— `tickIdleWorkers`). This card re-arms the escalation at boot, from a durable `origin:"kickoff"` marker
on the parked `session_message_gave_up` event, evaluated BEFORE `resumeFleetOnBoot` composes any
continuation nudge — and adds a `kickoff_confirm_escalated` durable marker so the escalation itself
becomes auditable and never double-fires for the same root across repeated restarts.

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
- Do not re-arm for a tasked worker (`taskId !== null`) — `tickIdleWorkers` already covers it on its own
  periodic cadence; re-arming here too risks an uncoordinated double notice.
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
- Do not extend this card's boot re-arm to `recoverCrashOrphanedWorkers` — its own candidate derivation
  structurally excludes every taskless worker, so there is nothing to re-arm on that path; see
  8882e2ca's Follow-up section for the residual this leaves.
