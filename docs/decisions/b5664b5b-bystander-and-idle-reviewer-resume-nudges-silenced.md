# b5664b5b — a non-causal bystander and an idle standing reviewer resume SILENTLY, no nudge at all

## Narrative

Card b5664b5b named (at least) two distinct wasted-turn problems in `resumeFleetOnBoot`'s old
continuation-nudge logic, both fixed by resuming the affected session with NO enqueue rather than a
"lighter" one:

**Problems A + C1 (bystander manager/platform):** a non-causal manager/platform bystander — `isNoOpManagerWake`
(card 5907b71e part 1): it did not request the restart, had zero live workers resumed, no queued I/O
replayed, no unconsumed answer, and no stranded board work — used to still get a "lightweight FYI"
nudge. That FYI was still dispatched via `enqueueStdin`, and an enqueue to an otherwise-idle session
submits as a FULL TURN regardless of how short the text is — so the "lightweight" notice burned exactly
the turn it claimed to save. Measured on the self-hosting Lead (which flows through this same branch):
~10 such wakes in one session, each a wasted full turn. Fix: a genuinely unaffected bystander now
resumes silently, with no enqueue whatsoever.

**Problem B (idle standing reviewer):** a standing reviewer (auditor/workspace-auditor/setup) resumed
while already idle BETWEEN its own scheduled runs (not busy/mid-run at capture time) used to also get a
"you were resumed — continue your work" nudge. But such a reviewer's own due wake/schedule already
re-engages it via the durable WakeService/Scheduler tickers, independent of any restart — the nudge was
pure waste, another wasted full turn. Fix: only nudge a standing reviewer that was BUSY (mid-run) at
capture time; an already-idle one resumes silently and lets its own scheduler bring it back.

`liveFleetResumeSet`'s `busy` field (snapshotting whether a session was mid-turn/mid-run at capture) is
what `resumeFleetOnBoot` reads to gate the Problem-B nudge.

## Do not

- Do not give a non-causal bystander manager/platform ANY enqueue on resume, however short — an enqueue
  to an idle session is a full turn regardless of message length, so a "lightweight FYI" is not actually
  lightweight; use `isNoOpManagerWake` to detect a true bystander and send nothing.
- Do not nudge a standing reviewer that was already idle at capture time — its own WakeService/Scheduler
  ticker will re-engage it on its next due run; only a reviewer that was BUSY (mid-run) when captured
  needs the "continue your work" nudge.

## Source

JSDoc comment in `packages/daemon/src/sessions/service.ts`, above `resumeFleetOnBoot`: lines 4383-4386
and 4400-4403, as of this tranche's HEAD (tranche 11). Cross-referenced (read-only) against
`orchestration/restart.ts` line 55, which documents the same `busy`-at-capture field for Problem B. Also
anchored at a second, restating site inside the same function's `isNoOpManagerWake` branch: lines
4668-4680, as of this tranche's HEAD (tranche 12).
