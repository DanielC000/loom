# sha:252e57ec — deleteBranch running LAST closes the lingering-MERGE-REQUEST-alert window

## Narrative

`finalizeMerge`'s post-merge bookkeeping (`packages/daemon/src/sessions/service.ts`) enforces
deleteBranch — the DESTRUCTIVE op — running LAST, after the durable terminal bookkeeping
(updateTask done + merge_done). This closes the window where a crash between deleteBranch and
merge_done lost the terminal event AND pruned the branch, leaving a merge_request dangling
forever (the lingering-MERGE-REQUEST-alert root cause).

## Do not

- Do not reorder `deleteBranch` ahead of the durable terminal bookkeeping (`updateTask done` +
  `merge_done`) in `finalizeMerge` — doing so reopens the window where a crash loses the terminal
  event and prunes the branch, leaving a merge_request dangling forever.

## Source

JSDoc comment above `finalizeMerge` in `packages/daemon/src/sessions/service.ts` ("ORDER IS
CRASH-CRITICAL..."), the block's closing clause: introduced by commit `252e57ecd1`
(`refactor(merge): worker merges use SQUASH (one clean commit per task)`), which switched
`confirmWorkerMerge`/`finalizeMerge` to squash merges and made re-detection key on the persistent
`Loom-Worker-Branch` trailer instead of the branch ref; verified via `git cat-file -t 252e57ec` ⇒
`commit`. No board card exists for this decision — sourced from `git blame` at extraction time
(tranche 63). The rest of the "ORDER IS CRASH-CRITICAL" paragraph (the ordering guard itself and
its Pass-A idempotency reasoning) stays inline at the same site, per this program's own doctrine
on ordered-enforcement-sequence comments.
