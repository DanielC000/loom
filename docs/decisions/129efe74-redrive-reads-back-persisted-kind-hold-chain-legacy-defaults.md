# 129efe74 — a redrive reads back its own persisted kind/hold/chain fields; legacy rows default to the old hardcoded behavior

## Narrative

Card 129efe74: `session_message_queued`'s own persisted `detail` was too narrow to reconstruct real
dispatch semantics on redrive — before this card, `redriveQueuedMessage` hardcoded `kind:"agent"`,
dropped any in-flight give-up hold, and reset the chain to depth 0 on EVERY redrive. That silently
reclassified a `"warning"` settle-nudge as `"agent"` and let a restart mid-hold-window deliver a
duplicate immediately (the hold was simply discarded, not honored).

The fix: a redrive now reads back the `kind`/`giveUpHeldUntil`/`rootMsgId`/`chainDepth` fields the
record ITSELF persisted, rather than reconstructing them from scratch. LEGACY ROWS (appended before this
card landed) carry none of these fields, so each default below reproduces the method's PRE-FIX behavior
exactly — an old undelivered record still redrives unchanged, never regressing on upgrade:

- `kind` → `"agent"` (the only classification this method ever hardcoded before the fix)
- `giveUpHeldUntil` → `undefined` (no hold — this method never passed one before the fix)
- `rootMsgId` → the record's own `msgId` (self-rooted — matches the old hardcoded argument)
- `chainDepth` → `0` (matches the old hardcoded argument)

## Do not

- Do not hardcode `kind`/`giveUpHeldUntil`/`rootMsgId`/`chainDepth` on a redrive — read them back from
  the persisted record's own `detail`, falling back to the legacy defaults above only when the field is
  genuinely absent (a pre-card row).
- Do not change the legacy-row defaults above without checking that they still reproduce this method's
  exact pre-card behavior — an old undelivered record must redrive unchanged across the upgrade.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`redriveQueuedMessage`'s re-enqueue branch):
lines 5155-5165, as of commit `7ddffad7bb4646f3041c5c68964ac7bcd79d089c` (`fix(sessions):
session_message_queued's detail is too narrow to reconstruct dispatch semantics — kind, giveUpHeldUntil,
rootMsgId and chainDepth are all lost on redrive`). Relocated by card `61632c05` (tranche 15); no wording
changed, wrapped source lines joined into a flowing paragraph and the `//` comment markers stripped.
