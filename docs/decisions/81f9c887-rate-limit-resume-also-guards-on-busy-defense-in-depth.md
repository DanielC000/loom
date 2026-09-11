# 81f9c887 — `resumeAfterRateLimit` also guards on `live.busy`, defense-in-depth against a caller invoking it on a never-parked session

## Narrative

Card `81f9c887` (defense-in-depth, mirrors `enqueueStdin`'s own idle-submit gate re-checking rather than trusting its caller): `resumeAfterRateLimit` also guards on `live.busy`. The invariant `rateLimited ⇒ !busy` (`rateLimited` is only ever set inside the Stop/StopFailure handler AFTER `setBusy(false)`) means a genuinely parked session is never busy — so hitting this guard on a BUSY session only happens when a caller invokes it against a session that was never actually parked (e.g. the per-session `POST /rate-limit/clear` REST route has no server-side busy/parked guard of its own, and `live.lastPrompt` is set by ANY `submit()`, not just a rate-limit kill).

That's a caller error, not a real resume — replaying `lastPrompt` there would re-submit it as a SECOND turn on top of the one already in flight (the exact double-turn hazard the M1/M2 busy-gate ordering exists to prevent). Skip the replay entirely rather than queuing it: unlike the stopping/drainHeld case (see `docs/decisions/7edd420b-…md`), there is no genuinely-held turn here to preserve — queuing would just deliver the same stale duplicate a moment later instead of on top of the live one.

## Do not

- Do not replay `live.lastPrompt` from `resumeAfterRateLimit` without also checking `live.busy` — a caller invoking it against a session that was never actually parked (e.g. the REST rate-limit-clear route, which has no server-side busy/parked guard of its own) would re-submit `lastPrompt` as a second turn on top of one already in flight.
- Do not queue the replay via `enqueueStdin` when the busy guard trips — unlike the stopping/drainHeld case, there is no genuinely-held turn to preserve here; queuing would just deliver a stale duplicate later instead of skipping it.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (`resumeAfterRateLimit`'s own method doc), commit `3f8c44effd` (2026-07-17). Extracted by card `09a1354e` (tranche 46 on `pty/host.ts`); condensed and reworded, not verbatim.
