# a6f84660 — `GitReader.log()`'s structural check must read revparse OUTPUT, not rely on rejection

## Narrative

`GitReader.log()` (`packages/daemon/src/git/reader.ts`) decides whether `HEAD` resolves to a commit by
running `git rev-parse --quiet --verify HEAD` and treating a thrown error as "it doesn't resolve" — this
was meant to be the locale-independent primary signal for a commitless repo (e.g. a fresh `project_init`
straight out of `git init`, with zero commits), ahead of a secondary, English-message-match fallback
(`isCommitlessRepoLogError`) kept as defence in depth.

Probe-verified (two independent agents, card `59e53710`; see project memory
`simple-git-raw-does-not-reject-on-exit-code-only-failure`): simple-git's `.raw()`/`.revparse()` RESOLVE,
with `""` output, when git exits non-zero but writes nothing to stderr — and `--quiet --verify HEAD` on an
unborn `HEAD` is exactly that shape. A bare `try { await … } catch { headResolves = false }` around the
call never observes this as a failure, since the call never rejects — `headResolves` stayed `true`
unconditionally, making the structural check dead code. A commitless repo was in practice caught *only* by
the English message-match fallback, which (per that fallback's own doc comment) survives only because
`GitReader`'s own git instance pins `LC_ALL=C`/`LANG=C` — leaving no second, independent line of defense.

The fix reads the call's resolved *output* instead of its rejection: `headResolves = out.trim() !== ""`.
This matches every other `-q --verify`/`--quiet --verify` site in the codebase (`git/worktrees.ts`,
`git/mainline-watch.ts`, `git/batch-merge.ts`), none of which relied on rejection for this same shape.

## Do not

- Do not revert `GitReader.log()`'s HEAD-resolution check to a bare try/catch around
  `revparse(["--quiet", "--verify", "HEAD"])` — simple-git resolves with `""` output on an unborn `HEAD`
  rather than rejecting, so a bare catch silently never fires and the check becomes dead code again.
- Do not remove the English message-match fallback (`isCommitlessRepoLogError`) as "no longer needed" —
  it stays as defence in depth against a git version/behavior this structural check hasn't foreseen; it is
  only no longer the *sole* signal.
- Do not assume any other `.raw()`/`.revparse()` call in this file or its callers is safe from this same
  trap without checking whether it reads output vs. relies on rejection — the other `-q --verify` sites in
  `worktrees.ts`/`mainline-watch.ts`/`batch-merge.ts` already read output correctly, but a new quiet-flag
  call added later must do the same.

## Source

`packages/daemon/src/git/reader.ts`, `GitReader.log()` — fixed on card `a6f84660`.
