# 245a3708 — one command replaces the unmaintained `grep -l readdirSync` folk recipe

## Narrative

WHY THIS EXISTS: `CLAUDE.md` documents `grep -l readdirSync packages/daemon/test/*guard*.mjs` BY NAME as an unmaintained folk recipe that answers a DIFFERENT question than "which guards does the merge gate always run" — it found its way into six card bodies anyway, because a worker who needs to run "the static guards" had no single command to reach for and reinvented one from memory. This script is that command, so there is nothing left to reinvent.

## Source

Inline comment in `packages/daemon/scripts/run-static-guards.mjs` (header, "WHY THIS EXISTS" paragraph, verbatim). Relocated by card `7fb7a5ba`.

## Section: history of the folk `grep -l readdirSync` recipe (relocated from CLAUDE.md, card `e0ba98c1`)

The `grep -l readdirSync packages/daemon/test/*guard*.mjs` recipe was prescribed verbatim in two agent briefs (`Dev` and `Bugfix`, since corrected). That is a DB-resident instruction surface `git grep` cannot see, which is why it spread unnoticed. It answers a different question than "what does `STATIC_GUARD_REPO_PATHS` name" and drifts independently of it, in BOTH directions, on its own clock: a file's `readdirSync` grep-match flips the moment someone adds or removes that literal call, unrelated to whether the file belongs on the real list. It wrongly INCLUDES a file the list deliberately excludes (e.g. `emit-compare-soundness-guard.mjs`, see its own membership-criterion doc comment) and wrongly OMITS included ones. Which ones is not fixed: as of 2026-09-04 it omitted `working-tree-eol-guard.mjs` and `exit-code-verdict-guard.mjs` (card `5784fb8f`, filed after the prior example, `fixed-wait-witness-guard.mjs`, rotted when that file picked up an unrelated `readdirSync` call).
