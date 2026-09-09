# 5ef78900 — `timingBand`'s cross-project numeric disclosure is deliberate, appended outside the redacted return

## Narrative

Card 5ef78900: `timingBand` discloses a foreign project's test-file COUNT and gate-duration DISTRIBUTION — appended in `gate_status`'s handler, OUTSIDE `sessions.gateStatus`'s own return, so that method's own cross-project redaction can never see or gate it; `isCrossProjectGateOp` is the same fail-safe comparison `gateStatus` uses internally, exposed for exactly this case. A deliberate decision (not an oversight): lower severity than the content-bearing fields `gateStatus` itself redacts — aggregate numerics, not another tenant's paths/test names/error text — but still real cross-tenant telemetry a foreign caller has no need for, so it is guarded by the SAME `isCrossProjectGateOp` check before being appended.

## Do not

- Do not treat `timingBand`'s numeric disclosure as equivalent to the content-bearing fields `sessions.gateStatus` redacts — it is deliberately lower-severity aggregate data, gated by its own `isCrossProjectGateOp` check, not folded into that method's redaction.

## Source

Inline comment in `packages/daemon/src/mcp/orchestration.ts` (`registerGateStatus`'s handler). Relocated by card 210cd10c (tranche 1 on `mcp/orchestration.ts`); no wording changed, wrapped source lines joined into a flowing paragraph and the `//` comment markers stripped.
