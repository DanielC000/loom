# e50600d2 — `LastWorkerGateCheck` records a worker's most recent settled self-check for merge-time reuse

## Narrative

A worker's most recent settled `run_gate` self-check outcome (card e50600d2 — reuse a green self-check instead of re-running the identical gate at merge). Recorded by `SessionService.runWorkerGate` on every settled (`ran:true`) outcome, pass or fail — overwriting whatever was there before — so a later failing (or racy) self-check at the exact same commit always supersedes an earlier green one; a stale green can never be resurrected by this record alone.

`stamp` is the same `WorktreeGateStamp` `runWorkerGate` took at settle (equivalent to its start/admit stamps whenever `headCurrent` is true, since those three stamps must already agree for `headCurrent` to read true — see `describeGateHeadCurrency`) — `SessionService.confirmWorkerMerge` compares a fresh stamp against this one via `gateStampsDiffer` to prove (or refute) that the worktree is byte-identical to what this run validated.

In-memory only, same daemon-uptime-scoped posture as `gateStartStamps`: a daemon restart between the self-check and the merge confirm simply loses this record, which is fine — the reuse check in `confirmWorkerMerge` fails closed on a missing record (falls through to running the gate exactly as before this existed), never on a false "nothing changed" guess.

## Do not

- Do not resurrect a stale green `LastWorkerGateCheck` after a later failing (or racy) self-check at the same commit has overwritten it — the record always holds the most recent settle, not the best one.
- Do not treat a missing record (e.g. after a daemon restart) as proof nothing changed — `confirmWorkerMerge` must fail closed and re-run the gate.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`LastWorkerGateCheck` type's top-of-type doc): lines 1044-1061, as of this tranche's HEAD. Relocated by card 5dcc1e98 (tranche 6); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
