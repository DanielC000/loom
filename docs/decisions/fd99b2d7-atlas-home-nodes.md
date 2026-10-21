# The Atlas home nodes are Atlas-only addresses, and the tree's parity check had to learn that

Card `fd99b2d7` — Atlas build plan P2-1 (`docs/plans/atlas-ui/03-decomposition.md`). Two decisions, both made while adding the Workspace root node and the project node.

## 1 · `ATLAS_HOMES` is mounted by `AtlasShell` only, never by `LegacyShell`

`src/nav.tsx` holds four declarations. Three of them — `NAV_PAGES`, `PARAM_PAGES`, `LEGACY_REDIRECTS` — exist precisely *because* both shells mount them: a path/element pair copied into two route tables drifts the moment one is edited, and the drift is silent, since each shell only renders under its own switch state so a test exercising one can never see the other go stale.

`ATLAS_HOMES` is the opposite case and is declared beside them anyway, so a reader looking for "what addresses does this app have" finds all four in one file.

`/home` and `/project` are **new nodes the classic IA has no equivalent of.** The parity checklist (`docs/plans/atlas-ui/01-parity-checklist.md` §A rows 1–2) maps Mission Control (`/`) onto *Workspace › Deck* and the project Overview (`/overview`) onto *project › Deck* — but that re-pointing is P3-switch-over's job. Phase 1's content-identity contract (`e2e/atlas-tree.spec.ts`) requires `/` and `/overview` to render byte-identically under both shells until then, so the home nodes could not simply take those paths.

### Do not

- **Do not add `ATLAS_HOMES` to `LegacyShell`'s route table.** Mounting them there puts a half-built phase-2 surface in front of a user who never opted into the preview — the one thing the switch exists to prevent. With the switch off, `/home` and `/project` correctly fall through to the classic shell's own unmatched-route behaviour.
- **Do not re-point `/` or `/overview` at these components inside `AtlasShell`.** That breaks phase 1's content-identity contract for those two destinations, which is a regression, not a migration. The migration is P3-switch-over, with the owner's sign-off in front of it.
- **Do not promote a node's `?tab=` to a route.** The frame's crumbs and `<h1>` derive from the NODE; a tab is a view of that node, and making it a route would put the tab in the address trail where the mockup puts only the node.

## 2 · The tree's node-set parity check is now "superset, by declaration"

`e2e/atlas-tree.spec.ts` asserted `treeRoutes` **equals** the classic rail's destination set. That was correct for phase 1, where the tree held exactly the 17 classic destinations and nothing else. Phase 2 adds nodes with no rail equivalent on purpose — these two homes, then the Agents node (P2-2) and the Platform node (P2-4) — so a strict equality fails every one of those cards by construction and would be "fixed" by whoever lands next, probably by relaxing it to something that proves nothing.

It is now: **every rail destination still has a node (unchanged, strict), and every EXTRA node must appear in `ATLAS_HOMES`** — parsed out of `src/nav.tsx`'s real source text the same way `atlas-legacy-redirects.spec.ts` parses `LEGACY_REDIRECTS` (the e2e tsconfig covers `e2e/` only, so a spec cannot import a `src/` module).

### Do not

- **Do not weaken this to a bare subset check** (`railRoutes ⊆ treeRoutes` with extras unconstrained). The extras are exactly where a typo'd or orphaned node hides; constraining them against a declaration is what keeps this check as strong as the equality it replaced.
- **Do not hand-list the expected extra addresses in the spec.** The parse is what makes the next phase-2 node covered the day it is declared, with no spec edit — and the filtered-vs-raw row-count control is what keeps a quietly-stopped-matching regex from returning a plausible subset.

## Where the tabs live

`?tab=overview` (default) / `?tab=deck` on the node's own path, read with `useSearchParams` and rendered as `<Link>`s wearing the app's existing `.loom-navtab` class. `NavLink` is deliberately not used: its `isActive` matches on pathname alone, so both tabs would read active on the same path.
