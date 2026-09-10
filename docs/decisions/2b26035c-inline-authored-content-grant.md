# 2b26035c — authored_content_grant is Direction (a): an inline chat grant, not a Settings hunt

## Narrative

`authored_content_grant` (card `2b26035c`) was built as "Direction (a) — inline authored-content grant": it lets the owner grant `board_create`/`board_update` permission to author real card text on ONE project directly from chat, instead of the owner having to go find and flip that project's Settings "authored content" toggle out-of-band.

The tool itself never authors or commits any card content — it only ever flips the grant that `board_create`/`board_update`'s own `contentIsVerbatim` check reads (see the guard comment at that call site, which stays inline).

## Do not

- Do not let this tool write card content on its own, even indirectly — it is a grant-flip only, never a content-authoring path.

## Source

Inline comment in `packages/daemon/src/companion/capabilities.ts` (`authored_content_grant`'s top-of-block doc, opening paragraph): lines 1500-1504, as of this tranche's HEAD. Relocated by card `d091d3fa` (tranche on `companion/capabilities.ts`); no wording changed beyond joining wrapped source lines into flowing paragraphs and stripping `*` comment markers.
