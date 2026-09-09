# a0dff493 — the Lead's git-write tools were the one repoKey-shaped writer surface never threaded through resolveRepoByKey

## Narrative

These four [git write tools: checkout/create-branch/commit/push] were the one repoKey-shaped writer surface that never got threaded through `resolveRepoByKey` when phase 2 landed everywhere else — before this they read `p.repoPath` directly and SILENTLY always targeted primary on a multi-repo project, no error or warning, even though the Lead already dispatches cards at an explicit repoKey via `project_task_create`/`update`. Decided repo-aware (not primary-only-by-design): the Lead already reasons in repo-key terms, so refusing it the ability to act on the key it already names would just trade a silent wrong-target for a hard block with no better option. The concept itself is taught HERE, in each tool's own description (point-of-use, never stale) rather than in the Lead's spawn-time brief (`platform-lead-prompt.ts`) — that file carries no project data at all today, and a baked-in registry snapshot for a session that spans every project would be exactly the stale-state-as-authority failure this project keeps getting bitten by; `project_get`/`list_all_projects` already give the Lead live, current registries on demand.

## Do not

- Do not resolve a Lead git-write's target repo any way other than the shared `resolveRepoByKey` — a second resolution path is exactly how these four tools silently drifted to primary-only before card `a0dff493`.
- Do not bake a project/repo registry snapshot into the Lead's spawn-time brief (`platform-lead-prompt.ts`) to "save a round-trip" — read it live via `project_get`/`list_all_projects` instead; a baked-in snapshot goes stale the moment a project's repos change.

## Source

Inline comment in `packages/daemon/src/mcp/platform.ts` (git-writes block header, lines 3069-3084 as of this tranche's HEAD, prior to compression). Relocated by card `b721401b` (tranche 1 on `mcp/platform.ts`).
