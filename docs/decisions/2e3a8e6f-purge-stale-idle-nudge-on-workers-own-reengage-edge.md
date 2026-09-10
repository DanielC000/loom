# 2e3a8e6f — purge a queued idle-worker nudge on the worker's OWN re-engage edge, not on delivery

## Narrative

Auditor finding 2e3a8e6f: a delivery-vs-watchdog TIMING race, distinct from the progress-vs-blocked
classification guard cited in passing at the same site as card `5d41fc8a` (that guard's own extraction
site was not resolved by this tranche).

`notifyManagerOfIdleWorker` classifies and enqueues its `[loom:worker-idle]` (or
`[loom:worker-spawn-broken]`) nudge the INSTANT a worker goes idle (or on `IdleWatcher`'s periodic
re-check) — correct when computed. But if the manager is BUSY right then, the nudge only QUEUES
(`delivered:false`) in its pending FIFO and drains on the manager's NEXT turn boundary. A manager can
reply to that very worker (`worker_message`/`worker_redirect`) LATER IN THE SAME still-in-flight turn —
re-engaging it — and only end its turn afterward, at which point the STALE queued nudge (computed
BEFORE the reply) would otherwise drain as if fresh, falsely telling an already-responded manager "it IS
parked awaiting your reply".

FIX: on the worker's OWN `busy(false→true)` edge (`index.ts`'s `onBusy` hook) — an objective,
unambiguous "no longer idle" signal, whether it came from a manager reply or the worker resuming on its
own — the classifying side (`SessionService.purgeStaleIdleNudgeForReengagedWorker`) calls the mechanism
side (`PtyHost.purgeQueuedWorkerIdleNudges`), which drops any still-queued `[loom:worker-idle]`/
`[loom:worker-spawn-broken]` nudge for that worker from its manager's pending FIFO before it can ever
drain stale into the manager's turn.

SAFETY: a worker that STAYS idle (no busy edge) never has its queued nudge touched — this can only
remove a nudge whose "still idle" premise has since become false, so a genuinely-stranded worker with
no reply is never silenced.

## Do not

- Do not let a nudge computed while the manager was busy drain unconditionally on the manager's next
  turn boundary — check whether the worker has since re-engaged (its own busy edge) and purge a
  now-stale nudge before it can falsely claim "parked awaiting your reply" to an already-responded
  manager.
- Do not purge on ANY signal other than the worker's own busy(false→true) edge — a worker that stays
  idle must keep its queued nudge, or a genuine strand goes silently unreported.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`purgeStaleIdleNudgeForReengagedWorker`'s
JSDoc): lines 9803-9818, as of main `a4fdccf6` (introducing commit
`8739db130ee13ddd9cc6681c474e6517b41e6814`, `fix(orchestration): stale [loom:worker-idle] nudge races
message delivery — fires "parked awaiting your reply" AFTER the manager already replied / the worker is
already busy (two independent managers)`). Extraction tranche 36.

## Also cited, not extracted this tranche

The same card id is cited, briefly and without further narrative, at the actual purge MECHANISM this
decision drives: `PtyHost.purgeQueuedWorkerIdleNudges` in `packages/daemon/src/pty/host.ts` (its own
JSDoc, ~line 7511) — the function `purgeStaleIdleNudgeForReengagedWorker` (above) calls. That site is
out of this tranche's file fence (`packages/daemon/src/sessions/service.ts` only); this record is
written generally enough — describing the classifying side and the mechanism side by name, not by
line number — that a future tranche on `host.ts` can anchor its own site to this SAME record rather
than minting a second one. A brief, un-extracted mention of card `df48366b`'s role-less-worker gate
also appears next to this decision's function body (`purgeStaleIdleNudgeForReengagedWorker`, the
"Mirrors notifyManagerOfIdleWorker's role gate" comment) — that is a distinct, already-recorded decision
(see `docs/decisions/df48366b-taskless-and-role-less-workers-need-their-own-idle-nudge-path.md`), not
part of this one.
