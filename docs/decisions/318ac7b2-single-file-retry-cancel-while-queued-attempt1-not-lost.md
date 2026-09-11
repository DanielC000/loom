# 318ac7b2 — the single-file retry's cancel-while-queued path doesn't lose attempt 1's real failure

## Narrative

CAVEAT (card 318ac7b2): for the single-file retry's own cancel-while-queued path specifically, attempt 1 — a SEPARATE, EARLIER admission — already genuinely ran and genuinely failed before this retry was ever queued; that real run is what the sibling `build_gate` event (stamped `cancelled:true`, emitted right before this same return) records, so it is NOT lost — just not carried on this particular return value's own fields.

## Do not

- Do not treat a `cancelled:true` return on the single-file retry's cancel-while-queued path as meaning attempt 1's failure was lost — it's recorded on the sibling `build_gate` event instead of on this return value's own fields.

## A cancel after attempt 1 genuinely ran must still record it — the fix that created the caveat above (separate decision, same card id, `sessions/service.ts` `build_gate` emission)

Card 318ac7b2 (the card's own body): a cancelled single-file retry used to return before `evt("build_gate")`
ever ran — this retry's own such call, further below, is the one every OTHER outcome of the method reaches,
but is never reached on this early-return path. By that point attempt 1 has already genuinely spawned and failed a real full suite
(`gateRan && classifyGateFailure(gateResult) === "genuine"` gated the retry in the first place) — but
`merge_cancelled` is not in `GATE_HISTORY_KINDS`, so without a fix the op left NO `gate_history` row at all,
silently erasing a real, completed full-suite run from both the rejection-rate and duration series (the
same fragility `8126f1a0`'s investigation found in this table).

FIX: emit `build_gate` (unlike `merge_cancelled`, `build_gate` IS in `GATE_HISTORY_KINDS` — db.ts) carrying
attempt 1's own real numbers, with `cancelled: true` set explicitly. `gateOutcomeFromDetail` (db.ts) checks
`detail.cancelled === true` BEFORE `detail.passed` — the same precedence a mid-run WORKER-gate cancel
already relies on — so this row reads as the distinct `"cancelled"` outcome, never `"pass"` and never
`"reject"`: folding a cancelled op into `"reject"` would inflate the rejection rate with an op that reached
no real verdict; dropping the row, as before this fix, silently deflates both the rejection rate AND the
duration series by discarding a real, completed run.

Field-by-field: `passed: gateResult.passed` (always `false` here — the guard requires a genuine,
non-passing, attempt 1) rides along purely as an honest record of what attempt 1 produced; it never wins
the outcome classification over `cancelled:true`. `durationMs: gateAttempt1DurationMs` is attempt 1's own
real measured run time, captured right after its admission settled — the exact figure that used to vanish
from the duration series. `gateSpawned: gateRan` mirrors every other `build_gate` emission in this method
(`gateRan` is provably `true` to have reached this retry at all). `retriedFile` records that a retry WAS
identified and attempted; `retryPassed` is deliberately omitted — the retry never ran to completion, so
there is no verdict to report for it (never assume `retriedFile` alone implies a pass).

This differs from the FIRST attempt's own identical-shaped cancel-while-queued catch, a few lines above this
site: there, a cancel means the gate never got to run at all (merge-gate `runGateSeq` calls never forward a
live `cancelSignal`, so a merge gate can only ever be withdrawn WHILE QUEUED, never mid-run) — nothing real
was lost, so no `build_gate` emission is needed there. A cancel HERE is different precisely because attempt
1 already ran for real.

## Do not (2)

- Do not fall through to the plain `merge_cancelled` return on this path without first emitting `build_gate`
  — attempt 1's real, measured run would silently vanish from `gate_history`.
- Do not classify this row as `"reject"` — `cancelled:true` must win the outcome classification over
  `passed:false`, or a cancelled op inflates the genuine rejection rate.

Source (this section only): inline comment in `packages/daemon/src/sessions/service.ts` (the single-file
retry's second, transient-kill-retry `GateCancelledError` catch — the same shape as the caveat above, one
retry later), commit `ddb9d3eeaef912ffaa7196c24019723a44592495`, as of this tranche's HEAD. Not the same
decision as the `ConfirmMergeResult.cancelled` field doc above — the two happen to share a card id.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`ConfirmMergeResult.cancelled`, single-file-retry caveat): lines 545-560, as of commit `f9caa77e30d5c1a6dd994b6203261968c0dbf94f`. Relocated by card `8f4c8a8f`; no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
