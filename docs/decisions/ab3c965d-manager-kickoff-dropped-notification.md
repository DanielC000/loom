# ab3c965d — a MANAGER's dropped kickoff gets its own durable record + Platform-Lead/owner-attention notification, never a re-mint

## Narrative

Card ab3c965d: when a MANAGER session's turn-1 kickoff exhausted its give-up requeue budget,
`handleKickoffGiveUpExhausted` (`sessions/service.ts`) used to bail out through the same early-return
guard as every other excluded case (`!w || (w.role !== "worker" && w.role !== null) || !w.parentSessionId`)
with only a `console.error` — no durable event, no notification anywhere. A worker's kickoff, by
contrast, already got bounded re-mint + park + a sender notice (card 7772176d).

Investigated at source (not assumed): the documented reason managers are excluded (decision `a8f8a8f2`,
"Do not" #1) is specifically about the NOTIFY step lacking a natural recipient for a top-level session
("there is no single natural recipient; leave it to the generic idle-watchdog + console.error") — not a
finding that the RE-MINT mechanism itself would duplicate for a manager. The two concerns (re-mint
eligibility, notify eligibility) were simply bundled into one guard for implementation simplicity.
`requeueGiveUpOrigin` (`pty/host.ts`), the generic, role-agnostic FIRST-tier remint, already fires once
for a manager's kickoff before `handleKickoffGiveUpExhausted` is ever reached — so a manager's kickoff
already gets one safety-net attempt; what was missing is purely the second-tier (SessionService) record
+ notify on the eventual drop.

This card deliberately does NOT extend re-mint to managers — only the record/notify gap, which is what
the card's own DoD requires. Extending re-mint would need its own proof that the duplicate-protection
chain (composerOwnerLineage, logicalId reuse) behaves identically for a manager-role PTY, which was not
established here.

The fix mirrors `handleClaudeBootDialogStuck`'s own parentless-manager resolution (card `e2a3c613`)
exactly, rather than inventing a new mechanism: a durable `manager_kickoff_dropped` event
(`parentNudged:false`, always, since a manager never has a parent) plus a best-effort Platform-Lead
escalation via a newly-generalized `notifyLeadOfParentlessManagerIssue` helper (extracted from the
single-purpose `notifyLeadOfStuckManager`) — never either/or. `companion/attention-push.ts`'s `classify()`
gates `manager_kickoff_dropped` into the owner-attention surfaces on the same `parentNudged === false`
condition `claude_boot_dialog_stuck` already uses.

Deliberately no self-nudge into the dropped session itself: its first turn never started (the caller
confirms this is a genuine drop, not a late confirmation, via `hasFirstTurnStarted`/`transcriptNonEmpty`
— see round 2 below), so there is nothing live to read a notice typed into its own composer, and reusing
the same delivery mechanism that just failed for the kickoff buys nothing.

## Round 2 (Code Review 5f95e7a1, BLOCKING)

Round 1 shipped the manager carve-out (`w?.role === "manager"`) in `handleKickoffGiveUpExhausted` BEFORE
the generic path's own late-confirmation guard (`hasFirstTurnStarted(sessionId) || transcriptNonEmpty`,
a few lines lower) — so the Narrative's own claim above ("the caller already confirmed this is a genuine
drop") was false as shipped: a manager whose kickoff actually landed but confirmed late still took the
manager branch unconditionally and got the full drop treatment (durable event, owner-attention push, web
KICKOFF DROPPED alert, Platform board task, a Lead nudge telling it to recover its brief and resend) — a
duplicated-work hazard. Project memory `5748425f-kickoff-remint-two-mechanisms`'s specimen `a38a6b47` is
exactly this shape: the requeue landed 7.5s before the final give-up fired.

