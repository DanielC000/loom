# e4f0c1df — after `daemon_restart`'s final live-ops recheck, NEW merge / merge_batch / deploy admissions are refused

Follow-up to `2bbc0412`, from its code review. The latch there gates only worker `run_gate`; the final recheck is synchronous, but the exit happens ~300 ms later plus `cleanup.run()` (vault flush, 60 s watchdog). A merge confirm, merge_batch or deploy admitted in that window was orphaned with no `orphanedOps` entry and no nudge.

## What it does

- `restartExiting` is set synchronously at the final recheck, once the exit is committed to, and cleared by `releaseLatch` (every non-exit path and after the exit callback).
- While set: `deployOwnProject` throws, `mergeBatchTracked` and a minting `confirmWorkerMergeTracked` return `{settled:true, ok:false, error}`. Same plain shape as the run_gate latch: no verdict, no op, no tombstone, never cached, never a gate failure, never toward `gateOwed`. The error names what was refused.
- A `confirmWorkerMergeTracked` call that attaches to an already-RUNNING op is still allowed (it mints nothing).
- A `proceedDespiteLiveOps` from an overlapping caller that attaches after the override was first captured is re-read at the final recheck (with its own session id), so no caller is told to pass what it already passed.

## What is and is not guarded

Guarded: new merge/merge_batch/deploy admissions after the final recheck; run_gate admissions from the wait onward. NOT guarded: a worker `run_gate` or merge already admitted before the recheck is seen by the recheck itself (refuse, or orphan under the override); the restart-intent boot recovery remains the only net for anything that slips past a path this card did not list.

## Do not

- Do not turn the refusal into a verdict, a `worker_gate`/`merge_*` event, or a cached outcome.
- Do not set `restartExiting` before the final recheck (it would refuse admissions for a restart that may still refuse) or leave it set on a path that does not exit.
- Do not claim the restart "never orphans"; claim only what the list above guards.
