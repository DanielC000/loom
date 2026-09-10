# 2ff32b5c — raise the daemon test-lane default from 2 to 3, on a direct owner decision

## Narrative

Filed on a direct owner decision given live in chat, superseding the adaptive-lanes shape (card
`a496166a`) they had chosen in a Request the same day: *"yes you are right maybe we should hold off
on the variable load dependent gate lanes and just raise the number of lanes for now."* The adaptive
version is deferred by owner decision, not abandoned.

**An earlier attribution in this card's own history was retracted.** A v2 draft compared aggregate
CPU-time and wall-clock across two runs, found their ratios agreed to three digits, and concluded
the rise was suite-population growth. That ratio agreement proved only that packing was unchanged
(~99.5%) — it proved nothing about *why* the aggregate itself rose, and the retracted draft had
differenced against a baseline run whose own file count was never recorded. The real NDJSON data
(`run-summary` records, all `poolSize=2`, same day) showed `testCount` rising only 661->666 (+0.8%)
while `durationMs` rose 862s->1239s (+44%) — population is excluded as the driver, decisively; the
real driver was left unidentified (contention was a candidate but was present in both the fast and
slow runs, so it couldn't discriminate).

**What survives is a ratio claim, not an absolute one:** at ~99.5% packing, ideal wall-clock is
approximately aggregate-CPU-time divided by lane count, so raising 2->3 lanes cuts wall-clock by
roughly a third *whatever the aggregate turns out to be* — robust to the aggregate's own
instability, unlike the retracted absolute-projection claim.

**The product-math safety table** (`maxConcurrentGates` x lanes = worst-case concurrent test
processes): 2 lanes -> 4 processes (today, safe); 3 lanes -> 6 processes (this change, still below
the documented failure level); 4 lanes -> 8 processes — *exactly* the level that starved the live
self-hosting Codescape service on 2026-07-15 (card `301d8c01`'s incident: one unpinned gate spiking
to `MAX_CONCURRENCY=8` lanes with nothing bounding it, not several gates at a smaller pool size —
but 8 total concurrent processes is 8 regardless of how they were assembled). `MAX_CONCURRENCY`
stays at 8 (the ceiling itself is deliberately unchanged) and this constant stays a fixed number,
not adaptive to host load — both explicitly out of scope for this change.

## Do not

- Do not raise this constant to 4 without separately re-deciding — 4 lanes puts the worst-case
  product at exactly 8 concurrent processes, the incident level that starved Codescape once already.
- Do not raise `MAX_CONCURRENCY` above 8, and do not make lane count adaptive to host load here —
  that is a separate, deliberately deferred card (`a496166a`).
- Do not report a single before/after timing pair as evidence of a lane-count change's effect — the
  2-lane baseline alone spanned a 44% band at constant population; compare distributions, not points.

## Source

Inline comment in `packages/daemon/scripts/test-daemon.mjs`, at the `DEFAULT_CONCURRENCY`
definition (originally ~lines 822-834). Card `2ff32b5c`, filed 2026-08-05, merged as commit
`9f98b24`.
