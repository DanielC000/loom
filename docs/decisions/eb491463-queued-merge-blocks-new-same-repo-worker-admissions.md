# eb491463 — a QUEUED merge blocks NEW same-repo worker admissions (writer-preference), so worker self-checks cannot starve it

## Narrative

Live specimen (lead, 2026-09-24): merge batch op `36c08174` sat `queued` at `queuePosition:1`, `repoContended:true` for ~87 min while `activeCount` was 1 of cap 2 and several later-queued worker `run_gate` self-checks were admitted and finished ahead of it.

Mechanism, read at source (`gate-semaphore.ts`): `mergeRepoFree` is asymmetric (see `e4701333`) — a merge is blocked by ANY active holder of its repo, including workers (`activeWorkerRepos`), but a worker is blocked only by an ACTIVE merge holder. Workers never exclude each other, and neither admission site (`acquire`'s fast path, `grantNext`'s in-order scan that skips an ineligible head) looked at a merge WAITING. So while worker gates overlapped back-to-back, `activeWorkerRepos[repo]` never emptied and the merge (admissible only at the instant it is empty) starved — classic writer starvation. The cap was never the blocker, and the merge held nothing.

Fix: `mergeRepoFree` for a `worker` entry also returns false while a `merge`-kind waiter for the same `repoPath` is queued in either tier (`mergeWaitingOnRepo`). Both admission sites and the `repoContended` snapshot go through `mergeRepoFree`, so they stay consistent. Running workers are never preempted; the barrier only removes candidates and running holders always release, so it cannot deadlock. Rejected alternative: FIFO admission, which would also serialize worker-vs-worker and contradict `e4701333`.

Attempt 1 of `36c08174` (29.5 min, no settled `gate_history` row, no `build_gate` event) is UNPROVEN. It is attempt 2 of a batch and the retry re-admits via `runExclusive` with `attempt:2, priorAttemptMs` (`sessions/service.ts` batch path); a retry writes its verdict into the final row, which is consistent with a retry in progress. The semaphore has no preemption path. Not related to this fix as far as read at source.

## Do not

- Do not drop the barrier or apply it at only one admission site — `acquire`'s fast path and `grantNext` each let a worker overtake a waiting merge on their own.
- Do not turn this into FIFO admission — worker-vs-worker on one repo must stay concurrent (`e4701333`).
- Do not extend the barrier across repoPaths or to `deploy` — it is scoped to the same `repoPath` and to `worker`-kind admissions only.

## Source

`packages/daemon/src/orchestration/gate-semaphore.ts` (`mergeRepoFree`, `mergeWaitingOnRepo`); regression coverage in `packages/daemon/test/gate-merge-starvation.mjs`.
