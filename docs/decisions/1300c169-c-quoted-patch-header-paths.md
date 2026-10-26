# 1300c169 — unquote C-quoted `+++`/`---` patch header paths in the unanchored-comment detector

From fdf09672's Code Review (session 7b67f7b5), finding 2. fdf09672 added `-c core.quotepath=false` to
`detectUnanchoredAddedCommentBlocks`'s scoped `diff` call, which suppresses git C-quoting a *non-ASCII*
path — but `core.quotepath` only controls that one case. A path containing a TAB, `"`, `\`, or another
control character is C-quoted by git's `quote_c_style` **regardless of `core.quotepath`** — verified on
real git 2.47 (`+++ "b/a\tb.ts"`, `+++ "b/q\"x.ts"`). `parseAddedLineNumbers`'s `^b\/`-strip ran against
that raw quoted text, which never matched the real file, so the detector silently found nothing for such
a path. It fails open (the detector is advisory-only), and such names are reachable only on POSIX (NTFS
forbids `"` and TAB in a real on-disk filename).

## Verifying real git's quoting on a host where the name can't exist on disk

NTFS rejects a literal TAB/`"` in a filename, so this can't be reproduced with `fs.writeFileSync` on a
Windows dev host. `git update-index --add --cacheinfo <mode>,<blob-sha>,<path>` writes an index entry with
an arbitrary `<path>` STRING directly — no filesystem call for the name at all — but git's own
`core.protectNTFS` (on by default on every platform, not just Windows) separately refuses `--cacheinfo`
for a path containing these characters; `-c core.protectNTFS=false` on that ONE call lifts it. Verified
that NO override is needed afterward — a plain `git commit`/`git diff`/`git show` against an
already-staged such entry works unmodified, since none of those touch a real path on disk. This made a
genuine, real-git, end-to-end regression test possible on every host, win32 included, with no SKIP.

## The fix: `unquoteGitPath` — reverse git's C-style quoting (quote.c's `quote_c_style`)

Chosen over the card's other proposed option (keying hunks off a NUL-safe source): there is no git flag
that makes the FULL unified patch (hunks, not just the numstat/name-status summary) NUL-safe —
`fdf09672`'s own decision record already established `-z` has no effect on `+++`/`---`/`diff --git`
lines. The only NUL-safe alternative would be correlating a separately-fetched ordered file list against
the unified patch's own `diff --git` block order — fragile (relies on two separate git invocations
agreeing on ordering, and breaks down for files with no `+++`/`---` at all, e.g. pure renames) compared to
directly reversing a well-specified, already-reverse-engineered quoting scheme.

`unquoteGitPath` decodes the named escapes (`\a \b \t \n \v \f \r \" \\`) plus 3-digit octal (`\NNN`),
accumulating consecutive octal bytes and UTF-8-decoding them together (needed for a multi-byte character
split across octal escapes, e.g. `é` as `\303\251` under `core.quotepath=true` — not reachable at this
call site today, since it always passes `quotepath=false`, but decoded correctly anyway for robustness).
An unescaped character is passed straight through as the literal JS string character it already is —
never re-encoded through the byte path — since `core.quotepath=false` means any real multi-byte UTF-8
text inside a quoted segment (quoted for an unrelated reason, e.g. a TAB elsewhere in the same name)
arrives already decoded by Node, not as individual raw bytes.

## Do not

- Do not assume `-c core.quotepath=false` is sufficient to never need `unquoteGitPath` — it only
  suppresses the non-ASCII case; TAB/`"`/`\`/control characters quote unconditionally.
- Do not reach for `git diff -z` to make the full unified patch NUL-safe — it has no such effect (see
  fdf09672's own record); `-z` only ever applies to `--numstat`/`--name-status`'s own summary records.
- Do not construct a TAB/`"`-named real test fixture via `fs.writeFileSync` — NTFS refuses it. Use
  `git update-index --add --cacheinfo` with `-c core.protectNTFS=false` on that one call instead; no
  override is needed on any later read/commit against the same entry.
