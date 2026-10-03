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

Consolidation note (declined here, flagged for its own card): four other fs-only gitdir-then-commondir
walks already exist in this codebase — `skills/inject.ts`'s `resolveGitCommonDir`,
`vault/versioner.ts`'s `resolveLeaseGitDir`, `git/repo-lock.ts`'s `resolveGitMainCheckoutRootSync`, and
`pty/codex-doctrine.ts`'s `resolveGitCommonDirForDoctrine` (a literal duplicate of the `skills/inject.ts`
one). None return both `privateDir` and `commonDir` together, none are `async`, and none share this
fallback: `resolveGitCommonDir` and `resolveGitCommonDirForDoctrine` return `null` on a missing
`commondir` file (so a submodule-shaped repo silently gets no `info/exclude` hiding — a pre-existing,
unrelated limitation, out of scope here); `resolveLeaseGitDir` returns `privateDir` with no commondir
indirection at all (correct for ITS use — a per-worktree pause-lease file — wrong for ref resolution);
`resolveGitMainCheckoutRootSync` returns a CHECKOUT ROOT (a directory above the git dir, with its own
basename-is-`.git`/nested-`.git` disambiguation), not a readable-files dir, and falls back to the
worktree's own toplevel rather than `null`. None was reused; migrating any of them was ruled explicit
scope creep for this card.

## Do not

- Do not make this function's missing-`commondir` fallback `null` "for safety" — that's the regression
  this record exists to prevent: a submodule or `--separate-git-dir` canonical repo has no `commondir`
  file BY DESIGN (there is no indirection to follow), and `null` there would make its ref resolution
  permanently fail instead of correctly resolving in `privateDir`.
- Do not migrate `skills/inject.ts#resolveGitCommonDir`, `vault/versioner.ts#resolveLeaseGitDir`,
  `git/repo-lock.ts#resolveGitMainCheckoutRootSync`, or `pty/codex-doctrine.ts#resolveGitCommonDirForDoctrine`
  onto this helper as a side effect of an unrelated change — each has its own call-site-specific
  behavior (see Design above); a real consolidation needs its own card that audits all four behavioral
  differences at once, not a drive-by swap.
- Do not add a `git` subprocess call anywhere in this resolution — it sits on the merged-map/diff-cache
  hot path specifically to avoid one; see `readBaseSha`'s own doc for why a non-`"HEAD"` unresolvable
  base bypasses the cache entirely instead.

## Tests

`packages/daemon/test/merged-map-gitfile-canonical-repo.mjs`: a plain-directory `.git` control (byte-
identical to pre-fix behavior), a linked-worktree fixture (gitfile + `commondir`, both absolute and
relative `gitdir:` forms), and a submodule/`--separate-git-dir` fixture (gitfile, no `commondir`) —
each proving the merged-map cache invalidates after a simulated new commit (a changed `refs/heads/<branch>`
sha), plus a packed-refs-only variant resolved through `commonDir`.
