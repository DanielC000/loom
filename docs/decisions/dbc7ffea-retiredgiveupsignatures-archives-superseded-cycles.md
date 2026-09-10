# dbc7ffea — `retiredGiveUpSignatures` archives every superseded give-up cycle's signature

## Narrative

Card `dbc7ffea` adds `Live.retiredGiveUpSignatures: Map<logicalId, Array<{len,hash,writtenAt,batchId,memberSig}>>`: archives every EARLIER give-up cycle's own signature for a message whose "current" `ambiguousDispatches` slot has since been superseded, so that slot can move on without losing the ability to recognize an earlier write's confirmation arriving late. 13 sites in `pty/host.ts` (line 525 to past 11000) cite this id; this record covers only the field-doc site — a later tranche reaching another site should extend it, not re-derive the mechanism.

**THREE paths feed/drain the archive** (corrected after the card body first mis-stated it as one path, then an earlier doc draft under-counted at two):

1. `drainPending`'s delete-at-redrain, via `archiveAmbiguousDispatch` — the ordinary self-retry/exhaustion case (production specimen card `96c6afb8`, and this card's own repro test). Pre-fix, a `giveUpGen`-tagged entry being redrained had its "current" entry DELETED outright (never overwritten), so a late confirmation of the first cycle's own write had nothing left to match.
2. `requeueGiveUpOrigin`'s own `.set()`, via the SAME helper — a genuine OVERWRITE, for the auto-joined-resend case `capAmbiguousDispatches`'s own doc names (card `a9e4240f`): a manual resend joins via `hasAmbiguousMatch` to an existing still-ambiguous logicalId, and if that resend itself later gives up, this runs while the ORIGINAL dispatch's entry is still live — a cross-message trigger on the same "current slot only" limitation.
3. `capAmbiguousDispatches`'s own count eviction DELETES without archiving, deliberately — a memory-safety backstop for a stale entry, not a "supersede" worth preserving; archiving it would just relocate the same unbounded-growth risk.

Paths (1) and (2) are covered by the archive, so "every prior cycle survives" holds regardless of which superseded it. See `purgeConfirmedGiveUpRequeue`'s own doc and project memory `card-66649a90-duplicate-write-residual-measured` for the production specimen path (1) closes.

**Generalizes past the default limit:** archiving forward (never overwriting) means every prior cycle survives, not just the first — past the default `GIVE_UP_REQUEUE_LIMIT=1` (two cycles) to whatever a configured limit allows, PROVIDED the batch-provenance check groups by logicalId before looking at `batchId` (Code Review Major 2: an earlier version counted distinct `batchId`s alone, breaking at limit>=2 — two of one message's own successive cycles share byte-identical tagged text, since the tag embeds only `rootMsgId` never the generation, so they were wrongly read as two distinct give-up events and declined instead of resolved).

**Consulted only alongside a proven confirmation:** ONLY by `purgeConfirmedGiveUpRequeue`'s content-match, additionally to (never instead of) `ambiguousDispatches`'s current entry — a match here can only purge a write PROVEN by a real engine confirmation, never a merely-suspected one, so this cannot reopen the loss-safety guard the FIFO-fallback still separately protects (that decline branch is deliberately untouched). Verified by `pty-giveup-retired-signature-safety.mjs` (cross-logicalId isolation + batch-provenance discrimination) and `pty-giveup-retired-signature-autojoin-overwrite.mjs` (path 2 specifically).

**The invariant keeping `hasAmbiguousMatch` safe untouched** (Code Review, confirmed correct, clearer after Major 1): the archive MAY hold resolved/dead chains; only a PROVEN confirmation may ever consult it. `hasAmbiguousMatch` is a GUESS (auto-joins a fresh manual resend to a chain it merely suspects is open) — feeding it entries the archive can't vouch for would be strictly worse than its own existing staleness discipline.

**Memory-safety and lifecycle:** bounded by COUNT, never time — `capRetiredGiveUpSignatures` (outer map, capped at `AMBIGUOUS_DISPATCH_CAP` distinct logicalIds) and `RETIRED_GIVEUP_SIG_CAP` (each logicalId's own array, capped at 8) — worst case ~20 × 8 tiny records (~16KB), never unbounded. Removed on: a content-match purge, the FIFO-fallback's purge, either cap, OR (Code Review Major 1) `retireResolvedArchiveEntries` at the next turn-end once a chain is no longer in flight by any of those — otherwise an ordinary no-give-up confirmation of a later cycle can leave a DEAD entry indefinitely, a real false-ambiguity hazard, not a harmless leftover.

A plain session exit (crash or stop) does NOT discard this map — a `kind:"claude"` `Live` entry survives exit with `alive:false`, so a dead session's archive sits frozen until that sessionId's next resume/fork/recycle (through `spawn()`, which always constructs a fresh `Live`) or a full daemon restart (neither map persists). Not a new leak — `ambiguousDispatches` already has this posture; this map inherits it. No cross-session risk: both maps are strictly per-sessionId.

## Do not

- Do not archive the count-eviction path — it is a memory-safety backstop, not a supersede event; archiving it relocates the unbounded-growth risk the cap exists to close.
- Do not let the batch-provenance check count distinct `batchId`s alone — group by logicalId first, or successive cycles of one message are wrongly read as distinct events.
- Do not let `hasAmbiguousMatch` (a guess) consult this archive directly — only a proven content-match may.
- Do not reintroduce delete-outright at `drainPending`'s redrain — a late confirmation would have nothing left to match.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (the `Live.retiredGiveUpSignatures` field doc), as of `main` `d8b3076b`. Extracted by card `b19e70d3` (tranche 10); wording unchanged beyond joining wrapped lines and stripping `//` markers. 12 other dbc7ffea sites remain in this file, unextracted.
