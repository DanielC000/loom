# 2e73af30 — the prelanded-content fixtures' `makeRepo` never persisted a canonical-repo git identity

## Context

`merge-prelanded-content-diverged.mjs` and `merge-prelanded-content-diverged-wiring.mjs` failed on every
`mergeBranch(...)` precondition, ubuntu-CI-only (runs 37991257259 / 38234820974), ~2s in, with no local
repro on WSL or Windows (card `cceb62fd`). Commit `fdc57db2` added a `DIAG` line after every failing
precondition; the next CI run (38319596650, on `a038054a`) logged:

```
{"ok":false,"reason":"squash commit failed: Author identity unknown ... fatal: empty ident name (for
<runner@...>) not allowed"}
```

`mergeBranchLocked`'s own squash commit (`worktrees.ts`, the `git commit -m message` call right after the
`expectAlreadyLanded` check) deliberately lands with repo-config identity and no `-c` override — unlike
`mergeMainIntoWorktree` and `batch-merge.ts`'s own cherry-pick commit, it has no `FALLBACK_GIT_IDENTITY`.
That's an existing, deliberate per-call-site choice (see `FALLBACK_GIT_IDENTITY`'s own doc comment:
"each commit-creating path in this codebase decides its own identity policy") — not what this card
touches.

Both fixtures' own `makeRepo` built an `ID_ARGS` (`-c user.email=... -c user.name=...`) and applied it
only as a scoped prefix to the `git config core.autocrlf false` call. A `-c key=value` override is
process-local to that one invocation — it is never written to `.git/config`. So the canonical repo these
fixtures create carries **no persisted identity at all**, unlike their own template file
(`merge-squash-target-toctou.mjs`), which runs `git config user.email`/`git config user.name` as real,
persisted writes.

On a host with a GLOBAL git identity configured (this project's own dev/CI-self-host machines), the
squash commit's repo-config lookup falls through to the global config and the gap is invisible. A CI
runner (or a fresh end-user host) with no global identity has nothing to fall back to — "empty ident
name", exactly the DIAG above.

REPRODUCED locally (Windows self-host) by simulating an identity-less environment: unset
`GIT_AUTHOR_NAME`/`GIT_AUTHOR_EMAIL`/`GIT_COMMITTER_NAME`/`GIT_COMMITTER_EMAIL`, plus
`GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` pointed at an empty temp file, `GIT_CONFIG_NOSYSTEM=1`, and
`HOME`/`XDG_CONFIG_HOME` redirected to an empty temp dir (never the real global config) — both files went
fully RED (every precondition reproduced the exact CI error text) before the fix, fully GREEN (0 FAIL
lines) after.

## Fix

Test fixture only. `makeRepo` in both files now runs `git config user.email <x>` / `git config user.name
<x>` as real persisted writes (matching the template file), before the `core.autocrlf` config call. No
product code changed — `mergeBranchLocked`'s "repo-config identity, no fallback" choice for the solo
squash path is untouched.

## Do not

- Do not reach for a scoped `-c user.email=... -c user.name=...` prefix as a substitute for persisting
  identity into a canonical repo fixture that a product code path will later commit into with no `-c`
  override of its own — `-c` is call-scoped and never survives past that one invocation.
- Do not assume a fixture copied from a sibling test file (even one using the identical-looking
  `ID_ARGS`/`GIT_ID` pattern) persisted identity the same way the template did; check whether the pattern
  is applied to a `commit`/`revert` call (persists nothing extra, but is explicit per-call) or to an
  unrelated `config` call (persists nothing at all, including the identity that call's own `-c` prefix
  named).
- Do not read this as a product-side gap to close — `mergeBranchLocked`'s solo squash commit staying on
  repo-config identity (no `FALLBACK_GIT_IDENTITY`) is a separate, pre-existing, deliberate per-call-site
  decision; whether a *fresh end-user host* with no configured git identity at all should also get a
  fallback there is a different, larger question this card did not investigate or decide.
