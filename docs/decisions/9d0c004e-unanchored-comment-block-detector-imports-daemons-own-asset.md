# 9d0c004e — the unanchored-comment-block detector imports the DAEMON'S OWN packaged comment-anchor-lint.mjs, never a worktree's copy, via a scoped direct git diff/show, never `diffBranch`'s own `files:` option

## Why (three failure modes found in code review)

An earlier version of `detectUnanchoredAddedCommentBlocks` dynamically imported the WORKTREE's own copy
of `comment-anchor-lint.mjs`, so a worker's branch was judged by its own (possibly edited) rules. Code
review found this untrustworthy on both axes it touches: the untrusted CONTENT being imported, and the
process-wide, per-URL nature of Node's ESM module cache.

- A worktree copy containing a top-level `await new Promise(() => {})` (deliberate or accidental) hangs
  `worker_report(done)`/`reviewWorkerMerge` forever — the diff's own bounded timeout covers only the git
  call, never `import()` itself.
- A syntactically-valid but pathologically-looping `extractCommentBlocks` (e.g. a half-edited branch)
  would freeze the daemon's entire single-threaded event loop, for every project sharing that daemon
  process, not just the branch that shipped the loop.
- Node's ESM loader caches a module per URL for the process's lifetime: a second call against the SAME
  worktree replays a STALE copy even after the worktree's own file changes, and each DISTINCT worktree
  path mints its own permanent module graph that is never released.

## Decision

Import ONLY this daemon's OWN packaged `packages/daemon/assets/comment-anchor-lint.mjs`
(`COMMENT_ANCHOR_LINT_SCRIPT`, `paths.ts`), resolved the same way `RELAY_SCRIPT` is, exactly ONCE per
process, memoized (`loadCommentAnchorLintModule`, `git/unanchored-comment-blocks.ts`). Every worker's
branch, every project, is judged by whatever linter rules THIS daemon process currently has installed —
never a worktree's own copy, edited or not.

**Accepted trade-off:** the advisory's rules (the line threshold, the block-grouping algorithm) are frozen
at whatever this daemon process loaded at its own first use, until its next restart. A branch that itself
edits `comment-anchor-lint.mjs` does not see its own edited rules reflected in this advisory — only in the
PostToolUse hook (which reads live, per-invocation, from the file being edited) and the merge-gate lint
itself.

## Scoping against decision dbad4b59

`dbad4b59` forbids `mcp/decisions.ts` importing `assets/decision-records.mjs`, to preserve that asset's
independence from `dist/` (an agent-facing MCP tool depending on a hook script would couple two things
meant to evolve separately). This module's import does not violate that: `comment-anchor-lint.mjs` still
imports nothing from the daemon, so its own dist-independence is untouched.

The coupling this decision DOES introduce runs the other direction: the daemon's compiled `dist/` now
depends on this asset's EXPORTS (`extractCommentBlocks`/`isInScope`/`DEFAULT_MIN_LINES`) staying named and
shaped as expected. Because `loadCommentAnchorLintModule` fails SAFE on a missing/renamed export (the
advisory just goes silently disabled, matching this detector's own advisory-only contract), a rename could
otherwise disable the whole advisory with no error anywhere.
`test/unanchored-comment-blocks-asset-contract.mjs` is the backstop: it imports the REAL packaged asset and
asserts those three exports exist with the expected shapes, so a rename fails loudly at the gate instead of
silently degrading a live feature.

## Cost: why the patch is fetched via a direct scoped `git diff`, never `diffBranch`'s own `files:` option

`diffBranch`'s `files`/`pathGlob` filter re-derives its OWN fresh `diffSummary` internally and maps over
THAT summary's own `.file` values to build the real `git diff -- <paths>` pathspec. For a renamed file,
`git diff --stat`'s summary rendering collapses the rename into `{old => new}` (or `old => new`) — neither
a real path nor a valid git pathspec — so routing a rename-aware candidate list through `diffBranch`'s
`files:` option would still end up passing THAT unusable bracket string as the pathspec, silently dropping
the renamed file from the scoped fetch. That is the exact rename bug `normalizeDiffstatPath` exists to fix,
reintroduced through a second door. This detector instead issues its own bounded, direct `git diff -- <paths>`
call (via `boundedSimpleGit`), using paths it already normalized itself — never re-derived a second time
inside `diffBranch`.

## Do not

- Do not go back to importing a worktree's own copy of `comment-anchor-lint.mjs` — see the three failure
  modes above; a hang or a freeze from untrusted branch content is not an acceptable cost for an advisory.
- Do not remove `test/unanchored-comment-blocks-asset-contract.mjs` without an equivalent replacement — it
  is the only thing that makes a silent export rename of the packaged asset visible.
- Do not route the scoped patch fetch through `diffBranch`'s own `files`/`pathGlob` option — it re-derives
  a fresh diffstat internally and reintroduces the rename bug this record exists to explain.
