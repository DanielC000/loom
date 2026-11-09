# 104a31a4 — Needs-you rows lead with the ask, and the band panel shows only the rows that fit

Card `104a31a4` (Atlas audit epic `898a64ef`, findings A-07, A-03, A-18). Builds on `d0d430d4` (the compact band row) and `b4442d27` (the band's track budget).

## What was wrong, as measured

On `/home` with Atlas on, an isolated daemon, 12 pending Requests across three projects:

- **A-07.** `decisionAttentionText` built `routed to mgr <id8> · <project> — <title>`. Every surface that shows it (the Needs-you rows, the ⌘K palette) ellipsizes at the END, so the title was the part cut off, at every width up to 1920.
- **A-03.** The band panel was a fixed 320px with a scrolling body and `cap={6}`. Three rows fit, and the fourth was clipped mid-button at the panel edge. The "+N more" foot sat below the scroll, where nobody saw it. On rows with a longer kind ("Permission needed"), the compact head line's `flex-wrap: wrap` dropped the × onto a line of its own.
- **A-18.** `align-items: stretch` plus the fixed 320px height stood every quiet panel (Operators, Gate lanes, Plan usage, Pulse) at full height as an empty frame.

## The decision

1. **The ask leads.** `decisionAttentionText` is now `<title> · <project>`. The routing target moves to the row's `hoverText` (`decisionRoutingLabel`), appended after the full text, so hovering shows both. The palette builds its row `title` from the same `hoverText`. The "framed as a destination, never the asker" rule from card `5b22b262` still holds for the tooltip.
2. **The band panel shows whole rows only.** `AttentionList`'s `fitPanel` (band panel only) measures the real DOM and renders only the rows that fit inside the panel's `max-height`, plus an explicit `+N more in Inbox ↗` row linking to `/inbox`. The room is read from the panel's **max-height**, never from its current height or the body's `clientHeight`, because both shrink as rows are removed and would cut again on every pass. It re-measures only when the PANEL's width (or the row set, or font loading) changes, never the body's width, because the measuring pass's own scrollbar moves that width and would loop.
3. **The compact row is three lines: head, ask, actions.** The head line (dot, kind label, ×) is `nowrap`. The kind label is `flex: 1 1 auto` and ellipsizes, with its full text in a `title`, and the × is `flex: none`, so the × never drops to a line of its own. The **ask** has its own full-width line under the kind label (indented 18px, i.e. dot + gap), clamped to two lines (`-webkit-line-clamp: 2`, line-height 1.35). The actions (Pending chip, Answer) keep their own right-aligned line below. This supersedes `d0d430d4`'s head-line shape (`flex-wrap: wrap`, the title `nowrap` beside the kind label). A first version of this card kept the ask on the head line with an 80px floor. Measured at 1440, that showed about 12 characters of the ask, so it was replaced. The two-line ask shows about 55 characters at 1440 and about 110 at 1920.
4. **The band aligns to `start`.** `.loom-bandpanel` is `max-height: 320px`, not a fixed `height`, at every width (the phone rule's 300px cap is gone), so a quiet panel collapses to its one-line empty state. `BandPanel` also takes the stylesheet's 12px bottom padding instead of the kit Panel's 16px, which leaves the list 253px of room. A row is about 103px with a two-line ask and about 87px with one line, plus a 6px gap each, and the overflow row is 27px. That fits 2 rows plus "+N more" at 1440, 1920 and 390, measured.

## Do not

- **Do not put the routing id, or anything else, ahead of the title in `decisionAttentionText`.** Whatever leads is what survives the ellipsis.
- **Do not measure the fit against the panel's or the body's current height,** and do not re-measure on the body's width. The first cuts again on every pass; the second loops on the scrollbar the measuring pass itself causes.
- **Do not put the ask back on the head line beside the kind label, or drop its two-line clamp.** Beside the kind it showed about 12 characters at 1440. Without the clamp, one long ask takes the whole panel.
- **Do not let the compact head line wrap or the × shrink.** The kind label is the part that gives way.
- **Do not return `.loom-bandpanel` to a fixed `height`, the band to `align-items: stretch`, or the phone rule to a smaller cap.** The first two bring back the empty frames at 1920. A 300px cap at phone width leaves room for only one two-line row.
- **Do not grow the overflow row's padding or line-height, the ask's line-height, the row gaps, or the band panel's bottom padding,** without re-measuring two two-line rows at the 320px cap.

## Known limits

- "+N more in Inbox" also counts non-Request kinds the band shows (merge requests, stuck sessions), which the Inbox does not list. The copy predates this card (the old foot said the same). Not changed here.
- The project node's Needs-you card (`ProjectHome`, a full-width card with `cap={10}`) and the KPI pop-over keep the plain foot. Neither is height-capped, so neither clips.
