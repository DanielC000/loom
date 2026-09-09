# 8bda9fc6 — Companion runtime status is a dedicated read, never folded into config

## Narrative

Card `8bda9fc6`: Companion RUNTIME STATUS is the zero-reply detector's NAMED READER — a dedicated runtime read, deliberately SEPARATE from `/api/companion/config`. A caller must never have to read a config row to learn a runtime fact. `companion/reply-watch.ts` already writes a durable `companion_zero_reply_detected` event and a `console.warn` on detection, but both are internal — the warn goes to a rotating log nobody tails and the event was never queried. This route is the pull side.

Not folded into `maskCompanionConfig`: that is the CONFIG-masking edge — its shape is what a human edits and PUTs back to `PUT /api/companion/config/:sessionId` — and a settings row (read-modify-write) and a per-turn runtime counter have different lifetimes. Mixing them would also make every plain config read join runtime state it has no business touching.

Adds NO persisted state: every field is derived from `companion_config`'s existing `last_chat_reply_turn_seq` / `zero_reply_alert_turn_seq` plus the bound session's `turn_seq`. Read-only, so Tier-1 in `gateway/trust-tier.ts` alongside the other companion GETs.

## Do not

- Do not fold this route into `maskCompanionConfig` or `/api/companion/config` — a config read and a runtime-status read have different lifetimes and must stay separate endpoints.

## Source

Inline comment in `packages/daemon/src/gateway/server.ts` (`/api/companion/status` route, lines 1535-1549 as of commit `a9b55042`). Relocated by card `c57868e5`; wording condensed, no substantive detail dropped.
