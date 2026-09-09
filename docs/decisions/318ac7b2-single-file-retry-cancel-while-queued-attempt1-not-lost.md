# 318ac7b2 — the single-file retry's cancel-while-queued path doesn't lose attempt 1's real failure

## Narrative

CAVEAT (card 318ac7b2): for the single-file retry's own cancel-while-queued path specifically, attempt 1 — a SEPARATE, EARLIER admission — already genuinely ran and genuinely failed before this retry was ever queued; that real run is what the sibling `build_gate` event (stamped `cancelled:true`, emitted right before this same return) records, so it is NOT lost — just not carried on this particular return value's own fields.

## Do not

- Do not treat a `cancelled:true` return on the single-file retry's cancel-while-queued path as meaning attempt 1's failure was lost — it's recorded on the sibling `build_gate` event instead of on this return value's own fields.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`ConfirmMergeResult.cancelled`, single-file-retry caveat): lines 545-560, as of commit `f9caa77e30d5c1a6dd994b6203261968c0dbf94f`. Relocated by card `8f4c8a8f`; no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
