# 4c7a337d — a restart rate ceiling that `ranHealthy` cannot clear, layered on the original backoff-exhaustion ceiling

## Narrative

`scheduleRestart`'s `if (ranHealthy) this.restartAttempts = 0` is legitimate policy for a long-lived healthy process that dies once — it shouldn't be permanently penalised by ancient restart history. But it has no notion of CADENCE: any kill that recurs on a period LONGER than `healthyRunMs` (30s by default) sees `ranHealthy` true on essentially every single death, so `restartAttempts` resets to 0 before it can ever reach `restartBackoffMs.length` — the give-up ceiling becomes structurally unreachable, and the loud "codescape serve is DOWN … needs a human" diagnostic never fires. Measured directly against this exact defect: 12 -> 30 spawns over 3s with zero give-ups, and separately 92 kill cycles over 30s with zero give-ups.

Card `4c7a337d` fixes it with a SECOND, independent ceiling: `restartTimestamps` (a sliding window over `restartWindowMs`, default 1 hour) shows `maxRestartsPerWindow` (default 10) restarts already scheduled inside the trailing window — a ceiling `ranHealthy` CANNOT clear. This window-based count is orthogonal to `ranHealthy`/`restartAttempts` entirely — it just asks "how many times has `serve` actually been restarted recently", independent of whether any individual run happened to clear the `healthyRunMs` bar. A single isolated restart (the legitimate case the `ranHealthy` reset exists to protect) never comes close to this ceiling; only a GENUINE, sustained crash loop — on ANY cadence, not just one faster than `healthyRunMs` — does.

`scheduleRestart` now gives up (stays down, logs loudly) once EITHER ceiling is reached: (1) the backoff schedule (`restartBackoffMs`) is exhausted without a healthy run resetting it in between — the ORIGINAL mechanism, unchanged; or (2) `restartTimestamps` shows `maxRestartsPerWindow` restarts already scheduled inside the trailing `restartWindowMs` — the new ceiling. (1) alone left a hole for ANY sustained crash loop on a cadence longer than `healthyRunMs` — not just the one specific 500-misclassification trigger card `545ef479` fixed. (2) is what makes the diagnostic reachable again regardless of cadence, while leaving the legitimate `ranHealthy` reset itself intact for the isolated-single-restart case it exists to protect.

Repeated `spawnServeSelfReporting` timeouts (card `44d45f81`) DO feed this same give-up arithmetic — each abandoned attempt calls `scheduleRestart(false)`, never "healthy" — a slow-but-genuinely-broken host CAN still reach the give-up path via backoff exhaustion; the raised port-report timeout only makes that structurally much harder to reach, never impossible (see `docs/decisions/44d45f81-port-report-timeout-raised-after-live-regression.md` for the reachability arithmetic).

## Do not

- Do not rely on backoff-exhaustion alone as the give-up ceiling — `ranHealthy` can reset it on essentially every death for a crash loop slower than `healthyRunMs`, making that ceiling structurally unreachable; the rate-window ceiling must stay in place alongside it.
- Do not let the rate-window ceiling (`restartTimestamps`/`maxRestartsPerWindow`) be cleared by `ranHealthy` — it exists precisely because that reset cannot be trusted to catch every crash-loop cadence.

## Source

JSDoc constant comment above `DEFAULT_MAX_RESTARTS_PER_WINDOW` (originally lines 140-159) and the rate-ceiling portion of `scheduleRestart`'s own doc (originally part of lines 1334-1369), both in `packages/daemon/src/codescape/supervisor.ts`, as of this tranche's HEAD. Relocated by card `725511f2` (tranche 1); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
