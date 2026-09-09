# 503cd822 — Build a no-commit review worktree only when the reviewed diff touches a test-shaped file

## Status

accepted

## Context

A no-commit/read-only rig (Code Reviewer, Docs & Vault, …) never runs a build gate by default, since it
never executes compiled output for its own sake. But a reviewer that *executes* a test file under review
does need `dist/`, and a build-free worktree never populates it. Card `503cd822`: a real Code Reviewer
session could not run 2 of 5 changed files under review for exactly this reason, and its manager had to
relay a "build and run those yourself" round-trip back to the author — because the build-free rig's
premise had never been recorded as a decision, so the gap looked like a bug rather than an accepted
trade-off. Building for every review would defeat the entire point of `runBuild:false`'s latency win,
since most reviews touch no test at all.

## Decision

`runBuild` (`ProvisionDeps`, `packages/daemon/src/git/worktrees.ts`) is **not** derived from `noCommit`
alone. The spawn caller (`sessions/service.ts`) sets it to `!noCommit` for an ordinary no-commit rig with
nothing yet to review (a fresh task — no diff exists yet to inspect), but for a review spawn
(`reviewOfWorkerSessionId`/`reviewOfTaskId`) it additionally asks `reviewDiffNeedsBuild` whether the
**reviewed** branch's diff touches a test-shaped file (`looksLikeTestFile`) — build the review worktree
only if so, even though the reviewer itself never commits. INSTALL still runs unconditionally regardless
(a no-commit rig still needs `node_modules` to run/read the repo) — only the BUILD phase is gated.

## Do not

- Do not derive `runBuild` from `noCommit` alone — a review spawn needs the diff-shape check
  (`reviewDiffNeedsBuild`) layered on top.
- Do not build every no-commit review worktree unconditionally — that defeats the latency win
  `runBuild:false` exists for, since most reviews touch no test at all.
- Do not skip the INSTALL phase for a no-commit rig — only the BUILD phase is conditional; a no-commit rig
  still needs `node_modules` to run or read the repo.

## Consequences

- Easier: a Code Reviewer session can actually execute a test file under review when the diff touches
  one, without a round-trip back to the review's author.
- Harder / accepted: the decision now rests on a diff-shape heuristic (`looksLikeTestFile`) rather than a
  flat rule — a diff touching a test-shaped file through an unusual path or extension could still miss the
  heuristic and silently skip the build.
- This premise was not recorded as a decision before this ADR, which is what produced the original wrong
  bug report in card `503cd822` — this record exists specifically to close that gap.

## Evidence

- READ-IN-SOURCE: `packages/daemon/src/git/worktrees.ts` — `ProvisionDeps.runBuild`'s own doc comment
  (~line 357) and `reviewDiffNeedsBuild`'s own doc comment (~line 2651) state this decision and cite card
  `503cd822` verbatim (read directly in this worktree, 2026-09-09).
- No inline source anchor added by the `92cfc09e` task: `git/worktrees.ts` was held by a concurrent
  worker (card `8ea85329`) at that task's kickoff — the exact collision that task's own kickoff named.
  Reported as a remainder rather than edited.
- OBSERVED (card `f42c545f`, 2026-09-09): that hold had since cleared. A `// @decision 503cd822` anchor
  was added at `provisionWorktreeDeps`'s `if (deps.runBuild === false) return;` line (~line 624) — the
  actual behavioral chokepoint that skips the build phase.
