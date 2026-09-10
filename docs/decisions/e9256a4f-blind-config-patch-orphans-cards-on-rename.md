# e9256a4f — blind config-PATCH writes orphan cards on column rename/removal

## Narrative

The blind `db.setProjectConfig` is a two-path asymmetry hazard: it writes the new columns with NO card re-key, so renaming/removing a column ORPHANS every card still on the old key (Board.tsx filters strictly → the card vanishes, no migration), violating columns.ts's hard invariant "no task references a non-existent column". The dedicated column editor (PUT /api/projects/:id/columns → planColumnLayout) re-keys cards; these config-PATCH surfaces bypassed it.

The fix: `setProjectConfigSafe` (`packages/daemon/src/tasks/columns.ts`) is the shared writer now sitting behind every config-PATCH surface (the platform `project_configure` MCP tool + the REST `PATCH /api/projects/:id/config`). When an override changes the column KEY SET — the only thing that can orphan a card — it routes the change through the existing transactional safe writer `db.applyBoardColumnLayout` instead of the blind path: every card on a removed/renamed-away key lands in the resolved defaultLanding lane, and the writer's backstop sweep + post-apply assertion guarantee ZERO orphans (or the whole thing rolls back). A patch that does NOT change the key set stays on the blind path, byte-identical to before.

## Do not

- Do not let a config-PATCH surface write `kanbanColumns` through the blind `db.setProjectConfig` path when the write can change the column key set — that reopens the card-orphaning hazard this fix closed.

## Source

Inline JSDoc above `setProjectConfigSafe` in `packages/daemon/src/tasks/columns.ts` (the "Apply a project config override..." doc), as of this tranche's HEAD. No card id anywhere in the block, the file, or the introducing commit's message — sourced via the `sha:` grammar. Block introduced by commit `e9256a4ff170cc0fc3684887b43e00c271a6ed5a` ("fix(spawn,platform): close 3 bypassed guards — live-task respawn data-loss + humanHold spawn gate + project_configure column orphan"). Extracted by card `f94ab261` (tasks/columns.ts, tranche 1).
