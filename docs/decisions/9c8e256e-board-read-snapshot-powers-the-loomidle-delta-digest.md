# 9c8e256e — board-read snapshotting, keyed per (session, project), powers the `[loom:idle]` delta digest

## Narrative

The `[loom:idle]` nudge used to carry no indication of what changed on the board since the recipient last looked, forcing a full board re-read on every park cycle. `orchestration/board-read.ts` fixes this by snapshotting a session's own board state at the moment it genuinely reads the board (`tasks_list`) and later diffing the live board against that snapshot to produce a delta digest.

The snapshot is stored via the existing generic `Db.getMeta`/`setMeta` (the `app_meta` table) — no schema change, so this never touches `db.ts`.

Keyed per **(session, project)**, not per session alone: a Lead session can genuinely read multiple projects (`list_all_tasks`, either the no-filter aggregate or a `projectId`-narrowed call — see card `e9750bc2` for the Lead's own recording side of this). A single per-session key would let a read of project B silently clobber project A's snapshot, and a later delta for A would then diff against B's cards — false "created" entries for every one of A's real cards. Keying by (session, project) makes each project's anchor independent, so the not-computed/measured-zero/real-delta three-way distinction below holds per project, not just per session. A manager (single-project, unchanged since this card) still gets exactly one key — this is a superset, not a behavior change for that path.

`computeBoardDelta` renders three distinguishable shapes: not-computed (no anchor exists for this session/project yet), computed-and-empty (a genuine "0 changes", stated as a measured fact), and computed-and-nonempty (per-kind counts + capped id lists). `computed:false` must never render in a way that could be mistaken for a measured zero — collapsing the two would tell a recipient "nothing changed" when the true state is "never checked."

`computeBoardDelta` deliberately does **not** use `Task.updatedAt` to detect a move or re-prioritization: `Db.updateTask` bumps `updatedAt` on every patch — held/deferred/repoKey/merged* writes included, not just column or priority — so "updatedAt changed" can't tell you which field changed, only that something did. (Only `Task.version` is gated to title/body edits specifically — a different field.) Comparing the actual `columnKey`/`priority` values against the snapshot is the only way to know whether a given update was a move, a re-prioritization, both, or neither.

## Do not

- Do not key the board-read snapshot per session alone — a Lead reading multiple projects will silently clobber one project's snapshot with another's, producing false "created" entries on the next delta.
- Do not render `computed:false` (no snapshot yet) the same way as a computed-and-empty delta — a recipient can't tell "never checked" from "genuinely 0 changes" unless the two stay visibly distinct.
- Do not "simplify" `computeBoardDelta` to compare `Task.updatedAt` instead of the actual `columnKey`/`priority` values — `updatedAt` bumps on unrelated patches too and can't identify which field moved.

## Source

Inline comments in `packages/daemon/src/orchestration/board-read.ts` (module doc comment and `computeBoardDelta`'s doc comment, lines 5-20 and 110-126 as of this tranche's HEAD, prior to compression).
