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

## Message-kind classification itself is owner-directed, and the bias-to-"agent" rule is deliberate

Card eac3464d (amending an owner-directed 2026-07-03 classification): `QueuedMessageKind` splits every
queued message into `"warning"` (a Loom operational nudge — idle/context/busy-stuck watchdogs,
restart/boot continuation notes, memory-recall injection) and `"agent"` (a message authored by an agent
or human TO the recipient — a Lead's `session_message`, a human composer turn, a worker→manager report, a
manager→worker direction/redirect, a companion inbound or proactive reminder/heartbeat). The 2026-07-03
guarantee this classification exists to protect: two DIFFERENT senders' agent-kind directives are never
drained mashed together into one turn. Card eac3464d's 2026-08-28 amendment (owner-authorized ask 3 —
"concatenated and sent together as one prompt... so it's clear to the user what is happening") gives up
the WITHIN-sender one-per-turn guarantee for a consecutive same-sender run (bounded by the constants this
record's other section already covers) while deliberately keeping the CROSS-sender guarantee intact — a
stated trade, not an oversight. `DRAIN_SEPARATOR` is the legibility mitigation for that trade: coalesced
same-sender entries are joined with it so the concatenated turn still reads as distinct messages rather
than one run-on block, which is what lets the recipient tell "it's clear to the user what is happening."

Every pre-existing `enqueueStdin` caller (tests, and any call site this change didn't touch) defaults to
`"warning"` so it keeps the old full-coalesce behavior byte-identical; every real production call site is
classified explicitly. Anything genuinely ambiguous about which kind a new caller should use is resolved
toward `"agent"` — the harm this classification exists to prevent is coalescing different senders' agent
messages together, so a warning wrongly delivered one-per-turn (rather than coalesced) is merely a few
extra benign turns, the cheaper mistake of the two.

## Do not (2)

- Do not classify a new `enqueueStdin` caller as `"warning"` when it's genuinely ambiguous whether the
  message is Loom-authored or agent/human-authored — bias toward `"agent"`; the failure mode of a
  wrongly-`"warning"` message (mashing two senders' directives together) is worse than the failure mode of
  a wrongly-`"agent"` one (a few extra benign turns).
- Do not assume `resumeAfterRateLimit` participates in this classification — it replays `live.lastPrompt`
  via a direct `submit()` call, bypassing `enqueueStdin`/`live.pending` entirely.

## Source (2)

Inline comment in `packages/daemon/src/pty/host.ts` (`QueuedMessageKind`'s own type doc), as of commit
`8078a08ed95998599554d6ed4f2c10826c48f158`. The 2026-07-03 classification itself introduced by commit
`ab65c2ac3529ceeaf5f19f906517a408200eeab6`; the same-sender coalescing amendment by commit
`8d4f9a086c1200205bb1f96f168e8bfe07798392`. Relocated by card `3f45b7d8` (tranche 6 on `pty/host.ts`).
