# fdf09672 — parse diffstat paths from `-z` machine-readable output, never `--stat`/`--numstat`/`--name-status` display text

From card c7dc99bf's fourth Code Review (reviewer 7fb963b2). `normalizeDiffstatPath`/`diffstatRenameSource`
(deleted by this card) parsed `git diff --stat`'s DISPLAY rendering of `allFiles` (itself built from
simple-git's `diffSummary()`, confirmed by reading that package's own bundled source to run
`git diff --stat=4096 <range>`). Verified empirically (real git, hex-dumped, not assumed from docs) that
this display text carries two defects, and that plain `--numstat`/`--name-status` WITHOUT `-z` carry the
same defects:

- A non-ASCII path is C-quoted under the default `core.quotepath` (`"caf\303\251.txt"` for `café.txt`),
  which is a literal octal-escaped string, not the real path — never matches the real file as a pathspec.
- A rename is collapsed into display text: `--stat` uses `{old => new}` (common-prefix form) or
  `old => new` (whole-path form); plain `--numstat`/`--name-status` (no `-z`) always use the whole-path
  `old => new` form, with no bracket-collapsing at all. Neither is a valid pathspec, and the bracket form
  additionally collides with a REAL filename containing literal `{`/`}` (e.g. a cookiecutter-style
  `{{tpl}}/a.txt` becomes `{tpl}/a.txt` under `normalizeDiffstatPath`'s own brace-scanning).

Only adding `-z` removes both defects, verified the same way: under `-z`, a non-ASCII path's raw UTF-8
bytes come through unquoted (no `-c core.quotepath=false` needed — matching `machineReadablePathSet`'s
own, card c7dc99bf, prior finding for `--name-status -z`), and a rename row's own path FIELD goes EMPTY
(the byte right after the counts' second tab is the NUL terminator) with the real old/new names following
as two SEPARATE NUL-terminated tokens immediately after — never collapsed into any text form at all.

## The exact `--numstat -z` record shape (verified via hex dump)

- Non-rename, non-binary: `<ins>\t<del>\t<path>\0`
- Non-rename, binary: `-\t-\t<path>\0` (literal dash characters, not zero)
- Rename (regardless of binary/content-change): `<ins>\t<del>\t\0<old-path>\0<new-path>\0` — i.e. the
  "path" field between the second tab and the next NUL is empty, and the real paths are the NEXT two
  NUL-terminated tokens. Copy rows (`C`) are never produced by a plain `git diff` without an explicit
  `-C`/`--find-copies` flag, so only renames are expected to reach this shape in practice.

`parseNumstatZ` matches the `<ins>\t<del>\t` prefix by regex against the whole head token (never splits
positionally on the first two tabs), so a filename containing a literal tab (pathological, POSIX-only)
cannot desync the walk.

## Consumers fixed (4 sites, the card named only 2) — NOT every `diffSummary`/display-text caller

`workerDiff` (`worktrees.ts` ~L8284/~L8306) still calls `git.diffSummary()` twice (the live-worktree and
merged-branch arms) and was reviewed and deliberately left alone: it only ever reads
`summary.files.length`/`.insertions`/`.deletions` (aggregate counts for the orchestration-view diff), never
a per-file `.file` path — so it carries neither the C-quoting nor the rename-collapse defect this card
fixes. The 4 sites below are every PATH-IDENTITY consumer, not every `diffSummary` caller.

1. `diffBranch`'s core diffstat (`worktrees.ts`, feeds `allFiles`/`files`) — was `git.diffSummary()`
   (`--stat=4096`); now `git.raw(["diff", "--numstat", "-z", range])` + `parseNumstatZ`.
2. `diffNameStatus` (deny-glob status enrichment, `includeStatus` opt) — was `git.raw(["diff",
   "--name-status", range])` with no `-z`; now adds `-z` and tokenizes on NUL directly (still skips a
   rename/copy row exactly as before — attribution across a rename is inherently ambiguous).
3. `detectUnanchoredAddedCommentBlocks` (`unanchored-comment-blocks.ts`) — consumed `diffBranch`'s
   `allFiles` via `normalizeDiffstatPath(f.file)`; now reads `f.file` directly (already the real path).
4. `diffOwedLanding` (card 13fc5227, the HELD-branch "late range" review diffstat) — was a hand-rolled
   `/^(\d+|-)\t(\d+|-)\t(.+)$/` line parse over plain `--numstat` (no `-z`, no rename handling at all —
   would have pushed the literal `"old => new"` text as `file`); now `-z` + `parseNumstatZ`.

## A 5th site, found while writing the regression tests: the unified PATCH's own `+++`/`---` lines

`-z` fixes the three machine-readable record formats (`--numstat -z`, `--name-status -z`), but it has NO
effect on a unified PATCH's own `diff --git`/`+++`/`---` header lines — verified on real git: those stay
C-quoted under the default `core.quotepath` even when `-z` is also passed. `detectUnanchoredAddedCommentBlocks`
(`unanchored-comment-blocks.ts`) reads exactly those lines via `parseAddedLineNumbers` to key its own
added-lines map by filename — a non-ASCII filename's `+++ "b/caf\303\251.ts"` line never matched the real
`café.ts` key, so the detector silently found nothing (caught by this card's own new non-ASCII regression
test, scenario (I), which failed before this fix). Only `-c core.quotepath=false` (also a GLOBAL flag,
also must precede the subcommand — combines with `--literal-pathspecs` in either order, verified) fixes
the patch text itself. Added to `unanchored-comment-blocks.ts`'s scoped patch call (where it's load-bearing
for correctness) and to both of `diffBranch`'s own patch-producing calls (filtered and unfiltered — the
manager-facing `fullDiff:true` patch display carries the same quoting otherwise, even though nothing
downstream re-parses it today).

