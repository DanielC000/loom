# daaf7fc9 — `hadPriorMergeDone`'s one known Pass-A2 board-state exception

## Narrative

`hadPriorMergeDone` (in `finalizeMerge`, `packages/daemon/src/sessions/service.ts`) is TRUE the
moment ANY earlier `finalizeMerge` call for this exact `workerSessionId` already recorded a
`merge_done` event — this is the REPLAY DETECTION card `daaf7fc9` introduced, so a later
`finalizeMerge` call for the same worker (a boot-reconcile re-run re-finding the same landed
squash, an idempotent worktree-GC retry, or a stale `worker_merge_confirm` redelivery) does not
refire the reingest a genuinely first finalize does.

ONE KNOWN EXCEPTION: `hadPriorMergeDone` can also be satisfied by reconcile Pass A2 (the OTHER
`merge_done` writer besides this method — search `service.ts` for `reconciled: true`), which
infers "landed" from BOARD STATE (the task's terminal column) rather than from git. A task
manually moved to the terminal column, on a worker that filed a merge_request but never actually
merged, would get an A2 `merge_done` — and a genuine FIRST `finalizeMerge` for that worker would
then see `hadPriorMergeDone:true` and skip a reingest that was legitimately due. Narrow,
pre-existing to A2, and low-consequence (a best-effort reingest is skipped; the graph is merely
stale until the next merge) — not fixed here.

## Do not

- Do not assume `hadPriorMergeDone:true` always means a real, git-verified prior merge landed —
  Pass A2 can set it from board state alone, so a genuine first finalize can occasionally see it
  true and skip a legitimately-due reingest. This gap is known and deliberately not fixed.

## Source

Inline comment above the `hadPriorMergeDone` computation in `finalizeMerge`
(`packages/daemon/src/sessions/service.ts`), the "ONE KNOWN EXCEPTION" clause: introduced by
commit `4ef05f710b3479032167037c320b8f84b1d393d3`
(`fix(sessions): a replayed finalizeMerge refires a full codescape reingest with zero new
commits — and our own client timeout is logged as a codescape failure`), the same commit that
closed board card `daaf7fc9` (root cause: a boot-reconcile replay over an already-finalized merge
with a retained worktree used to refire a full codescape reingest, each hitting the client's own
45s timeout and logging it as a codescape failure). The "REPLAY DETECTION (card daaf7fc9): ..."
contract sentence and the "A LATER finalizeMerge call..." replay-scenario sentence stay inline at
the same site, per this program's Class-C doctrine (a reader must still learn what
`hadPriorMergeDone` means without opening this record).
