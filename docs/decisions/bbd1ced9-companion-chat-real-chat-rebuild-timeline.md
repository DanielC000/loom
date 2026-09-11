# bbd1ced9 — the companion chat panel rebuilt from a flat bubble wall into a structured, day-segmented timeline

## Narrative

Card `bbd1ced9`, "the real chat rebuild": the companion chat panel no longer renders a flat, timeless bubble wall that grows without anchors. `buildTimeline` (`lib/companionChat.ts`) segments the message stream by calendar day, collapses consecutive same-sender turns under one header, and marks each message's delivery + channel state.

The direct fix for "grows endlessly": the scroll sticks to the bottom while the reader is there; once they scroll up to read back, the view is never yanked back down — instead a floating "Jump to latest · N new" anchor appears, so the newest turn is always one click away rather than a hijacked scroll position.

## Do not

- Do not go back to rendering messages as a flat, undated bubble list — the day/sender structure and the stick-to-bottom / jump-to-latest scroll mechanic are both load-bearing parts of this fix, not cosmetic.
- Do not yank a reader who has scrolled up back to the bottom on a new message — accrue it as unread and surface the jump anchor instead.

## Source

Inline comment in `packages/web/src/components/CompanionChat.tsx` (the `CompanionChat` component's top-of-block doc, "THE REAL CHAT REBUILD" paragraph), as of this tranche's HEAD. Extracted by card `9bef2070` (tranche 1 on this file); wording condensed into flowing prose, no clause dropped.
