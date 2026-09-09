# c469d54e — the mode-cycle fallback re-arms from SessionStart dispatch, with a spawn-anchored absolute ceiling

## Narrative

`MODE_CYCLE_FALLBACK_MS` (card c469d54e) is a mode-cycle-scoped readiness fallback, re-armed from SessionStart (not spawn) once the SessionStart hook's `deliverHook` call is actually DISPATCHED (not merely once the hook has arrived at the process — an arrived-but-not-yet-dispatched hook, e.g. queued behind other synchronous work on an overloaded event loop, gets none of this budget's protection until dispatch actually happens). Sized like the original `READY_FALLBACK_MS` budget: comfortably over `cycleToMode`'s documented worst case (~13-14s) so a HEALTHY cycle always finishes first.

Under host contention, SessionStart's dispatch can land late enough to leave less than this much runway before the ORIGINAL spawn-anchored deadline — that shrinking residual, not `cycleToMode` being slow, was the actual defect: confirmed against the 2026-08-01 mass-restart's raw `daemon-output.log` — 9/9 fallback firings in that incident had SessionStart already dispatched 5.3s-11.6s before the old spawn+20s deadline, well under this budget, and 7/9 (8/9 under a broader any-non-clean-landing definition) showed the corrupted-footer signature this card fixes (see `docs/investigations/c469d54e-ready-fallback-race/findings.md` for the frozen log, its md5, and the re-runnable extraction script — this is manager-verified, not the parent card's original worker-reported figure). Re-arming FROM SessionStart's dispatch gives every healthy cycle its full, un-eroded budget regardless of how late that dispatch was.

`READY_FALLBACK_ABSOLUTE_CEILING_MS` (also card c469d54e) is the absolute ceiling on the re-armed timer above, measured from SPAWN (`Live.startedAt`), not SessionStart. Preserves `READY_FALLBACK_MS`'s original liveness guarantee ("never strand a queued boot injection forever") for the residual failure mode this fix does NOT eliminate: a SessionStart hook whose `deliverHook` dispatch is delayed to or past the original spawn+`READY_FALLBACK_MS` mark — a strictly worse contention level than anything observed in the incident this card fixes (worst observed SessionStart-dispatch gap there was ~11.6s; this ceiling gives roughly 4x that margin before giving up regardless). Deliberately NOT unbounded: a cycle that starts very late still gets bounded runway, not an open-ended wait.

INVARIANT (must hold for the ceiling clamp to ever matter): `READY_FALLBACK_ABSOLUTE_CEILING_MS − MODE_CYCLE_FALLBACK_MS ≥ READY_FALLBACK_MS` (45s − 20s ≥ 20s at the shipped defaults). All three are independently env-overridable — raising `LOOM_READY_FALLBACK_MS` past ~25s alone (holding the other two at their defaults) shrinks that margin below zero and deterministically RE-CREATES this card's race: the ceiling would then clamp the re-armed budget to LESS than the original spawn-anchored deadline already gave a cycle starting near spawn+0, for no reason. Nothing enforces this invariant at runtime — it is a deployment-time contract between three env vars.

## Do not

- Do not raise `LOOM_READY_FALLBACK_MS` past ~25s without also re-checking `READY_FALLBACK_ABSOLUTE_CEILING_MS − MODE_CYCLE_FALLBACK_MS ≥ READY_FALLBACK_MS` — violating it deterministically re-creates this card's race.
- Do not anchor `MODE_CYCLE_FALLBACK_MS`'s re-arm to spawn time instead of SessionStart's dispatch — that's the exact defect this card fixed (a shrinking residual under host contention, not slow cycling).
- Do not make `READY_FALLBACK_ABSOLUTE_CEILING_MS` unbounded — a very-late-starting cycle must still get bounded runway, not an open-ended wait.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (`MODE_CYCLE_FALLBACK_MS` and `READY_FALLBACK_ABSOLUTE_CEILING_MS`'s top-of-const docs), as of commit `1974444dc94618d380f474192e22edff20215ec5`. Relocated by card `de94a415` (tranche 2 on `pty/host.ts`); no wording changed, wrapped source lines joined into flowing paragraphs and the `*` comment markers stripped. See also the fuller incident write-up at `docs/investigations/c469d54e-ready-fallback-race/findings.md`.
