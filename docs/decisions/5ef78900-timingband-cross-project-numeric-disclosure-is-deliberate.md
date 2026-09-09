# 5ef78900 — `timingBand`'s cross-project numeric disclosure is deliberate, appended outside the redacted return

## Narrative

Card 5ef78900: `timingBand` discloses a foreign project's test-file COUNT and gate-duration DISTRIBUTION — appended in `gate_status`'s handler, OUTSIDE `sessions.gateStatus`'s own return, so that method's own cross-project redaction can never see or gate it; `isCrossProjectGateOp` is the same fail-safe comparison `gateStatus` uses internally, exposed for exactly this case. A deliberate decision (not an oversight): lower severity than the content-bearing fields `gateStatus` itself redacts — aggregate numerics, not another tenant's paths/test names/error text — but still real cross-tenant telemetry a foreign caller has no need for, so it is guarded by the SAME `isCrossProjectGateOp` check before being appended.

## Do not

- Do not treat `timingBand`'s numeric disclosure as equivalent to the content-bearing fields `sessions.gateStatus` redacts — it is deliberately lower-severity aggregate data, gated by its own `isCrossProjectGateOp` check, not folded into that method's redaction.
- Do not gate an individual spread inside `gateStatus`'s `rawVerdictFields`/`rawOuterFields` construction with its own `&& !crossProjectRedacted` check (round 2, below) — redaction happens exactly once, after the object is fully assembled.

## Round 2 — `gateStatus` redacts once, post-hoc, not per spread

### Narrative

Every spread inside `gateStatus`'s `rawVerdictFields`/`rawOuterFields` construction is VERBATIM/unconditional — no more per-line `&& !crossProjectRedacted`. Redaction happens exactly once, after the object is fully assembled, by filtering it against `GATE_VERDICT_FIELD_CLASSIFICATION` (see that Record's own doc for why it's an exhaustive classification, not a Set). Round 3 (a later card) widened the mechanism further; this shape — one post-hoc filter, not scattered per-field gates — is what round 2 established and is what `isCrossProjectGateOp` (above) exists to let a caller reuse rather than re-derive by hand.

### Do not

- Do not reintroduce a per-line `&& !crossProjectRedacted` gate inside `rawVerdictFields`/`rawOuterFields` — filter the assembled object once, against `GATE_VERDICT_FIELD_CLASSIFICATION`.

### Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`gateStatus`'s `rawVerdictFields` ternary): lines 3763-3767, as of this tranche's HEAD (tranche 9).

## Source

Inline comment in `packages/daemon/src/mcp/orchestration.ts` (`registerGateStatus`'s handler). Relocated by card 210cd10c (tranche 1 on `mcp/orchestration.ts`); no wording changed, wrapped source lines joined into a flowing paragraph and the `//` comment markers stripped.

## `isCrossProjectGateOp` — exposed standalone because `timingBand` is appended AFTER `gateStatus` returns

### Narrative

`isCrossProjectGateOp` checks whether `opId`'s settled row belongs to a DIFFERENT project than `redactCrossProject` declares — the EXACT SAME fail-safe comparison `gateStatus` uses internally for its own cross-project redaction. Exposed standalone because `gate_status`'s `timingBand` join (`mcp/orchestration.ts`) is appended to `gateStatus`'s return AFTER that method has already returned — a service-layer enumeration inside `gateStatus` structurally cannot see or gate a field a CALLER adds later, so that caller needs this same comparison available on its own rather than re-deriving (and risking drifting from) the fail-safe polarity by hand.

`redactCrossProject === undefined` (the worker path, which never constructs the wrapper) returns `false` — "not asking, nothing to redact" — identical to `gateStatus`'s own discipline. A caller-project lookup that failed to resolve (`callerProjectId: undefined`) still compares unequal against any real `string | null` project id and so still redacts — fail-SAFE, not fail-open. An opId that can't be resolved at all returns `false` (nothing to compare against) rather than throwing — harmless, since `gateStatus` itself independently and authoritatively reports `never_existed`/`unknown` for that identical miss; this method is a gating aid for an ALREADY-settled, ALREADY-resolved op, never a resolution path of its own.

### Do not

- Do not re-derive the cross-project fail-safe comparison by hand at a new call site — reuse `isCrossProjectGateOp`, or a future caller risks drifting from `gateStatus`'s own polarity.
- Do not treat an unresolvable `callerProjectId` or `opId` as "safe to disclose" — both compare unequal / return `false`, the fail-SAFE direction, never fail-open.

### Source

JSDoc comment in `packages/daemon/src/sessions/service.ts`, above `isCrossProjectGateOp`: lines 3927-3944, as of this tranche's HEAD (tranche 9).
