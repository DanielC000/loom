# a0cafef2 — actor attribution for project-config writes routes through one chokepoint

## Narrative

`actor` (card a0cafef2) identifies WHO is making this write — every one of the four config-PATCH surfaces (the human REST PATCH, the Platform Lead's + Setup Assistant's project_configure/project_update, and the manager's project_update) routes through this ONE chokepoint, so recording the change history HERE means every writer gets truthful attribution for free instead of four separate call sites each having to remember to record it. See `ProjectConfigHistoryEntry`'s doc for the actor-string convention — never hardcode "human" (unlike platform_config's single human-only writer, three of these four are agents).

## Do not

- Do not record project-config change history at an individual call site instead of routing through `setProjectConfigSafe` — that's how the four surfaces would drift out of sync and some writers would stop recording attribution.
- Do not hardcode `actor: "human"` in a config-PATCH writer — three of the four surfaces (Platform Lead, Setup Assistant, manager) are agents, not the human.

## Source

Inline JSDoc above `setProjectConfigSafe` in `packages/daemon/src/tasks/columns.ts` (the "Apply a project config override..." doc), as of this tranche's HEAD. Block introduced by commit `67e964639687f3f826bba1bbaf087636effa1a2e` ("feat(daemon): record actor and timestamp for project-config changes"). Extracted by card `f94ab261` (tasks/columns.ts, tranche 1).
