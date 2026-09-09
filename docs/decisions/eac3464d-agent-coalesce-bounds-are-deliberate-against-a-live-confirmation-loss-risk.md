# eac3464d — `AGENT_COALESCE_MAX_COUNT`/`AGENT_COALESCE_MAX_BYTES` are deliberate bounds against a live risk

## Narrative

Card eac3464d DoD-1/DoD-2/DoD-4: bounds on a SAME-SENDER agent-kind coalesced run (see `drainPending`'s same-sender branch and `enqueueStdin`'s reorder-on-enqueue) — a run stops at whichever binds first. Both are a DELIBERATE, STATED bound: card eac3464d's own "LIVE RISK" section (sharpened by that card's DoD-0 finding) is that coalescing makes writes BIGGER on a write path with a live, unresolved confirmation-loss defect (cards c23e2869/3ce3fa39, and DoD-0's own give-up/re-mint finding, card 8af2b9bd) — an unbounded run is not acceptable.

COUNT (5): handles the common 2-3-message same-sender burst DoD-0 measured in production without letting one sender's backlog balloon into a single enormous write. Also used as the REORDER LOOKBACK in `enqueueStdin` (see there) — sharing one constant keeps the "how far can one sender reach" mental model single-valued instead of two knobs that can silently drift apart.

BYTES (20,000 chars): comfortably clears typical single-report sizes observed in production (up to ~15KB) — a head entry already over this bound is NEVER excluded by it and still drains alone, exactly as today; the bound only limits how much MORE gets folded onto an already-large head. It bounds the INCREMENTAL growth coalescing adds, not any single message's own size.

## Do not

- Do not raise or remove these bounds without accounting for the live, unresolved confirmation-loss defect (cards c23e2869/3ce3fa39/8af2b9bd) that coalescing writes bigger amplifies.
- Do not decouple the COUNT bound from `enqueueStdin`'s reorder lookback — they intentionally share one constant so "how far can one sender reach" stays a single mental model.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (`AGENT_COALESCE_MAX_COUNT`/`AGENT_COALESCE_MAX_BYTES`'s top-of-const doc): as of commit `1974444dc94618d380f474192e22edff20215ec5`. Relocated by card `de94a415` (tranche 2 on `pty/host.ts`); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
