# 760cd01d — Pin a worker's boot-cycle mode to `auto`, independent of the project's own cycles knob

## Narrative

WORKER structural default (audit finding 760cd01d, sev medium): `acceptEdits` auto-approves file edits ONLY — Bash/`gh`/build/test and non-allowlisted MCP calls still prompt, and a spawned worker has no human at its TUI to answer, so it stalls (the owner had to manually worker_set_mode('auto') twice before this fix). Pin a WORKER's boot-cycle target to `auto` INDEPENDENT of the shared `config.permission.startupModeCycles` knob, so a project-level cycles customization (made for manager/other-role reasons) can never silently leave a worker un-cycled. A manager can still pin a specific worker to the rare edits-only `acceptEdits` mode after spawn via `worker_set_mode`.

## Do not

- Do not let a project's `config.permission.startupModeCycles` knob determine a worker's boot-cycle target — it is pinned to `auto`, independent of that knob, via `withRolePermissionModeCyclesPin`.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`resolveAgentSpawn`), originally part of lines 3070-3107 as of commit `9818aa2627c6f58c26aaaec6fc33d70c468c3943`. Relocated by card `3c50eae9` (`docs/adr/92cfc09e` convention); no wording changed. See also `docs/decisions/5603f40f-pin-assistant-boot-mode-to-auto.md` (the sibling assistant pin) and `docs/decisions/3388be4d-role-scoped-transcript-root-deny-lives-at-createpty.md`.
