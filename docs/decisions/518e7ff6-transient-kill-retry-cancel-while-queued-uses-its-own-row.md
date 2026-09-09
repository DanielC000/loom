# 518e7ff6 — the transient-kill retry's cancel-while-queued path records its own `build_gate_retry` row

## Narrative

SIBLING CAVEAT (card 518e7ff6): the transient-kill retry's own cancel-while-queued path ALSO has an earlier real attempt 1 — but there, attempt 1's `build_gate` row was already written before this retry even started, so nothing needs filling in on IT; instead a separate `build_gate_retry` row (also `cancelled:true`) records the retry's own missing verdict.

## Do not

- Do not conflate the transient-kill retry's cancel-while-queued handling with the single-file retry's (card 318ac7b2) — attempt 1's `build_gate` row is already written before the transient-kill retry starts, so this path instead writes a separate `build_gate_retry` row for the retry's own missing verdict.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`ConfirmMergeResult.cancelled`, transient-kill-retry caveat): lines 545-560, as of commit `f9caa77e30d5c1a6dd994b6203261968c0dbf94f`. Relocated by card `8f4c8a8f`; no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
