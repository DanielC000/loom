# 22a44352 — strand backstop: a worker's report reaching an exited manager needed its own recovery trigger

## Narrative

Incident 22a44352: a worker could report `done` to a manager whose pty had already EXITED (it
idle-reaped after dispatching its last worker), so the report reached no live FIFO
(`delivered:false`, `boarded`) and its branch sat unmerged with nothing watching it — the existing
`session_died` trigger never fires here because the manager exited CLEANLY, not by crashing.

The fix: `recordUndeliveredReport` (`crash-recovery-watcher.ts`) files a separate, durable
`worker_report_undelivered` trigger whenever `SessionService.workerReport`'s framed notify comes
back `boarded` — `delivered:false` with NO queue position, i.e. the manager's pty genuinely isn't
alive. A live-but-busy/parked manager (`queued`, `delivered:false` WITH a position) is explicitly NOT
a strand — its FIFO drains on its own next turn — so that case never records a trigger. The watchdog
then bounded-auto-resumes the manager (once its row is exited) via the same attempt-cap/escalation
machinery as a `session_died`, so it can merge the work its worker already finished.

Gate broadened by card `fc9a27d5`: the old boolean `delivered` couldn't distinguish "durably queued
behind a busy parent" from "boarded with nobody live" — the five-value `DeliveryStatus` that card
introduced is what makes the `boarded`+no-position condition this trigger keys on checkable at all.

## Do not

- Do not assume `session_died` alone covers a strand — a manager that exits CLEANLY (idle-reap) after
  a worker reports to it needs this separate `worker_report_undelivered` trigger; nothing else
  re-wakes it.
- Do not fire this trigger for a live-but-busy/parked manager (`queued`, `delivered:false` WITH a
  position) — its FIFO drains on its own next turn, so recording a trigger there would be a useless
  wake.

## Source

JSDoc comment in `packages/daemon/src/orchestration/crash-recovery-watcher.ts`, above
`recordUndeliveredReport`: lines 131-147, as of this tranche's HEAD (crash-recovery-watcher.ts,
tranche 1). Second citing site (no new content): the `CrashRecoveryWatcher` class doc, lines 254-257
(same HEAD).
