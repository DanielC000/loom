# Retiring Mission Control and Projects as Atlas destinations

Card `5afd71bd` — Atlas restructure 11 of 11, epic `9fe8cd4e`. Spec: item 11 of the Atlas gap audit. Owner sign-off: request `b54c9e59`, "Retire both in Atlas (as the design shows)".

The approved round-4 V2 design dissolves two of the classic shell's destinations rather than re-homing them. Both were class **D** in the gap audit — present in Atlas, absent from the mockup — and both were still a tree row and a full page. This card removes them from the Atlas shell only: with the switch OFF, each renders exactly as it did before, which is the condition the owner's sign-off was given under.

## The mechanism

`ATLAS_RETIREMENTS` in `packages/web/src/nav.tsx` is a list of `{from, to}` pairs. `AtlasShell` reads it twice: once to swap each retired address's route element for a `<Navigate to={to} replace/>`, and once to drop the address from `BY_SPECIFICITY`, the frame's own `currentPage` lookup. `AtlasTree` reads it not at all — it simply no longer has anything that would render a retired destination, because the escape hatch is gone (below).

Three properties of that shape are load-bearing:

**The addresses stay in `NAV_PAGES`.** That array is mapped by BOTH shells, so the classic rail, the classic route table and the Command Palette's own list all still carry both destinations. Deleting a row, or moving a retirement into `LEGACY_REDIRECTS` (whose rows deliberately carry ONE target for both shells), would delete the destination from the classic shell too — which is precisely what the owner's sign-off excluded.

**There is no `retired` flag on `NavPage`.** A flag would be read by the classic shell's own mapping of that array, where it means nothing, and it cannot say the one thing that actually matters: *where* the address goes.

**The frame drops the NAME, not just the route.** A `<Navigate>` is a navigation react-router performs on the first render AFTER the match, so a retired page left in `currentPage` would put "Mission Control" in the node head and the crumb trail for that frame — naming a node the tree no longer holds. The tree's row and the frame's name are removed from the same declaration, so they cannot disagree.

### Why both retire to `/home`

Mission Control's surfaces are all on the Workspace node or a tab of it. The Projects page's are spread deeper — project lifecycle on the project node's Settings tab, the archived tier on the Workspace node's Settings tab, agent definition on the Agents node, project creation on the Platform node's guided setup wizard — but its *primary* pane, the "All projects" rail, is the tree's own project tier plus that node's Projects grid. Landing on the shallowest node that contains the pane a reader came for is the same "scope is depth" rule the tree itself follows; landing deeper would be guessing which of four panes they wanted.

## Do not

- **Do not move a retirement into `LEGACY_REDIRECTS`, and do not drop its `from` from `NAV_PAGES`.** Either one deletes the destination from the CLASSIC shell, for a user who never opted into Atlas. A retirement is Atlas-only by construction, and that is the whole scope boundary of this card.
- **Do not re-add a tree escape hatch.** An unscoped `NAV_PAGES` destination named in none of `WORKSPACE_TIER_NODES`, `WORKSPACE_NODE_TABS` or `ATLAS_RETIREMENTS` is now simply ABSENT from the tree. Decide its placement in one of the three instead. `atlas-tree.spec.ts`'s four-way partition fails on a destination that lands in none of them, which is the structural guard that replaced the hatch.
- **Do not give the Workspace node's Pulse band an `action`.** It is the deepest cross-project view of the orchestration event stream the app has. The Replay tab is wave replay (a different corpus), `/runs` is a project tab (the wrong tier), and a session's Timeline is one slice of it — each would be the affordance lying about where "all of this" is.
- **Do not point a "new project" affordance back at `/projects`.** Project creation's Atlas home is the Platform node's guided setup wizard.

## The re-pointed links

Every link into a retired address was re-pointed rather than deleted; the labels did not change, because what each control *does* did not.

