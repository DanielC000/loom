# b9e07a4a — `RepoGuardOnlyQueueEntry` exists so a repo-guard-only holder isn't invisible, and `repoPath` stays own-project only

## Narrative

Card b9e07a4a Code Review: one repo-guard-only holder/waiter in `GateQueueSnapshot.repoGuardOnly` — the `db9b0130` inert-diff skip's own hold/wait (`GateSemaphore.acquireRepoGuardOnly`), which is NOT a cap-admitted run and so never appears in `GateQueueSnapshot.running`/`.queued` at all. Before this existed, a repo-guard-only holder was entirely invisible to `gate_queue`: an operator could see a queued `merge`-kind `GateQueueEntry` reporting `repoContended:true` while `activeCount`/`running` showed ZERO running merges on that repo, with no explanation available anywhere in this snapshot. Same cross-project redaction rule as `GateQueueEntry`: `taskId`/`branch`/`workerLabel` present ONLY for the calling manager's own project.

`repoPath` (Code Review MAJOR fix, card b9e07a4a): an earlier version emitted this UNCONDITIONALLY, for every project — an absolute HOST FILESYSTEM PATH, disclosing another project's repo directory name and this host's own directory layout to a caller who has no business seeing either. `GateQueueEntry` has no `repoPath` field at all (this is the ONE field that only exists on this new type), so that was a brand-new cross-project disclosure with no counterpart in the sanctioned set this daemon otherwise ships (project + gate kind + age + queue position — never a raw host path). Present ONLY for the calling manager's own project, same as `taskId`/`branch`/`workerLabel` below — this daemon serves a private peer product; a leaked absolute path is treated as a real disclosure, not a nit.

## Do not

- Do not fold a repo-guard-only holder/waiter into `GateQueueSnapshot.running`/`.queued` — it is NOT a cap-admitted run and needs its own `repoGuardOnly` array, or a queued merge reporting `repoContended:true` has no explanation anywhere in the snapshot.
- Do not emit `RepoGuardOnlyQueueEntry.repoPath` unconditionally for every project — it is an absolute host filesystem path with no counterpart in this daemon's sanctioned cross-project disclosure set; gate it to the calling manager's own project only.
- Do not let the SINGLE-FILE RETRY (card 344ce950) bypass `runExclusive` (RESOLVED by the same Code Review, card b9e07a4a) — it used to skip the fresh concurrency-slot admission entirely, leaving the gate concurrency triple describing only the first, FAILED admission on a merge that ended `retriedFile`+`retryPassed:true`, and leaving the per-repo merge-admission guard unheld through that retry's own squash. It now re-admits through `runExclusive` exactly like the transient-kill auto-retry, so the triple correctly describes whichever admission the final verdict is actually about on every retry path alike.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`RepoGuardOnlyQueueEntry`'s top-of-interface doc, lines 183-199; the single-file-retry `runExclusive` fix, lines 587-609): as of commit `f9caa77e30d5c1a6dd994b6203261968c0dbf94f`. Relocated by card `8f4c8a8f`; no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
