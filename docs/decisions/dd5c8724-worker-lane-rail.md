# dd5c8724 — the worker lane rail infers a manager's fleet web-side, and says what it cannot know

Phase 2 of owner intake `90bb3e98`. The owner picked **C · Lane rail** (request `050b30ba`, 2026-11-12) over A · Crew table and B · Workers tab. The mockup set and plan are in the vault at `Projects/Loom/Mockups/2026-11-12 Session page workers/`.

## What was built

A standing right-hand rail on a **manager's** session node only (`role === "manager"`: `worker_spawn` is registered on the orchestration router alone, so no other role dispatches). It is an opt-in `atlasNode.rail` slot on `components/TerminalCard.tsx`, rendered as a sibling column beside the tab row, panes and inline strips. Every other node renders byte-identically to before. Component: `components/WorkerLaneRail.tsx`. Derivations: `lib/workerLanes.ts`, unit-tested in `packages/web/test/worker-lanes.mjs`. e2e: `packages/web/e2e/worker-lane-rail.spec.ts`.

No daemon change. The rail reads only existing cache entries: `["allSessions"]` (live over `/ws/fleet`), `["tasks", projectId]`, `["orchEvents", managerId]` (shared with the Timeline tab and the card dialog) and `["gates-active"]` (shared with the Gates page, polled every 3s only while one of this manager's workers is live).

## The lifecycle mapping

Dispatched → Working → Reported → Review → Merging. The first rule that holds wins:

| Step | Rule |
|---|---|
| Merging | the worker's `pendingMerge` op is `running` (queued for a gate lane, or holding one) |
| Review | its manager filed a `merge_request` still pending for THIS worker (`hasPendingMergeRequest`, the Needs-you pairing) |
| Reported | its latest `worker_report` is `done` and no turn is running |
| Working | a turn is running, OR it has filed any report, OR `turnSeq`/`ctxTurns` show a completed turn |
| Dispatched | none of the above: spawned, with no turn and no report |

A `progress` or `blocked` report keeps the lane on Working. Only `done` is Reported, which is how the mockup draws it (a blocked lane sits on Working, in amber).

## What it cannot know

- **A report filed before a manager recycle.** Events are keyed on `manager_session_id`; a live worker reparented onto the successor keeps its earlier reports on the predecessor's stream. It reads as "No report yet" (and so Working, not Reported) until it reports again. Closing this needs a lineage-aware events read, a daemon change.
- **Dispatched vs. Working for an idle worker** is read off `turnSeq`/`ctxTurns`. A worker whose first turn finished before those counters were written reads as Dispatched until it next runs or reports.
- **An abandoned merge request.** A request the manager walked away from without a `merge_rejected`/`merge_done` stays "Review" for as long as the worker is live.
- **What the worker is doing inside a turn** (its current tool call). Not on the session row; the lane's Session link is one click away.
- **Finished workers older than this manager's stream.** "Finished this hour" is built from this manager's own `merge_done` / `stop_worker` / `worker_exited_without_report` events. A finished worker's session row is usually archived, so the footer names its card when the board knows it, else `w:<short id>`.

## Status precedence (one pill per lane)

Not running (its `processState`, muted) › rate-limited › merging / merge queued › awaiting review › blocked (latest report `blocked` and no turn running since) › working › starting › idle. Lanes sort awaiting review, blocked, rate-limited, merging, working, starting, idle, then not running; ties keep the oldest dispatch first.

Two deliberate departures from plan.md's draft order. A session that is no longer running reads as that first (a dead process is not "rate-limited", and the board's worker pill also puts it first). A RUNNING merge gate beats "awaiting review", because the `merge_request` stays the latest merge event for the whole gate run, so the plan's order would show a merging worker as still waiting for review.

## Layout decisions

- **Sized off the node, not the viewport.** The split is a container query on `.loom-atlas-sessionnode.has-rail`, because the Atlas tree takes a variable share of the screen. 372px rail; 320px below 1000px of node; below 720px the rail moves ABOVE the tab row and its lanes become a horizontally swipeable, scroll-snapped strip (actions always out). Classes are `wlane`, never `lane`: the board owns `.loom-lane-*`.
- **The terminal re-fits on its own.** The rail is a sibling column, never inside `.loom-atlas-nodepanes`, so the pane height the composer is pinned against (card `4f62b5cb`) does not move. The narrower width reaches the pinned grid through the pane's existing width ResizeObserver.
- **The Loom MCP strip runs full width BELOW the split.** Beside a 372px rail at an ordinary 1280px window the main track is under 700px, which is the MCP strip's own container breakpoint, so it dropped its duration column (two existing e2e specs caught it). On a node with a rail, TerminalCard renders the strip after the split instead of inside the main track.
- **The phone strip re-anchors on every ORDER change.** It is scroll-snapped, and a snap container re-snaps to the lane it was on when the order changes. Reports arrive after the session rows and re-sort the lanes, so without this the strip opened mid-way (measured: scrollLeft 574, two lanes in). It returns to the start, or to the lane the reader picked; it is deliberately not keyed on a pick, so a tap never yanks the strip.
- **Empty state.** A wide node keeps the mockup's one-sentence empty state. On the narrow layout an empty rail (no lanes, nothing finished) is hidden: it would push the terminal down for one sentence.
- **Selection.** The top lane (the one most needing a look) starts selected, so its actions are out without a click. A lane is a focusable list item; Enter or Space selects it. The merge itself stays on the review surface (`@decision c2968651`); the rail only links to it.

## Do not

- Do not mount the rail for any role but `manager`, or derive the step anywhere but `lib/workerLanes.ts`.
- Do not present the track as authoritative, or drop the limits above from this record when the mapping changes.
- Do not add a per-worker fetch (transcript, diff) to fill a lane. Every lane reads shared cache entries; a per-worker request is an N-request fan-out on every manager page.
- Do not put the rail inside `.loom-atlas-nodepanes`: it would change the pinned pane height and move the composer.
- Do not move the MCP strip back into the narrowed main track, or drop the phone strip's order-change re-anchor: each has an e2e assertion in `worker-lane-rail.spec.ts` that fails without it.
