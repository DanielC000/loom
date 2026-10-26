# f103dd2d — guard that a test calling createWorktree sets a temp LOOM_HOME before the dist import

## Do not

- Do not weaken `_guard.mjs`'s real-home exclusion to make a new test pass — it exists because a prior
  test once wiped the real projects/tasks DB, recovered only by a WAL-checkpoint (card `49c50b80`).
- Do not build this check as a runtime test that itself calls the real `createWorktree()` — it is a
  STATIC check over file text; exercising the real thing would reintroduce the hazard it guards against.
- Do not treat the harness-provided-`LOOM_HOME` pattern as an exception to tolerate — it is a first-class
  PASS shape, not something to special-case away.
- Do not add this file to a guard's debt baseline if it ever starts failing — fix the file.

## Narrative

Card `aac489a2` fixed two test files that leaked real worktrees into the owner's actual
`~/.loom-worktrees` by calling the production `createWorktree()` without first setting a temp
`LOOM_HOME` (`WORKTREES_DIR` is derived as a sibling of `LOOM_HOME`). That fix was per-file, and nothing
stopped a NEW test file reintroducing the same defect — invisibly to every existing trigger, since a new
`packages/daemon/test/*.mjs` file can do this without touching any `.ts` source at all, so neither the
emit-compare transpile-identity gate nor the `.ts`-keyed scanner lists would ever see it.

The corpus uses at least three legitimate patterns: `useOwnLoomHome(...)`, a hand-rolled
`process.env.LOOM_HOME = <temp>`, and harness-provided (the file sets nothing because
`scripts/test-daemon.mjs` already gave it one). The guard (`createworktree-loom-home-guard.mjs`) asserts
a temp `LOOM_HOME` is in force — by one of the first two patterns, or membership in the harness-only set
— strictly BEFORE the file's own `await import("../dist/...")` line, since `WORKTREES_DIR` resolves at
import time, not call time.

Positive-controlled against a known-bad pre-fix specimen (`git show 2ed7f86e~1:packages/daemon/test/
batch-merge.mjs`): the guard fails on that file and passes on the fixed one. Confirmed clean against the
whole corpus at ship time. Added to `STATIC_GUARD_REPO_PATHS` (`packages/daemon/src/git/worktrees.ts`)
with no allowlist — a file that fails this guard must be fixed, not exempted.

## Source

`packages/daemon/test/harness-config-child-load.mjs:38` (and `createworktree-loom-home-guard.mjs`
itself), `@decision f103dd2d`. Merged `4e3d90d`. Related: `aac489a2` (the 2-file fix), `de7abf0b` (the
temp-home sibling-leak variant), `49c50b80` (why `_guard.mjs` excludes the real home), `83cd04dc` (the
tracing that surfaced all of it).
