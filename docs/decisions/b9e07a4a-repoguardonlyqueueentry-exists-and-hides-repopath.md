# b9e07a4a — `RepoGuardOnlyQueueEntry` exists so a repo-guard-only holder isn't invisible, and `repoPath` stays own-project only

## Narrative

Card b9e07a4a Code Review: one repo-guard-only holder/waiter in `GateQueueSnapshot.repoGuardOnly` — the `db9b0130` inert-diff skip's own hold/wait (`GateSemaphore.acquireRepoGuardOnly`), which is NOT a cap-admitted run and so never appears in `GateQueueSnapshot.running`/`.queued` at all. Before this existed, a repo-guard-only holder was entirely invisible to `gate_queue`: an operator could see a queued `merge`-kind `GateQueueEntry` reporting `repoContended:true` while `activeCount`/`running` showed ZERO running merges on that repo, with no explanation available anywhere in this snapshot. Same cross-project redaction rule as `GateQueueEntry`: `taskId`/`branch`/`workerLabel` present ONLY for the calling manager's own project.

`repoPath` (Code Review MAJOR fix, card b9e07a4a): an earlier version emitted this UNCONDITIONALLY, for every project — an absolute HOST FILESYSTEM PATH, disclosing another project's repo directory name and this host's own directory layout to a caller who has no business seeing either. `GateQueueEntry` has no `repoPath` field at all (this is the ONE field that only exists on this new type), so that was a brand-new cross-project disclosure with no counterpart in the sanctioned set this daemon otherwise ships (project + gate kind + age + queue position — never a raw host path). Present ONLY for the calling manager's own project, same as `taskId`/`branch`/`workerLabel` below — this daemon serves a private peer product; a leaked absolute path is treated as a real disclosure, not a nit.

## `opId` is the Map identity `activeMergeRepos` stores against `repoPath`, not merely forensics

Card b9e07a4a Critical: `GateDescriptor.opId` was purely optional forensics (also what makes a run findable via card edc1ec12's `gate_status(opId)`). For a `merge`-kind descriptor with `repoPath`, `opId` is now the IDENTITY `activeMergeRepos` stores. Omitting it doesn't break admission (`repoHolderId` has a safe fallback), but the hold then can't be matched by an external `beginSquash`/`endSquash` call — a descriptor calling `holdRepoGuardOnExit` MUST supply a real, stable `opId`.

## `RepoGuardOnlyEntry` — no process, no `repoContended` of its own

Card b9e07a4a: one repo-guard-only holder/waiter in `repoGuardOnlySnapshot()` (the `db9b0130` inert-diff skip's own descriptor). Before this, an operator could see a queued merge report `repoContended:true` with ZERO running merges visible on that repo (the holder was invisible to `snapshot()`), no way to see or cancel a wedged wait. Deliberately NOT merged into `GateSnapshotEntry`: no process runs here, so no `lastOutputAt`/`extended`/`liveness`/`repoContended` (an entry here IS the contention that field would otherwise report).

## `activeMergeRepos` is `Map<repoPath, holderId>`, not a bare `Set` — the cascade a Set allowed

Card b9e07a4a CRITICAL: a bare `Set<string>` couldn't tell "free" from "held by someone else". Reproduced cascade: op A's gate FAILS (`holdRepoGuardOnExit` never called) → `release(holdRepoGuard:false)` hands `repoPath` to queued op B → but `confirmWorkerMerge`'s outer `finally` still unconditionally calls `endSquash(repoPath, A's opId)` (gated on `gateRan`, set before the gate ran — true regardless of pass/fail) → an unconfined `Set.delete` would DELETE B's now-live hold, and B's later release would delete C's in turn. Same shape for a cancelled-while-queued op (`GateCancelledError` before `fn` runs: never touched the map, yet `finally` still fires `endSquash`). `Map<repoPath, holderId>` closes both: every release must present the SAME `holderId` stored at acquisition, REFUSED (logged `refused-not-owner`, see card `96d5f76b`) on a mismatch — an op can only ever touch its own hold.

## Do not

- Do not fold a repo-guard-only holder/waiter into `GateQueueSnapshot.running`/`.queued` — it is NOT a cap-admitted run and needs its own `repoGuardOnly` array, or a queued merge reporting `repoContended:true` has no explanation anywhere in the snapshot.
- Do not emit `RepoGuardOnlyQueueEntry.repoPath` unconditionally for every project — it is an absolute host filesystem path with no counterpart in this daemon's sanctioned cross-project disclosure set; gate it to the calling manager's own project only.
- Do not let the SINGLE-FILE RETRY (card 344ce950) bypass `runExclusive` (RESOLVED by the same Code Review, card b9e07a4a) — it used to skip the fresh concurrency-slot admission entirely, leaving the gate concurrency triple describing only the first, FAILED admission on a merge that ended `retriedFile`+`retryPassed:true`, and leaving the per-repo merge-admission guard unheld through that retry's own squash. It now re-admits through `runExclusive` exactly like the transient-kill auto-retry, so the triple correctly describes whichever admission the final verdict is actually about on every retry path alike.
- Do not omit `opId` on a merge descriptor calling `holdRepoGuardOnExit` — an external `beginSquash`/`endSquash` only ever presents an `opId`, so a missing one makes the hold un-matchable.
- Do not free an `activeMergeRepos` entry without checking the presented `holderId` matches what's stored — an unconditional `finally` can otherwise delete a live sibling's hold.

## Source

`packages/daemon/src/sessions/service.ts` (`RepoGuardOnlyQueueEntry` doc, lines 183-199; single-file-retry fix, lines 587-609), commit `f9caa77e30d5c1a6dd994b6203261968c0dbf94f`, relocated by card `8f4c8a8f`. Also `packages/daemon/src/orchestration/gate-semaphore.ts` (`GateDescriptor.opId`, 155-169; `RepoGuardOnlyEntry`, 380-394; `activeMergeRepos`, 524-547), commit `5f6d9fd981336bfafd530fada633b229677aa081`, relocated by card `9641742e`. No wording changed beyond joining wrapped source lines into flowing paragraphs and stripping `*` comment markers.
