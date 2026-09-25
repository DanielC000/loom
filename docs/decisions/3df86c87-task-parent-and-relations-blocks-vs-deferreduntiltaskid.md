# 3df86c87 — task parent links + `blocks`/`related`/`discovered-from` relations, and how `blocks` relates to `deferredUntilTaskId`

Owner directive 2026-09-25 ("no overkill"): make the structure agents already write into prose (epics, "depends on", "related to", follow-ups) into data. This record freezes the contract the web card (`1ae4f88c`), doctrine card (`f13f8cc2`) and backfill card (`753092fe`) build against.

## Do not

- Do not add a second storage for "waits on another card". `blocks` edges in `task_relations` are the ONE storage; `deferredUntilTaskId` is an alias over the edges flagged `gates_deferral=1`.
- Do not let a plain `blocks` edge (`gates_deferral=0`) set or clear `deferred`. It feeds `ready` and display only.
- Do not persist a "resolved" state for a `blocks` edge, and do not convert it to `related`. Resolution is DERIVED at read time (blocker in the terminal column, or merged), so it cannot go stale and history is kept.
- Do not change the deferral-alias semantics: it still clears only when EVERY named blocker is merged, and a blocker closed with 0 commits / deleted / cross-project is still `deferredStuck` (`@decision 93669813`, `@decision 022659ac`). A plain `blocks` edge deliberately does NOT do that: a 0-commit close RESOLVES it.
- Do not add a type field, cross-project parents/relations, or more relation types. "Epic" = "has children".
- Do not re-run the boot backfill of the legacy `deferred_until_task_id` column: it is stamped once (`app_meta` marker) and the column is frozen afterwards.
- Do not put an index on `tasks.parent_id` in the base SCHEMA: it is a migrate-added column, so its index is created in `migrateTasks()` after the ALTER.

## Model

- `tasks.parent_id TEXT` (nullable, no DEFAULT; migrate-added). Same project only. Max depth: a top card is depth 0, so at most 2 levels below it (epic → task → subtask). Cycles rejected. Every rejection says what WOULD work.
- `task_relations(id, project_id, from_task_id, to_task_id, type, declared, gates_deferral, released, created_at)`, `UNIQUE(from_task_id, to_task_id, type)`. Directions: `blocks` = `from` blocks `to`; `discovered-from` = `from` was discovered while working `to`; `related` is stored once with `from < to` and read both ways. `blocks` must stay acyclic over ALL edges, resolved ones included: a resolved edge re-opens when its blocker leaves the terminal lane, so a cycle through one is still a cycle (this is stricter than the plan, deliberately). The `deferredUntilTaskId` alias obeys the same rule.
- No SQLite FKs; deletion is application-level. Deleting a card deletes its edges and NULLs `parent_id` on its children (they become top-level; the delete is never blocked by having children). The one exception is a `gates_deferral` edge whose BLOCKER is deleted: it is kept dangling so the deferred card still reads `deferredStuck` (`@decision 793ac76d`: a dangling blocker degrades to "stays deferred").
- Relocating a card to another project drops its parent link, its children's link to it, and every relation edge that is not an alias (`gates_deferral`) edge; on the alias edges it clears the `declared` bit (relations are same-project only).

## Edge invariants (review 4d3096d0)

