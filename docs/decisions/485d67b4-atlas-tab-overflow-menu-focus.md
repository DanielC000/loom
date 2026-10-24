# 485d67b4 — an open Atlas tab-overflow menu must never lose its DOM, or its focus, to a relayout

Card `485d67b4` (retitled mid-flight from `test(web)` to `fix(web)`), discovered from card `5afd71bd`.
Anchored at `packages/web/src/components/atlasHome.tsx`'s two-fit split.

## Do not

- **Do not collapse `settledFit` and `fit` back into one value**, and do not gate the menu's own
  `overflow` list on `measuring`. The row's fit must go to `tabs.length` during a measuring pass —
  that is how the chip widths are captured — and the menu's must not follow it there.
- **Do not key the focus effect on `[open]` alone.** The item that holds focus can unmount while
  `open` stays true, and an `[open]`-keyed effect never re-runs to put focus back.
- **Do not turn the reclaim pass into an unconditional `if (open) focusItem(0)` on every list
  change.** It would yank focus back to item 0 from wherever the reader had arrowed to. It reclaims
  from `<body>` only, which is the one state the browser produces and no reader ever chooses.
- **Do not read `document.activeElement` bare after a visibility assertion in these specs.** It
  passed for three months by outrunning the bug; see "Why the old test was green".

## The defect

The menu focused its first item from a passive effect keyed only on `open`:

```ts
useEffect(() => { if (open) focusItem(0); }, [open]);
```

and its body rendered under `{open && overflow.length > 0 && …}`.

A re-measure — `document.fonts.ready` resolving, the `ResizeObserver`, or the `signature` effect —
sets `measure: true`. `measuring` forced `fit` to `tabs.length`, so every tab went back in the row
and `overflow` computed to `[]`. React then **destroyed the menu's DOM while `open` was still true**.
Focus fell to `<body>`, the `[open]` effect never re-ran, and focus never came back. The measuring
render is not painted (its `useLayoutEffect` re-renders before paint), so there was no visible
flicker — but the DOM removal, and therefore the focus loss, happened anyway.

A keyboard reader who opened the menu in that window was stranded on `<body>` with the menu open.

Instrumented capture, pre-fix (twice, independently):

```
focusin atlas-node-tabs-more → FONTS-READY → focusin atlas-more-item-repository
→ focusout atlas-more-item-repository
settled: { active: "BODY", menuPresent: true, itemCount: 5, expanded: "true" }
```

Focus landed correctly at ~13ms and was lost ~30-50ms later.

## Why the old test was green

`atlas-node-tab-overflow.spec.ts`'s keyboard leg read `document.activeElement` bare, the instant
`toBeVisible()` resolved — inside that ~30-50ms window. It was **validating a correct transient
state the user never keeps**, and reporting green.

Replacing the bare read with a retrying `focusedTestId` poll **raised** the observed failure count,
4/20 → 8/20. That rise is the fix working: the two numbers measure different things — how often the
read beat the defect, versus how often the defect occurs. A before/after flake delta here must never
be read as "the test got worse".

## The fix, and why this mechanism

Two independent relayout cases produce the same stranding, and they need different answers.

**1. The measuring pass — split the fit (the primary fix).** `layout.fit` survives a re-measure
(`setLayout(cur => ({ ...cur, measure: true }))` never clears it), so the menu renders from
`settledFit` while the row renders from `fit`. During a measuring pass the menu's list is unchanged,
React reconciles the items in place, and no DOM is destroyed. Chosen over re-focusing after the
fact because it prevents the teardown rather than papering over it: nothing unmounts, so nothing has
to be restored, and the (unpainted) flicker goes too. Measurement confirms the row still draws every
tab, so `recompute()`'s `chips.length !== tabs.length` guard is unaffected — the menu is a sibling of
the row and carries no `data-nt-chip`.

**2. A genuine relayout — reclaim focus from `<body>` only (the backstop).** A real viewport change
legitimately changes which tabs overflow, so the item holding focus really does unmount and no
freeze can prevent it. The effect is keyed on the item list as well as `open`, and on a non-opening
pass it moves focus only when the browser has dropped it on `<body>`.

Rejected: closing the menu on a relayout (it would yank the menu out from under a reader
mid-interaction, for a list change they can see happen), and keeping focus on the trigger instead
(a reader who pressed Enter to enter the menu would be silently put back outside it).

## Evidence

Every control rebuilt first, build exit code checked, `atlasHome.tsx` restored byte-identical (md5)
after each. The built bundle's content hash was checked to differ between polarities, because a
stale `dist` is exactly how one of these controls first produced a false green.

| State | Result |
| --- | --- |
| Neither half (HEAD), whole spec ×20 | 4/20 red — the bare read; the pre-fix baseline |
| Neither half, web-first spec ×20 | 8/20 red |
| Neither half, web-first spec ×10 (control C) | **8/10 red**, all at the keyboard leg |
| Freeze only, no backstop ×10 (control B) | **10/10 green** — the freeze alone fixes case 1 |
| Both halves, whole spec ×20 | **0/20 green** (140/140 test runs) |
| Both halves, instrumented probe ×12 | 0 settled on `<body>`; **12/12 saw `FONTS-READY` land in the window**, so the trigger really was exercised |
| Resize probe, backstop removed | **3/3 `active: "BODY"`** |
| Resize probe, backstop present | 3/3 focus on the new item 0 |

The resize case is now a permanent leg ("an open menu keeps keyboard focus across a relayout"),
which asserts the overflow list actually changed before claiming focus survived — without that
control the focus claim is vacuous.

## Not fixed here, and why

`AtlasTree.tsx`'s drawer uses the same `[open]`-keyed passive-effect focus (`nav.focus()`), but its
focus target cannot be destroyed this way: the drawer **overlays** and the `<nav>` stays mounted at
every width — that is `@decision 49e883a9`'s own standing prohibition ("never express it by
unmounting the tree"). No re-measure removes it, so there is nothing to strand. Its two e2e focus
reads were still converted to `toBeFocused()`, because the passive effect can land *late* even where
it cannot land *never*.

One observation left unattributed: a single run of the "blocks are ONE line" leg failed on unchanged
`HEAD` with `workspace: block 74px, one line is 35px`, and did not recur in 40 further runs. The
trigger is plausibly the same font-ready re-measure — the row legitimately draws every tab then, and
wraps — but **this change does not fix it**: `rowTabs = tabs` while measuring is deliberate and
untouched. It is a geometry read racing a measuring pass, not a focus loss, and it needs its own
card.
