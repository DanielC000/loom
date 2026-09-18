# bab0e772 — wedge-KILL detection is disarmed (via `healthProbeWedgeKillEnabled:false`) in `codescape-health-probe.mjs` scenario (5), not the whole probe, and not widened

## Context

Card `bab0e772` tracked seven weeks of unexplained `codescape-health-probe` flakes under host load.
A third specimen (gate `a053812a`, 2026-09-18) finally captured the full ordering: scenario (5) — which
tests ONLY the build-drift restart path — asserts an exact spawn ledger (`calls.length === 2`, then
`=== 3`). Under real host contention, the SAME supervisor instance's liveness probe
(`healthProbeIntervalMs:300` / `healthProbeTimeoutMs:180` / `healthProbeFailureThreshold:3` — orthogonal
machinery already covered by scenarios (1)-(4)) can independently decide the freshly drift-restarted
child is "alive but unresponsive" and kill it, injecting extra unwanted spawns into the exact ledger
scenario (5) counts, before its own assertions ever run. Forced reproduction (a scratch script arming
the fixture's `FAKE_CODESCAPE_HEALTH_WEDGE_FILE` wedge against the post-drift-restart child) reliably
turned a clean 2-spawn ledger into a polluted 4-spawn one, confirming the mechanism deterministically.

**First attempt was wrong and is recorded here so it isn't retried:** disarming the WHOLE health-probe
timer (`startHealthMonitor()`) for scenario (5) breaks the scenario outright — `checkBuildDrift()` only
ever runs from inside `probeHealth()`'s SUCCESSFUL-response branch, so no timer means no drift detection
either, not just no wedge-kills. Confirmed by forced re-run: with the whole timer disabled, the intended
drift restart itself never fired (ledger stuck at 1, not 2).

## Decision

Added `CodescapeSupervisorOpts.healthProbeWedgeKillEnabled` (default `true`) to `supervisor.ts`. The
probe timer keeps running unconditionally exactly as before (decision `sha:e2d23231` is untouched) — the
flag gates ONLY the no-answer branch inside `probeHealth()` (`supervisor.ts`, the
`consecutiveHealthFailures` count-and-kill logic), leaving the successful-response branch (and therefore
`checkBuildDrift`) fully intact. Scenario (5) in `codescape-health-probe.mjs` now constructs its
supervisor with `healthProbeWedgeKillEnabled: false` — wedge-kill detection is orthogonal to what that
scenario tests, and disarming just that action removes a false-positive source rather than reducing the
assertion's ability to catch a real drift-restart bug.

## Do not

- Do not achieve the same effect by widening `healthProbeIntervalMs` / `healthProbeTimeoutMs` /
  `healthProbeFailureThreshold` to a large number instead of this explicit flag — that is
  indistinguishable on the page from quieting a flake by loosening a timeout (forbidden by this card),
  and the next reader cannot tell the two apart. The flag states the intent directly.
- Do not gate `startHealthMonitor()`'s arming (or the probe tick itself) on this flag — see the "first
  attempt was wrong" note above. Only the wedge-kill branch may be gated; the tick must keep running so
  `checkBuildDrift` keeps working.
- Do not read this as reopening decision `sha:e2d23231` (health-probe arming must stay unconditional in
  PRODUCTION, never gated on project count). `healthProbeWedgeKillEnabled` defaults to `true` and
  production code never passes `false` — this is a test-only seam on a different axis entirely.
- Do not apply `healthProbeWedgeKillEnabled:false` to scenarios (1)-(4), (8b), (9), or any other scenario
  whose own subject IS the health-probe wedge path, or that deliberately widens
  `healthProbeFailureThreshold` instead (e.g. scenario (8b), which predates this decision and was left
  as-is — out of scope for this card).

Full incident notes, the ordering evidence, and the forced-repro methodology: card `bab0e772`.
