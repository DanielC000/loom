# 44634792 — a codex real-spawn family member's `CODEX_OWN_WORK_BUDGET_MS` entry must cover its own widened waits at `ambientScaledBudget`'s actual cap

## Context

`resolveEffectiveTimeoutMs` (`scripts/test-daemon.mjs`) ignores `TEST_TIMEOUT_OVERRIDES` entirely for any
`CODEX_REAL_SPAWN_SET` member — the per-file kill ceiling a codex real-spawn family member actually gets
is `computeCodexFileCeilingMs(ownWork, cap)`, where `ownWork` is
`CODEX_OWN_WORK_BUDGET_MS[name] ?? DEFAULT_CODEX_OWN_WORK_BUDGET_MS(120_000)`. Widening one of a file's
own inner `waitUntil` budgets via `ambientScaledBudget` is pointless if this outer ceiling kills the
process first — the SIGTERM fires at `computeCodexFileCeilingMs`'s own sum regardless of how generous the
inner wait is, converting a late-but-alive run into an uninformative timeout kill.

`ambientScaledBudget(baseMs, marginMultiplier)`'s actual worst case is `baseMs × AMBIENT_OVERSHOOT_CAP ×
marginMultiplier` — confirmed via `test/wait-ambient-scaled-budget.mjs` (`AMBIENT_OVERSHOOT_CAP = 4`), so
at the family's established `marginMultiplier = 3` convention, each widened wait can reach `baseMs × 12`.

## The gap found

`codex-prompt-ascii-fold-real-spawn.mjs` had three inner waits widened to `ambientScaledBudget(base, 3)`
by card 421d10fd (2026-10-17) with no corresponding `CODEX_OWN_WORK_BUDGET_MS` entry added — it carried
the `DEFAULT_CODEX_OWN_WORK_BUDGET_MS` (120_000ms) ceiling against a real worst-case own-work sum of
1,146,000ms from that landing until this card closed it. Not something this card's own diff introduced —
found while sizing the two sibling files this card widens.

## The sizing method (reusable for any future codex real-spawn family member)

Sum, in sequence, everything the file's own test logic can spend once it holds the lock:
- the fixed `codex login status` probe (10_000ms, every family member)
- the usage-limit probe on a cold host-wide cache (`PROBE_TIMEOUT_MS`, 45_000ms default)
- each `ambientScaledBudget(base, marginMultiplier)` wait at its worst case (`base × AMBIENT_OVERSHOOT_CAP
  × marginMultiplier`) — for a wait reused across N retry attempts (e.g. a nudge loop), multiply by N
- `CODEX_GRACEFUL_STOP_WAIT_BUDGET_MS` (8_000ms, shared `_codex-graceful-stop.mjs` helper)
- the best-effort config-settle wait (3_000ms; `.catch()`-guarded, never fails the test, but still spends
  wall time before the file exits)

Set `CODEX_OWN_WORK_BUDGET_MS[name]` comfortably above that sum (a small rounding slack for process/
module-load overhead not covered by any wait is enough — these are deliberately generous theoretical
ceilings meant almost never to fire for a healthy slow run, not a tight empirical measurement).

Computed at this card (2026-10-28):
- `codex-prompt-ascii-fold-real-spawn`: 10,000+45,000+240,000+720,000+120,000+8,000+3,000 = 1,146,000 →
  entry 1,200,000.
- `codex-submit-confirmation-real-spawn`: 10,000+45,000+240,000+360,000+8,000+3,000 = 666,000 → entry
  700,000.
- `codex-transcript-real-spawn`: 10,000+45,000+240,000+720,000+(3×120,000)+360,000+1,080,000+8,000+3,000
  = 2,826,000 → entry 2,880,000.

## Do not

- Do not widen a codex real-spawn family member's inner `waitUntil` budget via `ambientScaledBudget`
  without re-deriving its `CODEX_OWN_WORK_BUDGET_MS` entry (or adding one) by this same method — a wider
  inner wait with no matching outer ceiling just moves where the false timeout kill happens, it doesn't
  remove it.
- Do not read `AMBIENT_OVERSHOOT_CAP` or the family's `marginMultiplier` convention from this record if
  either has since changed — re-derive from `test/_wait.mjs` and the call sites directly; this record's
  own numbers are a snapshot, not a re-answer.
- Do not assume `TEST_TIMEOUT_OVERRIDES` governs a `CODEX_REAL_SPAWN_SET` member's timeout — it does not;
  `CODEX_OWN_WORK_BUDGET_MS` (`test/_codex-real-spawn-lock.mjs`) is the only place that matters for this
  family.
