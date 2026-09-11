# 8f1d7912 — `drainPending`'s route-keyed branch is deliberately UNBOUNDED by count/bytes

## Narrative

Card 8f1d7912 (decided 2026-09-04, filed from worker `efbd63a9`'s DECLINED item on card `a9e4240f`/MINOR-3
— that worker correctly refused to fold this into a "safe-by-construction" batch rather than derive the
analysis itself): `drainPending`'s ROUTE-KEYED branch (`else`, taken whenever `coalesceAgentMessages:true`,
or for any non-agent/"warning"-kind or route-bearing run) coalesces the leading same-route(+same-kind) run
with NO count or byte bound — unlike the same-sender agent-kind branch above it, which IS bounded by
`AGENT_COALESCE_MAX_COUNT`/`AGENT_COALESCE_MAX_BYTES` (see `docs/decisions/eac3464d-…md`) specifically
because that branch shares a live, unresolved confirmation-loss risk (cards `c23e2869`/`3ce3fa39`/
`8af2b9bd`) that coalescing writes bigger amplifies.

That same in-code rationale — "coalescing makes writes bigger on a path with a live confirmation-loss
defect" — applies here too, but a byte/count bound is NOT the same safe remedy on this branch. Enumerated
against every real `"warning"`-kind producer before deciding NOT to add one:

- **Memory-recall digests** (`sessions/service.ts`'s resume-time companion + project recall, enqueued
  back-to-back via `enqueueStdin` with no route between them, kind defaulting to `"warning"`) are the
  dominant payload and are DELIBERATELY meant to land as one coherent block. Companion recall is
  hard-capped at `MEMORY_RECALL_MAX_BYTES` (`companion/memory-recall.ts`) = 8,000 body bytes (~8,350
  framed); project recall is hard-capped via `MEMORY_CONFIG_MAX.budgetTokens` (`shared/src/config.ts`) =
  8,000 tokens × the project's own ~4-bytes/token estimator (`estimateTokens`,
  `sessions/project-memory-recall.ts`) = 32,000 body bytes (~32,430 framed). The two ALREADY routinely
  coalesce here today (same empty route, same `"warning"` kind) for a combined worst case of ~40,780
  bytes — over 2x `AGENT_COALESCE_MAX_BYTES`. A cap small enough to bite would SPLIT this intentional
  pairing across turns, a WORSE outcome than the unbounded write it would replace (exactly the hazard this
  card was filed to avoid); a cap large enough to never split it protects against nothing that has ever
  been observed or is structurally possible today.
- **Restart/boot continuation notes** (`crash-recovery-watcher.ts`, `resume-doc-watcher.ts`) are fixed
  single-sentence templates, ~200-500 bytes each — no unbounded list inside them.
- **Idle/context/busy-stuck watchdog nudges** (`idle-watcher.ts`, `context-watcher.ts`,
  `busy-worker-watcher.ts`) are fixed templates plus, for the idle nudge only, a board-delta digest capped
  at `DELTA_LIST_CAP=10` entries per category (`board-read.ts`) — bounded to roughly 1-2 KB even at max.
  Each watcher is independently cooldown/dedup-gated to at most ONE pending nudge per session at a time
  (idle escalates-once, context re-nudges on a cadence, busy-worker is once-per-episode, resume-doc has a
  30-min cooldown) — no unbounded same-producer accumulation.
- **"Rate-limit/usage nudges" turned out NOT to be a real producer on this branch**: `resumeAfterRateLimit`
  replays `live.lastPrompt` via a DIRECT `this.submit()` call, bypassing `enqueueStdin`/`live.pending`
  entirely — it never reaches `drainPending` at all. A false claim to the contrary, once left uncorrected
  in `QueuedMessageKind`'s own doc, `CLAUDE.md`, and `shared/src/config.ts`, was fixed by card `ba690cc2`.
- **Fan-in risk** (many small per-worker watchdog nudges landing on one manager's queue at once) is
  structurally bounded by `orchestration.maxConcurrentWorkers` (`shared/src/config.ts`) — a hard cap on
  live workers per manager, default 3 — so even a fleet-wide recovery burst keeps this branch's total
  bytes in the low KB range for any project running the default.

No enumerated producer today can drive an unbounded byte or count run on this branch — a cap would either
break the one legitimate large/atomic case (memory-recall) above or guard against a scenario nothing here
can produce.

## Do not

- Do not reintroduce a count/byte bound on this branch without re-deriving the producer enumeration above
  fresh — the numbers (memory-recall's ~40,780-byte worst case especially) can drift as producers change.
- Do not fold this branch's analysis into a "safe-by-construction, add a bound" batch without actually
  deriving the enumeration — the worker who filed this card was declined for exactly that shortcut on card
  `a9e4240f`/MINOR-3.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (`drainPending`'s route-keyed branch), commits
`582ebd783` (2026-09-04, the enumeration) and `f13d5bd90` (2026-09-06, the rate-limit correction / card
`ba690cc2`). Relocated by card `0d9bbbf4` (tranche 31 on `pty/host.ts`); no wording changed beyond joining
wrapped source lines into flowing paragraphs and stripping `//` comment markers.
