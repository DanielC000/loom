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

## Source

`packages/daemon/src/sessions/service.ts` (`handleKickoffGiveUpExhausted`'s manager carve-out +
lazy-memoized `transcriptNonEmpty`/`lateConfirmation`, its round-3 `withinKickoffConfirmWindow` consult +
deferred recheck, `armKickoffConfirmRecheck`'s round-3 `onExhausted` generalization + both call sites,
`handleManagerKickoffDropped`, `notifyLeadOfParentlessManagerIssue`/`notifyLeadOfStuckManager`/
`notifyLeadOfDroppedManagerKickoff`), `packages/shared/src/types.ts`
(`manager_kickoff_dropped` kind + `ORCHESTRATION_EVENT_KIND_MEMBERSHIP`), `packages/shared/src/config.ts`
(`BROWSER_NOTIFICATION_KINDS`), `packages/daemon/src/db.ts` (`DURABLE_AUDIT_EVENT_KINDS`),
`packages/daemon/src/companion/attention-push.ts` (`classify()`'s switch case + `alertLine()`'s own
`manager_kickoff_dropped` case, round 2), `packages/web/src/lib/attention.ts` (`BROWSER_NOTIFICATION_LABELS`,
the `latestManagerKickoffDropped` map's `parentNudged` filter (round 2) + its round-3 comment clarifying the
liveness scoping is inherited from `allEvents`, not a local check, and the render item). Tests:
`packages/daemon/test/manager-kickoff-giveup-dropped.mjs` (round 3: HOME/USERPROFILE sandboxing +
scenarios (I)/(J)/(K), via `node:test`'s `mock.timers`),
`packages/daemon/test/kickoff-giveup-exhausted.mjs`, `packages/daemon/test/companion-attention-push.mjs`.
