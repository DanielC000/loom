# b9515beb — the PendingOpRegistry's own origin: a client-side MCP timeout left a manager unable to tell whether a slow op landed

## Narrative

Before `PendingOpRegistry` existed, `worker_spawn`/`worker_merge_confirm` used a bare `inFlightSpawnTaskIds` claim Set — a throw-on-retry mutex with no way to ask "did it actually finish?" once a caller's own MCP client-side timeout fired on a minutes-long gate run (the Auditor friction, card b9515beb). A retry after that timeout bounced off a hard "already in flight" error instead of finding out whether the original call had landed, failed, or was still running. `PendingOpRegistry` generalizes that Set into a record whose outcome a client can come back for: `attach()` either serves the same in-flight op's eventual result, or — if it's still running past the caller's own `waitMs` — hands back a `{settled:false}` pending view the caller can poll (`peek()`) or re-`attach()` to later, rather than throwing.

## Do not

- Do not reintroduce a bare claim-Set / throw-on-retry mutex for a long-running orchestration op — a caller whose own client-side timeout fires needs a way to ask "did it land?", not just "something is already running".

## Source

Inline comment in `packages/daemon/src/orchestration/pending-ops.ts` (`PendingOpRegistry`'s class doc, opening paragraph): lines 204-209, as of commit `507e966583ff18068f5e7e56942acfe67001ee94`. Relocated by card `a1491009` (tranche 1); no wording changed beyond joining wrapped source lines into a flowing paragraph and stripping `*` comment markers.

## Decision B (unrelated decision, same card id, `sessions/service.ts`)

`resolveRecord` serves exactly one file per id, so a second `b9515beb-*.md` file would have been silently unreachable; folded here rather than duplicated, per this repo's own "one record file per id" rule.

### Narrative

A separate finding cited under the SAME 8-hex id: `confirmWorkerMerge`'s build/DoD gate runs its steps as SEPARATE sequential processes (`runGateSequential`) rather than one `&&`-chained `spawnSync` — a shared memory footprint across lint+test+build was OOM-killing a worker's gate (exit 137, Auditor finding `b9515beb`). Same fail-closed short-circuit semantics as the old `&&` chain: the first non-zero step still stops the run; only the process-memory isolation changed.

### Do not (this section only)

- Do not revert to one `&&`-chained `spawnSync` for the gate's steps — a shared memory footprint across lint+test+build was observed OOM-killing a worker's gate (exit 137).

### Source (this section only)

Inline comment in `packages/daemon/src/sessions/service.ts`, `confirmWorkerMerge`'s build/DoD gate doc (the `runGateSequential` paragraph), as of this tranche's HEAD before this extraction. This is a genuinely separate decision from the `PendingOpRegistry` narrative above — not the same underlying incident, just the same 8-hex card/finding id.
