# sha:61446519 — reconnect board-reconciliation used to clobber a manual post-merge column move

## Narrative

`finalizeMerge` only lands the task in the merge-landing column ON THE FIRST finalize for a
worker (no prior `merge_done` event) — a REPLAY (an idempotent worktree-GC retry, or a
reconnect/boot reconciliation re-run finding the merge already landed) must never force the
column back over a manual move a human made AFTER the merge landed.

That clobber was the bug: a card the manager moved to a non-terminal "ready for owner review"
lane got silently reset to the terminal column on the next reconnect/boot reconcile, which then
made `worker_spawn` wrongly refuse it as a terminal-column task.

## Do not

- Do not let a REPLAY of an already-landed merge (boot reconcile, worktree-GC retry) re-run the
  column-landing move — it must only fire on the first finalize for a worker, or it clobbers any
  manual column move a human made after the merge landed.

## Source

Inline comment above the `hadPriorMergeDone`/`alreadyFinalized` computation in `finalizeMerge`
(`packages/daemon/src/sessions/service.ts`), the "clobber was the bug" clause: introduced by
commit `61446519543db98b80f231f7f254a69dd8ebc9b4`
(`fix(orchestration): reconnect board-reconciliation replays merge-move events over manual column
state, resetting merged cards to the terminal column`); verified via
`git cat-file -t 61446519` ⇒ `commit`. No board card exists for this decision — sourced from
`git blame` at extraction time (tranche 63). The preceding "ONLY on the FIRST finalize..." guard
sentence stays inline at the same site.
