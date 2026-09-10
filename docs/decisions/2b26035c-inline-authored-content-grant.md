# 2b26035c — authored_content_grant is Direction (a): an inline chat grant, not a Settings hunt

## Narrative

`authored_content_grant` (card `2b26035c`) was built as "Direction (a) — inline authored-content grant": it lets the owner grant `board_create`/`board_update` permission to author real card text on ONE project directly from chat, instead of the owner having to go find and flip that project's Settings "authored content" toggle out-of-band.

The tool itself never authors or commits any card content — it only ever flips the grant that `board_create`/`board_update`'s own `contentIsVerbatim` check reads (see the guard comment at that call site, which stays inline).

A fresh "/new"/"/reset" (chat-gateway.ts's `resetConversation`) is a deliberate clean-slate boundary: it must not silently carry over a warm Tier-A trust window OR a live inline authored-content grant from the conversation just wiped. `closeCompanionTrustWindow` (mcp/orchestration.ts) closes BOTH in one call — it clears `AuthoredContentGrantStore` alongside the trust window. This is what makes the grant's "session" scope doc-promise ("until reset/recycle") actually true: without this call, the grant used to survive a reset, since the sessionId is unchanged across "/new".

## Do not

- Do not let this tool write card content on its own, even indirectly — it is a grant-flip only, never a content-authoring path.
- Do not let a "/new"/"/reset" skip `closeTrustWindow` — the grant's "session" scope promise depends on that call closing it, not on the sessionId changing across a reset (it doesn't).

## Source

Inline comment in `packages/daemon/src/companion/capabilities.ts` (`authored_content_grant`'s top-of-block doc, opening paragraph): lines 1500-1504, as of this tranche's HEAD (unchanged by this tranche). Relocated by card `d091d3fa` (tranche on `companion/capabilities.ts`); no wording changed beyond joining wrapped source lines into flowing paragraphs and stripping `*` comment markers.

Also: `packages/daemon/src/companion/chat-gateway.ts`'s `resetConversation` doc (the "(d) TRUST WINDOW / GRANT CLOSE" clause, card 2b26035c CR follow-up): lines 482-490 as of this tranche's HEAD. Relocated by this tranche (`chat-gateway.ts, tranche 1`); no wording changed beyond joining wrapped source lines and stripping `*` comment markers.
