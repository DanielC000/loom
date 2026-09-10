# 9ec79b52 — media-out gained in-app delivery as a fast-follow after a Telegram-only v1

## Narrative

The `media-out` companion lever (card `3a81b0f2`) shipped its v1 delivery TELEGRAM-FIRST (owner decision, 2026-07-09): `ctx.outbound.deliverMediaToOwner` resolves the active turn's own route + adapter server-side (never a lever-guessed destination — mirrors `deliverToOwner`), but at that point only the Telegram channel adapter actually implemented `sendMedia`.

Card `9ec79b52` closed that gap as a fast-follow: the in-app channel now delivers media too (`InAppChannel.adapter.sendMedia`, `companion/in-app.ts`) as a base64-inlined WebSocket frame that the web chat renders inline.

A channel with no media support at all still degrades gracefully (`status:"unsupported-channel"`, naming the resolved path) rather than erroring, so the companion can still tell the owner where the file lives instead of the call just failing. That graceful-degradation branch is now future-proofing for a channel that doesn't implement `sendMedia`, not the expected day-to-day path — Telegram and in-app both implement it today.

## Do not

- Do not assume `sendMedia` support is universal across channel adapters — the `"unsupported-channel"` degrade path exists because it once was not, and a future channel adapter can still omit it.

## Source

Inline comment in `packages/daemon/src/companion/capabilities.ts` (`media-out`'s top-of-block doc, the "DELIVERY was TELEGRAM-FIRST v1" paragraph): lines 1901-1909, as of this tranche's HEAD. Relocated by card `d091d3fa` (tranche on `companion/capabilities.ts`); no wording changed beyond joining wrapped source lines into flowing paragraphs and stripping `*` comment markers.
