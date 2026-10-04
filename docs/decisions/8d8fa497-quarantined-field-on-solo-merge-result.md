# 8d8fa497 — `mergeBranch`/`mergeBranchLocked` must set `quarantined:true` on their own result whenever they raise or discover one

`mergeMainIntoWorktree` (the union-merge producer) and `batch-merge.ts` already set `quarantined: true` on
every one of their own `enterMergeQuarantine`/`RepoQuarantinedError` returns. The solo squash-merge path
(`mergeBranchLocked`, plus its `mergeBranch` wrapper) never did — its own return type had no `quarantined`
field at all, and none of its own `reason` strings contain the literal word "QUARANTINED" (that word is
coined only by `assertRepoNotQuarantined`'s refusal format, `git/merge-quarantine.ts`, read by a
SUBSEQUENT caller hitting an already-active quarantine — never by the op that itself raised it).

Reproduced directly (not just inferred) under synthetic host load: `test/merge-hang-does-not-wedge-queue.mjs`'s
scenario [B] op1 can itself raise a quarantine from ANY of its internal canonical git calls (not just the
hook-triggering `git commit` — a bare-`withTimeout` read probe like `git ls-files --unmerged` can also
spuriously exceed its budget under contention, triggering `resetOrSkip`'s cleanup, whose own kill-confirm
can itself go unconfirmed) while its own returned `reason` carries nothing a caller can detect that by.

## Do not

- Do not add a new quarantine-raising (`enterMergeQuarantine`) or quarantine-discovering
  (`RepoQuarantinedError`) branch inside `mergeBranchLocked`/`mergeBranch` without also setting
  `quarantined: true` on that same return — string-matching `reason` for "QUARANTINED" can never detect
  a quarantine this function itself just raised or found.
- Do not have `resetOrSkip` go back to returning a bare `string | null` — it must keep returning
  `{ message, quarantined? } | null` so every one of its callers can propagate `quarantined` without
  re-deriving it from `message` text.
- Do not patch `classifyOutcome`/`NEVER_CACHED_OUTCOMES` (`sessions/service.ts`/`orchestration/pending-ops.ts`)
  for this — both already key off the generic `value.quarantined`/`outcome.value.quarantined` field
  (decision `7e5b23e7`'s own "fix classifyOutcome once" rule), so a new call site needs no change there as
  long as it sets the field.
