# 03fbb126 — comment-anchor-lint scans any project's layout, and markdown HTML-comment blocks are not "comment blocks"

`packages/daemon/assets/comment-anchor-lint.mjs` ships to every project (PostToolUse hook + CLI scan, gated on
`docLint`) but used to scope itself with a hardcoded `SOURCE_ROOTS` list — Loom's own `packages/{daemon,web,shared}`
layout. In any other project every path failed that prefix test, so the hook was a silent no-op and every
whole-repo check scanned nothing, while the asset looked generic.

## Ruling 1 — layout-agnostic (option A), not "Loom-only tooling" (option B)

Scope is now the whole repo minus exclusions: `node_modules`, `dist`, `build`, `.turbo`, `.next`, `.cache`,
`coverage`, `.git`, `.loom`, `worktrees`, the repo-ROOT `docs/` only (record stores plus frozen investigation scripts; not matched at depth, so `src/docs/x.ts` stays in scope), any dot-directory (tool state or a mirror such as `.claude/skills`,
which would double-count anchors), and `test`/`tests`/`e2e` (a DEFAULT: fixtures plant synthetic anchor ids with
no record by design). Extensions are the `//` + `/* */` family `extractCommentBlocks` can group. The hook's
`isInScope` stays a pure per-path string test (no fs), so per-tool-call cost is unchanged; only the CLI/
`computeReport` walk touches the tree, bounded by `MAX_WALK_FILES` (20_000, parity with `mcp/decisions.ts`),
and a capped walk sets `walkTruncated` on the report and prints a stderr warning — never a silent partial scan.

The hook resolves its repo root by walking up to the nearest `.git` (`resolveHookRepoRoot`), the same as
`decision-records.mjs`'s `findRepoRoot` and the daemon's store gate (card a4760fc8); a project bound to a
subfolder of a larger repo otherwise reads `docs/<kind>` at the wrong root and reports every anchor as an orphan.

## Ruling 2 — HTML-comment blocks in `.md` do NOT count as comment blocks

`.md` stays out of the source extensions, so `extractCommentBlocks`, `unanchoredLongBlocks` and the diff-scoped
unanchored-long-comment warning (card 9d0c004e, which reuses `isInScope`) stay inert on notes. A note's prose is
content, not comment bloat; a long `<!-- -->` block in a vault note is not narrative that should be extracted.
The markdown anchor form `<!-- @decision <id> — … -->` is resolved by `decision-records.mjs`, not by this script.

## Do not

- Do not reintroduce a hardcoded package-layout root list — it makes the asset a silent no-op outside one repo.
- Do not add `.md` (or any prose format) to `SOURCE_EXTENSIONS` to "make markdown work": it turns every long
  note paragraph wrapped in an HTML comment into a flagged violation, and makes the 9d0c004e warning noisy on vaults.
- Do not remove the `walkTruncated` signal or the walk cap: an uncapped walk of a huge repo is unbounded, and a
  capped one that says nothing reads as a clean scan.
- Do not make the hook's root resolution diverge from `decision-records.mjs`'s `findRepoRoot`.
