# sha:c6338ae1 — `live.rateLimited` suppresses drain/submit across the reconcile window, mirroring `stopping`

## Narrative

`§19c`'s usage-limit park (a `StopFailure` detected as `error==="rate_limit"`) originally only recorded
the resume-at time and broke out of the Stop/StopFailure case — it never actually suppressed anything.
Skipping the synchronous drain at that one call site was not enough: the pty stays alive while parked, and
the ~10s reconcile timer (plus any incoming `enqueueStdin`) would still fire later, drain the held pending
queue, and `submit()` into the still-capped account — clobbering `live.lastPrompt`, the very turn the park
exists to preserve so `resumeAfterRateLimit` can replay it. The killed turn would be lost, not resumed.

Commit `c6338ae1` fixed this by adding `live.rateLimited: boolean`, a THIRD suppress flag deliberately
mirroring the existing `stopping` flag's shape and enforcement points, not a bespoke mechanism:

- Set the moment the `StopFailure` is classified as a rate limit (right where the park already fires).
- Checked at `enqueueStdin`'s immediate-submit gate (alongside `!live.busy && !live.stopping`), so a message
  arriving while parked queues FIFO instead of writing straight into the capped session.
- Checked at the top of `drainPending` (alongside its existing `live.stopping` early-return) — this is the
  actual fix for the reconcile-timer hazard: the held queue stays intact, untouched, until unparked.
- Cleared FIRST, before anything else, in `resumeAfterRateLimit` — so the re-submitted `lastPrompt` and the
  post-resume Stop's own drain of the held queue can both proceed once `submit()` re-arms busy.

## Do not

- Do not treat suppressing the synchronous drain at the park's own call site as sufficient — the reconcile
  timer runs independently and will drain a held queue into a still-capped account unless `drainPending`
  itself also checks the park flag.
- Do not clear `live.rateLimited` anywhere except the start of `resumeAfterRateLimit`, and do not clear it
  after the resume submit — a resume that re-arms busy before clearing the flag would race the reconcile
  timer into skipping the very drain it's supposed to perform once unparked.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (the Stop/StopFailure case's §19c park block), as of
commit `c6338ae175af786cd5a1f3b982343aae6475b4c9` ("fix(pty): rate-limit park must survive the reconcile
drain (don't clobber the parked resume prompt)"). No board card id anywhere in the block, the file, or this
commit's message — keyed by commit sha per the extraction program's `sha:` grammar. Relocated as part of
`pty/host.ts` tranche 24.

## Round 2 (card dfef375f) — a bail must not clear this flag either

Round 1 of card dfef375f added `PtyHost.clearRateLimitedFlag(sessionId)` and called it from BOTH bail
call sites (`index.ts`'s loop-breaker override and `RateLimitWatcher.bail()`) — reasoning that an
abandoned episode should at least unstick drain/submit for a later ordinary message. A Code Review
caught that this is exactly the violation this record's own "Do not" already named: clearing
`live.rateLimited` anywhere except the start of `resumeAfterRateLimit` reopens the reconcile-timer
hazard — the ~10s timer (or any `enqueueStdin`) would drain the held queue straight into the still-capped
account the moment a bail cleared the flag, starting a fresh episode instead of leaving the session
genuinely suppressed until a human cleared it.

Fix: `clearRateLimitedFlag` was removed entirely. The shared bail helper
(`orchestration/rate-limit-bail.ts`'s `bailRateLimitEpisode`, used by both call sites) now only clears
the DB park columns — `live.rateLimited` stays `true` until an explicit human clear. The two REST clear
routes (`/api/sessions/:id/rate-limit/clear`, `/api/usage/clear-hold`) already call
`resumeAfterRateLimit` unconditionally, never gated on `rateLimitedUntil` being non-null, so they remain
reachable after a bail nulls that column — verified directly rather than assumed.

## Round 3 (card dfef375f) — round 2's own sentence above was FALSE for one of the two routes, and for the UI entirely

Round 2's closing sentence claimed BOTH REST clear routes "remain reachable after a bail nulls that
column." `/api/sessions/:id/rate-limit/clear` genuinely is — it takes a session id directly and always
ran `resumeAfterRateLimit` unconditionally, exactly as claimed. `/api/usage/clear-hold` was NOT: its
cascade iterates `db.listRateLimited()`, which queried `WHERE rate_limited_until IS NOT NULL` — the exact
column a bail nulls — so a bailed row was silently excluded from the cascade's loop and `resumeAfterRateLimit`
was never called for it via that route at all. Separately, "the route is reachable" was never the whole
story for a human: `SessionActions.tsx`'s Clear-and-retry button (the per-session route's only UI
affordance) was gated on `rateLimited` alone (`!!s.rateLimitedUntil && ...`), so a bailed session had no
button to click — the route being technically reachable by a direct REST call doesn't help someone using
the UI as intended.

Fix: a new durable `rate_limit_bailed_at` session column (set once by `bailRateLimitEpisode`, cleared by
both REST clear routes and `onExit`) lets every reader distinguish "never capped" from "bailed, needs a
human" even after `rateLimitedUntil` is nulled. `db.listRateLimited()` now matches
`rate_limited_until IS NOT NULL OR rate_limit_bailed_at IS NOT NULL`, so `/api/usage/clear-hold`'s cascade
picks up a bailed row again. `SessionActions.tsx`'s gate widened to `rateLimited || bailed`. A new
attention-queue row ("AUTO-RESUME ABANDONED") surfaces a bailed LIVE session even outside the per-session
panel, so a parentless top-level manager/lead's bail is never silent.
