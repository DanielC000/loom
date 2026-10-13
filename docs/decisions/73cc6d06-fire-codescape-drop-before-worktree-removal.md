# 73cc6d06 — fire the codescape drop before attempting worktree removal, not after

## Narrative

`gcWorktreeDir` (`packages/daemon/src/sessions/service.ts`) used to call `fireCodescapeDrop` only
inside its `removed` success branch, after `removeWorktree` had already deleted the directory. On
Windows, Node 22's `fs.watch` spins (~100k callbacks/s, ~1.6 MB/s private-commit growth, ~1.35 cores)
when the directory it's watching is deleted while the watcher is still open, and that memory is never
returned — this explained roughly 60% of a 110 GB codescape `serve` memory incident (card `ba22005b`,
Codescape's own card `abc82fe9`). Firing the drop only after a successful remove meant codescape's
watcher was still open for the entire duration of every ordinary removal, and a wedged or partially
failed removal (`wedged`/`left-on-disk`) never dropped the registration at all — codescape counted 24
"could not remove dir" lines on 2026-10-04, with worktrees still showing stale "Directory not found"
overlays for up to 25 minutes afterward.

The fix moves the `fireCodescapeDrop(codescapeCtx)` call to immediately before the `removeWorktree`
call inside `gcWorktreeDir`'s own removal attempt, right after the worktree path is marked `REMOVING`
(`this.removingWorktreePaths.add(normPath)`). It fires there regardless of whether the removal that
follows then succeeds (`removed`) or fails (`wedged`/`left-on-disk`) — unless the path is already
claimed (see Round 2) — because in either of those two outcomes the old `worktreeId`'s codescape
registration is stale regardless of which branch is taken next. The call stays fire-and-forget/
best-effort (same posture as before the move): it never blocks or delays the removal it precedes, and a
failed/erroring drop is only logged, never thrown.

The call deliberately does NOT move any earlier than the final `REMOVING` mark — none of
`gcWorktreeDir`'s early-return guards above that point (quarantine, path-refusal, the `needsHuman`
skip, either `staleKnowledgeGuard` check, the nested-repo scan's `nested-repo-blocked`, or
`retainIfUncommitted`'s `dirty-retained`) actually remove the worktree; the directory is retained
exactly as-is in every one of those cases, so dropping its codescape registration there would
deregister a worktree codescape should still legitimately be watching.

Separately, this never fires for a manager's `recycleWorker` reuse of a worktree, because that path
never calls `gcWorktreeDir` at all — recycling a worker reuses the existing directory in place rather
than removing and recreating it, so there is nothing to drop.

## Round 2 — the unconditional-before-removeWorktree placement raced a reclaiming spawn's re-registration

Code review caught a regression in the round-1 placement above: firing `fireCodescapeDrop`
unconditionally, immediately after `removingWorktreePaths.add(normPath)` and before calling
`removeWorktree` at all, meant it also fired in the `aborted`/`"claimed"` outcome (card `f487a493`) — the
case where a NEW spawn reclaims this EXACT worktree path (same `taskId` ⇒ same path ⇒ same
`codescapeWorktreeId`) while `removeWorktree`'s own retry loop is still running. Pre-round-1, the drop
never fired in that case at all (it lived only in the `removed` branch, which `aborted` never reaches).
Round 1 introduced a NEW drop call into a scenario it never previously ran in, racing the reclaiming
spawn's own `fireCodescapeRegisterWorktree` call for the SAME `worktreeId` — if the drop's HTTP request
landed on codescape's server AFTER that spawn's register request, codescape would end up believing a
still-live, actively-reused worktree is gone (a false 404 on its MCP route).

The fix: a reclaiming spawn's claim (`claimedWorktreePaths`, populated only by
`reclaimWedgedWorktreePathForSpawn`) can be present at this point in `gcWorktreeDir` ONLY if it landed
BEFORE `removingWorktreePaths.add(normPath)` ran — `reclaimWedgedWorktreePathForSpawn`'s own mutual
exclusion (card `a5d9c458` round 3, commit `ce2fe5cf`) refuses any NEW claim against a path already
marked `REMOVING`, so nothing can claim it afterward for as long as this call holds that mark. This means
`removeWorktree`'s own `abortIfClaimed` check can only ever fire under the EXACT same condition a
pre-check right there can already detect. `gcWorktreeDir` now checks `claimedWorktreePaths.has(normPath)`
immediately after marking `REMOVING` and, if true, short-circuits to the `"claimed"` outcome WITHOUT ever
calling `fireCodescapeDrop` or `removeWorktree` — the reclaiming spawn's own re-registration (after its
`createWorktree` resolves) is left as the only call for this `worktreeId`, exactly as it was before round
1. `removeWorktree`'s own `abortIfClaimed`-driven `aborted` branch is kept as a defensive backstop (should
be structurally unreachable today) rather than removed outright.

## Do not

- Do not move `fireCodescapeDrop` back into (or add a duplicate call inside) the `removed`-only branch
  of `gcWorktreeDir` — the whole point of this change is that the drop must happen before the removal
  attempt, not conditioned on its outcome.
- Do not call `fireCodescapeDrop` from any of `gcWorktreeDir`'s early-return guards (before the
  `REMOVING` mark) — those paths retain the worktree; firing the drop there would deregister a worktree
  that is still legitimately in use.
- Do not add a `fireCodescapeDrop` call on the `recycleWorker` reuse path — that path intentionally
  never removes the worktree directory, so it must never deregister it either.
- Do not fire `fireCodescapeDrop` before checking `claimedWorktreePaths.has(normPath)` right after the
  `removingWorktreePaths.add` mark (round 2) — a claim present at that exact point means a reclaiming
  spawn is about to re-register this SAME `worktreeId` itself, and firing the drop anyway races that
  re-registration (the round-2 regression this section documents).
- Do not remove the defensive `abortIfClaimed`/`aborted` handling inside `removeWorktree`'s call just
  because the pre-check above makes it structurally unreachable today — it is a backstop against a
  future change to the claim mutual-exclusion reopening this window, not dead code to delete.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts`, on `gcWorktreeDir`'s `fireCodescapeDrop`
call site and on `fireCodescapeDrop`'s own doc comment.
