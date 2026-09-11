# fd9edb87 — `GateRun.gateTimeoutMs` is the per-project RAW ceiling, not the ~2x effective one an auto-extend can reach

## Narrative

Card fd9edb87: the RESOLVED per-project `orchestration.gateCommandTimeoutMs` (ms) for this run's project, read server-side through the SAME `resolveConfig(project.config, platformConfig)` path the gate itself enforces, so a per-project override is reflected rather than the platform default. It exists so a cross-project reader can scale a "this lane has been held a long time" cue to each row's OWN bound: the timeout is per-PROJECT, so two rows in one snapshot can legitimately carry different values, and no single page-level constant can be correct for both.

`null` means the bound is genuinely UNKNOWN for this run — today only when the project row could not be read (deleted while its gate was still in flight), plus any older record predating this field. `null` is NOT a measured zero and NOT a licence to substitute a default: a reader with no bound cannot say whether a run is long, and must not warn on an invented one.

This is the RAW configured value — the HARD ceiling a post-timeout RETRY enforces — never the ~2× effective ceiling a FIRST attempt's one-time output-gated auto-extend can reach. Same convention as `GateProximity.fraction` (daemon `gate-runner.ts`), and for the same reason: that is the ceiling that actually bites. So an elapsed clock measured against this CAN legitimately pass 100% on a run that extended, and that is correct rather than a bug.

## Do not

- Do not substitute a default when `gateTimeoutMs` is `null` — a reader with no bound cannot say whether a run is long, and warning on an invented default is worse than not warning at all.
- Do not read `gateTimeoutMs` as the effective ceiling a first attempt's auto-extend can reach — it is the RAW per-project configured value (the hard ceiling a post-timeout retry enforces), so an elapsed clock measured against it can legitimately exceed 100% on an extended run.
- Do not use a single page-level constant for every row's timeout cue — the bound is per-project, and two rows in one snapshot can legitimately carry different values.

## `LONG_RUN_WARN_FRACTION` (`Gates.tsx`'s per-row cue)

WHY A FRACTION AND NOT A FIXED NUMBER OF SECONDS (card fd9edb87, owner-reported): the gate timeout is PER-PROJECT and this page is a deliberate cross-project view, so two rows on screen can legitimately have different bounds — ⛔ no single page-level constant can be correct for both. The constant this replaced was a hardcoded 420s, which on this repo's own 1,800,000ms bound fired at ~23% and left a completely healthy 16–20 minute merge gate red for most of its life. A warning that is on almost always carries no information: it trains the reader to ignore the one time it matters.

WHY 0.80: Loom's own healthy merge gates measure ~16–20 min against a 30 min bound (~53–67%), so 0.80 clears the top of that measured band by a comfortable margin while still leaving ~6 minutes of runway before the bound — late enough to be quiet on routine runs, early enough for the cue to be actionable. It sits deliberately just UNDER the daemon's own post-settle `GATE_PROXIMITY_THRESHOLD` (0.85, see `orchestration/gate-runner.ts`): this is the LIVE cue, so it should draw the eye slightly before the settled record would call a run near-budget, while there is still time to act on it.

⚠️ THE HEALTHY BAND IS WORKLOAD-DEPENDENT, AND APPEARS TO SCALE WITH BATCH SIZE K. The ~16–20 min anchor above is itself a K=2 `merge_batch` measurement (~15.1–18.9 min) — ⛔ NOT a solo-gate figure — so it does not describe a larger batch. Against it, a K=4 batch was observed still healthy past 20 minutes (opId 07520fa5, 2026-09-05). ⚠️ BOUND THAT: it is ONE live reading off a running gate, reported rather than measured here — a direction, never a second band, and it must not acquire the K=2 range's authority. ⇒ A correct cue may legitimately fire on a large HEALTHY batch. ⛔ Do NOT read that as this constant being mistuned — a batch genuinely approaching its bound is exactly what the cue is for. If you retune, measure per-K rather than widening one band to cover every K: a band stretched to keep the largest batch amber goes quiet on the smaller runs it must still catch.

### Source (this section only)

Inline comment in `packages/web/src/pages/Gates.tsx` (the `LONG_RUN_WARN_FRACTION` constant's own doc comment). `07520fa5` above is an orchestration operation id, not a board card — not a record key.

## Source

Inline comment in `packages/shared/src/types.ts` (`GateRun.gateTimeoutMs`'s field doc). Relocated by card 35d90c4e (tranche 1 on `packages/shared/src/types.ts`); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
