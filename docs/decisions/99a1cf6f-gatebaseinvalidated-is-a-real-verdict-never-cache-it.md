# 99a1cf6f — `gateBaseInvalidated` is a real, resolved verdict about canonical main, never cacheable against the branch

## Narrative

Card 99a1cf6f: `true` only on the stale-base rejection return (`merge.gateBaseInvalidated`, below) — a BENIGN race where canonical MAIN advanced during this merge's own gate/squash (see `AdmissionReunionFailedError`'s own doc for how this differs from a REAL git failure encountered while trying to close that staleness gap). `merged` is always `false` alongside this, exactly like `cancelled` above, but for a different reason: this IS a real, resolved verdict (a gate genuinely ran and would have squashed), just one whose validity depends on canonical main's state, not the branch's. Existed for years as `merge.gateBaseInvalidated` (a git-layer-only fact, `git/worktrees.ts`) with no echo on this return type at all — `confirmWorkerMergeTracked`'s `classifyOutcome` reads THIS field (not `merge.gateBaseInvalidated`, which it doesn't have access to) to map the settle to the `"stale-base"` string `PendingOpRegistry`'s `NEVER_CACHED_OUTCOMES` treats specially — see that constant's own doc (`orchestration/pending-ops.ts`) for why a stale-base rejection must never be served back to a later plain re-confirm: unlike an ordinary rejection (a real test failure, likely to reproduce identically on a re-run against the SAME branch head), this rejection says nothing about the branch at all, and the rejection's own advertised remedy ("just re-run worker_merge_confirm") only works if a bare re-call genuinely re-gates. `undefined` on every other return path.

## Do not

- Do not serve a stale-base rejection back to a later plain re-confirm from cache — `PendingOpRegistry`'s `NEVER_CACHED_OUTCOMES` treats `"stale-base"` specially precisely because the rejection says nothing about the branch; the advertised remedy ("just re-run worker_merge_confirm") only works if the re-call genuinely re-gates.
- Do not read `gateBaseInvalidated` as an ordinary rejection like a real test failure — it is a benign race where canonical main advanced during this merge's own gate/squash, not evidence against the branch.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`ConfirmMergeResult.gateBaseInvalidated`): lines 559-574, as of commit `f9caa77e30d5c1a6dd994b6203261968c0dbf94f`. Relocated by card `8f4c8a8f`; no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