Fixed by hoisting the SAME discriminator (`lateConfirmation = hasFirstTurnStarted(sessionId) ||
transcriptNonEmpty`) above both branches, computed once and consulted by both: the manager branch now
checks it before calling `handleManagerKickoffDropped` (suppressing with a log line, mirroring the
worker path's own suppression wording, when true) and the worker path is otherwise byte-identical to
round 1. `handleManagerKickoffDropped`'s own doc now states this as a precondition the CALLER enforces,
not something the method can verify on its own.

## Round 3 (re-review CR `b0cc737e` BLOCKER + its own finding #2)

**Blocker:** `manager-kickoff-giveup-dropped.mjs` set only `LOOM_HOME`, never `HOME`/`USERPROFILE`, before
its `../dist` import — scenario (H)'s `writeLiveTranscript` resolves its path via `engineTranscriptPath`
(`sessions/transcript.ts`), which reads `os.homedir()`, so every run leaked a real file into the owner's
actual `~/.claude/projects/...` (6 files at review time; agents can't read/delete transcript roots).
Fixed by copying `kickoff-giveup-exhausted.mjs`'s own sandbox block — a `sandboxHome` dir under the
test's own `tmpHome`, with `HOME`/`USERPROFILE` pointed at it, set BEFORE the `../dist` import.
Reproduced the leak directly (revert the sandbox lines, rerun, grep the real `~/.claude/projects` for
the run's own engine-session-id suffix — a hit), then restored and reconfirmed no leak for a matching run.

**Finding #2 (design fix):** the manager branch fired the FULL drop treatment (durable event, owner
attention alert, Platform board task, Lead nudge) on the FIRST exhaustion, with no plausible-confirm
window at all — unlike the worker park path a few lines below, which already consults
`withinKickoffConfirmWindow` and defers via `armKickoffConfirmRecheck` before treating a give-up as a
genuine drop. A manager's kickoff is the LARGEST of any role's (it carries the full agent brief +
kickoff), so by `fd4704bc`/`8882e2ca`'s own reasoning it is the role MOST likely to confirm late — p95
confirmation lag measured ~342s in production (project memory `5748425f-kickoff-remint-two-mechanisms`).

Fixed by mirroring the worker path exactly, reusing its own mechanism rather than building a second one
(decision `8882e2ca`'s own "do not add a second...timer...mechanism" rule): the manager branch now
consults `withinKickoffConfirmWindow` too. Still within the window → defer (no event/task/enqueue yet),
arm the SAME `armKickoffConfirmRecheck` timer, and re-evaluate once it fires; still unconfirmed at that
point → `handleManagerKickoffDropped` fires then, exactly once; confirmed by then (a real transcript) →
suppressed entirely, forever (no event ever recorded for that episode). Outside the window (the
unmeasurable-or-elapsed case, which is what (A)-(H)'s hermetic `PtyStub` always reads) → drops
immediately, byte-identical to round 2.

`armKickoffConfirmRecheck` itself is generalized from a worker-only terminal action (it used to call
`notifyManagerOfIdleWorker` unconditionally) to a caller-supplied `onExhausted(w)` callback — the worker
call site now passes its own `notifyManagerOfIdleWorker` + `recordKickoffConfirmEscalated` logic as that
callback, byte-identical in behavior; the manager call site passes its own transcript re-check +
`handleManagerKickoffDropped`. The timer's generic stand-down (hasFirstTurnStarted/busy/turnSeq>0) is
unchanged and applies to both callers; it does NOT cover the on-disk-transcript discriminator, so each
caller's own `onExhausted` re-checks that itself before treating the fire as a genuine, still-unconfirmed
exhaustion.

Nitpick (same round): `transcriptNonEmpty`/`lateConfirmation` were computed unconditionally at the top of
`handleKickoffGiveUpExhausted` for EVERY role, paying `readTranscript`'s disk read even for a
platform/setup/auditor/other role that bails via the generic guard a few lines down without ever needing
it. Made lazy + memoized (a closure, computed at most once, only by a role that actually reaches a
`lateConfirmation()` check) — no behavior change, only avoids the needless read.

New test scenarios (I)/(J)/(K) in `manager-kickoff-giveup-dropped.mjs`, using `node:test`'s `mock.timers`
to drive the real in-memory timer deterministically (same technique `kickoff-confirm-boot-rearm.mjs`'s own
"(5) TIMER-PATH PARITY" section uses): (I) still within the window, confirmed (a real transcript) BEFORE
the recheck fires — suppressed forever, no event/task/enqueue ever; (J) still within the window, still
unconfirmed when the recheck fires — the full drop fires exactly once, at the recheck, never at the first
exhaustion; (K) outside the window at call time — drops immediately, proving the new check doesn't
regress the ordinary case. Negative-controlled against round-2 shape via `negative-control.mjs`: (I)'s
"deferred, NOT dropped on the first exhaustion" assertions go RED under round-2 code (which drops
immediately regardless of the window), GREEN after this round's fix, tree restored byte-identical.

## Round 4 (card `3d72900f`, Code Review `3f198d0c` of round 3)

Round 3's own `pending` (still-within-window) branch recorded NOTHING durable before arming
`armKickoffConfirmRecheck` — that timer is in-memory only, so a daemon restart inside the window lost the
drop permanently: no boot re-arm existed for a manager/platform session at all (`escalateParkedKickoffAtBoot`'s
own first line, `!w.parentSessionId → return false`, excludes it structurally — a top-level manager/Lead
never has one). The resumed session then got an ordinary continuation nudge with nothing flagging that its
turn-1 brief may never have landed.

**The fix, mirroring `b03e636c`'s own worker-side boot re-arm exactly:**

1. The `pending` branch in `handleKickoffGiveUpExhausted` now `appendEvent`s a durable
   `session_message_gave_up(outcome:"deferred", origin:"kickoff", detail:{msgId,rootMsgId,role})` BEFORE
   arming the timer — the same unconditional-write discipline the worker park branch already uses a few
   lines up. Reuses the existing kind rather than adding a new one: verified safe against every other
   reader (`companion/attention-push.ts`'s `classify()` has no case for this kind at all and falls to its
   existing default; `mcp/orchestration.ts`'s `resolveDirectiveOutcome`/`directiveByMsgId`/
   `peerMessageStatusByMsgId` are structurally unreachable for a kickoff's synthetic rootMsgId — their own
   `findOrigin` only matches `message_worker`/`redirect_worker`/`cross_project_message` events; `pty/
   host.ts`/`db.ts`/`orchestration/report-resolution.ts`/`mcp/eventsSearch.ts` either don't read this kind
   at all or read it generically with no outcome-set enumeration; and none of the test files referencing
   `session_message_gave_up` assert an exhaustive outcome set — each filters for one specific outcome and
   checks presence, so a new value is additive, not breaking. Count as verified via `grep -rl
   session_message_gave_up packages/daemon/test`, re-run at Round 5: 19 files as of that
   check — this project's own standing rule against hardcoding a drift-prone count applies here too, so
   re-run that grep rather than trusting this number if it matters to a later decision).
2. A new boot-reconcile consumer, `SessionService.escalateDeferredManagerKickoffAtBoot(sessionId,
   hasQueuedPending, hasBusyAtCapture, hadUnsentDraft?)` — the manager/platform twin of
   `escalateParkedKickoffAtBoot`. Discriminators (role; persisted `turnSeq>0`; persisted `busy`; captured `hasBusyAtCapture`;
   `hasQueuedPending`; then, last, the disk-reading transcript check) — a strict subset of the worker
   twin's five: there is no manager/platform analog of "any worker_report ever recorded" (nothing a
   manager calls on itself serves that role), so the transcript check alone is the comprehensive catch-all,
   mirroring the live path's own `lateConfirmation()` compound. Finds the latest `deferred` marker via
   `listEventsForWorkerKinds` and stands down if a LATER `manager_kickoff_dropped` event for the same
   `rootMsgId` already exists in the same trail (the live timer fired before this restart hit) — never a
   double-fire across repeated boots, since calling `handleManagerKickoffDropped` IS the terminal action
   whose own event becomes the next boot's "already handled" check. No separate `kickoff_confirm_escalated`-
   style marker is needed here (unlike the worker side, which has three sites that can send the same
   terminal notice text without one shared durable gate) — the manager/platform path has exactly one
   terminal action, and its own event is self-sufficient.
3. Called from `resumeFleetOnBoot`'s manager/platform branch BEFORE `wakeImpact`/the continuation-nudge
   composition — same load-bearing ordering as the worker call: that nudge (or the pending replay above
   it) can itself start the session's first turn and permanently hide that the original kickoff never
   landed.
4. **`handleManagerKickoffDropped` itself was NOT crash-safe against the dedup check above relying on it**
   — it ran `notifyLeadOfDroppedManagerKickoff` (board-task insert + live-nudge) BEFORE appending the
   terminal `manager_kickoff_dropped` event. A crash between a successful Lead-notify and the append left
   NOTHING recorded, so a second boot's `escalateDeferredManagerKickoffAtBoot` would call
   `handleManagerKickoffDropped` again — filing a SECOND board task and a SECOND Lead nudge for the same
   single drop (`notifyLeadOfParentlessManagerIssue`'s own dedup only matches against a PRIOR
   `manager_kickoff_dropped` event, which in this exact window doesn't exist yet either). Fixed by wrapping
   the Lead-notify call in its own try/catch: the terminal event now always gets appended regardless of
   whether Lead-notify throws, so the dedup check `escalateDeferredManagerKickoffAtBoot` relies on is sound
   across a "restart twice" scenario. Proved with a dedicated test (see Source, below) that fires two
   simulated boots in a row and asserts exactly ONE `manager_kickoff_dropped` event + ONE Lead nudge.
5. Tests also cover: the live timer firing and dropping (or late-confirmation suppressing) BEFORE a
   restart — the boot consumer correctly stands down either way (a `manager_kickoff_dropped` event already
   exists, or the transcript is non-empty); `archiveOnExit` clearing the timer before the recheck fires
   (no event at all, live path); and `hasFirstTurnStarted` flipping true mid-window from something OTHER
   than the kickoff's own confirmation (see the residual below).

**Residual, carried over unchanged from round 3 — documented here per Code Review `3f198d0c` item 2, not
newly introduced by round 4:** if ANY turn starts in the manager/platform session during the plausible-
confirm window — human typing, a Lead `session_message`, anything that flips `hasFirstTurnStarted`/`busy`/
`turnSeq>0` other than the kickoff's own content-match confirmation — `armKickoffConfirmRecheck`'s generic
fire-time stand-down suppresses the drop forever, even though the kickoff itself never landed. This is the
SAME mis-classification `b03e636c`'s own record already documents and accepts for the worker boot path;
it is not fixed here, and is not something round 4's durable marker changes (the marker only closes the
restart-loses-it-entirely gap, not this live-path mis-classification).

## Round 5 (a Code Review of round 4)

**SF-1 (the real gap):** round 4's boot consumer was wired into `resumeFleetOnBoot` only — but
`index.ts` runs that method ONLY when a `RestartIntent` was captured (a self-host `daemon_restart`); every
OTHER boot (a genuine crash, an OS-service `loom start`/`restart`/`update`, including the end-user
Platform Lead's own install) runs `recoverCrashOrphanedWorkers` instead (card `9fc41af5` — the two are
mutually exclusive per boot), which round 4 never touched. `deriveCrashOrphanedManagers`
(`orchestration/crash-orphaned-workers.ts`) never filters on `turnSeq`, so a manager/Lead whose kickoff
never landed still reaches that method's own unconditional per-manager summary nudge. Fixed by calling
`escalateDeferredManagerKickoffAtBoot` inside `recoverCrashOrphanedWorkers`'s per-manager loop, right
after the `managerParked` check and before `computeWakeImpact`/the summary nudge — same load-bearing
ordering as the `resumeFleetOnBoot` call. This path has no restart-intent snapshot to read `busy`/`pending`
from (an OS-level crash captures nothing before dying).

**SF-1's own busy-capture correction, found and fixed in the SAME round before this record ever shipped:**
the first implementation of `hasBusyAtCapture` for this call site read `db.getSession(managerId)?.busy`
directly — a bug, not a design choice: that value is ALWAYS false by the time `recoverCrashOrphanedWorkers`
runs, because `index.ts`'s `runBootRecoveryPrefix` calls `db.recoverStaleSessions()` (which unconditionally
zeros every live/starting session's `busy` column) BEFORE `recoverCrashOrphanedWorkers` ever runs, later in
the same boot — so the read was dead code, and the (EE) test that first "proved" it only passed because it
set `busy` AFTER the point a real `recoverStaleSessions()` call would have zeroed it, which production
can never do. Fixed by threading the PRE-FLIP busy value through instead:
`recoverStaleSessions()`'s own SELECT reads every live/starting session's busy flag BEFORE the UPDATE
zeros it, and that snapshot (`recovered`) is already captured in `index.ts`. `recoverCrashOrphanedWorkers`
gained a new opts field, `busyAtCrashByManagerId` (a `Map<string, boolean>` `index.ts` builds from
`recovered`; card `7970db77` later widened this to ANY session id and renamed it
`busyAtCrashBySessionId` once a worker-level consumer needed the same map — see that card's own section
in `b03e636c`'s record), threaded to `escalateDeferredManagerKickoffAtBoot`'s own `hasBusyAtCapture` parameter —
mirroring, on the crash path, the role `RestartResumeEntry.busy` already plays on the `resumeFleetOnBoot`
path. `hasQueuedPending` needed no equivalent fix: it is read live from
`db.listUnresolvedQueuedMessagesForWorker(managerId)` — the SAME durable store
`recoverUndeliveredMessagesOnBoot` redrives from elsewhere in this same boot, scoped by `workerSessionId`
(the recipient convention `session_message_gave_up`/`manager_kickoff_dropped` already use for a manager
row too) — and has no "already zeroed by the time this runs" hazard the way a persisted column does.
See card `3d72900f`'s own "Round 5" section for the full mechanism (that is this card's own method).

**Named explicitly, per Code Review's own instruction:**
`escalateParkedKickoffAtBoot`'s own crash-path EXCLUSION (it is never called from
`recoverCrashOrphanedWorkers` at all) holds ONLY because `deriveCrashOrphanedWorkers` structurally
excludes every taskless worker from its candidate derivation (see `b03e636c`'s own Follow-up section) —
that exclusion does NOT extend to a manager/platform candidate, which is exactly the gap this round closes.

**SF-2 (making the proof real):** round 4's own (Y) scenario asserted "no continuation nudge" against a
subject that was ALREADY a no-op bystander (`isNoOpManagerWake` true regardless) — a vacuous proof,
identical in shape to card `237aa3a9`'s own lesson (see project memory). Fixed by giving the subject a
REAL nudge-forcing condition — `hadUnsentDraft:true` on its `RestartResumeEntry`, which forces
`enqueueDurableNudge` in the no-op branch's own `if (draftNote || capNote)` check — and adding the mirror
scenario (same fixture, no deferred marker) that DOES get the draft-loss nudge, proving the marker (not
mere bystander status) is what suppresses it. The SAME shape is proven through the crash path too: the
candidate manager also carries one real crash-orphaned worker so `computeWakeImpact`'s own
`liveWorkersResumed>0` forces a non-no-op impact, with a no-marker mirror scenario proving the same thing.

**SF-3 (the try/catch's real guarantee, and what it does NOT cover):** round 4's own "restart twice" (Z)
scenario proved the dedup check holds across two ordinary boots, but never exercised the try/catch itself
— nothing in it ever threw. Two new scenarios stub a REAL throw: `db.insertTask` throwing (the terminal
event still lands, with `leadNotified:false` and no `leadBoardTaskId` — nothing was ever filed) and, found
only once that one was written, a gap the try/catch's own ORIGINAL placement still had — stubbing the
nudge-send to throw returned `leadNotified:true` regardless, because `enqueueDurableNudge` never actually
throws (it swallows internally and reports via its own `onOutcome` callback) — so wrapping the WHOLE call
in try/catch was dead code for that failure mode, and `leadNotified = true` was being set unconditionally
right after the call regardless of whether the dispatch actually succeeded. Fixed by reading `leadNotified`
from `onOutcome`'s own `dispatched` flag instead (synchronous here since role `"platform"` never mounts
orchestration MCP, so `enqueueDurableNudge` never defers for this specific recipient role) — this is also
what makes `leadBoardTaskId` now genuinely carry forward across a nudge-send failure, since the already-
filed task id is untouched by whatever happens to the nudge attempt after it.
**Reworded, per Code Review's own instruction:** the previous wording described this as surviving a
daemon "crash" — it survives a THROW (a DB fault, a dispatch error) inside Lead-notify; what the try/catch
actually buys is that no uncaught exception can escape the live `armKickoffConfirmRecheck` setTimeout
callback (or `escalateDeferredManagerKickoffAtBoot` itself) with the terminal event never written. **Named
residual, not closed by this fix:** a genuine OS-level process death in the narrow window between a
successful Lead-notify and the `appendEvent` call immediately below it is a real gap no try/catch can
close — a throw and a kill are different failure shapes, and only the former is what this round's fix
actually covers.

**SF-4 (the Lead-nudge dispatch mechanism — investigated, found unsafe to change the way proposed, and
reverted to the safe form):** the Code Review's own framing was that `isLiveAndPreBoot`'s skip-gate
silently drops the live nudge during a real boot (the Lead was likely JUST resumed and is still pre-boot
at this exact instant) and that routing through `enqueueDurableNudge` instead would let it "actually
arrive" via that method's own `waitForMcpSeen`-deferral. Verified against `usesOrchestrationMcp`
(`packages/shared/src/types.ts`): it returns `role === "manager" || role === "worker" || role ===
"assistant"` — **`"platform"` is NOT a member**, so `enqueueDurableNudge` never defers for the Lead at all;
it dispatches synchronously via the exact same `enqueueDurableMessage` path `enqueueSystemNudge` already
called directly. Removing `isLiveAndPreBoot` was tried and reverted after it broke a REAL, deliberate
hazard test — `claude-boot-dialog-stuck-no-self-nudge.mjs` scenario (M4): the Lead itself can be stuck on
the SAME blocking CLI dialog as the manager it's being notified about (card `850eb55c`'s own hazard,
shared by this helper's other caller, `notifyLeadOfStuckManager`). **`isLiveAndPreBoot`'s skip-gate is a
DELIBERATE POLICY (card `850eb55c`, scenario M4), not a demonstrated fact that every live-and-pre-boot
write would misfire** — the one case that WOULD misfire (the Lead genuinely stuck on the same dialog)
cannot be told apart cheaply from the ordinary "just resumed, hasn't reached SessionStart yet" case, so
the gate suppresses both alike rather than risk the one it can't rule out. **What DID ship from SF-4:**
the call site now uses `enqueueDurableNudge` (harmless for role `"platform"`, and correctly reports
`leadNotified` via `onOutcome` per SF-3 above) with `isLiveAndPreBoot` UNCHANGED. The reviewer's stated
mechanism for "it actually arrives" does not hold for this recipient role; no fix for the pre-boot-skip
case itself shipped this round. **The honest consequence, left open by this policy:** at boot, whether
the Lead ever actually hears about THIS episode's board task is incidental to the episode itself — it
depends on whether `isNoOpManagerWake`/`strandedBoardWork` happens to force a re-orient nudge onto the
Lead's OWN resume for some unrelated reason, and on supervisor-relaunch iteration ordering, never on a
dedicated delivery path for this specific notice. A follow-up card has been filed to close that gap
("deliver a boot-time manager-kickoff-drop notice to the Lead once it is ready") — not fixed here; see
"Do not" below.

**N-1/N-2/N-3 (the boot consumer's own cleanup):** the docblock's claimed discriminator count ("four...a
strict subset of five") never matched its own six-item list — removed the count entirely rather than
fix the arithmetic (this project's own standing lesson: a hardcoded count rots the moment either
function's check list changes without the comment being touched in lockstep — see the
`STATIC_GUARD_REPO_PATHS` saga in `CLAUDE.md`). The indexed `listEventsForWorkerKinds` trail lookup now
runs BEFORE the disk-reading transcript check (was after) — a session with no deferred marker at all no
longer pays for that read. The unused `manager_kickoff_dropped_resolved` kind — included in the trail's
own kind filter but never actually checked anywhere in the function body (the "already dropped" check
only needs `manager_kickoff_dropped`'s own presence, resolved or not) — is dropped from that filter.

**N-4 (making the role-check scenario real):** the original (V-role) scenario never appended a deferred
marker to the tested worker session at all, so it could never distinguish "the role check stopped this"
from "there was nothing to escalate anyway" — the SAME vacuous-proof shape SF-2 found elsewhere. Fixed by
appending a real marker before calling the boot consumer.

**N-6 (forwarding the lost-draft signal):** `escalateParkedKickoffAtBoot`'s own worker twin appends a
draft-loss clause to its manager-facing notice; the manager/platform boot consumer had no equivalent.
`hadUnsentDraft` now threads `resumeFleetOnBoot`'s own `RestartResumeEntry.hadUnsentDraft` through
`escalateDeferredManagerKickoffAtBoot` → `handleManagerKickoffDropped` → `notifyLeadOfDroppedManagerKickoff`,
appending a third-person clause (the audience is the LEAD, never the dropped session or its — nonexistent
— manager) to both the filed board task's body and the live nudge text. The crash-recovery call site
(SF-1) has no equivalent captured-draft signal on that path at all and passes nothing (defaults to
`false`) — there is nothing to forward there, not an oversight.

**N-5:** (AA) is noted in its own scenario comment as characterizing PRE-EXISTING `archiveOnExit`/
`clearKickoffConfirmRecheckTimer` behavior (decision `8882e2ca`), not a round-4 addition — round 4 (via
round 3) only widened WHICH sessions can hold a timer entry there; the clearing mechanism itself is older.

## Do not

- Do not re-mint a manager's kickoff inside `handleKickoffGiveUpExhausted` without first proving the
  duplicate-protection chain (composerOwnerLineage, logicalId reuse via `requeueGiveUpOrigin`) behaves
  identically for a manager-role PTY — this card deliberately left that unestablished and scoped itself to
  the record/notify gap only.
- Do not add a second near-duplicate of `notifyLeadOfParentlessManagerIssue` for a future parentless-
  manager episode kind — add a `dedupEventKind`-parameterized thin caller instead, the same way
  `notifyLeadOfStuckManager`/`notifyLeadOfDroppedManagerKickoff` both now are.
- Do not enqueue a nudge into the dropped manager session itself — its first turn never started, so
  nothing is live to read it (same self-nudge hazard `01160ae3` already guards against for a stuck boot
  dialog, for a different underlying reason here: there is no live turn to interrupt, only an idle one to
  write into for no benefit).
- Do not gate `manager_kickoff_dropped` into the owner-attention surfaces (`companion/attention-push.ts`'s
  `classify()`, `web/src/lib/attention.ts`) unconditionally — gate on `detail.parentNudged === false`,
  mirroring `claude_boot_dialog_stuck`'s own gate exactly (a manager always sets this `false`, so the
  practical effect is "always", but the field is what a reader should check, not the role). Enforced at
  TWO distinct sites, round 2: `companion/attention-push.ts`'s `classify()` switch (already correct, round
  1) and `web/src/lib/attention.ts`'s `latestManagerKickoffDropped` map build (round 1 built the map from
  every matching event unconditionally, with no `parentNudged` check at all — round 2 added it).
- Do not let a role-scoped carve-out (the manager branch in `handleKickoffGiveUpExhausted`) skip a
  generic-path safety check just because it returns earlier in the function — round 1's manager branch ran
  BEFORE the late-confirmation guard the generic/worker path uses a few lines later, so the two silently
  diverged on a precondition the Narrative claimed was shared. Compute a shared discriminator once, above
  every branch that needs it, when two branches must agree on the same check.
- Do not describe this feature's scope as "manager/platform-lead" in a comment — only `role === "manager"`
  is carved out here (and in `handleClaudeBootDialogStuck`'s own Lead-notify call). The Platform Lead's own
  equivalent gap is a separate, not-yet-built card (`5c2f8108`).
- Do not write a hermetic test that calls `readTranscript`/`engineTranscriptPath`/anything resolving off
  `os.homedir()` without sandboxing `HOME`/`USERPROFILE` to a dir under the test's own `tmpHome`, set
  BEFORE the `../dist` import — round 3's blocker (above) is exactly this gap, and it leaks a real file
  into the owner's actual home on every run with no error to notice it by.
- Do not drop a manager's kickoff on the first exhaustion without consulting `withinKickoffConfirmWindow`
  first — round 3's own finding; a manager's kickoff is the LARGEST (and so the most likely to confirm
  late) of any role's, which is exactly backwards from dropping it with the LEAST plausible-confirm
  patience of any role.
- Do not give `armKickoffConfirmRecheck` a second, independent terminal-action path for the manager case —
  it takes a caller-supplied `onExhausted(w)` callback precisely so the worker and manager paths share the
  ONE timer mechanism (decision `8882e2ca`'s own rule); add a new caller's own callback, never a second
  timer/arming method.
- Do not write the `outcome:"deferred"` marker AFTER arming `armKickoffConfirmRecheck`, or inside its
  callback — it must be written FIRST, in the `pending` branch itself, or a restart in the gap between
  arming the timer and it ever firing loses the drop exactly like before round 4.
- Do not give `escalateDeferredManagerKickoffAtBoot` a `kickoff_confirm_escalated`-style second durable
  marker — the manager/platform path has exactly ONE terminal action (`handleManagerKickoffDropped`), and
  its own `manager_kickoff_dropped` event (matched by `rootMsgId`) is already sufficient to detect
  "already handled" on a later boot; a second marker here is an unneeded divergent copy.
- Do not let `handleManagerKickoffDropped` run `notifyLeadOfDroppedManagerKickoff` UNWRAPPED ahead of its
  own terminal `appendEvent` — round 4's own finding: an uncaught throw there leaves nothing recorded, and
  a later boot's dedup check (keyed on that event existing) then re-fires the whole method, double-filing
  the Lead's board task and nudge. Keep the Lead-notify call wrapped in its own try/catch so the terminal
  event is written unconditionally.
- Do not read the round-3/round-4 residual (any non-kickoff turn-start permanently suppressing the drop,
  see "Round 4" above) as a defect this card leaves open to fix later without a fresh card — it is the
  SAME accepted shape `b03e636c` already documents for the worker boot path, carried here deliberately,
  not an oversight.
- Do not wire `escalateDeferredManagerKickoffAtBoot` into `resumeFleetOnBoot` alone — `recoverCrashOrphanedWorkers`
  is the path every non-self-host install (and the end-user Platform Lead) actually takes; round 4 missed
  it entirely (Round 5, SF-1) and it is the load-bearing call site, not an edge case.
- Do not remove `isLiveAndPreBoot`'s gate in `notifyLeadOfParentlessManagerIssue` to make the Lead-notice
  "arrive during boot" — this was tried (Round 5, SF-4) and reverted: it breaks a real,
  deliberate hazard test (`claude-boot-dialog-stuck-no-self-nudge.mjs` scenario M4) protecting against the
  Lead itself being stuck on the same blocking dialog as the session it's being notified about. Switching
  the dispatch call to `enqueueDurableNudge` is safe and shipped; removing the precondition is not.
- Do not set `leadNotified = true` unconditionally right after calling `enqueueDurableNudge` — that method
  never throws (it swallows internally and reports via `onOutcome`), so a line immediately following the
  call runs regardless of whether the dispatch actually succeeded (Round 5, SF-3's own
  finding, caught only because the (CC2) test stubbed a real dispatch failure). Read `onOutcome`'s own
  `dispatched` flag instead — synchronous here only because role `"platform"` never mounts orchestration
  MCP; a future caller passing an orchestration-mcp role would need to handle the deferred case too.
- Do not read the Lead-notify try/catch as surviving a daemon "crash" — it survives a THROW (a DB fault, a
  dispatch error) inside Lead-notify. What it actually buys is that no uncaught exception can escape the
  live `armKickoffConfirmRecheck` setTimeout callback (or `escalateDeferredManagerKickoffAtBoot` itself)
  with the terminal `manager_kickoff_dropped` event never written. A genuine OS-level process death in the
  narrow window between a successful Lead-notify and the `appendEvent` call immediately below it is a
  DIFFERENT failure shape this try/catch cannot close — name it as a residual, never as fixed.
- Do not let `notifyLeadOfParentlessManagerIssue` lose an already-filed `leadBoardTaskId` just because a
  LATER step (the nudge-send) throws — wrap the nudge-send in its OWN try/catch, separate from the
  `insertTask` step above it, so a later failure still returns the real board-task id the caller's own
  terminal event needs to carry.
- Do not write a positive-proof scenario for "no continuation nudge" against a subject that would already
  be a no-op bystander regardless of the escalation (Round 5, SF-2's own finding on the
  original (Y)) — give it a genuine nudge-forcing condition (`hadUnsentDraft`, or a real crash-orphaned
  worker candidate on the crash path) and pair it with a no-marker mirror scenario proving the silence was
  the escalation's doing, not a property of the fixture.
- Do not test a role-check discriminator (or any other early-return guard) without a marker/fixture that
  would otherwise trigger the LATER code the guard is supposed to pre-empt — a role check "passing"
  against a session with nothing to escalate anyway proves nothing about the check itself (Round 5's own
  fix to the original (V-role) scenario, which never appended a real deferred marker at all).
- Do not hardcode the `session_message_gave_up`-referencing test-file count in this record (or restate the
  boot consumer's own discriminator count in its docblock) — both already rotted once (ten → nineteen;
  "four... a subset of five" never matched its own six-item list) for the exact reason `CLAUDE.md`'s
  `STATIC_GUARD_REPO_PATHS` section warns about; point at the `grep`/source instead.

## Source

`packages/daemon/src/sessions/service.ts` (`handleKickoffGiveUpExhausted`'s manager carve-out +
lazy-memoized `transcriptNonEmpty`/`lateConfirmation`, its round-3 `withinKickoffConfirmWindow` consult +
deferred recheck, its round-4 `outcome:"deferred"` durable write before arming the timer,
`armKickoffConfirmRecheck`'s round-3 `onExhausted` generalization + both call sites,
`handleManagerKickoffDropped` (round 4: Lead-notify wrapped so the terminal event always lands),
`escalateDeferredManagerKickoffAtBoot` (round 4, new; round 5: its own `hadUnsentDraft` param, the
indexed-trail-before-transcript reorder, the dropped unused kind), its `resumeFleetOnBoot`
manager/platform-branch call site (round 4, ordered before the continuation nudge; round 5: forwards
`e.hadUnsentDraft`) AND its round-5 `recoverCrashOrphanedWorkers` call site (new, SF-1 — ordered before
that method's own unconditional per-manager summary nudge), `archiveOnExit`'s round-4 comment fix (a
manager/platform CAN hold a recheck-timer entry, not worker-only),
`notifyLeadOfParentlessManagerIssue`/`notifyLeadOfStuckManager`/`notifyLeadOfDroppedManagerKickoff` (round
5: the nudge-send's own inner try/catch, the `enqueueDurableNudge` + `onOutcome`-derived `leadNotified`
swap, `notifyLeadOfDroppedManagerKickoff`'s own `hadUnsentDraft` param + draft-loss clause)),
`packages/shared/src/types.ts` (`manager_kickoff_dropped` kind + `ORCHESTRATION_EVENT_KIND_MEMBERSHIP`;
round 5: the `session_message_gave_up` doc comment's own `outcome:"deferred"`/`origin`/`role` addition),
`packages/shared/src/config.ts` (`BROWSER_NOTIFICATION_KINDS`), `packages/daemon/src/db.ts`
(`DURABLE_AUDIT_EVENT_KINDS`), `packages/daemon/src/companion/attention-push.ts` (`classify()`'s switch
case + `alertLine()`'s own `manager_kickoff_dropped` case, round 2), `packages/web/src/lib/attention.ts`
(`BROWSER_NOTIFICATION_LABELS`, the `latestManagerKickoffDropped` map's `parentNudged` filter (round 2) +
its round-3 comment clarifying the liveness scoping is inherited from `allEvents`, not a local check, and
the render item). Tests: `packages/daemon/test/manager-kickoff-giveup-dropped.mjs` (round 3:
HOME/USERPROFILE sandboxing + scenarios (I)/(J)/(K), via `node:test`'s `mock.timers`; round 4: the
`outcome:"deferred"` marker, `escalateDeferredManagerKickoffAtBoot`'s discriminators, the restart-twice
no-double-fire proof, and item-2/item-3's live-path residual coverage; round 5: (V-role) made real, (Y)
given a genuine nudge-forcing condition + its no-marker mirror, (CC1)/(CC2) the throw-resilience pair,
(DD)/(DD-without-marker) + (EE) the crash-path equivalents of the above, via the REAL
`recoverCrashOrphanedWorkers`), `packages/daemon/test/kickoff-giveup-exhausted.mjs`,
`packages/daemon/test/companion-attention-push.mjs`, `packages/daemon/test/kickoff-confirm-boot-rearm.mjs`,
`packages/daemon/test/crash-orphaned-workers.mjs`, `packages/daemon/test/recycle-settle-lost-to-restart.mjs`,
`packages/daemon/test/recycle-manager-halted-successor-dies.mjs`,
`packages/daemon/test/recycle-fleet-resolved-after-halted-boot-reconcile.mjs`,
`packages/daemon/test/give-up-exhausted-durable.mjs`,
`packages/daemon/test/claude-boot-dialog-stuck-no-self-nudge.mjs` (round 5: re-run to catch the SF-4
regression attempt — scenario M4 is the one that actually caught it), `packages/daemon/test/notify-mcp-silence.mjs`,
`packages/daemon/test/platform-escalate-end-user-lead-home.mjs`, `packages/daemon/test/kickoff-readiness-fallback.mjs`
(both env states, re-run unchanged).
