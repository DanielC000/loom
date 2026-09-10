# 3a833d94 — the conventional-type guard mirrors the entity guard because a bad type LOOKS valid to the coercion net

## Narrative

`checkTitleConventionalType` (returns `{error, type, allowed}`) rejects a title carrying a `type(scope):`-shaped prefix whose `type` is NOT one of `CONVENTIONAL_TYPES`, unless `allow` is explicitly true. It mirrors `checkTitleHtmlEntities`'s shape exactly (same escape-hatch convention, same "never silently rewrite" posture) — this is the SAME argument as card `267fd215`, applied to a second way a SOLO merge's verbatim-title-as-squash-subject turns an authoring slip into permanent mainline history.

A title typed as `design(pty): …` is not bare prose to the merge-time coercion net (`toConventionalSubject`, `git/worktrees.ts`) — it already LOOKS conventional, so the net leaves it untouched-but-invalid rather than fixing it (the net only fixes BARE prose with no type-shaped prefix at all). A caller who never inspects the merge review's `coerced`/`commitSubject` fields — as this card's own filer very nearly didn't — ships it as-is, with a bogus type permanently on mainline.

## Do not

- Do not assume the merge-time coercion net (`toConventionalSubject`) catches an invalid `type(scope):`-shaped prefix — it only fixes BARE prose with no prefix at all; an already type-shaped-but-invalid prefix ships untouched.
- Do not diverge this guard's escape-hatch convention from `checkTitleHtmlEntities`'s — same shape, same posture, deliberately.

## Consequences

A title carrying an unrecognized Conventional Commits type prefix (e.g. `design(pty): …`) is rejected at the write boundary instead of silently shipping as a permanent, invalid-type mainline commit subject — closing the gap the merge-time coercion net structurally cannot close on its own.

## Source

Inline JSDoc in `packages/daemon/src/tasks/title-guard.ts`, above `checkTitleConventionalType` (lines 115-129 as of this tranche's HEAD, prior to compression). Wrapped source lines joined into a flowing paragraph, `*` comment markers stripped, no wording changed.
