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

## Decision B — `Live.recentOwnerTurns` (unrelated decision, same card id, `pty/host.ts`)

**Source (this section only):** not the same decision as the section above — `authored_content_grant` is a Settings-bypass content-grant tool; this is Companion injection-guard Primitive A's own recent-turns widening. Both landed under card `2b26035c` (`resolveRecord()`'s one-id-one-file rule shadows the second unless they're merged here).

### Narrative

Primitive A widening, "recent-turns verbatim acceptance": `Live.recentOwnerTurns` is a BOUNDED, most-recent-first ring of the last `RECENT_OWNER_TURNS_WINDOW` (5) authenticated owner-turn texts. Pushed alongside `activeTurnOwnerText` in `submit()` whenever a turn carries real `ownerText` — built from the EXACT SAME server-attested owner inbound bytes as Primitive A, just retained across turn boundaries instead of being cleared at Stop. A proactive/heartbeat/system turn (`ownerText` undefined) never pushes an entry, so this can never accumulate model-authored or injected text — only the TURN SCOPE widens, never the source. Lets a lever accept a candidate that's a verbatim substring of a RECENT turn (e.g. a cross-turn correction/re-phrase), not just the one in flight.

GROUP companion note: in a group-scope route, each turn's `ownerText` is already whichever ALLOWLISTED sender's message formed it (`chat-gateway.ts`'s per-turn sender-authz gate, unchanged by this card) — so this window can span MULTIPLE allowlisted senders' recent turns, not just one person's. This is intentional, not an escalation: every entry is still an authenticated, authorized-user turn (never model-authored/injected), and a lever committing content still separately requires the COMMITTING turn's own current-turn owner-auth (Primitive A) plus the trust window/confirm round-trip — the widened quote-source never substitutes for either of those.

`RECENT_OWNER_TURNS_WINDOW = 5` is deliberately small: wide enough to cover a cross-turn correction/re-phrase in the same live exchange without widening "recent" into "anything the owner ever said in this conversation", which would erode the guard's whole point.

### Do not (this section)

- Do not let a proactive/heartbeat/system turn push an entry onto `recentOwnerTurns` — only real, authenticated `ownerText` may.
- Do not let a lever treat a `recentOwnerTurns` match as sufficient on its own — it must still pair with the committing turn's own Primitive A owner-auth plus the trust window/confirm round-trip.

### Source (this section only)

Inline comment in `packages/daemon/src/pty/host.ts` (the `Live.recentOwnerTurns` field doc), as of `main` `d8b3076b`. Extracted by card `b19e70d3` (tranche 10 on `pty/host.ts`); wording unchanged beyond joining wrapped lines and stripping `//` markers. Two shorter sibling docs of this same decision remain inline at `RECENT_OWNER_TURNS_WINDOW`'s own constant doc and `getRecentOwnerTurns`'s own doc (both under the 15-line extraction threshold) — not extracted, left as-is.
