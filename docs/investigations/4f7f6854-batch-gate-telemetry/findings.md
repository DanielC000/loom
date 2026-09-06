# 4f7f6854 / cf0e2e3b — batch-gate telemetry: the realised-vs-modelled comparison, now computed

Read-only measurement. No production code changed. No gate run. No load generated. The 2026-09-03 pass (card `4f7f6854`) found the daemon held exactly one batch-gate event, predating the commit that added `durationMs` to that event — DoD-2/3/4 were not yet computable. This pass (card `cf0e2e3b`, 2026-09-06) re-runs the same extractor against the now-accrued corpus and adds a second script to compute the derived comparisons. **DoD-2/3/4 are now answerable, and the headline is a clear net saving, well above the registered prediction.**

## Reproduce

```
node docs/investigations/4f7f6854-batch-gate-telemetry/scripts/extract-batch-gate-events.mjs
node docs/investigations/4f7f6854-batch-gate-telemetry/scripts/compute-realised-saving.mjs
```

Both read-only (`{ readonly: true, fileMustExist: true }`) against the live `loom.db`. Run against Loom project data only; population and window are printed by the second script and restated below.

**Population and window:** Loom project, `orchestration_events.kind='build_gate'`, batched rows from `2026-09-03T11:09:18.010Z` to `2026-09-05T23:59:11.732Z` (the first batch row carrying `durationMs` through the most recent batch row at the time of this pass). 33 batched rows total (32 carrying `durationMs`; the very first ever batch row, from before the field was added, is excluded from every duration-based calculation below). K distribution: `{2:24, 3:4, 4:3, 6:1}`. This matches an audit taken by the lead the same day via `gate_history` — but `gate_history` and this script both read the same underlying rows (`Db.listGateEvents` is a JOIN over `orchestration_events`, per §3 below), so this is **the same instrument read twice through two different front doors, not independent corroboration**. The agreement does rule out a transcription or scoping error on either side, which is real and worth having; it does not rule out a rows-level error common to both reads.

**Instrument note:** this worker's tool surface does not include `gate_history` (checked directly: absent from the full `mcp__loom-orchestration__*` tool list). The card's own fallback instruction — read `loom.db` directly, read-only, and say so — was followed. Every number below comes from that direct, read-only query, cross-checked twice (an inline query and the committed script both reproduce the same figures).

## 1. DoD-3 (invariance): does a K=3/K=4/K=6 batch gate take materially longer than K=2?

**No — the bands overlap heavily and do not scale with K, confirming the prediction.**

| K | n | median | min | max |
|---|---|---|---|---|
| 2 | 24 | 18.04 min | 15.06 min | 24.16 min |
| 3 | 4 | 19.36 min | 18.40 min | 20.76 min |
| 4 | 3 | 19.37 min | 17.22 min | 20.06 min |
| 6 | 1 | 18.28 min | 18.28 min | 18.28 min |

All four bands sit inside roughly the same 15-24 minute envelope regardless of batch size. This is exactly what `1055f5e3`'s measurement (`pnpm build` ≈0.2% of gate time, the test suite dominating and running regardless of diff size) predicted. **DoD-3 confirmed, not refuted.**

## 2. DoD-2: wall-clock gate time per merged branch, before vs after

**"Before" (the counterfactual):** the windowed solo (non-batched, non-reused) full-gate population, `2026-09-03T11:09` to `2026-09-05T23:59`: n=84, of which 60 are full gates (≥300s) and 24 are reduced gates (<300s) — a clean gap (reduced max 124.8s, full min 896.9s). **Full-gate median: 17.46 min.** This is the counterfactual used below: *"had this branch merged solo instead, it would have needed one full gate."* This assumption is deliberately simple and stated so it can be challenged: it likely **overstates** the true counterfactual for any branch that would have qualified for a reduced solo gate on its own (≈29% of the windowed solo population did) — so the realised savings below are, if anything, a **conservative** read on batching's true benefit for those branches, not an inflated one.

**"After," clean (first-attempt, no retry) batches only** — n=22 of 26 total passes; a batch counted here landed on its first attempt, nothing before it failed:

| K | n | median batch duration | counterfactual (K × 17.46 min) | realised saving |
|---|---|---|---|---|
| 2 | 20 | 17.94 min | 34.92 min | **48.6%** |
| 4 | 2 | 18.30 min | 69.84 min | **73.8%** |

No clean K=3 or K=6 sample exists — every K=3 and K=6 success in this corpus followed at least one earlier failure at that composition (see §4). Stated rather than interpolated.

Both figures land **well above** the card's registered prediction (~26% at K=3, ~28% at K=4, at p=14.9%) and above the corrected falsifier's 60%-of-prediction refutation floor — in the opposite direction the falsifier was watching for. The falsifier as registered only guards against underperformance; it has no answer for outperformance this large, which is itself worth flagging back to whoever owns the model.

**Fully-loaded aggregate, including every failure and every fallback it triggered** (the honest fleet-level number, not just the clean cases):

