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

## Why the explainer paragraph lives on the Home tab, not in the node head

A node head is one row. The home name and the muted span compress into pills; a 300-character paragraph does not, and leaving it under the tab row would have been the same second identity block in a different place. So the first build of this card simply did not render it inside the frame — the same thing card `a7f23a2f` did to `/memory`, `/gates`, `/inbox` and `/projects`, each of which also lost a descriptive line, and what the owner-approved round-4 mockup shows (`$LOOM_PROJECT_WORK_DIR/atlas-gap-audit/mockup/platform-1440.png`: node head, tab row, then straight into the View-as row and the guided-setup panel, with no identity block anywhere).

**That was reversed on review, and the reasoning is worth keeping.** This paragraph is not the same kind of thing as `/memory`'s dropped line. `/memory`'s was partly redundant — the entry count it carried is read off the foot strip — whereas this one is the ONLY place the surface explains what Platform is: the agent cards below it carry no prose of their own, and the pills state scope, not purpose. Deleting it would have cost a brand-new end user, on the exact surface built to onboard them, their only explanation, in exchange for visual tidiness. **A mockup omitting something is not a decision to delete user-facing guidance** — it is silent about it, and silence is not an instruction.

So it renders at the top of the **Home tab's body**, as muted body copy (`data-testid="platform-explainer"`), above the guided-setup launcher. That placement is the honest one: it is not identity (the frame states that once, above), it is an explanation of the agents the Home tab actually shows. The dev edition gets its own paragraph in the same place, so the placement belongs to the node rather than to one edition. The classic layout is untouched and still renders it under its own one-line heading.

**Home only, and exactly once.** All five panels stay mounted (inactive ones only `hidden`), so a second copy on another tab would be a live second match in the DOM, not a harmless alternative — which is why the spec counts it page-wide rather than scoping the count to a panel.

## The pill titles are not decoration

The scope pill deliberately shows only the first clause of the classic page's caption; its `title` carries the whole caption, which is what keeps the dropped clause ("hidden from the project picker") reachable. Do not remove it as redundant with the pill text — it is not the same string.

This matters more than a tooltip usually would, because **a head pill cannot truncate gracefully.** `.loom-atlas-headpill` is `display: inline-flex`, and `text-overflow: ellipsis` does not reach a bare text child of a flex container (that text is an anonymous flex item, unstylable), so a pill wider than its box is **clipped mid-word with no ellipsis**. Measured at 420px with the full caption: `scrollWidth` 462px in a 388px box, right edge still inside the viewport and `document.scrollWidth == clientWidth` — so no box, overflow or document-width assertion can see it; the only honest claim is `pill.scrollWidth <= pill.clientWidth`, which the spec now makes. The fix here was shorter copy, not a change to the shared pill: **the underlying kit defect is filed as its own card** and is deliberately out of scope here.

## Do not

- **Do not re-add a title, description or IDENTITY strip under the Platform node's tab row.** The frame states this node's identity — crumbs, the one `<h1>`, the two pills, the tab row — and a block below it is the duplication this card removed. The Home tab's explainer paragraph is not that block: it states purpose, not identity, and is covered by the next rule.
- **Do not delete the Home tab's explainer paragraph, and do not copy it onto a second tab.** It is the only place this surface explains what Platform is, and every panel stays mounted, so a copy elsewhere is a live duplicate in the DOM rather than an alternative placement. Keep it `Home`-only and keep it exactly one.
- **Do not give the Platform node a boxed `Segmented` tab row again, or hand `NodeTabs` a per-node `aria-label`.** The shared row's `Node tabs` label is what lets one spec fingerprint the project node's row and the Platform node's row and require them equal.
- **Do not turn either head pill into a per-tab reading.** Both are node-level identity and must be byte-identical on all five tabs (card `5968d7e0`'s rule: a head pill is a state or identity phrase, never a figure the row below already carries).
- **Do not restore `replace: true` navigation for these tabs without changing every other node's row too** — the point of the card is that one affordance behaves one way.

## Verification

`platform-edition.mjs` — the source-text test the card warned would redden on a behaviourally perfect refactor — stayed green at 62/62 untouched, because none of the literals it pins (`useAtlasUi(` once, the two `<AgentControl` / `<PlatformAgentsSection` mounts, the `previewOnly={previewOnly}` hop count, the `<PlatformView` mount shapes in `Platform.tsx`) is anything this card edits. That green was proved non-vacuous rather than assumed: importing `components/atlasHome` pulls it and its own imports into that file's transitive write sweep, and a planted `api.updateTask(` call inside `atlasHome.tsx` was caught by the sweep as an undecided write (`components/atlasHome.tsx::__probe.api.updateTask`), which is what shows the new module is genuinely walked.

`atlas-platform.spec.ts` gained legs 10 and 11 and had its `tabs`/`tab`/`openTab` helpers re-pointed from `role="radiogroup"`/`role="radio"`/`aria-checked` to the NodeTabs roles — an intent-preserving change, since card `3f28f1c3` re-roled `Segmented` and deliberately left `NodeTabs` on real tab semantics. One assertion moved rather than changed meaning: the end-user edition marker used to be read inside `main`, and is now read off the scope pill, with `main` asserted to carry no copy of it.