| Site | Was | Now | Why |
|---|---|---|---|
| `WorkspaceHome` Pulse band `action` | `/` ("Mission") | *(no action)* | Nothing deeper exists — see the prohibition above |
| `WorkspaceHome` "New project ↗" (×2, Overview + Deck) | `/projects` | `/platform` | The guided setup wizard is where project creation went |
| `WorkspaceHome` empty project grid copy | "…from the Projects node" | "…with guided setup on the Platform node" | Same destination, named in prose |
| `AgentsNode` "All projects ↗" | `/projects` | `/home` | This node is one project's roster; the Workspace node is where every project is listed |
| `CommandPalette` page rows | both listed | both filtered when the switch is ON | Offering a destination that silently lands somewhere else is worse than not offering it |

`CommandPalette` is the one place outside the two shells that has to know about a retirement: `App.tsx` mounts a single instance of it for both shells. It reads `useAtlasUi()` once, at the component's own entry, the way `pages/Settings.tsx` reads it to pick its sections — never inside the row-building map, and never by a row deciding its own visibility.

`components/Sidebar.tsx`'s attention `statrow` still calls `navigate("/")`. That is correct and deliberate: the Sidebar is the CLASSIC rail, mounted only by `LegacyShell`, where Mission Control is still a live destination.

## The escape hatch is gone

Card `0d0c6cee` moved ten cross-project destinations out of the tree's rows and parked them in a "Not yet re-homed" disclosure at its foot, with its demolition date named when it landed: the last re-homing card deletes it. Card `41eab0eb` took seven as Workspace node tabs, `25c08fba` took `/terminals` down to project depth, and this card retires the last two — so `UnhomedDestinations`, its `unhomed` derivation, and the whole `.loom-atlas-unhomed*` stylesheet block are deleted.

That removes a fallback. The replacement is not another fallback but the test partition: a destination in none of the four placements fails `atlas-tree.spec.ts` rather than appearing in a flat list bolted to the side of a hierarchy, which was the "worst of both worlds" `0d0c6cee` existed to end.

Four specs carried assertions about the hatch, and each one's **positive control** is what decided how to treat it — an absence claim is only worth keeping where a collector can still be shown firing:

- `atlas-tree.spec.ts` had `expect(unhomedRoutes.length).toBeGreaterThan(0)` with a comment naming this card as the one that would delete it. It is now `toEqual([])` plus a `toHaveCount(0)` on the disclosure. The hatch stays a *bucket* in the partition, so a re-added entry would still be counted and would still fail the "exactly one placement" claim.
- `atlas-workspace-tabs.spec.ts` had a per-row "a tab is not also a hatch entry" zero, controlled by reading an arbitrary hatch entry off the rendered hatch. With nothing left to read, that control cannot fire, so the assertion was removed rather than left as a zero with a false justification. The claim moved to a document-wide one, which is strictly stronger.
- `atlas-param-routes.spec.ts` had a `a.loom-atlas-unhomed-link.is-here` zero whose justification cited atlas-tree.spec.ts's (now deleted) positive control. Removed for the same reason.
- `atlas-legacy-redirects.spec.ts`'s `treeNodeAddress` fell back to a hatch entry when a redirect target had no node. There is no second place to look now, so it requires the node outright and says what is missing when there isn't one.

## What was verified before anything was deleted

Every surface the gen-439 investigation flagged as living only on `/` or `/projects` was re-checked against the running code, and its Atlas home named. The result is in the worker's report for this card; the three blockers it identified (`c9b78d80`, `baca1835`, `ff6123de`) had all landed first.

### One measured gap, deliberately NOT closed here

The Workspace node's Pulse band and Mission Control's Activity column share a derivation byte-for-byte — same `["orchEvents", managerId]` query keys, same flatMap, same sort, same `GLOBAL_ACTIVITY_CAP`, same `EventRow` — **except for the manager set they fan out over**. Mission Control fans out over every non-archived manager (`allSessions` filtered by role); the Pulse band fans out over LIVE, non-companion managers only (`pages/WorkspaceHome.tsx`'s `live`). So the band's population is a strict subset: orchestration events belonging to a manager that has exited but not been archived are in Mission Control's feed and not in the band's.

Widening the band to match would add one `api.orchestrationEvents` poll at `refetchInterval: 3000` per non-archived exited manager, on the most-visited node in the app, unbounded by anything but how many such managers the workspace has accumulated. Mission Control accepted that cost on a page people visited occasionally; moving it onto the Workspace root is a different trade, and not one this card was scoped to make. It is recorded here rather than silently absorbed.
