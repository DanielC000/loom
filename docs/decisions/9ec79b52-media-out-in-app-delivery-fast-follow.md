# 9ec79b52 — media-out gained in-app delivery as a fast-follow after a Telegram-only v1

## Narrative

The `media-out` companion lever (card `3a81b0f2`) shipped its v1 delivery TELEGRAM-FIRST (owner decision, 2026-07-09): `ctx.outbound.deliverMediaToOwner` resolves the active turn's own route + adapter server-side (never a lever-guessed destination — mirrors `deliverToOwner`), but at that point only the Telegram channel adapter actually implemented `sendMedia`.

Card `9ec79b52` closed that gap as a fast-follow: the in-app channel now delivers media too (`InAppChannel.adapter.sendMedia`, `companion/in-app.ts`) as a base64-inlined WebSocket frame that the web chat renders inline.

A channel with no media support at all still degrades gracefully (`status:"unsupported-channel"`, naming the resolved path) rather than erroring, so the companion can still tell the owner where the file lives instead of the call just failing. That graceful-degradation branch is now future-proofing for a channel that doesn't implement `sendMedia`, not the expected day-to-day path — Telegram and in-app both implement it today.

## Do not

- Do not assume `sendMedia` support is universal across channel adapters — the `"unsupported-channel"` degrade path exists because it once was not, and a future channel adapter can still omit it.
- Do not record an in-app media delivery to chat history, and do not add a store-and-forward retry for it — media delivery is a pure, best-effort live push by design, unlike a text/voice reply.

## In-app delivery is never recorded and has no store-and-forward (added by card `e04aa826`)

The in-app delivery path is deliberately NOT recorded to chat history — media never touches
`companion_messages.text` the way a text/voice reply does — and has no store-and-forward fallback: with zero
clients attached to the target chat, the push is simply dropped. Both properties mirror how a text reply's
own live push behaves when nobody is attached, except a text reply is still durably recorded first (so it
shows up on the next attach); a dropped media push is gone for good.

## Source

Inline comment in `packages/daemon/src/companion/capabilities.ts` (`media-out`'s top-of-block doc, the "DELIVERY was TELEGRAM-FIRST v1" paragraph): lines 1901-1909, as of this tranche's HEAD. Relocated by card `d091d3fa` (tranche on `companion/capabilities.ts`); no wording changed beyond joining wrapped source lines into flowing paragraphs and stripping `*` comment markers.

Additional source: `packages/daemon/src/companion/in-app.ts` (the `InAppServerFrame` `type:"media"` doc), lines 92-100 as of main `8a99dba9`. Added by card `e04aa826` (tranche on `companion/in-app.ts`); no wording changed beyond compressing wrapped lines.
