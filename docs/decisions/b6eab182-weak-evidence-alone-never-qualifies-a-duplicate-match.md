# b6eab182 — a suspected-duplicate match requires a STRONG identifier; weak evidence never qualifies alone

## Narrative

Card b6eab182 (2026-08-06) revised `findSuspectedDuplicate` (`packages/daemon/src/mcp/duplicateDetection.ts`): weak evidence — a code symbol, `file:line` reference, or naming-convention hit, of ANY category, in ANY combination — no longer qualifies a task as a suspected duplicate by itself. This supersedes the module's earlier `MIN_WEAK_CATEGORIES`-based design, which required weak evidence to span at least 2 distinct weak categories (not merely 2 raw tokens) to qualify on its own — the founding p2 pair had cleared that bar via one SCREAMING_SNAKE_CASE constant + one PascalCase symbol (two categories), while "two camelCase symbols from one subsystem" no longer did.

The reason for the revision: unlike the synthetic sampled-draw measurements that justified the earlier design (2.5%–15% per-draw false-positive rate, n=200 pooled across 5×40-card draws), this is 5 REAL spurious create-BLOCKS measured in live usage. The 5th matched on nothing but a bare camelCase-shaped field name (`workerlabel`) plus a `file:line` landmark (`sessions/service.ts:3341`) — i.e. exactly the `MIN_WEAK_CATEGORIES=2` bar clearing on two bare code identifiers.

Per the detector's founding asymmetry — a spurious dedup CONFLICT is loud and self-correcting (the caller sees it and re-files), while a spurious create-BLOCK is silent in the OTHER direction (the finding still exists, but the path of least resistance is to give up filing it) — the tuning now favors false NEGATIVES over false positives: a block requires at least one STRONG identifier (a session id / task id, both full UUIDs, or a Loom branch name) shared with an existing card. Weak (code-symbol / file:line / naming-convention) evidence is retained ONLY as ranking/corroboration context on top of an already-qualifying strong hit (folded into `sharedIdentifiers` for legibility) — it can no longer trigger a block on its own, however many distinct categories it spans.

This closes the detector's second disclosed false-positive class outright (a weak-only coincidental code-landmark/convention collision — see the `0ef0270b` record's second section) — that class can no longer fire, because weak-only matches no longer exist. The detector's first disclosed class (a meta/design document quoting another incident's identifiers VERBATIM — see the `5b221bf2` record's second section) is UNCHANGED by this: it's about STRONG evidence and stays open.

## Accepted cost

The module's own founding `abcf0eba`/`bc91e86c` positive-control pair (the Windows-argv-limit duplicate) carries NO strong identifier at all — it was originally caught purely via `ERROR_FILENAME_EXCED_RANGE` + `CreateProcess` + `startupPrompt` (three weak categories, zero strong). Under this redesign it is no longer auto-flagged — a genuine duplicate whose only shared evidence is a code symbol/error constant/file:line now has to be caught by a human/agent reading the board, or filed with `supersedes`/`relatedTo` by hand. That is the accepted trade of the stated asymmetry, not a bug — see the regression test in `task-dedupe.mjs` for the explicit, documented "this pair no longer matches" assertion rather than a silently-dropped check.

## Do not

- Do not reintroduce a "minimum weak categories" style bar that lets weak evidence qualify a match on its own — measured to have produced 5 real spurious create-blocks in live usage.
- Do not expect `abcf0eba`/`bc91e86c` (or any duplicate pair sharing only weak evidence) to auto-flag — that is the accepted trade of this decision, not a regression.

## Source

Inline JSDoc in `packages/daemon/src/mcp/duplicateDetection.ts` (the module's top-of-file doc comment's "CARD b6eab182" section, and `findSuspectedDuplicate`'s own doc's "SECOND DISCLOSED LIMITATION" closing note, as of this tranche's HEAD, prior to compression).
