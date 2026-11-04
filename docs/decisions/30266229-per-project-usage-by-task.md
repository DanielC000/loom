# Per-project Usage tab, broken down by task (card 30266229)

Card `30266229`, parent `16106aaf` (the owner's 2026-11-03 Atlas feedback round). Owner item, verbatim: *"Add new per project "Usage" tab. - Breakdown usage by tasks and related tasks too."*

Investigation + data-availability table: `$LOOM_PROJECT_WORK_DIR/analyses/30266229-usage-tab.md` (§5b is the design this built). The daemon half is card `58d5a36f` — `session_usage_samples.task_id` plus `aggregateSessionUsage`'s `byTask` / `orchestrationOverhead` / `unattributed`.

## What shipped

A tenth `PROJECT_NODE_TABS` entry, `Usage` (Atlas only), whose body is `pages/ProjectUsage.tsx`:

- One row per board task that any usage resolved to, with its tokens, its estimated cost and a meter, linking to the card on the board.
- Children rolled into their parent (a tree sum), expandable into the itemised subtree.
- Each expanded card's `blockedBy` / `blocks` / `related` / `discoveredFrom` / `discoveries` edges as separate rows carrying their OWN totals.
- Two labelled non-task buckets — **Orchestration overhead** and **Unattributed** — so the visible rows add up to the window's stated total.
- A four-sentence disclosure (estimate not a bill · a review worker can land in Unattributed · a manager is never one task · plan/rate-limit usage is account-wide).

The shaping rules are pure functions in `lib/projectUsage.ts`, unit-tested in `test/project-usage.mjs`; the e2e witness is `e2e/project-usage.spec.ts`.

## Why the addresses and the structure are what they are

**The tab is a second `?tab=` on `/project`, and that is not a violation of `@decision 25c08fba`.** That anchor forbids *re-addressing* a project tab as `?tab=`, for two stated reasons: it would collide with the re-homed page's own `?tab=`, and the both-shells `LEGACY_REDIRECTS` row it would need breaks the switch-OFF contract. Neither applies to a surface that never had an address: this body owns no `?tab=` of its own, and there is nothing to leave behind, so there is no redirect row and no `NAV_PAGES` entry. It is the same shape the `overview` home tab already has. `/usage` could not be reused either way — it is the WORKSPACE node's own cross-project tab (`WORKSPACE_NODE_TABS`), and a project-depth slice of one plane of that page is a different surface, not a re-home of it.

**`components/usageKit.tsx` is an EXTRACTION, not a second kit.** The formatters (`fmtTokens`/`fmtUsd`/`fmtRatio`/`ratioTone`/`sessionTotalTokens`), the four windows and the small primitives (`Stat`/`Field`/`SectionHead`/`RowName`/`SortToggle`/`MetricToggle`/`WindowSelect`) moved out of `pages/Usage.tsx` and are imported back by it. Two copies would drift the moment one surface's formatter was tuned, and the drift would be invisible — both pages would still render plausible numbers, just differently. Usage.tsx's live-occupancy helpers and its runs-plane `totalTokens` deliberately did NOT move: hoisting them would make the kit the union of two pages rather than their intersection. `test/usage-consumption-wording.mjs` slices Usage.tsx between two comment markers and its END marker was `MetricToggle`'s own comment, so that test's bound moved with the code.

**One plane, not three.** `/usage` is a god-eye console over three planes that must never be summed. This tab shows exactly one — interactive-session consumption — because it is the only one that can be sliced by task: live occupancy is a context snapshot (not spend), and Agent Runs are API-triggered with no `task_id` at all and are deliberately not getting one (the investigation's G5). That is why this tab carries no plane labels or never-sum warnings of its own.

**The body is rendered only while selected**, like the home tab and unlike the eight re-homed bodies that `@decision 25c08fba` parks with `hidden`. That rule exists to protect unfinished INPUT; this body has none (window, sort and the expanded-row set are re-derivable choices, not typed text), and keeping a 30s-polling usage query mounted behind nine other tabs would make every project address pay for a breakdown nobody opened.

**Relations are fetched lazily, per expanded row.** The board LIST projection carries relation COUNTS only, never the edges, so there is no way to draw them from data already loaded; `GET /api/tasks/:id` per expanded card (on the board drawer's own query key) is what keeps a thousand-card project from issuing a thousand requests to render a page nobody has drilled into.

## Do not

- **Do not fold a relation edge's usage into a task's own total.** `blockedBy`/`blocks`/`related`/`discoveredFrom`/`discoveries` are dependency and provenance edges with no containment semantics: summing one attributes effort that was never shared, and because relations are not a tree the same card is reachable from several others, so a per-view sum double-counts it. Only `parentId` rolls up.
- **Do not re-walk a `parentId` chain for a node whose parent is already resolved.** In a cycle the second walk overwrites the first's deliberate `null` with the edge that closes the loop, leaving every node in the cycle parented and the whole cycle unreachable from any root — its usage silently dropped from the page. Measured, before the guard in `buildTaskUsageTree` existed.
- **Do not drop a usage row whose parent (or whose own card) is missing.** A card whose `parentId` names a card not on the board stays a ROOT, and a row whose task was deleted keeps its figures and loses only its name. Dropping either silently shrinks the total the page claims to break down.
- **Do not treat a zeroed `byTask`/overhead/unattributed trio as a balanced partition.** The route omits all three TOGETHER for an unscoped or unknown project; `usagePartition`'s `present` is what tells those apart, and reporting the absent case as balanced would have the tab claim its rows add up when it has no rows.
- **Do not average per-row `cacheHitRatio`s when rolling up.** Recompute from the summed token columns via the shared `cacheHitRatio`, or a 3-sample row weighs the same as a 3000-sample one.
- **Do not assert the project tab COUNT from prose.** Every spec that enumerates these tabs parses `PROJECT_NODE_TABS` out of `src/nav.tsx`; this card's own addition is the second time the count moved.
