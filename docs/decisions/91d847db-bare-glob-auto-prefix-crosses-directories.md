# 91d847db — A bare leading-`*` glob with no `/` is auto-prefixed to cross directories

## Narrative

`pathGlobToRegExp` translates a glob (supporting `**`, `*`, `?`) to an anchored RegExp matched against a POSIX, repo-relative path. `**` (optionally `/`-bounded) crosses directories and may match zero segments; `*`/`?` stay within a single segment. No `{a,b}` brace expansion — the surface is kept small and predictable. (Deliberately a small local copy rather than importing `mcp/repo-read.ts`'s equivalent — this git-layer module shouldn't reach up into the mcp layer for a 15-line helper.)

A BARE leading `*` with no `/` anywhere in the pattern (e.g. `*service.ts`) is auto-prefixed with a `**` + `/` (zero-or-more-dirs) segment before translation: as written, `*` stays within one path segment, so `*service.ts` only ever matches a ROOT-level file and silently misses `packages/daemon/src/sessions/service.ts` — the "matched 0 files, indistinguishable from no changes" trap (task `91d847db`). A caller writing a bare filename glob almost always means "match this file anywhere," so that's the least-surprising behavior. Patterns that already scope a directory (contain `/`) or already cross boundaries (start with `**`) are left untouched — only the fully-bare, single-segment case is rewritten.

## Do not

- Do not remove the bare-leading-`*` auto-prefix as "unnecessary magic" — without it, a bare filename glob silently matches nothing for any file not at the repo root, which is indistinguishable from "no changes" to a caller.
- Do not widen the rewrite to patterns that already contain `/` or already start with `**` — those are left untouched by design; only the fully-bare, single-segment case needs correcting.

## Consequences

A deny-glob or diff-status matcher written as a bare filename (e.g. `*service.ts`) now correctly matches that filename anywhere in the repo tree, instead of silently matching nothing outside the repo root.

## Source

Inline comment in `packages/daemon/src/git/worktrees.ts`, `pathGlobToRegExp`'s own doc comment (~line 1893), as of this worktree's HEAD before this extraction. Wrapped source lines joined into a flowing paragraph, `*` comment markers stripped, no wording changed.
