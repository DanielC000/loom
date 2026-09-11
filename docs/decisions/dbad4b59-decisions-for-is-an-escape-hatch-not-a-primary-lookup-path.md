# dbad4b59 — `decisions_for` is an escape-hatch index, never the primary lookup path

## Narrative

Design note, following CLAUDE.md's comment-taxonomy convention (card `90b19799`): the `Read`-hook (`assets/decision-records.mjs`) is the PRIMARY delivery path — it costs the agent zero extra lookups. `decisions_for` is an explicit escape hatch for what the hook cannot answer positionally: "what decisions touch this file/flow", "what does this record govern" (reverse lookup), and enumerating records before a refactor.

Card `dbad4b59`'s own body explains why, under its "Relationship to the injection hook — read this before building" section: an earlier draft of this proposal made this tool the primary path, and that was wrong — a query the agent must remember to make depends on agent discipline and is strictly worse than the inline comments already available. The card says to keep that ergonomics judgement in place; this design does.

Deliberately NOT Loom-source-specific, unlike `comment-anchor-lint.mjs` (a Loom-internal lint tool with a hardcoded `SOURCE_ROOTS` over Loom's own package layout). This tool runs against ANY project's repo via `TaskMcpRouter`'s server-derived `repoPath`, so its file walk is repo-root-relative and layout-agnostic (mirrors `repo-read.ts`'s own generic `walkFiles`), never assuming a fixed `packages/<pkg>/src` layout.

Duplicates `assets/decision-records.mjs`'s resolution logic rather than importing it. Both resolve across all three stores at runtime (`docs/adr/`, `docs/decisions/`, `docs/investigations/<id>-<slug>/findings.md`), but this module keeps its own, independently-maintained copy — the same asset-vs-compiled duplication already accepted between `decision-records.mjs` and `comment-anchor-lint.mjs` (assets ship standalone, invoked by a bare `node <path>`; this ships compiled into the daemon). Do not import from `assets/decision-records.mjs` — that asset's independence from `dist/` is load-bearing (see its own scope-fence note), and importing it here would couple the two.

## Source

`packages/daemon/src/mcp/decisions.ts` — module-level doc comment above `ANCHOR_RE` (extraction tranche 1, card `7f04a474`), introduced by commit `8bdd78d20903f77eda67177408a5febd9fc3711b` ("feat(mcp): add decisions_for(query) — the @decision anchor index", card `dbad4b59`). Condensed and reworded, not verbatim.

The "earlier draft ... primary path, that was wrong" paragraph above is NOT from the removed comment — the comment only pointed at it ("see the card body's own warning about that"). It is drawn from card `dbad4b59`'s own body, under its "Relationship to the injection hook — read this before building" section, which reads: "An earlier draft of this proposal made this tool the primary path. That was wrong: a query the agent must remember to make depends on agent discipline and is strictly worse than the inline comments we already have. Keep the ergonomics judgement in place." The paragraph above preserves that meaning without quoting it verbatim.
