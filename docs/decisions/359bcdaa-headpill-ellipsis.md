# 359bcdaa — a head pill's reading rides its own span, so the ellipsis can fire

Card `359bcdaa` (epic `9fe8cd4e`, the Atlas UI behind its switch). Closes the kit defect card `f76b89b9` measured and deliberately deferred: `.loom-atlas-headpill` carried `overflow: hidden` + `text-overflow: ellipsis` + `white-space: nowrap` and still clipped mid-word with no `…`.

## Why the properties were in the right place and still did nothing

`text-overflow` applies to a **block container**'s inline content. The pill is `display: inline-flex`, so a bare text child of it is not inline content at all — it is wrapped in an **anonymous flex item**, which by spec cannot be targeted by any selector and therefore cannot inherit a usable `text-overflow`. The declaration resolved, applied to the pill, and had no inline content of its own to truncate; the pill's `overflow: hidden` then clipped the oversized anonymous item at the border box, mid-word.

The fix is one nested span (`.loom-atlas-headpill-text`) holding the reading. As a flex item it is blockified, so it *is* a block container, and the three truncation properties now sit on the element that actually holds the text.

**`min-width: 0` on that span is equally load-bearing, for a second and unrelated reason.** A flex item's `min-width: auto` floors it at its min-content width, and `white-space: nowrap` makes a run of text's min-content width its *full* width — so without `min-width: 0` the span refuses to shrink, never overflows *itself*, and the clipping falls back to the pill exactly as before. Either property alone leaves the defect in place; the pair is the fix.

## Why no geometry assertion could see it

Measured at 420px with the pre-`f76b89b9` caption: 462px of text in a 388px box, **right edge still inside the viewport**, and `document.scrollWidth == document.clientWidth`. The overflow is consumed entirely by the pill's own `overflow: hidden`, so it never reaches the document, the head's box, or any ancestor. Nothing about the layout is wrong — only the rendering of the text inside a correctly-sized box.

The claim a test can make instead is about **which element holds the text**: walk to the parent of the pill's first non-empty text node and require that element to be a block container (never a flex one) carrying the truncation properties, and to be genuinely overflowing. `atlas-node-head.spec.ts`'s "an over-long reading is ellipsised, not chopped" leg does exactly that, driven by a fixture repo on a deliberately over-long branch name so the over-long value is real app data rather than an injected string.

The old `pill.scrollWidth <= pill.clientWidth` claim (`atlas-platform.spec.ts`, card `f76b89b9`) stays and still means something — but it means something *different* now: it holds the Platform node's **copy** short enough that nothing is truncated at all. It is not a check on the ellipsis, and it would pass on a pill that ellipsised badly.

## Short copy is still the rule

`f76b89b9`'s choice — a dedicated short `scopePill` field rather than the classic page's full caption — is **not** superseded by this card. An ellipsis is a graceful degradation, not a licence to overflow: a clause the reader cannot see is lost whether it ends in `…` or mid-word, and only the `title` recovers it. Keep a pill's reading a phrase.

## Do not

- **Do not move `min-width: 0` / `overflow: hidden` / `text-overflow: ellipsis` / `white-space: nowrap` from `.loom-atlas-headpill-text` up onto `.loom-atlas-headpill`.** They read as if they belong there and have twice been written there. On an `inline-flex` pill they are inert, and the failure is invisible to every box and document-width assertion.
- **Do not hand-roll a `.loom-atlas-headpill` span at a new call site.** `HeadPill` (`components/atlasHome.tsx`) is the only thing that may wear that class; it is what guarantees the inner span exists. `SessionNode`'s `gen · turns` pill was the one hand-rolled copy and was converted here.
- **Do not pass a `HeadPill` sibling elements as its reading.** One text run per pill: a reading made of parts expresses its separator *in* the text (`genReadout`'s `" · "`), because the span truncates what it contains as a single run and sibling flex items would each be truncated independently, or not at all.
- **Do not weaken the e2e leg to `pill.scrollWidth > pill.clientWidth` or to a bare computed-style read on the pill.** The pill does not overflow after the fix (the span absorbs it), and the pill's *computed* `text-overflow` was `ellipsis` throughout the defect — a check on either passes in both states and proves nothing.
