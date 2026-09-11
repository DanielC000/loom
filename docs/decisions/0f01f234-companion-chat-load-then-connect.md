# 0f01f234 — the companion chat panel loads history BEFORE opening its WebSocket (load-then-connect)

## Narrative

Bug `0f01f234`: a page reload used to lose the whole conversation. The fix is load-then-connect — on every `sessionId` mount, the panel first loads the durable history (`GET /api/companion/messages/:sessionId`) and seeds `messages` from it, and only THEN opens the WebSocket, so there is no window in which a live frame can arrive before the history snapshot is taken.

A cross-channel live push is still deduped by its own persisted row id, independent of this ordering (a reconnect or duplicate push could otherwise double-render it regardless of load order). A history-fetch failure degrades to an empty seed and the panel still connects live — a broken history read must never block the chat itself.

This is the ORIGINAL, in-app-scoped fix; card `7d63e200` later generalized the same "reload loses history" problem to every channel the gateway routes (see `docs/decisions/7d63e200-unified-cross-channel-chat-history-recorder.md`) — that record covers the daemon-side recorder, not this panel's own load-then-connect ordering.

## Do not

- Do not open the WebSocket before the history fetch resolves — that reopens the exact race this bug was about (a live frame landing before the history snapshot, silently losing or duplicating it).
- Do not let a history-fetch failure block the live connection — degrade to an empty seed and still connect.

## Source

Inline comment in `packages/web/src/components/CompanionChat.tsx` (the `CompanionChat` component's top-of-block doc, "HISTORY" paragraph), as of this tranche's HEAD. Extracted by card `9bef2070` (tranche 1 on this file); wording condensed into flowing prose, no clause dropped.