- Distinct branches landed via a passed batch: 62. Via a forfeit-triggered solo fallback (see §4): 8. Total distinct branches the batching mechanism actually landed: **70**.
- Total actual wall-clock spent (all 32 batch attempts, pass and fail, plus the 8 fallback solo gates): **671.2 min**.
- Counterfactual (70 × 17.46 min): **1222.3 min**.
- **Aggregate realised wall-clock saving, fully loaded: 45.1%.**

Even with every rejected batch attempt and every fallback counted as pure overhead, the fleet still saved 45.1% of gate wall-clock over the window — a real, large, positive result, not a marginal one.

## 3. The open positive control (reuse-rate tautology) — still resolved, unchanged since 2026-09-03

`confirmWorkerMerge` emits `build_gate` unconditionally on its reused/no-op path (`sessions/service.ts`), verified again at commit-current source. Re-running the extractor today: **Loom-project reuse rate, full history, solo build_gate rows only: 5/1452 = 0.34%** (previously 5/1351 = 0.37%; the denominator grew with ordinary merge activity, the numerator did not — reuse remains rare, not broken). Cross-project sweep for `"reused":true` still turns up rows beyond Loom (51 at the 2026-09-03 pass; not re-swept cross-project this time since it isn't this card's DoD).

## 4. DoD-4: forfeit rate, and the instrumentation gap this pass had to work around

**The "official" fields for this — `batchForfeited` and `fallbackOfBatchOpId` — exist in the daemon's source (landed 2026-09-05, per worker-report chatter in `orchestration_events` itself) but carry ZERO live `build_gate` rows as of this measurement.** Checked directly: `SELECT COUNT(*) FROM orchestration_events WHERE kind='build_gate' AND detail_json LIKE '%batchForfeited%'` → 0, and the same for `fallbackOfBatchOpId` → 0. This is a "merged, not yet accrued" gap, not a broken feature — no batch has both failed and been reconciled since that code went live, or it has not yet reached this daemon's running build. Whoever next revisits this: re-run `compute-realised-saving.mjs`'s §0 check and prefer the official fields the moment they show a nonzero count; the reconstruction below is a heuristic stand-in, not a replacement.

**0 `batch_merge_forfeited` events exist**, full history, any project (unchanged from the 2026-09-03 pass). Read literally that says a 0% forfeit rate — but this pass found that reading is **misleading**: real forfeit-shaped outcomes are happening and are simply not tagged with that event kind.

**Reconstructed by taskId correlation** (heuristic — see script header): of the 7 rejected batch attempts in this window —
- 3 fell back entirely to solo gates for every branch in the batch (2 branches each).
- 1 fell back to solo for 2 of its 3 branches, retried the third into a later passing batch.
- 3 were retried as a batch (same or overlapping branch set, sometimes with the failing branch dropped and replacement branches added, sometimes just re-run and passing — the flake-vs-real-defect distinction the card's own triage notes left open is visible in this data but not conclusively resolved by it; see the two shapes below).

Concretely: one cluster (tasks `dd961cf9`/`84a2eb2d`/`a16c580b`) failed **three times** (two attempts at K=2, one at K=3) before passing at K=3 — 4 total gate runs, ~88 min of wall-clock, to land 3 branches that would have cost ~52 min solo. **This specific cluster is a net loss from batching**, not a saving — a concrete existence proof that the model's failure-cost term is real and can dominate for an unlucky branch set, even while the aggregate across the whole window is strongly positive.

Total wall-clock burned on batch attempts that were outright rejected: **143.1 min** across the 7 failures (≈24% of all batch-attempt wall-clock in this window). Total additional wall-clock spent on the solo fallbacks those rejections triggered: **73.1 min**. Both figures are already folded into the §2 fully-loaded aggregate (45.1% saved) — they are not a separate cost sitting outside it.

**Not measured, and no data exists for it in this table:** the manager-side content-audit minutes a batch forces (the card's own DoD corollary — batching drops the automatic per-branch content check, making a manager's manual audit the only content-level verification left). `orchestration_events` has no field for manager audit time; this half of the cost genuinely cannot be reported from this instrument. Say so plainly rather than omitting it silently.

## 5. What this does and does not settle

**Settled:** DoD-3 (no material duration scaling with K) and DoD-2 (a real, large, positive wall-clock saving — 45.1% fully loaded, 48.6-73.8% on clean first-attempt passes) are both answered from real data, in the population's own units, with the counterfactual assumption stated. The model's registered prediction (~26-28%) is not refuted — it is exceeded, in a direction the registered falsifier did not anticipate.

**Not settled:** the manager-side audit-time cost (no instrument for it); the true forfeit rate under the *official* `batchForfeited`/`fallbackOfBatchOpId` fields (0 live rows — re-check once they accrue); and the flake-vs-real-defect split within the 7 rejected batches (visible in the retry-composition data above, not conclusively resolved by it — the card's owner previously ruled this decomposition out of scope unless it fell out of other work, and it did not fully fall out here).
