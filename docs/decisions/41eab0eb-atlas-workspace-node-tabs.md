# 41eab0eb — the cross-project surfaces are Workspace node tabs

Card `41eab0eb` (Atlas restructure 2 of 11, epic `9fe8cd4e`), on top of card `0d0c6cee`'s entity tree. The approved design is the round-4 V2 mockup's own declarations — `atlas.js`'s `ROOT_TABS`, `VIEWS` and `NODES` — not the screenshots.

In the mockup every cross-project surface is `node: "root", tabs: "root"`: a tab on the Workspace node, under one persistent readout, with the node head still reading `Workspace` and the crumb trail still stopping at it. The build gave that node only `Overview` and `Deck` and left the rest as tree rows pointing at full-page classic components — the gap audit's own item 2 (`$LOOM_PROJECT_WORK_DIR/atlas-gap-audit/REPORT.md`).

Seven surfaces move here: Inbox, Gates, Automation, Actors, Usage, Companion and the Atlas-only workspace Settings node. Three remain in card `0d0c6cee`'s escape hatch — Terminals belongs to the PROJECT tier (card `25c08fba`'s `Sessions` tab), and Mission Control and Projects are dissolved outright by card `5afd71bd`.

## The declaration

`WORKSPACE_NODE_TABS` (`packages/web/src/nav.tsx`) is an ordered list of `{ key, from }` and nothing else. The tab's LABEL and its BODY are resolved from the `from` address's own `NAV_PAGES` / `ATLAS_HOMES` row (`workspaceNodeTabOf`), so each exists once and a rename reaches the tab for free. Three consumers derive from that one list: the tab row (`pages/WorkspaceHome.tsx`), the Atlas-side redirect (`components/AtlasShell.tsx`), and what is left of the tree's escape hatch (`components/AtlasTree.tsx`, by subtraction — the hatch shrinks on its own as the remaining cards land).

The seven labels this produces match the mockup's `ROOT_TABS` labels exactly, which is why no label literal appears anywhere in this card.

## The redirect is Atlas-only, and that is the point

`/inbox` redirects to `/home?tab=inbox` under Atlas and renders the standalone classic page under the classic shell. That is a genuine divergence between the two shells, and it is why these are NOT `LEGACY_REDIRECTS` rows: that declaration carries ONE target for both shells by design, precisely so a redirect cannot drift between them. Here the shells must differ, so the Atlas shell swaps the route's element for a `<Navigate>` while the classic route table is untouched.

`from` therefore has to stay a live `NAV_PAGES` / `ATLAS_HOMES` address. Deleting one would re-home the surface out of the classic shell too, for a user who never opted into the preview.

## The host/guest `?tab=` collision

Three of the seven already own `?tab=` for sub-tabs of their own: Actors (Profiles | Skills), Automation (Time | Events) and the Companion node (Chat | Manage | Terminal). Hosted on `/home?tab=actors`, a click on Skills wrote `?tab=skills`, the host stopped recognising its own tab, and the whole node fell back to Overview. Not cosmetic — the page broke.

`lib/nodeTabHost.tsx` resolves it by having the HOST declare the key its guest may use (`sub`) and the guest ask for it rather than assume. Standing alone there is no host, the key is `tab`, and every address the classic shell has ever produced is byte-identical — which is what keeps the switch-OFF half of this card true by construction rather than by testing.

Two consequences worth not re-deriving:

- An incoming `?tab=` on a re-homed address is TRANSLATED to `sub`, never dropped. `/skills` → `/actors?tab=skills` is a real legacy chain, and without the translation it would land on Profiles under Atlas and on Skills under the classic shell.
- A tab link in the node's own row is built FRESH, not merged over the live query. `sub` belongs to whichever guest is showing; carrying it onto a sibling tab would hand one guest's sub-tab value to another.

Card `25c08fba` re-homes `Repository`, which owns `?tab=git` in the same shape — it uses this hook rather than a second mechanism.

## Mount on first visit; never unmount after

The owner's standing rule is that no path may discard unfinished input, and five of the seven hold some the moment a reader touches them — a half-written cron, an edited profile or skill, a Settings field, a companion composer draft, an in-progress Request answer. So a panel that has been visited stays mounted and is `hidden` when inactive, the same shape card `c07ff42a` gave the Platform node's five panels.

