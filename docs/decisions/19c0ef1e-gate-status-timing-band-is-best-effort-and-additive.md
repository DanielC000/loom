# 19c0ef1e — `gate_status`'s `timingBand` join is best-effort and additive, never able to fail the call

## Narrative

Card 19c0ef1e: only a settled row with a recorded verdict can even have a matching gate-timing NDJSON `run-summary` row to join against — best-effort and ADDITIVE (never fabricated, never able to fail this call): `computeGateTimingBand` itself already returns `undefined` on every "nothing to report" case (no NDJSON, opId outside the read window, a non-Loom gate command), and the outer catch around it is belt-and-suspenders against an unexpected read/parse failure.

## Do not

- Do not let a `timingBand` read/parse failure propagate into a real `gate_status` error — it must fall through to the plain result, same posture as any other advisory-only enrichment on this call.

## Source

Inline comment in `packages/daemon/src/mcp/orchestration.ts` (`registerGateStatus`'s handler). Relocated by card 210cd10c (tranche 1 on `mcp/orchestration.ts`); no wording changed, wrapped source lines joined into a flowing paragraph and the `//` comment markers stripped.
