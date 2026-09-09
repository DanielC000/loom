# fe848bfc — Why dropping `computeEmitCompareGate`'s second `repoPath` argument is sound

## Narrative

ARG CONTRACT (card `fe848bfc` — this function used to also take a separate `repoPath`, dropped here): `worktreePath` must be a checkout of `ref`, and `baseSha`/`ref` are git revisions resolved from `worktreePath` itself — that precondition is STILL an unenforced caller obligation, exactly as before this card. What's now structural is narrower: there is no longer a SECOND path argument that can disagree with `worktreePath` about which checkout `ref` resolves against. The old two-path signature let a caller pass a DIFFERENT repo as the git cwd than the one `ref` actually checks out — exactly the shape that produced card `d422e279`'s bug (`mergeBatch` passed canonical `repoPath` with the literal ref `"HEAD"`, so `"HEAD"` resolved against canonical's own checked-out branch rather than the batch worktree, silently diffing a sha against itself).

## Why dropping the second path is sound: a REF-CLASS distinction

NOT "a linked worktree shares its parent's object database so any ref resolves identically from either path" — that broader claim is FALSE: shared OBJECTS ≠ shared refs — `HEAD`/`ORIG_HEAD`/`MERGE_HEAD`/`HEAD@{n}`/`@{-1}`/`@{u}` live under `$GIT_DIR/worktrees/<name>/` and are PER-WORKTREE; `git rev-parse HEAD` from a worktree and from its canonical repo can and do disagree, and that exact divergence is what card `d422e279`'s bug depended on.

What actually matters is which class each revision THIS FUNCTION resolves falls into: `baseSha` is always a raw sha (repo-wide, identical from any path); the two solo call sites (`sessions/service.ts`) pass a branch NAME as `ref` (an ordinary ref, shared and identical repo-wide, not a per-worktree symref) — both were already behavior-identical from canonical before this card, and stay so now; the batch call site passes the literal `"HEAD"` — the ONE per-worktree ref in play here — and is now forced onto the only path that was ever correct for it, `worktreePath` itself.

## The coupling this introduces, named, not hidden

Before this card, a wrong `repoPath` could only ever corrupt the git calls this function makes directly (`diff --name-status`/`git show`, via `boundedGit`). `loadExcludedTestDirNames`/`loadNotHermeticNames`/`emitCompareSoundnessOk` were already pinned to `worktreePath` through their OWN separate argument, independent of `repoPath` — a wrong `repoPath` alone could never reach them. Now ONE argument drives all four (the git reads AND those three filesystem reads), so a caller passing the wrong single path corrupts everything at once rather than just the git half. This is a narrower failure surface (one argument left to get wrong, not two that can silently disagree with each other) but not a smaller one at a given call site. At the two solo sites the mistake is still CONSTRUCTIBLE — a `repoPath` local is in scope one line above the pre-wait classify call, same `string` type, compiles clean — and would be near-silent there: `ref` is a branch name, so the diff itself would stay correct even from the wrong repo, and only the three filesystem reads would silently answer from the wrong checkout, diverging exactly on a diff touching `scripts/test-daemon.mjs` or either tsconfig — both already called load-bearing by those helpers' own doc comments. `emit-compare-branch-capture-order-guard.mjs` pins the first argument at all `computeEmitCompareGate` call sites as `worktreePath` (never `repoPath`) as a static backstop against exactly this near-miss.

## Do not

- Do not reintroduce a second `repoPath` argument to "make call sites more explicit" — the old two-path signature is exactly what produced card `d422e279`'s bug.
- Do not justify this refactor with "a linked worktree shares its parent's object database" — that claim is false for refs (`HEAD` and friends are per-worktree); the real justification is the ref-class distinction above.
- Do not pass a `repoPath` local (still in scope at either solo call site) as the first argument instead of `worktreePath` — `emit-compare-branch-capture-order-guard.mjs` exists specifically to catch that near-miss statically.

## Consequences

A caller can no longer construct the exact two-disagreeing-paths shape that caused `d422e279`'s silent sha-diffed-against-itself bug, at the cost of a single argument now driving four different reads (three filesystem, one git) instead of two arguments each driving a subset — a wrong single path now corrupts everything at once rather than just the git half, a narrower but not smaller failure surface at a given call site.

## Source

Inline comment in `packages/daemon/src/git/worktrees.ts`, `computeEmitCompareGate`'s own doc comment (~line 3011, arg-contract section), as of this worktree's HEAD before this extraction. Wrapped source lines joined into a flowing paragraph, `*` comment markers stripped, no wording changed.
