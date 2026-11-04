# 0bcfa530 — the project Overview's Sessions card is the Workspace card's twin, under one preference

Card `0bcfa530` (parent `16106aaf`, the owner's 2026-11-03 Atlas feedback round). His decision on request `925ea659`, verbatim:

> "Also add a filtered terminal list to the project Overview (new card)"

answering his own original item under Projects › Overview:

> "Optionaly show either only tarminals of spawnable agents or teminals of all running agents. Adjustable by user preference."

## What this closes

Card `effd47d5` shipped the preference as a filter over the **roster table**, and its own record ended with a section headed *"Still open — the owner's word was 'terminals'"*: the roster is a table, this tab mounted no terminal since card `269f46ef` removed furniture from it, and re-adding a live-pty surface was a design decision the manager put to the owner rather than taking as a side effect of a filter. He answered it: add the list, as a new card, filtered by the same preference.

So this card builds the **project-scoped twin of the Workspace node's Sessions card** (`9b6be377`) and wires it to the preference `effd47d5` already stores. That pairing is the whole card — neither half is new on its own.

## One component, two mounts

The expandable list moved out of `pages/WorkspaceHome.tsx` into **`components/sessionTerminals.tsx`** — `SessionTerminalList` plus its `SessionRow`. It owns everything that is not the population: the single-mount rule (`toggleExpandedSession` / `liveExpandedSession`), the `starting`-row note (`canMountTerminal`), the row grammar, and the one `TerminalCard` variant either node may mount (`lifecycle="none"`, no Fork, no Stop, Composer kept).

Each node brings two things of its own and nothing else:

| | Workspace (`9b6be377`) | Project (this card) |
|---|---|---|
| population | `workspaceRunningSessions` — every running session, every project | `projectRunningSessions` — the same rule, one project |
| chrome | `Panel.loom-wsessions` + `.loom-bandhead` | `OverviewCard`, this tab's only card vocabulary |
| rows name their project | yes (`showProject`) | no — every row shares one |
| filtered | no | by `RosterScope`, the roster's own preference |
| testids | `atlas-sessions-*` / `atlas-session-*` | `atlas-psessions-*` / `atlas-psession-*` |

The **chrome is deliberately not shared**. Pulling the head and footer into the component would force one node to wear the other's furniture, which is the shape `269f46ef` forbids for this tab. The caller owns its card; the component owns the list inside it.

That the extraction is real rather than a copy was measured, not assumed: a single mutation inside `SessionTerminalList` (mounting `rows[0]` instead of the expanded row) reddened the attach assertions on **both** nodes' specs in one run — see *Negative controls* below.

## One population rule, not two

`projectRunningSessions` **calls** `workspaceRunningSessions` after a `projectId` filter. It does not re-spell the predicate, because the predicate is the thing that must not drift: not a companion (the companion guard, card `5c87f4b6` — a companion is driven only through its chat surface, never a raw pty + stdin Composer) and actually running.

The **order needs nothing extra either**. `byProjectThenManager` compares project name, then project id, then `byManagerThenCreated`; inside one project the first two comparisons are always ties, so what is left *is* the shared within-project order the Terminals page and the roster table already use. There is no project-tier comparator.

A null or empty `projectId` yields **no rows**, never the whole fleet: this card sits under a project heading, so listing another project's sessions there states something false, while listing none states only that the page is not ready.

## One preference, not a second toggle

`scopeAdmitsAgent(agentId, scope, spawnableAgentIds)` is now **the** predicate, in one place, and both scoped surfaces call it — the roster through `filterRosterRows`, the terminal list through `filterScopedSessions`. The difference between the two filters is the roster's `child` indent repair, which a flat terminal list has nothing to do.

Everything `effd47d5` decided about that preference is inherited unchanged and is not re-decided here: "spawnable" is `splitRoster`'s agent-id set taken as an **argument** (never re-derived from `session.role !== "worker"`), `null` means "the agent/rig reads have not landed" and admits everything, an empty set is the real answer and admits nothing, and the default stays `"all"`.

**The toggle itself stays in the roster's head and is not duplicated.** One preference with two controls is two preferences the moment they can disagree. The Sessions card instead *names* the control in its footer while anything is hidden — `"…hidden by the filter on the card above"` — which is what makes the single control findable from the second surface.

## The two cards' populations differ, and that is correct

The roster lists every non-archived manager and worker, **exited ones included**, because its question is "what is this project working on". A terminal list can only list what is actually running: an exited session has no pty to attach to, and a companion is not driven from one.

So the two heads state different counts. That is not the defect card `9b6be377` recorded — that one is a card's own **head** disagreeing with that card's own **list** ("a card reading 3 beside a list showing 2"). Both heads here count exactly what their own body lists, and each footer names its own omissions. The e2e pins the divergence with a seeded exited session that the roster shows and the Sessions card does not.

## Placement

Brief line → **Needs you** → **Work in flight** (roster + toggle) → **Sessions** → Board → Pulse.

- **Needs you stays first** — the owner's own amendment on `269f46ef` ("'Needs you' should be on top in its own row so it has enough space").
- **Directly under the roster**, and that adjacency is load-bearing rather than tidy: the control that governs both lists lives in the roster's head, so the two have to be visible together for one toggle to read as governing two populations. Measured at 1440: the toggle and the whole Sessions card are on screen at once.
- **Above Board and Pulse** because those are navigation and history while these two are the project's live state — the same ordering `9b6be377` used to put the Workspace card above its project grid.

## Do not

- **Do not fold this list into the roster card.** The roster is a seven-cell grid that must keep every cell at both widths (`269f46ef`: "do not drop a column"), so an expandable terminal region hung off a table row needs a second render path through it — and most roster rows are not expandable at all, because the roster lists exited sessions. A control that does nothing on most rows reads as broken, not as filtered.
- **Do not give this card its own scope toggle, and do not add a second definition of "spawnable".** One preference, one control, one predicate (`scopeAdmitsAgent`). The footer names where the control is.
- **Do not re-spell the running-session predicate** in `projectRunningSessions`. Delegate to `workspaceRunningSessions`, or the two tiers drift into listing different things under one word.
- **Do not render a second `TerminalCard`, pre-expand a row, or pass `resizable`.** `9b6be377`'s performance contract now binds every node that mounts `SessionTerminalList`, not just the Workspace one — each mount is a real `/ws/term` attach plus an xterm instance, and `CLAUDE.md` records that the cockpit's renderer has frozen on one.
- **Do not let collapsing a terminal reach the session.** Sessions outlive viewers: collapsing releases the view and nothing else. The e2e reads the daemon's own `processState` across a collapse, with an exited session as the contrast case so the "still live" reading is discriminating.
- **Do not give this card an `action` exit.** The roster card immediately above already carries `Sessions ↗` → `/terminals`; a second copy of that link 200px below it is the same-thing-twice shape this tab is built to avoid. Each row's `Open ↗` is this card's exit, and it goes somewhere that link does not.
- **Do not re-add the Board embed, the `KpiDeck` or the `BandDisclosure`** while adding cards here. `269f46ef`'s removals are the owner's own instruction and are untouched by this card.
- **Do not seed an extra ROSTER row into `seedRiggedFleet`.** The two scope legs from `effd47d5` pin the roster's population and its segment counts exactly; this card's own exited-session negative is seeded inside the leg that needs it. (Measured: adding it to the shared fixture reddened both of those legs.)

## Known, pre-existing: the row's narrow-width budget

At 420 the row's state pill + role badge keep their natural width while the agent name ellipsises (`"Orchest…"`). This is `SessionRow`'s inherited behaviour, not new: `.loom-wsession-state` already drops its `min-width` below 820px (`9b6be377`), and what remains is the pills' own content. This node is in fact **better off** than the Workspace one, which additionally carries the project name on the same line. Changing it would alter both nodes' rendering, so it is left alone here and named rather than silently inherited.

## Verified

- `pnpm build` exit 0 — tsc, tsc-e2e, vite, and **55 web unit files** (`atlas-project-overview.mjs` 33 → 38 checks, `workspace-sessions.mjs` 16 → 22).
- `packages/web/e2e/atlas-project-overview.spec.ts` — **8/8**, the six pre-existing legs byte-identical in behaviour plus two new ones.
- `packages/web/e2e/atlas-workspace-sessions.spec.ts` — **4/4**, untouched, proving the extraction left that node's rendering intact.
- `packages/daemon/test/working-tree-eol-guard.mjs` — pass, for the one new source file.
- Eyeballed at **1440 and 420**, both scopes, with a terminal expanded, against the e2e fixture daemon at a real pinned 80×24 geometry. `scrollWidth === clientWidth` asserted at both widths. PNGs: `$LOOM_PROJECT_WORK_DIR/0bcfa530-terminals/`.

### Negative controls

Each is **API-keeping** — a reverted-to-pre-card control would be structural here (a new file and new exports), which proves nothing (`"not a function"` is not a behaviour failure). Every build exit code was checked before any RED was believed; the two that reddened a unit test could not produce a green build at all, so their e2e half was run against a `vite build` that bypasses the unit gate.

| Mutation (API kept) | Reddened |
|---|---|
| `projectRunningSessions` ignores `projectId` | unit *"only the named project's sessions are listed"*; e2e `sessRows` count on both new legs — the other project's session is listed |
| `filterScopedSessions` passes `"all"` to the predicate | unit *"both scoped filters keep exactly the same sessions, in every mode"* at `scope=spawnable set=[]`; e2e the toggle leg **and** the reload leg's own Sessions assertion |
| `SessionTerminalList` mounts `rows[0]` instead of the expanded row | e2e the project node's "MOVE IT" byte-change assertion **and both** Workspace-node attach assertions — which is itself the proof the component is genuinely shared |
| the card reads `DEFAULT_ROSTER_SCOPE` instead of the live `rosterScope` | e2e the toggle leg and the reload leg — isolating "the card reads the *same live* preference" from "the filter works" |

Every one of the four was a **split**, not a blanket red: the six pre-existing legs stayed green throughout.
