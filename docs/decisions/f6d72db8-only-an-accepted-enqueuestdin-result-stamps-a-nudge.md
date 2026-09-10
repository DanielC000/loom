# f6d72db8 — only an ACCEPTED `enqueueStdin` result may stamp a nudge cooldown or count a strike

## Narrative

`PtyHost.enqueueStdin` (`pty/host.ts`) returns a richer `EnqueueResult` with THREE possible outcomes.
`IdleWatcher`'s own `IdlePty.enqueueStdin` interface collapses these to the two it needs to distinguish
(mirroring `ContextPty`, `context-watcher.ts`'s structurally identical injectable interface):
`delivered:true` (handed straight to `submit()` this turn) and `delivered:false, queued:true` (durably
held, lands at the next turn boundary) both mean the nudge was ACCEPTED. `delivered:false` with `queued`
falsy — or the call throwing — means it was NOT accepted at all (e.g. the target went not-live between an
earlier `isAlive` check and this call). Card f6d72db8 is the fix that makes this distinction load-bearing
(mirrors `ContextWatcher`'s own identical fix, card 49fdcbbc, against the same contract) — see below.

Before this fix, `idle-watcher.ts` discarded `enqueueStdin`'s return value and unconditionally stamped
the nudge as sent. An unaccepted attempt must not buy the target silence (the next tick should retry, not
wait out a full `idleNudgeMinutes` cooldown for a nudge that never arrived), and — for the manager-idle
loop specifically — must not increment the `unanswered` escalation counter: a strike toward
`idle_escalated` ("this manager has slept through every nudge") must never count an attempt the manager
was never actually told about.

The SAME discard existed at a second, lower-stakes site (`tickAnsweredStuckQuestions`'s answered-stuck
re-nudge): there the consequence is different in degree, not kind — marking a question "nudged" only
suppresses it from the in-memory `nudgedAnsweredQuestions` Set (no DB cooldown, no escalation strike), but
an unaccepted attempt marked nudged anyway would never re-fire for the rest of the process lifetime (that
Set has no other expiry/cadence) — a real, if lesser, bug. Fixed the same way: only an ACCEPTED
(`delivered` or durably `queued`) attempt marks the question nudged.

## Do not

- Do not discard `enqueueStdin`'s return value and assume a nudge was delivered — check
  `delivered || queued` before stamping any cooldown, counter, or in-memory "already nudged" mark.
- Do not count an unaccepted attempt toward a human-facing escalation counter (`unanswered` →
  `idle_escalated`) — that reads as "slept through every nudge," which must not include a nudge the
  target was never actually told about.

## Source

Inline comments in `packages/daemon/src/orchestration/idle-watcher.ts` (the `IdlePty.enqueueStdin`
interface doc, the manager-loop nudge site, and the `tickAnsweredStuckQuestions` re-nudge site). As of
commit `87134ec8c` ("fix(orchestration): record both idle-watcher nudges only when accepted"). Relocated
by card `b072e5d4` (tranche 1 on `idle-watcher.ts`).
