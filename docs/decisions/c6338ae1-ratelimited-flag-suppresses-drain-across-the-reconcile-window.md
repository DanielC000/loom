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
