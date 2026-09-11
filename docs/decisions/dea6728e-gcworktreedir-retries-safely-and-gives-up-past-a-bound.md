# dea6728e — `gcWorktreeDir`'s removal chokepoint was widened by `b6d41db1` to be the ONE place the nested-repo guard lives

## Narrative

`gcWorktreeDir` is the single removal chokepoint shared by `finalizeMerge`, boot-reconcile Pass B's two GC sites, and the background wedge sweep (task dea6728e). Card b6d41db1's follow-up widened it to be the ONE place the nested-repo guard lives, so all four callers inherit it — a guard planted only in `finalizeMerge` left the other three force-removing past a nested clone with no scan at all, the exact same data-loss shape via a sibling path.

The chokepoint's own retry/give-up behavior (what it does with a wedged worktree, when it gives up) stays inline in `packages/daemon/src/sessions/service.ts`, right after this record's anchor; that inline text is the current, authoritative description and is not restated here.

## Do not

- Do not add a second removal call site that bypasses `gcWorktreeDir` — the nested-repo guard (card b6d41db1) lives in exactly ONE place because a guard planted only in `finalizeMerge` previously left three other callers force-removing past a nested clone with no scan at all.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts`, `gcWorktreeDir`'s own doc comment (the single-chokepoint/widened-by-b6d41db1 history only): originally the parenthetical inside lines 16298-16303, as of this tranche's HEAD (tranche 62). The function's own retry/give-up contract description was kept inline per lead review and is not part of this record's extracted text.
