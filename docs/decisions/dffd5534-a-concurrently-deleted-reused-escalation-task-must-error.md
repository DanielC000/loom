# dffd5534 — a concurrently-deleted reused escalation task must error, never silently report false success

## Narrative

`platformEscalate`'s returned `outcome` is derived as `created ? "created" : "appended"` — unconditional
on `created` alone — while the sibling `appended` flag only ever flips `true` inside the
`if (reusedTask)` branch, after a fresh `getTask` re-read of the task id resolved moments earlier. If
that re-read ever returned nothing for a `reuseTaskId` resolved moments earlier (e.g. the task were
deleted concurrently in between), the two fields would disagree: `outcome:"appended"` with no `appended`
flag set, no body write ever made, and a `taskId` pointing at a card that no longer exists — silent
detail loss reported as a success.

**Fix:** an explicit thrown error (`escalation target task ${taskId} no longer exists (deleted
concurrently)`) instead of falling through to a false "appended" success.

**UNREACHABLE today:** `platformEscalate` takes no `await` anywhere between the resolution read and this
re-read, so nothing can genuinely delete the task in between. Latent, not live — but cheap to close now
rather than leaving two fields (`outcome` and `appended`) that can silently disagree if the function's
async shape ever changes.

## Do not

- Do not derive `outcome` from `created` alone once an `appended`-flagging branch exists — the two must
  never be able to disagree, even on an unreachable path.
- Do not silently fall through to a false "appended" success when a reused task's re-read comes back
  empty — throw, even though the path is currently unreachable.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`platformEscalate`'s reuse branch, labeled
"Code Review Minor B" in the source, referencing the reviewed commit `dffd5534` — the commit that landed
card `8636f761`). The actual fix for this finding was implemented under board card `648ae961`
("fix(orchestration): three escalation-path correctness and wording fixes", finding B; reviewer
`e696a3de`, 2026-08-26) — a distinct, real card exists for the fix, but the inline comment cites the
reviewed commit, so this record is keyed to that commit per the anchor grammar's `sha:` rule. A sibling
finding from the same review (Code Review Minor A) landed in `packages/daemon/src/mcp/tasks.ts`'s
`appendBody` conflict-retry error message — not yet anchored as of this tranche; out of this tranche's
file fence (`sessions/service.ts` only). See also
`packages/daemon/test/platform-escalate-missing-reused-task.mjs` for the forced-repro test.
