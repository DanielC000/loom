# 25c08fba — the project surfaces are tabs on the project node

Card `25c08fba` (Atlas restructure 3 of 11, epic `9fe8cd4e`), on card `0d0c6cee`'s entity tree. The approved design is the round-4 V2 mockup's own declarations — `atlas.js`'s `PROJ_TABS` prepended by `homeTabs("proj")` — not the screenshots: Overview · Deck · Board · Sessions · Agents · Repository · Memory · Runs · Archive · Settings.

> ⚠ **Superseded in part by card `44f725fe`** (the owner's D1 pick, request `fb8de852`): the `Deck` tab is gone and the two HOME tabs are now ONE `Overview`, so this node declares **nine** tabs, not ten. Everything below about a RE-HOMED tab's address, the mount-once rule and the hook-above-the-early-return trap is untouched and still current — only the home-tab half of the set changed. See `docs/decisions/44f725fe-atlas-unified-project-home.md`.

## A tab's address is the path it already had

Only the HOME tabs are `?tab=` on `/project` — at the time of this card, two readings of one home, which is what the mockup's own `homeTabs().concat(PROJ_TABS)` split says they are (card `44f725fe` has since unified them into one, which is the bare path). Every other tab keeps the path it had, and `AtlasShell` routes that path at the project node instead of at the bare page. Three reasons, each sufficient alone:

- **A `?tab=` on `/project` collides with the tab body's own `?tab=`.** `pages/Repository.tsx` reads `?tab=git` off the query string itself, as Actors and Automation do. One query parameter cannot address both the node's tab and its body's sub-tab.
- **`LEGACY_REDIRECTS` is mounted by BOTH shells from one declaration.** A row pointing `/board` at `/project?tab=board` would redirect the classic shell too, breaking this card's switch-OFF contract. A second, Atlas-only redirect table would be a second list to keep in step for no gain.
- **Nothing has to be re-pointed.** Every `<Link to="/runs">`, band-panel `action`, palette row and bookmark already names these paths.

So this card adds **no `LEGACY_REDIRECTS` row at all** — a redirect needs an address to leave behind, and these did not move. It also keeps `atlas-tree.spec.ts`'s content-identity walk meaningful: that walk requires the URL to still be the destination's own path after clicking its node.

## The node head still names the TAB, not the project

The mockup's `node-title` on a tab view is the PROJECT's name, with the tab as the deepest crumb. This card keeps the heading as the tab's own label, unchanged from today: `atlas-legacy-redirects.spec.ts` asserts the node heading equals the tree row's label for every redirect target (`/repository` is one), and the node head's own shape — its pills, its `Spawn +` / `More ⋯` cluster — belongs to the cards that own it. Crumbs already read `Workspace / <project> / <tab>`, which is the mockup's trail exactly.

## Mount once, then park with `hidden`

A tab body is mounted on FIRST VISIT and never unmounted after; inactive ones carry `hidden`. The owner's directive is that a tab click is not consent to discard unfinished input, and unmounting the body you are leaving destroys a half-typed Settings field, a board filter or a commit message. Same mechanism as the Platform node's five panels (card `c07ff42a`).

First-visit rather than always-mounted because the cost here is not that node's: nine bodies polling on every project address is not what the classic shell already paid (these were nine pages), and the Sessions body opens a live pty WebSocket per live session. First-visit-then-sticky is exactly enough for the directive — input can only exist in a body that has rendered.

The two HOME tabs are the one exception and stay mutually exclusive: they hold no input, each carries a full `<Board/>`, and `atlas-home.spec.ts` pins it from the other side (the Deck tab must leave no `atlas-kpi-deck` in the document, which a parked Overview would).

## `/terminals` is the only tier change

It is an unscoped god-eye page in the classic rail and the design's project-node "Sessions 5" tab, so under Atlas it sits at project depth under the name "Sessions". `NAV_PAGES` still declares it unscoped, because the CLASSIC page still is. Depth and label come from `PROJECT_NODE_TABS` via one resolver (`projectNodeTabAt`) the node, the frame and the tree all read, so the three cannot disagree. Its body takes a `projectName` prop pre-selecting the page's own project filter — an affordance that page already documented — so the tab's count and its contents describe one set.

## Measured, not reasoned

- **React error #310.** The visited-set `useRef` was first written below ProjectHome's `!projectId` early return, so the no-project path called one fewer hook than the resolved one and the first resolve of the active project blanked the app on every project-node address — only on a load with no project pinned yet, which is why most of the suite stayed green through it.
- **The ten-tab row was clipped at 420px.** `.loom-atlas-tabrow` never wrapped; with two tabs it never reached its container's edge, with ten it did, and the last five were off-screen with no scrollbar. It now wraps, changing nothing where the row already fits.

## Do not

- **Do not re-address a project tab as `?tab=` on `/project`.** It collides with the tab body's own `?tab=`, and the both-shells redirect row it would need breaks the switch-OFF contract.
- **Do not unmount an inactive tab body, and do not park one with an inline `display`** — that out-specifies the UA `[hidden]` rule. Unfinished input must survive a tab switch.
- **Do not declare a hook below the `!projectId` early return.** See above; it blanks the app rather than failing locally.
- **Do not derive a re-homed tab's depth or label from the page's own `scoped` flag.** `/terminals` is at project depth under Atlas and at workspace depth in the classic rail, and only the tab declaration knows that.
- **Do not add a count a tab has no natural figure for.** Overview, Repository and Settings carry none in the approved design (Deck did too, until card `44f725fe` removed it), and the spec asserts their absence.

## Left for the cards that own them

The KPI strip on every tab (`7874e8c2`), the mounted pages' own duplicate headers (`a7f23a2f`), the node head's pills and actions, session nodes in the tree (so Sessions can stop being a tree row), and `/overview` — still a project-tier tree row, since re-pointing it is P3-switch-over's job.

`atlas-legacy-redirects.spec.ts` gained a `pageSubTabs` helper excluding the node tab row from "exactly one sub-tab is selected" (both are `role="tab"`). Its second use site, the `/skills → /actors?tab=skills` test, is untouched and still correct — it needs the helper only once card `41eab0eb` puts a tab row above `/actors`.
