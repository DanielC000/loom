# a880c391 — a human-only guarded-paths list governs TASKLESS landings

Follow-up to the card-policy enforcement record (9623e943). A card policy matches a card by title or id, so a TASKLESS worker (no card) can never match one: `mergePolicyRefusal` used to return null for it, and a manager could do policy-covered work in a taskless `worker_spawn` and `worker_merge_confirm` it onto main. Chosen over a blanket "taskless needs review" (breaks legitimate spikes and reviews) and over a taskless evidence model (new plumbing for little gain): a project-level list of path globs a taskless landing may not touch.

Code: `shared/config.ts` (`orchestration.tasklessGuardedPaths`, `parseTasklessGuardedPaths`, its doc is the semantics contract), `sessions/service.ts` (`tasklessGuardRefusal`, called from `mergePolicyRefusal`'s taskless arm), `mcp/platform.ts` (human validator, agent omit, `HUMAN_ONLY_NESTED_PROJECT_CONFIG_KEYS`). Test: `packages/daemon/test/taskless-landing-guard.mjs`.

Shape: the SAME `mergePolicyRefusal` serves solo confirm (before attach, backstop, and the pinned-tip pre-squash re-check) and `merge_batch` (per-candidate drop), so there is one implementation. The list is read from the RAW stored override each call; an empty or absent list returns before any git work. The changed-path set is `machineReadablePathSet` (`git diff --name-status -z`, both sides of a rename, through `canonicalGit`) over `<mainline watermark ref>...<pinned tip or branch>`. Matching uses the repo's one glob translator (`pathGlobToRegExp`, now exported) with an added case-insensitive flag.

Other taskless paths: a review spawn (`reviewOfTaskId`) has a null `taskId` and is covered by the same arm; boot-reconcile and recycle reuse the same confirm/batch entry points.

## Do not

- Do not read the list through `resolveConfig` at an enforcement site: a corrupt stored value degrades to `[]` there, which would silently turn the guard off. Parse the RAW value and refuse on a parse failure.
- Do not let an unreadable, unresolved or over-cap (500 paths / 32 KB) changed-path set pass; it refuses, because a partial list would let a guarded path through.
- Do not match only the new side of a rename; moving a file OUT of a guarded path is a change to it.
- Do not make matching case-sensitive: on a case-insensitive host filesystem `DOCS/x` would slip past a `docs/**` guard. (Deny-globs are case-sensitive; this guard deliberately is not.)
- Do not add this key to the agent validator, the setup router, or the elevated Lead `project_configure`; it is on the human-only nested list so set, unset and replace-drop are all refused.
- Do not add a second implementation of the taskless check in the batch or backstop paths; call `mergePolicyRefusal`.
- Do not name a card id in the refusal text; it is agent-facing.