The Platform node's reasoning does not carry the rest of the way, though. There, mounting all five was the status quo — the classic page already rendered them in one column. Here it would be new cost on the default Atlas landing: a reader arriving at `/home?tab=overview` would start Gates, Usage, Automation, Actors, Settings and the Companion node's twelve manage sections before asking for any of them.

Mount-on-first-visit keeps both halves — nothing a reader has touched is destroyed, nothing they have not touched is started. The visited set is written during render (React's own "adjusting state when a prop changes" path) rather than in an effect, so a tab's first frame is already its content and not an empty column.

The node's own `Overview` and `Deck` stay CONDITIONAL, deliberately: neither holds unfinished input, and the Deck's whole trade is vertical room.

## What this card does not do

Each of these is a named later card, and each is visible when the built node is compared against `mockup/inbox-1440.png`:

- The tab row carries no KPI strip (card 5 of the restructure).
- The node head carries no status pills and no `Spawn +` / `More ⋯` cluster (card 6).
- Every tab body still renders its own `<h1>` under the node head — the double header (card `a7f23a2f`, which this card blocks).
- A guest's own sub-tabs are still a boxed `Segmented` beside the node's underlined `NodeTabs` — two tab affordances on one screen (card 9).
- The Inbox body is still the classic single-column queue, not the mockup's queue + answer pane. The gap audit classes `/inbox` as "wrong structure, still the classic page inside the frame" and scopes this card to moving it, keeping its component as the tab body.

## Where this meets card 25c08fba

Card `25c08fba` re-homed the PROJECT surfaces at the same time, and reached the opposite conclusion about addressing: its tabs keep the paths they already had, with no redirect at all. Its three reasons are worth answering here rather than leaving the two cards looking arbitrarily different.

- **A tab body's own `?tab=` collides with the node's.** True, and it is the central problem of this card — resolved by `useTabHost` rather than avoided. The WORKSPACE node has to carry a `?tab=`: `Overview` and `Deck` already live there, and the seven re-homed surfaces join tabs that exist.
- **`LEGACY_REDIRECTS` is mounted by both shells, so a redirect row breaks switch-OFF.** True of that declaration, which is why this card adds **zero** rows to it. The redirect lives in `AtlasShell`'s own route table, where it swaps the element for a `<Navigate>`; `App.tsx`'s `LegacyShell` maps `NAV_PAGES` straight to `p.element` and never consults `workspaceNodeTabFor`. The switch-OFF contract therefore holds structurally, not merely by assertion.
- **`atlas-tree.spec.ts`'s walk polls `pathname === route` after a click.** True, and that poll is now guarded: a node-tab destination asserts its TAB selection instead, because `/home` is its real address.

Two things a later card inherits from the pair:

- **`Segmented` becomes `role="radio"` in card `3f28f1c3`.** Every guest sub-tab locator here — this card's own spec and the scoped ones in `atlas-legacy-redirects.spec.ts` — selects `[role="tab"]` and will need re-pointing when that lands. Not pre-adapted, because today it would be wrong.
- Card `25c08fba` added a `pageSubTabs()` helper to `atlas-legacy-redirects.spec.ts` that excludes `[data-testid^="atlas-tab-"]` globally. This card solves the same two-tablists-on-one-page problem by scoping to the guest's own `atlas-tabpanel-<key>` wrapper. Either works; one of them should win when the two branches land.

## Do not

- **Do not turn these into `LEGACY_REDIRECTS` rows.** That declaration is one target for both shells; this is the one case where the two must differ, and folding it in would re-home the surface out of the classic shell.
- **Do not remove a re-homed address from `NAV_PAGES` / `ATLAS_HOMES`.** It is still the classic shell's live route, and it is where the tab's own label and body are resolved from.
- **Do not hardcode `"tab"` in a page that owns a sub-tab query.** It is invisible under the classic shell and silently breaks whichever node hosts the page. Read the key from `useTabHost`.
- **Do not render only the active panel** (it destroys unfinished input), **and do not mount all seven up front** (it makes the default landing pay for six surfaces nobody opened).
- **Do not put an inline `display` on a panel wrapper.** An author `display` out-specifies the UA's `[hidden]` rule and would silently un-hide it.
- **Do not read `WORKSPACE_NODE_TABS` at module scope from a module `nav.tsx` imports.** `nav.tsx` imports `pages/WorkspaceHome.tsx` for the `/home` element and that module imports the declaration back, so during module evaluation the binding is still undefined — a `const` built from it there blanked the entire app rather than failing in any one component. Read it inside a function; ESM live bindings make the cycle harmless then.
