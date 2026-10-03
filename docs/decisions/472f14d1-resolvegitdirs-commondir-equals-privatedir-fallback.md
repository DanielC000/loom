# 472f14d1 — `resolveGitDirs`'s missing-`commondir` fallback is `commonDir = privateDir`, not `null`

## Narrative

`readHeadSha`/`readRefSha`/`readBaseSha` (`git/worktrees.ts`, feeding the merged-commit-map cache and the
worker-diff cache) assumed a canonical repo's `.git` is always a DIRECTORY. When it's a FILE — a linked
worktree used as the canonical repo, a submodule, or a `--separate-git-dir` repo — `readHeadSha` threw,
was caught, and returned `null`. For `readBaseSha`'s `base === "HEAD"` branch that degrades to the
constant freshness key `"-"`, which the merged-map cache then serves forever: the cache never
re-validates against a new commit on such a repo.

Checked first whether this shape is even reachable: it is. `isGitRepo` (`git/reader.ts`) validates a
repo via the real `git` binary's own `checkIsRepo()`, which resolves `.git` gitfile pointers natively, so
project creation / `validateRepoRegistry` happily binds a gitfile-shaped canonical repo. `canonicalGit`
never inspects `.git`'s shape either. `createWorktree` itself already only checks `.git` EXISTENCE (never
directory-ness) for the worktrees it creates, because `git worktree add` always makes a new worktree's
own `.git` a gitfile pointer — so this shape is already normal and handled everywhere else in this file;
only these three HEAD/ref readers assumed otherwise.

## Design

`resolveGitDirs(repoPath)` resolves two roles, fs-only, no `git` spawn:
- `privateDir` — where THIS checkout's own per-checkout files live (`HEAD`, `index`, `logs/HEAD`).
- `commonDir` — where SHARED refs live (`refs/**`, `packed-refs`).

For an ordinary repo (`.git` a directory) the two are the same directory. For a `.git` FILE, `privateDir`
is the `gitdir: <path>` target. If that target has its own `commondir` file (a git-managed LINKED
WORKTREE), `commonDir` resolves from it. **If it does not** (a SUBMODULE's `.git` pointer, or a
`--separate-git-dir` repo — neither of which indirects through a `commondir` file at all), `commonDir` is
set to `privateDir` itself, not `null`: for both of those shapes, `HEAD`, `refs/**` and `packed-refs` all
live directly in that one directory, exactly where real git itself reads them from. Returning `null` here
instead would make every submodule/`--separate-git-dir` canonical repo's ref resolution silently never
resolve (permanent cache-bypass or permanent `"-"`-key staleness, depending on the caller), even though
the real answer is sitting right there in `privateDir`.

Consolidation (card 25389c3c, done): of the four other fs-only gitdir-then-commondir walks that existed
alongside this one — `skills/inject.ts`'s `resolveGitCommonDir`, `vault/versioner.ts`'s
`resolveLeaseGitDir`, `git/repo-lock.ts`'s `resolveGitMainCheckoutRootSync`, and `pty/codex-doctrine.ts`'s
`resolveGitCommonDirForDoctrine` (a literal duplicate of the `skills/inject.ts` one) — only the two
literal duplicates genuinely wanted this function's own semantics (commonDir, with the privateDir
fallback) and have been migrated onto a shared SYNC twin, `git/repo-lock.ts`'s `resolveGitDirsSync`
(both of their own local copies had exactly this function's pre-fix bug: `null` instead of `privateDir`
on a missing `commondir` file, so `info/exclude` hiding silently no-opped for a submodule-shaped canonical
repo — real, though narrow: only a repoPath-cwd session, manager/platform/setup/auditor, bound to a repo
that is itself a submodule or `--separate-git-dir` checkout; never a worker, whose worktree always has a
`commondir` file). `resolveLeaseGitDir` and `resolveGitMainCheckoutRootSync` were NOT migrated — each
genuinely wants different semantics (see their own doc comments): a per-worktree pause-lease file must
stay in `privateDir` with no commondir indirection, and the main-checkout-root resolver returns a
different shape (a directory, not a readable-files dir) with its own claude-CLI-mirroring disambiguation.
`resolveGitDirsSync` and this function (`resolveGitDirs`) must stay byte-identical in behavior —
`test/gitdirs-sync-async-parity.mjs` asserts this directly across the same fixture matrix.

## Do not

- Do not make this function's missing-`commondir` fallback `null` "for safety" — that's the regression
  this record exists to prevent: a submodule or `--separate-git-dir` canonical repo has no `commondir`
  file BY DESIGN (there is no indirection to follow), and `null` there would make its ref resolution
  permanently fail instead of correctly resolving in `privateDir`.
- Do not migrate `vault/versioner.ts#resolveLeaseGitDir` or `git/repo-lock.ts#resolveGitMainCheckoutRootSync`
  onto this helper (or its sync twin) — each has its own call-site-specific behavior (see Design above),
  already audited once by card 25389c3c and found genuinely different.
- Do not reintroduce a local gitdir/commondir-walking copy in `skills/inject.ts` or `pty/codex-doctrine.ts`
  — both now call `git/repo-lock.ts`'s `resolveGitDirsSync` (card 25389c3c); a new local copy would just
  regrow the exact missing-commondir bug this record exists to prevent.
- Do not add a `git` subprocess call anywhere in this resolution — it sits on the merged-map/diff-cache
  hot path specifically to avoid one; see `readBaseSha`'s own doc for why a non-`"HEAD"` unresolvable
  base bypasses the cache entirely instead.

## Tests

`packages/daemon/test/merged-map-gitfile-canonical-repo.mjs`: a plain-directory `.git` control (byte-
identical to pre-fix behavior), a linked-worktree fixture (gitfile + `commondir`, both absolute and
relative `gitdir:` forms), and a submodule/`--separate-git-dir` fixture (gitfile, no `commondir`) —
each proving the merged-map cache invalidates after a simulated new commit (a changed `refs/heads/<branch>`
sha), plus a packed-refs-only variant resolved through `commonDir`.

Card 25389c3c added: `test/gitdirs-sync-async-parity.mjs` (the same fixture matrix run through both
`resolveGitDirs` and `resolveGitDirsSync`, asserting identical results), `test/skills-inject-submodule-exclude.mjs`
(RED-first: a submodule-shaped canonical repo's `.claude/skills` was never excluded before the fix), and
the equivalent addition to `test/codex-doctrine-injection.mjs` for `AGENTS.md`.