## `--literal-pathspecs`

Folded into the two call sites that build a `--` pathspec from these real, git-output-derived paths and
hand it to a FURTHER git call: `diffBranch`'s filtered-patch build and
`detectUnanchoredAddedCommentBlocks`'s scoped patch build. Verified on real git that `--literal-pathspecs`
is a GLOBAL flag and must precede the subcommand (`git --literal-pathspecs diff …`, never `git diff
--literal-pathspecs …`) — same ordering `codex-auto-commit add`'s own `--literal-pathspecs` use already
established in this file. Verified discriminating: a pathspec literally `a*.txt` against two real files
`a1.txt`/`a2.txt` matches BOTH without the flag (glob-expanded) and matches NEITHER with it (treated as a
literal, non-existent name) — the case now pinned by the `a*.txt` regression tests.

Not applied anywhere else: the manager-supplied `files`/`pathGlob` filter values are matched entirely in
JS (`.includes()`/`pathGlobToRegExp` + `RegExp.test()`) against `allFiles`, never handed to git directly —
only the REAL file names that SURVIVE that JS-side filter are later used to build a git pathspec, so a
manager's own glob is never defeated by this flag. `diffBranch`'s own core stat call, its unfiltered patch
call, `diffNameStatus`'s call, and `diffOwedLanding`'s call all pass a revision range/two tree ids with no
`--` pathspec at all, so the flag is a no-op there and was not added.

## `diffBranch`'s `files:`/`pathGlob` filter — behavior change, not a regression

Before this card, the `files:` substring filter matched against the RAW `--stat` display text, which for
a rename happened to contain BOTH the old and new names (as the `"old => new"` string) — so searching for
the old name worked, by accident, because the string being searched was a concatenation of both names
joined by `" => "`. After this card, `f.file` is always the clean real (post-rename) path, and matching
the old name explicitly checks the new `f.renameFrom` field instead. The old behavior was never a
documented contract (`worker_merge`'s own tool description: `files` is "an array of exact/substring path
matches"; no mention of display-text artifacts) and could pathologically over-match across the `" => "`
boundary (a needle spanning both names' text). No caller is known or found to rely on the old accidental
behavior; the new behavior is strictly more precise while preserving the only INTENTIONAL capability
(matching either the old or new name of a renamed file).

## Do not

- Do not reintroduce a parse of `--stat`/`--numstat`/`--name-status` DISPLAY text (no `-z`) anywhere for a
  path identity, even for a "simple" display-only use (`diffOwedLanding` was exactly this, and still had
  real defects) — always add `-z` and go through `parseNumstatZ` (or, for a status-letter need, the same
  NUL-tokenizing discipline `diffNameStatus` now uses).
- Do not assume `-z` protects a unified PATCH's own `+++`/`---`/`diff --git` lines from C-quoting — it
  does not (verified on real git). Any code that parses those lines for a path (like
  `parseAddedLineNumbers`) needs `-c core.quotepath=false` on that SAME call, not `-z`.
- Do not add `--literal-pathspecs` to a call that only takes a revision range/tree id with no `--`
  pathspec — it is a no-op there and adding it everywhere "for consistency" obscures which calls actually
  need it.
- Do not add `--literal-pathspecs` to a call whose pathspec is a manager/user-supplied glob meant to be
  interpreted (there is no such call today — `diffBranch`'s own `pathGlob`/`files` options are matched in
  JS, never handed to git) — if one is ever added, it must NOT get this flag.
- Do not place `--literal-pathspecs` after the subcommand (`git diff --literal-pathspecs …`) — it is a
  GLOBAL option and must precede it; simple-git's own `.diff()`/`.add()` task helpers always prepend the
  subcommand first, so a call needing this flag must go through `.raw([...])` with the flag listed first.
