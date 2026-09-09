# f0718488 — retry the installed-build version probe only on a genuine TIMEOUT, with a bounded worst-case budget

## Narrative

`readInstalledBuild`'s retry loop retries ONLY a TIMED-OUT attempt (`r.timedOut`) — a non-zero exit or malformed stdout at exit 0 is a genuine failure of the installed binary, not host contention, so it breaks on attempt 1 and is never retried (stays fast + latched). The dominant observed cause of a timeout is steady-state contention from a live fleet of workers + gates, not a boot-window blip — measured, overturning the original "boot only" theory.

WORST-CASE BUDGET (every attempt hits the full timeout — do not "helpfully" retune any of these constants without redoing this arithmetic): `versionProbeMaxAttempts(3) * versionProbeTimeoutMs(5,000ms) + (versionProbeMaxAttempts - 1)(2) * versionProbeRetryDelayMs(250ms) = 15,500ms` for this method alone. This only ever runs after a successful `/graph/health` fetch inside the SAME `probeHealth()` tick (sequential awaits), so the full worst-case single-tick wall time also carries that fetch's own bound: `+ healthProbeTimeoutMs(5,000ms) = 20,500ms`, ~68% of the default 30,000ms `healthProbeIntervalMs` tick interval — a real ~9.5s margin, on top of the `probeInFlight` guard (which already makes a literal tick-overlap structurally impossible regardless). Under sustained contention this does mean ~20.5s of every 30s tick is spent spawning `--version` subprocesses — judged negligible next to the load actually causing the contention (live workers + gates), and the timedOut-only gate means a genuinely broken binary never enters this path at all. Deliberately no adaptive/stateful backoff here — not warranted at this priority.

A `for` loop's own post-body increment would still fire after a final, exhausted iteration breaks out — leaving `attempt` one higher than the real count. `attempt` is tracked explicitly instead so the "(N attempts)" reason string, and every test asserting on `getVersionProbeAttemptCount()`, see the true number actually made.

3 attempts sits at the top of the originally-suggested "2-3 attempts" range: the observed failure is steady-state host contention (a live fleet of workers + gates), exactly the shape more chances helps with, while the timedOut-only retry gate already filters out genuine breakage after just one try. The flat (non-escalating) delay between attempts (250ms) is deliberately NOT `DEFAULT_RESTART_BACKOFF_MS`'s escalating shape (that nurses a possibly-broken PROCESS back up over minutes); this is only bridging a brief host-scheduling blip on a cheap subprocess spawn, so a short fixed pause is the right fit.

## Do not

- Do not retry a non-timeout failure (non-zero exit, malformed stdout) — only a genuine timeout is retried; a real failure of the installed binary is not host contention.
- Do not retune `versionProbeMaxAttempts`/`versionProbeTimeoutMs`/`versionProbeRetryDelayMs` without redoing the worst-case-budget arithmetic against `healthProbeIntervalMs` — the current values leave only a ~9.5s margin.
- Do not rely on a `for` loop's own post-increment to count attempts — track `attempt` explicitly, or the count is off by one on the exhausted-final-iteration case.

## Source

JSDoc method comment in `packages/daemon/src/codescape/supervisor.ts`, above `readInstalledBuild`'s retry loop (the card-f0718488 paragraphs): originally lines 1792-1815, as of this tranche's HEAD. Relocated by card `725511f2` (tranche 1); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
