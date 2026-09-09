# f324e8fa — The squash-subject HTML-entity check is AUTHORITATIVE, not merely a second copy of the pre-gate one

## Narrative

The TITLE/SUBJECT ENTITY BACKSTOP in `mergeBranchLocked` is the AUTHORITATIVE enforcement point, not merely a second copy of the pre-gate check `confirmWorkerMerge` (`sessions/service.ts`) already runs. `subject` here is the exact string `git commit -m` is about to use, at the moment it is well and truly fixed — this sits AFTER the staged-diff noop check (a genuine `ALREADY_MERGED`/`STAGE_EMPTY_RETRY` re-confirm returns before `subject` is ever built, so it can never trip this) and INSIDE the canonical index lock, downstream of every subject source (`taskSubject`, the taskless `deriveTasklessSubject` fallback, and the branch-name last resort) — so it closes the taskless-merge gap too, as a side effect, at no extra cost.

WHY THE PRE-GATE CHECK ISN'T ENOUGH ON ITS OWN: it reads the task's title once, before the gate runs — a SNAPSHOT. The title can be rewritten out from under it before this call ever lands: the human REST edit route (`POST /api/tasks/:id`, `gateway/server.ts`) writes `title` directly, with NO entity check at all. A gate can run for minutes; that's a real window. This check is what makes the invariant actually hold regardless of when/how the title last changed — the pre-gate check stays too, because refusing before a gate lane is spent is still strictly better when it catches the common case.

Reuses the SAME predicate every other call site does (`checkTitleHtmlEntities`, `tasks/title-guard.ts`) — never a second pattern. Unconditional (`allow:false`): this path has no caller-supplied override to honor, for the same reason the pre-gate check doesn't (nothing is persisted for either site to read).

On a hit, the squash phase is aborted before landing (canonical repo restored to its pre-merge state via `resetOrSkip`) and the reason explicitly cites the past incident: an HTML entity in a squash subject would become a PERMANENT, unrewritable mainline commit subject — this has already happened once (commit `fe2c1c6b`).

## Do not

- Do not rely on the pre-gate check alone — it's a snapshot taken before the gate runs, and the title can be rewritten (via the human REST edit route, which has no entity check) during the gate's multi-minute run.
- Do not invent a second entity-checking pattern for this call site — reuse `checkTitleHtmlEntities` from `tasks/title-guard.ts`.
- Do not skip this check for the taskless-merge path — it's downstream of every subject source (task title, taskless fallback, branch-name last resort), so it covers all three uniformly.

## Consequences

An HTML entity in a squash commit subject can no longer land as a permanent, unrewritable mainline commit subject regardless of when or how the source title was last edited — closing the exact gap that produced commit `fe2c1c6b`.

## Source

Inline comment in `packages/daemon/src/git/worktrees.ts`, `mergeBranchLocked`'s title/subject entity backstop block, as of this worktree's HEAD before this extraction. Wrapped source lines joined into a flowing paragraph, `//` comment markers stripped, no wording changed.
