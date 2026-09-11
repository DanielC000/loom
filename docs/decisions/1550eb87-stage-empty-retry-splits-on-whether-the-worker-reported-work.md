# 1550eb87 — `STAGE_EMPTY_RETRY` splits on whether the worker reported work: silent orphaned-commit loss vs a genuine soft no-op

## Narrative

PL Auditor finding #2 (silent work loss): a squash merge with nothing staged (`emptyKind: "STAGE_EMPTY_RETRY"`) used to be one undifferentiated soft retry — worktree retained, `merged:false`, no alarm — regardless of whether the worker had actually reported its work done. That silently let a real incident class through: a 0-ahead assigned branch WHILE the worker reported done/blocked is the orphaned-commit-to-main signature — the reported work was committed somewhere OTHER than the assigned branch (almost always straight to main, incident: commit `28ae791`) — so the branch is genuinely empty and a later main sync can ORPHAN that commit and lose it silently, with the manager never told anything was wrong.

The fix splits `STAGE_EMPTY_RETRY` on `workerReportedComplete(workerSessionId)`:

- **Worker reported work, branch is 0-ahead** → HARD error (`hardError:true`, `reportedState`). A loud, named refusal telling the manager exactly what to do: find the orphaned commit on main (`git --no-pager log main`), cherry-pick it onto the assigned branch, then re-confirm — or re-task if the report was mistaken. This is the fix for the incident: a manager can no longer let this sail through as a routine soft retry.
- **No report of work, branch is 0-ahead** → stays the gentle soft retry (fail-closed, worktree retained so the manager can investigate why the worker produced no change, no alarm) — unchanged from before this card, because there is no orphaned-commit signature to warn about.

The underlying rule this backstop exists to enforce: workers must NEVER commit to main — commit only to the assigned branch. The hard-error path is what makes a violation of that rule loud instead of silently absorbed into a routine retry.

## Do not

- Do not treat every `STAGE_EMPTY_RETRY` as one undifferentiated soft retry — a 0-ahead branch alongside a worker-reported done/blocked is the orphaned-commit-to-main signature and must refuse loudly (`hardError:true`), not pass through silently.
- Do not skip naming the recovery recipe in the refusal message — the manager needs the exact remedy (find the commit on main, cherry-pick onto the branch, re-confirm) since the commit itself is real and recoverable, just mis-placed.

## Consequences

A worker's own reported-done/blocked commit that landed on main instead of its assigned branch is now caught and named as a hard, actionable refusal instead of silently orphaned by a later main sync.

## Source

JSDoc above `confirmWorkerMerge` in `packages/daemon/src/sessions/service.ts` (the `STAGE_EMPTY_RETRY` bullet), as of this tranche's HEAD before this extraction; wrapped source lines joined into a flowing paragraph, `*` comment markers stripped, no wording changed. The fuller inline implementation comment and refusal message later in the same method (`merge.emptyKind === "STAGE_EMPTY_RETRY"` branch, citing the same card and the `28ae791` incident) is read-only context for this record, not edited by this tranche — out of this tranche's line-range scope.