- **One validation, one plan, one transaction.** `planTaskStructure` validates the WHOLE proposed change once, against the COMBINED graph: existing edges (minus the sets this call replaces) + the deferral ids + `blockedBy` + `blocks` + `parentId`, on create too (a synthetic node stands in for the new card). `applyTaskPlan` executes the plan and never re-validates or returns an error; the card-row write and the plan land in ONE transaction (agent create/update, and both REST routes). The human REST update route's raw `deferredUntilTaskId` goes through the same plan (`resolveDeferralInput`); it used to reach `db.updateTask` unvalidated.
- **`project_id` of a flagged edge is ALWAYS its TARGET card's project** (the deferred card's board): that is what `listTasks(project)` reads and what `deleteProject(project)` removes. Audit of every path that can move a card or write an edge: (1) `setDeferralEdges`/`insertTask` use the target's project; (2) the boot backfill uses the row's own `project_id`; (3) `relocateTask` is the ONLY statement that changes `tasks.project_id`, and it now re-homes the moved card's own flagged edges (`to = id`) to the new project, while edges where the moved card is only the BLOCKER stay with the dependent's project and read `deferredStuck` there (cross-project blocker), as before; (4) non-alias edges are deleted on relocate (same-project only); (5) `deleteProject(p)` deletes only edges whose target is in `p`.
- **Two independent bits per `blocks` edge (review 8d5f73bd; replaces the earlier `alias_created` provenance flag, which recorded HISTORY where the rule needs STATE).** `declared` is set/cleared ONLY by `blockedBy`/`blocks` writes (the user's explicit dependency); `gates_deferral` is set/cleared ONLY by `deferredUntilTaskId` writes and the auto-release. Clearing one bit never touches the other. The row exists iff `declared || gates_deferral || released` (enforced by a CHECK constraint on the unreleased `task_relations` table); when the live bits are both clear it is deleted. Consequences: `blockedBy:[B]` + a deferral on B in one call sets both bits (clearing the deferral keeps B); `blockedBy:[]` on an alias-backed edge clears only `declared` (the deferral still holds, and clearing it later deletes the row, so a removed dependency is never resurrected); a deferral cleared while a declared edge exists keeps that edge.
- **Released history = a third bit, `released`.** The auto-release clears `gates_deferral`; if nothing declared the edge it is KEPT with `released=1` (if the user also declared it, it simply stays a live declared edge). A released edge is display-only: it shows under `blockedBy` as resolved history, but it is never counted by `ready`/the board roll-up and is not in the cycle graph. Setting a live bit on it clears `released`.
- **One function computes the post-patch graph.** `edgesAfterPatch` (tasks/edge-state.ts, pure) gives the set of edges after a patch (`blockedBy` replaces the declared bit into the card, `blocks` the declared bit out of it, `deferral` the gates bit into it; each part touches only its own bit so they commute). The planner's cycle check and the ONE writer `Db.applyBlocksPatch` both use it, so validation and write cannot diverge. Rows expose both bits (`TaskRelationRow.declared/gatesDeferral/released`); the legacy backfill writes `declared=0, gates_deferral=1`.
- **No await between plan and apply.** The agent update and the REST update route plan AFTER their last `await` (`checkTaskRepoKeyRebind`), and the plan is applied in the very next synchronous span.
- **Unreleased shape:** `task_relations` never shipped. A dev LOOM_HOME that booted an earlier draft (8fa9671b / d6859296) keeps the old columns because the table is created with `IF NOT EXISTS`; no migration is provided, drop the table there.
- **Released edge vs merged state.** The alias auto-release fires on the LIVE git merge scan; the persist step also stamps each released blocker's merged ship-state (`setTaskMergedInfoNoTouch`, the drawer's own cache-fill, never bumping `updatedAt`) when it has none, so the released (now plain) edge, the badge and `ready` agree. A plain `blockedBy` edge on a blocker that merged in git but was never stamped and never moved to done (and is not behind an alias release) still reads open until merge-confirm or the drawer stamps it.

## `blocks` resolution (derived, never stored)

An edge is OPEN while the blocker exists, is not in the project's `terminal`-role column, and has no persisted merged ship-state (`mergedSha`, the cache merge-confirm stamps; a merged card is in the terminal lane anyway, so the cache cannot make a truly open blocker read resolved). Otherwise it is RESOLVED and shown as "blocked by X (resolved)". A blocker moved back out of the terminal column re-opens the edge. A blocker closed with 0 commits is terminal, so its edge is resolved. A deleted blocker's plain edge is deleted with it.

## `blocks` vs `deferredUntilTaskId` (one storage)

- Writing `deferredUntilTaskId` (bare id or array) creates `blocks` edges blocker→this card with `gates_deferral=1` (an existing plain edge is flagged, not duplicated) and the card is `deferred:true` exactly as before.
- Reading `deferredUntilTaskId` projects the card's flagged edges back to a bare string (one) or an array (several): the response shape is unchanged.
- `resolveDeferredEffective` is unchanged except that its blocker ids come from the `gates_deferral` edges. Auto-clear (all merged) clears that bit and keeps the row as `released` history when nothing declared it (see "Two independent bits" below), and `deferred_until_task_id` clearing (`@decision cf62c1ef`) is satisfied because the card no longer has `gates_deferral` edges. An explicit `deferredUntilTaskId: null` or a replacement clears the dropped ids' `gates_deferral` bit (the row is deleted unless the user also declared it). The `1d27c3cd` re-fetch-before-fold, the `595fe28f` reason folding and `deferredUntilEvent` are untouched.
- Contract for callers: use `blockedBy` for "this card depends on that one" (a fact; drives `ready`), `deferredUntilTaskId` for "park this card and auto-release when they merge" (a hold). A card can have both.
- The `blockedBy` param REPLACES only the `declared` bit of the card's incoming `blocks` edges (and `blocks` the declared bit of its outgoing ones); the `gates_deferral` bit belongs to `deferredUntilTaskId` and is never touched by them.

## Migration and downgrade

