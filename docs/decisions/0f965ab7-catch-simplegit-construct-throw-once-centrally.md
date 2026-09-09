# 0f965ab7 — Catch simple-git's synchronous construct throw once, centrally, via a stub proxy

## Narrative

`simpleGit(repoPath, ...)` throws `GitConstructError` SYNCHRONOUSLY when `repoPath` doesn't exist or isn't a directory (verified directly against the installed simple-git, with an existing-dir control that constructs fine — board card `0f965ab7`). Every caller of `boundedGit`/`boundedMergeGit`/`boundedDiffGit` in this file documents its own fail-safe contract on error/timeout ("FAIL SAFE", "FAILS CLOSED", "best-effort, logged not fatal", …) by wrapping the git CALLS it makes in its own try/catch — but a synchronous throw from CONSTRUCTING the git handle escapes every one of those (they only guard the calls made inside them), rejecting the function outright instead of honouring its documented contract.

Two of ~nine affected callers (`worktreeHasWork`, `findLandedSquashCommit`) were each individually patched to wrap their own construct call — the exact "an invariant the next caller can forget" shape that let the other seven regress. Rather than add seven more per-caller wraps, `gitConstructFailure` catches the construct throw ONCE, centrally: `git` degrades to a stub whose every method returns the SAME rejected promise the construct threw, so a caller's existing `await withTimeout(git.<method>(...), ...)` inside its own try/catch sees this as an ordinary async git failure — indistinguishable from a timeout or a real git error — and no caller needs to change. `listCheckedOutBranches` is UNCHANGED by this: it has no try/catch of its own around its git call, so the (now-async, previously-sync) rejection still propagates out of it uncaught, exactly as its doc says it must.

## Do not

- Do not add a per-caller try/catch around a `simpleGit(...)` construct call as the fix for a new caller hitting this — route it through `boundedGit`/`boundedMergeGit`/`boundedDiffGit`, which already apply `gitConstructFailure` centrally.
- Do not assume every caller wraps its own construct call — `listCheckedOutBranches` deliberately does not, and the sync-to-async conversion here must keep propagating uncaught for it.

## Consequences

A construct-time throw is now indistinguishable from any other async git failure to every existing caller, so the fail-safe contract each caller already documents (FAIL SAFE / FAILS CLOSED / best-effort) is honoured uniformly instead of being defeated by an escaping synchronous throw. The one caller with no try/catch of its own is unaffected by design.

## Source

Inline comment in `packages/daemon/src/git/worktrees.ts`, `gitConstructFailure`'s own doc comment (~line 134), as of commit `f8d18a2cbc315a3020b962ac7e85cf2194ca09ba`. Relocated by card `5b001dde`; wrapped source lines joined into a flowing paragraph, `*` comment markers stripped, no wording changed. The `⚠️` guard on `then`/`catch`/`finally` resolving to `undefined` (not a rejecting function) stays inline at the source as a compressed class-A note — see that anchor.
