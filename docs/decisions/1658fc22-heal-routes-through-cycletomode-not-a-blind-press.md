# 1658fc22 — the plan-mode auto-heal routes through `cycleToMode`, not a single blind corrective press

## Narrative

A single blind corrective Shift+Tab press would carry the same drop risk as the failure it is healing (card 1658fc22): if that lone press ALSO drops under load, the session stays stranded with no further retry. `logLandedMode`'s auto-heal instead routes the correction through `cycleToMode` — the same footer-verified, retrying primitive the main SessionStart convergence path uses — which reads the footer and retries (bounded) until it reaches the target or the pty dies, exactly like the main path. So a dropped press under this heal just costs one more poll, not a permanent strand.

## Do not

- Do not correct a stranded/mismatched permission mode with a single blind Shift+Tab press — route it through `cycleToMode` instead, so a dropped press is retried rather than leaving the session stranded a second time.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (`logLandedMode`'s own JSDoc), as of main `62688be0` (host.ts tranche 49's merge). Extracted by card `9c0c60cb` (tranche 50 on `pty/host.ts`). Condensed and reworded, not verbatim.
