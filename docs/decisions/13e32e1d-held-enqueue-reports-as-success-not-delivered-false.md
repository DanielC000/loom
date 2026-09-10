# 13e32e1d — `EnqueueResult` carries `queued`/`landsAt`/`busyForMs` because a held enqueue used to read as a drop

## Narrative

Card `13e32e1d` (phase 2 of card `7acee6d4`): `enqueueStdin`'s return shape gained `queued`, `landsAt`, and `busyForMs` — additive fields, present alongside `delivered`/`reason`, and only meaningful on the `held` path. The problem this fixed: a `held` outcome (a SUCCESSFUL, durable enqueue — it WILL be retried until it lands) used to report through `delivered:false` alone, reading identically to an actual drop. A caller had no way to tell "this is queued and will retry" from "this never landed."

`delivered` itself never changes meaning — callers and tests read it as-is (delivered now vs not-yet); this card adds information alongside it rather than redefining it. `queued: true` means the text is durably recorded and will be retried at the recipient's next turn boundary — success, not failure — though not an unconditional delivery guarantee: a message that keeps giving up (the recipient's Enter never confirms) can still exhaust its redelivery budget and terminally park (`session_message_gave_up`, `handleGiveUpExhausted` in `sessions/service.ts`), surfaced to the sender rather than silently dropped, but genuinely never delivered. `queued: false` on the `session-dead` path makes the negative explicit too, instead of leaving it to be inferred from the field's absence. `landsAt: "next-turn-boundary"` states WHEN the next delivery attempt lands — at the recipient's next Stop/turn-boundary drain (or the reconcile tick) — not "eventually" or "if you're lucky"; this was silent before the card. `busyForMs` is how long the recipient has been mid-turn as of the call (undefined when the hold isn't due to busy — e.g. not-ready/composer-dirty/rate-limited), so a caller can tell "queued behind a long-running turn" from "queued behind one that just started".

## Do not

- Do not read `delivered:false` alone as "dropped" — a `held` outcome is a successful, durable enqueue that will be retried; check `queued`/`deliveryState` (card `9da2a435`) for the real disposition.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (the `EnqueueResult` type doc), as of commit `779f3ce7eccfb6cb3880d285b2016bc0554cc82c`. Extracted by card `6ba35149` (tranche 7 on `pty/host.ts`); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
