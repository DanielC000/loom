# f324e8fa — The squash-subject HTML-entity check is AUTHORITATIVE, not merely a second copy of the pre-gate one

## Narrative

The TITLE/SUBJECT ENTITY BACKSTOP in `mergeBranchLocked` is the AUTHORITATIVE enforcement point, not merely a second copy of the pre-gate check `confirmWorkerMerge` (`sessions/service.ts`) already runs. `subject` here is the exact string `git commit -m` is about to use, at the moment it is well and truly fixed — this sits AFTER the staged-diff noop check (a genuine `ALREADY_MERGED`/`STAGE_EMPTY_RETRY` re-confirm returns before `subject` is ever built, so it can never trip this) and INSIDE the canonical index lock, downstream of every subject source (`taskSubject`, the taskless `deriveTasklessSubject` fallback, and the branch-name last resort) — so it closes the taskless-merge gap too, as a side effect, at no extra cost.

WHY THE PRE-GATE CHECK ISN'T ENOUGH ON ITS OWN: it reads the task's title once, before the gate runs — a SNAPSHOT. The title can be rewritten out from under it before this call ever lands: the human REST edit route (`POST /api/tasks/:id`, `gateway/server.ts`) writes `title` directly, with NO entity check at all. A gate can run for minutes; that's a real window. This check is what makes the invariant actually hold regardless of when/how the title last changed — the pre-gate check stays too, because refusing before a gate lane is spent is still strictly better when it catches the common case.

Reuses the SAME predicate every other call site does (`checkTitleHtmlEntities`, `tasks/title-guard.ts`, a leaf module both `sessions/service.ts` and `git/worktrees.ts` can import without a cycle) — the write-time enforcement `createProjectTaskChecked`/`updateProjectTask` (`mcp/tasks.ts`, card `267fd215`) already apply is the SAME predicate, not re-derived, so the write-boundary and merge-boundary checks can never drift apart. Unconditional (`allow:false`): this path has no caller-supplied override to honor, for the same reason the pre-gate check doesn't (nothing is persisted for either site to read).

On a hit, the squash phase is aborted before landing (canonical repo restored to its pre-merge state via `resetOrSkip`) and the reason explicitly cites the past incident: an HTML entity in a squash subject would become a PERMANENT, unrewritable mainline commit subject — this has already happened once (commit `fe2c1c6b`).

## The pre-gate advisory: why no caller-supplied override

The pre-gate check in `confirmWorkerMerge` (`sessions/service.ts`) is an EARLY ADVISORY, not the last line of defense — that role belongs to the squash-time check above. It always passes `allow:false`: there is no caller-supplied override threaded through `worker_merge_confirm` to honor or ignore. Measured (Code Review, card f324e8fa follow-up): nothing is persisted anywhere that could carry a card's create-time `allowHtmlEntities:true` forward to merge time — `Task` (`shared/src/types.ts`) has no such field, the `tasks` table (`db.ts`) has no such column, and every `allowHtmlEntities` hit outside `dist/` is a transient zod/function param, never a stored one. Argued for why one must NOT be added, rather than merely absent:

1. Neither known specimen (`fe2c1c6b`, and an independent 2026-07-17 origination) was a title genuinely ABOUT escaped HTML — both were accidental escapes of an ordinary title. This repo's own commit-subject convention (a subject states WHAT THE COMMIT DOES, never the defect it removes) already pushes a defect-titled card toward a fix-shaped retitle before it ships, narrowing but not eliminating the risk.
2. Even granting a genuine edge case, the fix costs nothing: a manager can retitle the CARD immediately before confirming the merge — a false refusal costs seconds, while a false accept is permanent unrewritable mainline history. That asymmetry is why the one boundary meant to be the last line of defense should stay maximally strict rather than grow a bypass for a case that has never actually occurred.

Taskless merges (`taskId === null`) have no card title to check here — the squash-time check (above) still covers that subject via the taskless-fallback path. The pre-gate lookup is also TENSIONED against the union-merge/`preLanded` capture: it runs `findLandedSquashCommit` first so a pure re-confirm of work ALREADY on main is never refused for a title issue that can no longer actually land (since `mergeBranchLocked`'s own noop path returns before `subject` is ever built on any noop path) — the residual cost of not special-casing a `STAGE_EMPTY_RETRY` unrelated to a prior landing is at most an unnecessary refusal, never a missed guard.

## Do not

- Do not rely on the pre-gate check alone — it's a snapshot taken before the gate runs, and the title can be rewritten (via the human REST edit route, which has no entity check) during the gate's multi-minute run.
- Do not invent a second entity-checking pattern for this call site — reuse `checkTitleHtmlEntities` from `tasks/title-guard.ts`.
- Do not skip this check for the taskless-merge path — it's downstream of every subject source (task title, taskless fallback, branch-name last resort), so it covers all three uniformly.

## Consequences

An HTML entity in a squash commit subject can no longer land as a permanent, unrewritable mainline commit subject regardless of when or how the source title was last edited — closing the exact gap that produced commit `fe2c1c6b`.

## Source

Inline comment in `packages/daemon/src/git/worktrees.ts`, `mergeBranchLocked`'s title/subject entity backstop block, as of this worktree's HEAD before this extraction. Wrapped source lines joined into a flowing paragraph, `//` comment markers stripped, no wording changed.
