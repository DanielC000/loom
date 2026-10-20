# The Atlas breadcrumb's deepest crumb shrinks last, by ratio and never by a cap

Card `1d3192dc` (Atlas P1-2 — `docs/plans/atlas-ui/03-decomposition.md` row P1-2). Anchored from `packages/web/src/components/AtlasShell.tsx`.

## What happened

P1-2 gave the Atlas frame its first FOUR-segment breadcrumb trail: `/review/:workerId` reads `Workspace / <project> / <worker node> / Diff`. Every earlier trail was three segments or fewer and fitted at any width, so the crumb row's original equal-shrink layout had never been under real pressure.

At a 420px viewport it was, and it failed in the worst possible direction: each `<li>` carried `flexShrink: 1`, so the deficit was spread evenly and the trail rendered `Wor… / live… / Dev · wor… / D.` — the tab crumb, the one segment that says where you actually are, clipped to two characters while its ancestors kept most of their width.

## Do not

**Do not express the fix as a width CAP on the deepest crumb.** Both obvious forms were tried and both regressed the wide case, which is the common one:

- **An absolute `ch` count** (`flexShrink: 0` + `maxWidth: "48ch"`). Wide enough for `Diff`, and it clipped a 47-character request title at 1500px that had previously rendered in full. Any value wide enough for one realistic detail label is too narrow for a longer one, and a request title is free text — there is no count that is correct.
- **A percentage** (`maxWidth: "70%"`). Worse, because it reads as adaptive and is not: the `<ol>` is sized by its own content, so "70% of the row" is 70% of the trail the cap is meant to protect. Measured: it clipped a 68-character title at 1500px, where the row had hundreds of spare pixels.

## What it does instead

A lopsided shrink **ratio** — the deepest crumb at `flexShrink: 1`, every ancestor at `999` — with no `maxWidth` at all. Flexbox distributes a deficit in proportion to `shrinkFactor × baseSize`, so:

- With no deficit, nothing shrinks and nothing is clipped, at any trail length. This is what a cap could not give.
- With a deficit, effectively all of it lands on the ancestors (each `minWidth: 0` and ellipsising) until they have nothing left to give.
- Only then does the deepest crumb ellipsise too — degrading rather than overflowing the row. `overflow: hidden` on the `<ol>` is the backstop.

This is the same priority `TileTitle` (`packages/web/src/components/TerminalCard.tsx`) already applies to a session's identity line, where the shrinkable prefix gives way and the short id is the last thing to go.

## How it is held

`packages/web/e2e/atlas-param-routes.spec.ts` measures **both** widths, deliberately — the narrow case alone is what led to the two regressions above. It reads clipping off the real rendered boxes (`scrollWidth > clientWidth`), asserts at 420px that an ancestor is clipped (a positive control: without it, "the last crumb is not clipped" would pass on a row with room to spare) while the tab crumb is not, and asserts at 1500px that a 68-character detail crumb is not clipped at all.
