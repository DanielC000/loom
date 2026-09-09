# 545ef479 — health-probe wedge detection distinguishes "no answer" from "answered but not ok", and drift-check state is latched once per transition

## Narrative — Defect 1: every `checkBuildDrift` exit path latches a `DriftCheckState`

Before card `545ef479`, `checkBuildDrift`'s two silent no-op returns (running build absent, installed build honestly `null`) and its ordinary steady-state MATCH were THREE code paths that all produced zero observable signal — "drift detection is running and finding nothing" was byte-identical, downstream, to "drift detection is inert". Every exit path — including those two no-ops — now latches a `DriftCheckState` via `announceDriftCheckState` before returning, exposed via `getDriftCheckState()` (a diagnostic/test seam, `null` until the first probe tick that reaches `checkBuildDrift` completes).

`announceDriftCheckState` latches and announces a TRANSITION only — never on every ~30s probe tick. A steady-state `"match"` (or a steady `"not-checked:*"`) logs nothing further after its first announcement; only a genuine change of state (including into/out of an UNKNOWN bucket) is worth a human's attention. It logs via `console.log`, not `console.warn` — a mismatch is already loudly warned in detail by the caller's own existing branches (deferring/STABLE/UNRESOLVED); this line exists so the coarse three-way signal (match / mismatch / not-checked) is ALSO visible without reading those detailed lines.

## Narrative — Defect 2: an answered-but-not-ok health response is never wedge evidence

`probeHealth`'s failure counting means the request never got an answer at all (timeout / connection refused / network error — `res.status` absent). A response that DID arrive, even a 5xx, is proof the process is alive and serving — it is reported (once, latched via `lastHealthAnsweredErrorStatus`) but never counted toward `consecutiveHealthFailures` and never kills the child. Before this card, any non-2xx (including a 500 meaning "I can't determine something") was scored as a wedge failure — three consecutive 500s killed a perfectly healthy process.

`spawnServe`'s `child.on("exit")` only ever catches a `serve` that DIES — a serve that's alive, port bound, and simply not answering (wedged) stays `alive:true` forever under that detector alone, and `getPort()` keeps handing sessions a port that will hang. The periodic `/graph/health` probe is what closes that gap. A single failed probe is NOT enough — a busy serve can miss one beat under load, and treating that as death would restart a perfectly healthy process; only a SUSTAINED run of `healthProbeFailureThreshold` consecutive genuine no-answer failures (reset to 0 by any success) counts as a wedge. On a sustained failure, `probeHealth` does NOT call `scheduleRestart`/`spawnServe` itself — it kills the live child. That kill is a REAL process death, so it fires the exact same `child.on("exit")` → `onDeath` → `scheduleRestart` path a crash would (same `restartAttempts` budget, same backoff, same give-up ceiling) — a health-driven restart can never resurrect a serve past an exhausted budget, because it never opens a second restart channel; it just triggers the existing one.

## Do not

- Do not count an answered-but-not-2xx health response toward `consecutiveHealthFailures` — only a genuine no-answer (timeout/refused/network error) is wedge evidence; a 5xx is proof of life and must only be reported once, latched.
- Do not let `checkBuildDrift` return silently on any exit path — every path (including the two "absent"/"honest null" no-ops) must latch a `DriftCheckState`, or "finding nothing" becomes indistinguishable from "inert".
- Do not log the transition-state line (`announceDriftCheckState`) on every probe tick — only on an actual state CHANGE.
- Do not open a second restart channel for a health-driven kill — route it through the existing `child.on("exit")` → `scheduleRestart` path so it shares the same give-up budget as a crash-triggered restart.

## Source

JSDoc method comments in `packages/daemon/src/codescape/supervisor.ts`, above `probeHealth` (originally lines 1414-1442) and the Defect-1 portions of `checkBuildDrift`'s and `announceDriftCheckState`'s own docs (originally part of lines 1568-1643), all as of this tranche's HEAD. Relocated by card `725511f2` (tranche 1); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
