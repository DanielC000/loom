# f76b89b9 — one tab affordance across the Atlas nodes, and the Platform node's identity in its head

Card `f76b89b9` (Atlas restructure 9 of 11, epic `9fe8cd4e`), on cards `c07ff42a`, `a7f23a2f` and `5968d7e0`. Closes item 9 of the Atlas gap audit (`$LOOM_PROJECT_WORK_DIR/atlas-gap-audit/REPORT.md`).

Card `c07ff42a` built the Atlas Platform node with a boxed `Segmented` for its five tabs, months before `NodeTabs` existed as the shared row. By the time cards `41eab0eb` and `25c08fba` had put that underlined row on the workspace and project nodes, the app was teaching two different "this is a tab" shapes on adjacent addresses — and the node was still stating its own identity a second time, in a strip under the head the frame had already filled with an `<h1>`.

## What shipped

Two changes, both confined to `AtlasPlatformLayout` in `pages/PlatformView.tsx`. The classic layout, every shared section, and the edition resolution above them are untouched.

1. The `Segmented` is now `NodeTabs` — the same component, classes (`.loom-atlas-tabs` / `.loom-atlas-tabrow` / `.loom-navtab`), roles (`tablist` / `tab` + `aria-selected`) and `atlas-tab-<key>` testid stem the project and workspace nodes already wear.
2. The identity strip (the home-name `Badge`, the edition's muted span and its explainer paragraph) is gone. Two node-head pills carry what it stated: `atlas-nodehead-pill-home` (which reserved home resolved) and `atlas-nodehead-pill-scope` (the muted span).

## Why the tabs became real links, and what that changes

`NodeTabs` renders each tab as a `<Link>` to a real address rather than a button over local state. Three consequences, all accepted deliberately:

- A tab is linkable and survives a reload. The node already put its tab in `?tab=`, so no address changed: `home` is the bare `/platform`, the rest are `/platform?tab=<key>`.
- **The back button now returns to the tab you came from.** The old `setParams(…, { replace: true })` kept tab switches out of the history stack, so a back press left the node entirely. That was a reasonable local choice and it is the one behaviour this card knowingly changes — unifying the affordance means unifying what it does, and every other node has worked the forward way since `NodeTabs` shipped.
- `?task=` is still dropped on a tab switch, now by construction: `platformTabHref` builds the address from scratch rather than editing the current params, so a consumed board deep link cannot ride onto a tab with no board to open it on.

## Why the explainer paragraph did not come up with the rest

A node head is one row. The home name and the muted span compress into pills; a 300-character paragraph does not, and leaving it under the tab row would have been the same second identity block in a different place.

So it is simply not rendered inside the frame — the same thing card `a7f23a2f` did to `/memory`, `/gates`, `/inbox` and `/projects`, each of which also lost a descriptive line, and what the owner-approved round-4 mockup shows (`$LOOM_PROJECT_WORK_DIR/atlas-gap-audit/mockup/platform-1440.png`: node head, tab row, then straight into the View-as row and the guided-setup panel, with no identity block anywhere).

**Stated plainly rather than buried:** this is a real content loss for a user who turns the Atlas switch on. The end-user edition's paragraph is the only place that surface explains what Platform is, and unlike `/memory`'s dropped line it is not restated elsewhere on the node — the agent cards carry no prose of their own. The classic page still renders it in full. If the owner wants it kept inside the frame it needs a home with room for it (the Home tab's own body is the obvious candidate), which is a placement decision, not this card's refactor.

## The pill titles are not decoration

`.loom-atlas-headpill` caps at the row's width and ellipsises, so at a narrow viewport the scope pill shows a prefix. Its `title` carries the whole phrase, which is the only thing that keeps the reading recoverable there. Do not drop it as redundant with the text.

## Do not

- **Do not re-add a title, description or identity strip under the Platform node's tab row.** The frame states this node's identity — crumbs, the one `<h1>`, the two pills, the tab row — and a block below it is the duplication this card removed.
- **Do not give the Platform node a boxed `Segmented` tab row again, or hand `NodeTabs` a per-node `aria-label`.** The shared row's `Node tabs` label is what lets one spec fingerprint the project node's row and the Platform node's row and require them equal.
- **Do not turn either head pill into a per-tab reading.** Both are node-level identity and must be byte-identical on all five tabs (card `5968d7e0`'s rule: a head pill is a state or identity phrase, never a figure the row below already carries).
- **Do not restore `replace: true` navigation for these tabs without changing every other node's row too** — the point of the card is that one affordance behaves one way.

## Verification

`platform-edition.mjs` — the source-text test the card warned would redden on a behaviourally perfect refactor — stayed green at 62/62 untouched, because none of the literals it pins (`useAtlasUi(` once, the two `<AgentControl` / `<PlatformAgentsSection` mounts, the `previewOnly={previewOnly}` hop count, the `<PlatformView` mount shapes in `Platform.tsx`) is anything this card edits. That green was proved non-vacuous rather than assumed: importing `components/atlasHome` pulls it and its own imports into that file's transitive write sweep, and a planted `api.updateTask(` call inside `atlasHome.tsx` was caught by the sweep as an undecided write (`components/atlasHome.tsx::__probe.api.updateTask`), which is what shows the new module is genuinely walked.

`atlas-platform.spec.ts` gained legs 10 and 11 and had its `tabs`/`tab`/`openTab` helpers re-pointed from `role="radiogroup"`/`role="radio"`/`aria-checked` to the NodeTabs roles — an intent-preserving change, since card `3f28f1c3` re-roled `Segmented` and deliberately left `NodeTabs` on real tab semantics. One assertion moved rather than changed meaning: the end-user edition marker used to be read inside `main`, and is now read off the scope pill, with `main` asserted to carry no copy of it.