- The legacy column is backfilled ONCE at boot into flagged edges (bare string and JSON-array rows both, via the existing parser; an id that does not resolve to a task is STILL copied, as a DANGLING edge, so the deferred card keeps reading `deferredStuck` (only an empty value or a self-reference is skipped, and skips are counted in a log line)), guarded by an `app_meta` marker so a re-boot never duplicates edges or re-reads a column that later drifted. The column stays in the schema but is FROZEN: not read, not written after the upgrade.
- ⚠️ **Downgrade consequence:** an older daemon reads the frozen column, so it will not see deferral blockers written after the upgrade (its cards can look deferred with no blocker, i.e. a manual deferral with no reason), and a card whose blocker landed after the upgrade will not auto-clear there. Roll forward, do not roll back after using the new fields.

## `ready`

`ready` = column has role `workReady` AND `held` is false AND effective `deferred` is false AND no OPEN incoming `blocks` edge. A deferred card is never ready, whether or not it has flagged edges.

## `relatedTo` on create

`tasks_create({relatedTo})` now creates a `related` relation and no longer appends the `Related to: <id>` prose to either card. `supersedes` is unchanged (prose on both cards).

## FROZEN contract for the web (item 7)

Board list, `GET /api/projects/:id/board` (light: no relation arrays): each task additionally carries
`parentId: string|null`, `childCount: number`, `childDone: number`, `blockedByOpen: number`, `blockedByFirst: {id,title}|null` (first OPEN blocker, for the "deferred: waits on X" badge). `deferredUntilTaskId` keeps its existing shape. `GET /api/projects/:id/tasks` is the raw row list and carries `parentId` only.

Single task, `GET /api/tasks/:id` (the row, plus):
```
parentId: string|null
parent: {id,title,columnKey}|null
children: {done:number,total:number,items:[{id,title,columnKey,priority}]}   // items capped at 100; done/total always exact
relations: {
  blockedBy:      [{id,title,columnKey,resolved:boolean,released?:true}],   // edges pointing at this card
  blocks:         [{id,title,columnKey,resolved:boolean,released?:true}],   // edges from this card
  related:        [{id,title,columnKey}],
  discoveredFrom: [{id,title,columnKey}],                    // cards this one was discovered from
  discoveries:    [{id,title,columnKey}],                    // cards discovered while working this one
}
```
`resolved` is on the edge's BLOCKER side for both `blockedBy` and `blocks`. `released:true` (present ONLY then, always with `resolved:true`) marks auto-released deferral HISTORY: display-only, not a declared dependency and not live. It stays in `blockedBy`/`blocks` (no separate list), so the UI renders it as resolved history, and a read-modify-write client must NOT send a `released:true` item back in a `blockedBy`/`blocks` write (that would re-declare it as a live edge). This is stated in the tool descriptions and TASK_STRUCTURE_DOC. It differs from a declared edge that is merely `resolved` because its blocker is done (no `released` field). Both directions are computed in this one call.

Writes: `POST /api/projects/:id/tasks` and `POST /api/tasks/:id` accept `parentId`, `blockedBy`, `blocks`, `related`, `discoveredFrom` and run them through the same validator as the MCP tools (400 with the "what would work" message on rejection). The board learns of changes by its 4s poll (`Board.tsx` `refetchInterval`), and there is no board ws event for task updates, so no event is added; the poll already carries the fields above.

## Agent tools (no new tools)

`tasks_create`/`tasks_update` (loom-tasks) and `project_task_create`/`project_task_update` (platform): `parentId` (null clears), `blockedBy: string[]`, `blocks: string[]`, `discoveredFrom: string` (null clears) on create AND update; `related: string[]` on UPDATE ONLY. A CREATE declares related cards through the existing `relatedTo` (now `string | string[]`); there is no `related` create input, which avoids clashing with the duplicate-advisory `related` field on the create result. Whole-set replace on update. Ids resolve like the other task-id params (an ambiguous prefix errors naming the candidates). `tasks_list({parentId, ready})` (`countsOnly` honours `ready` via `countProjectTasksAsync`); `tasks_get` returns `parentId`, `children`, `relations` in the shape above.

## Measured 2026-09-25

Boot-test of the migration against a COPY of the live pre-migration DB (`sqlite backup` of `~/.loom/loom.db`, 6589 tasks): before, 38 cards carried a `deferred_until_task_id` (34 bare strings, 4 JSON arrays), no `parent_id`, no `task_relations`; after one boot, `parent_id` + `idx_tasks_parent` exist and there are 48 `gates_deferral` edges (34 + the arrays' 14 ids), 0 skipped, every one of the 38 rows projects back to the identical id/array (0 mismatches), and a second boot leaves the edge count at 48 (idempotent, marker stamped). The `ready` total is computed from the full filtered set (the cheap sync counter cannot apply it).

`grep -rn deferredUntilTaskId packages/web/src` = 0 hits (positive control: the same pattern over `packages/daemon/src` = 60 hits). The card's "0 web references" is confirmed by this grep.
