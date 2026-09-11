# c9924bcd — `UsageSampler`'s DB-aware first-sight delta closes the restart double-count

## Narrative

Epic `c9924bcd`, card B: the daemon-side background sampler that fills `session_usage_samples` is 100%
daemon-side and **token-free** (load-bearing owner constraint) — it never invokes an agent or makes a
model call, only reads the transcript JSONL files the engine already writes to disk (`readRunUsage`) and
prices them with the same per-model rate table Agent Runs use (`computeRunCostUsd`).

Each stored row is a per-interval DELTA (additive), so the read-side aggregation is a plain SUM. The
delta is `current_cumulative − lastSeen[sessionId]`, with two correctness wrinkles:

- **Mid-run rotation (fork/recycle):** `readRunUsage` is monotonic WITHIN one transcript, but a fork or
  recycle rotates to a new engine id → a new transcript whose cumulative restarts at 0. When the engine id
  changed (or any cumulative dropped) the sampler treats it as a fresh segment and the delta IS the new
  cumulative (never subtract → never emit a negative).
- **Restart double-count (the load-bearing one):** `lastSeen` is IN-MEMORY and wiped on every daemon
  restart, and a plain `--resume` REUSES the same engine id + the SAME transcript file — which still holds
  the full pre-restart cumulative. A naive first-sight delta (`prev === undefined` → emit the whole
  cumulative) would re-count, on every restart, everything a still-live session already recorded.

## The fix: DB-aware first-sight delta

First-sight is DB-AWARE — delta = `current_cumulative − the session's already-persisted SUM`
(`db.usagePersistedTotalsBySession`, snapshotted once per process). A session resumed across the restart
counts only the UNCOUNTED remainder (including the gap-window usage between its last sample and the
restart — exact, unlike a seed-only "emit nothing" prime); a genuinely new session (no prior rows) still
counts its full cumulative-so-far. This makes priming automatic on EVERY boot (the first tick
self-corrects) — independent of the one-time backfill marker (`BACKFILL_MARKER_KEY`). `correctiveResetOnce`
is the one-shot that scrubs the historical inflation this fix corrects: the boot that first deploys this
code wipes the (inflated) samples + clears `BACKFILL_MARKER_KEY` so the corrected backfill repopulates
clean; every later boot is a no-op.

## Do not

- Do not emit a first-sight delta as the session's whole cumulative without first subtracting its
  already-persisted SUM from the DB — that re-counts everything a still-live session recorded before a
  daemon restart, on every restart.
- Do not subtract a dropped cumulative across a fork/recycle rotation — a rotated engine id means a
  brand-new transcript starting at 0; treat it as a fresh segment (delta = the new cumulative), never a
  negative delta.

## Source

JSDoc class-header comment above `UsageSampler` in `packages/daemon/src/sessions/usage-sampler.ts`, lines
38-67 as of this tranche's HEAD.
