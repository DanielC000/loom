# 7da27eb5 — the board's done lane renders one page, and the cap is applied AFTER filtering

Anchored from `packages/web/src/pages/Board.tsx` (`DONE_LANE_PAGE`, and the `key` on `<Column>`).

## The problem, measured

Owner intake: *"make 'done' column on board to lazy load or something else that can solve this. page and other columns should load and not have to wait for the large done column."*

Loom's own board carried **4,870 cards, 4,763 of them done (97.8%)** when this landed. `Board.tsx` renders every lane in a single pass gated on one `board.data`, and the done lane's card list was an uncapped `tasks.map(...)`. So the done column's render blocked the first paint of the *whole* page — every other lane waited on it.

Measured on an isolated seeded daemon (own `LOOM_HOME`, `LOOM_PORT=0`, `LOOM_DEV=0`, real chromium; the real `~/.loom` DB was never opened), 3 trials per point, median, fetch/render split off Resource Timing:

| done cards | server | render after response | first LIVE-lane card visible | DOM nodes | payload |
|---|---|---|---|---|---|
| 0 | 5 ms | 101 ms | **397 ms** | 570 | 132 KB |
| 300 | 18 ms | 172 ms | 467 ms | 2,969 | — |
| 800 | 57 ms | 344 ms | 692 ms | 6,969 | — |
| 1,500 | 60 ms | 582 ms | 916 ms | 12,569 | — |
| 2,000 | 88 ms | 747 ms | 1,112 ms | 16,569 | 1,543 KB |
| 4,763 | 170 ms | 1,217 ms | **1,596 ms** | 38,673 | 3,494 KB |

The done column cost **1,199 ms** of "everything else waits", and the layer split of that was **~1,116 ms client render/layout (93%)** against ~83 ms of server handler time. Near-linear in card count, ~8 DOM nodes per card.

The decisive observation is that the lane is **already** a bounded, internally-scrolling box (`maxHeight: "75vh"`, `overflowY: auto`) showing roughly ten cards at a time. Rendering 4,763 into it put **99.8% of that work off-screen**.

## What was NOT the cause

Card `a428d224` ("make `list_all_tasks` includeDone merge-status enrichment lazy") looks like the obvious suspect and is **not on this path**. The board LIST route (`gateway/server.ts`, `GET /api/projects/:id/board`) makes no git call at all — it is `db.listTasks` + `toBoardTasks` + `boardRollup`, pure SQLite and in-memory maps. `resolveMergedInfo` / `scanMergedCommitMap` run only in `GET /api/tasks/:id` (the drawer's single-card lazy read) and in the `list_all_tasks` MCP tool. Do not re-derive `a428d224` as the board's problem.

## Do not

- **Do not apply the cap before the board's search/priority/column filter.** `Column` receives an array that is *already* filtered and sorted, and slices only what it renders. Capping first would search just the newest page and silently lose an older matching done card — the search would report "no matches" for a card that exists. This is the single most load-bearing property here, and `board-done-lane-cap.spec.ts` asserts it directly.
- **Do not derive the lane header's count from the sliced array.** The header is `tasks.length` (the full filtered set) and the soft-WIP readout is `cardCount` (the full *unfiltered* load). A count computed off `visible` would read `50` forever and make the cap look like data loss.
- **Do not cap a live lane.** The cap is gated on `isDoneColumn(col)` — the terminal *role*, resolved the same way the lane's tint and `byRecentlyDone` sort are. A live lane is bounded by WIP in practice and its cards are the working set.
- **Do not move the reveal state up into `Board`.** It lives in `Column` so it is genuinely per-lane. It survives the 4 s poll because `Column`'s key is stable across a refetch (a poll re-renders, it does not remount).
- **Do not drop the project id from `<Column>`'s `key`.** It is what makes a project switch collapse the lane back to one page. Removing it leaves lane B expanded because lane A was.

## Rejected alternatives

- **Virtualization** (`react-window` / `@tanstack/virtual`). It would cap DOM for the *expanded* case too, but it needs a new dependency, it fights `@dnd-kit`'s rect measurement for drag/drop, and the lane is already a scroll container — a render cap gets essentially the whole win for a few lines. Reconsider only if an expanded 4,763-card lane turns out to matter in practice.
- **Splitting the single `board.data` render gate** so live lanes paint before the done lane arrives. With the cap in place there is almost nothing left to win, and it would restructure the render tree for a benefit that could not be measured.
- **A server-side done window** (`?doneLimit=`, plus a bodyless `SELECT` for done rows — `db.listTasks` is `SELECT *`, so every done card's full markdown body is read out of SQLite and then discarded by `toBoardTasks`). This is real and worth doing: it would remove the 3,494 KB / 4 s payload and the 231 ms synchronous handler, which matters beyond this page because that handler is synchronous `better-sqlite3` on the daemon's single event loop and so taxes every concurrent request fleet-wide. Deliberately **split into its own card** — it touches `packages/daemon/src`, and this change is web-only.

## Scope

One component, `packages/web/src/pages/Board.tsx`, which is the *only* board implementation: classic `/board`, the Overview embed, the Atlas project node's Board tab and the Platform board all render it, sharing one `["board", projectId]` query. Both the classic and Atlas boards therefore benefit by construction, and the Overview embed is unchanged apart from the cap.

## Bound on the numbers

The fixture was an idle isolated daemon with one project and no live sessions or terminals. The owner's Overview page mounts live terminals above the board embed, and their daemon serves the whole fleet — so 1,596 ms is a **floor**, not their experienced figure. Behaviour under fleet load is unmeasured.
