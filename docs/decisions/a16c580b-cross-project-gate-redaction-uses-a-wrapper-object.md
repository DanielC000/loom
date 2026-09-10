# a16c580b — Cross-project redaction for gate output/diagnostic fields uses a wrapper object, not a bare optional string

⚠️ Spans two source locations: this record's original §1 narrative (`sessions/service.ts`'s `gateStatus`),
and §2 below (the `orchestration.ts` `registerGateStatus` call site that wires a manager into it). Folded
here rather than left as a second unreachable file for the same id (card `6de8956e`'s
`collidingRecords`-avoidance precedent).

## §1 Narrative

Card a16c580b, widened by card 5ef78900: cross-project REDACTION for the output/diagnostic fields (`outputFile`, `outputTail`, `steps`, `gateDetail`) — see `redactCrossProject`'s own doc above for why this is a wrapper object, not a bare `string | undefined`, and separate from `scopeProjectId`'s FILTERING. `redactCrossProject === undefined` (the worker call site never constructs the wrapper at all) means "nothing to redact" — that path's hard filter already made a foreign project's row unreachable before this line runs. Whenever the wrapper IS present (every manager call), `t.record.projectId` (typed `string | null`) is compared against `redactCrossProject.callerProjectId` (`string | undefined`) — a `string | null` value can never equal a bare `undefined`, so an UNRESOLVED caller project (a failed `db.getSession` lookup) fails safe to `true` (redacted) automatically, with no separate branch or sentinel value needed. The SAME `!==` also correctly redacts the legacy `projectId:null` row for the identical reason.

WHAT'S REDACTED, AND WHY IT GREW (card 5ef78900): originally (card a16c580b) this covered `outputFile` ONLY — an absolute host path into another project's full gate output — leaving `outputTail` (a bounded excerpt of the SAME output) and `gateDetail` (whose `failingTest`/`stderrTail` can name another project's test file/paths verbatim) unredacted on the identical unscoped manager path. That was a real, unintentional gap, not a second deliberate posture: `outputTail`/`gateDetail` are the SAME field CLASS as `outputFile` (all three are ways to read another tenant's captured gate output/diagnostics) and get the SAME treatment now. `steps` (bare `{step,durationMs,status}` timings, no captured output) is lower risk but redacted too for consistency — a `step` label is a verbatim fragment of the OWNING project's configured `gateCommand`, itself project-specific text this caller has no legitimate reason to read cross-project. NOT touched: this is a `redact, don't refuse` fix (mirroring `gate_queue`'s own `redacted:true` precedent for that sibling tool) — a foreign read still resolves (`state`, `passed`/`outcome`, timing/concurrency fields all survive), only the payload fields above lose their content.

## §1 Do not

- Do not represent cross-project redaction here as a bare `string | undefined` — use the `redactCrossProject` wrapper object, kept distinct from `scopeProjectId`'s own filtering.
- Do not add a separate branch or sentinel value for an unresolved caller project or a legacy `projectId:null` row — the plain `!==` comparison against `redactCrossProject.callerProjectId` already fails safe (redacted) for both.
- Do not redact `outputFile` while leaving `outputTail`/`gateDetail`/`steps` unredacted on the same unscoped manager path — all four are the same field class (ways to read another tenant's gate output/diagnostics) and must get the same treatment.

## §1 Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`gateStatus`): lines 5072-5082, as of commit `6faf27824c7f550d57bfdeb9e4724c7070b82315`. Relocated by card `5b8d2b0c`; no wording changed.

## §2 — `orchestration.ts`'s `registerGateStatus` call site: unscoped by design, deliberately including `deploy`-kind opIds

### Narrative

This call site (the manager MCP surface's `registerGateStatus` registration) is UNSCOPED (`scopeSessionId`/`getScopeProjectId` both omitted) — a manager can resolve ANY project's settled op by opId (see `gate_status`'s own header doc). `getRedactCrossProjectCallerProjectId` redacts every field `GATE_VERDICT_FIELD_CLASSIFICATION` (an EXHAUSTIVE, COMPILER-ENFORCED classification, not a deny-list) marks `"sensitive"` for a foreign project's row — widened from `outputFile` alone (card a16c580b) to also cover `outputTail`/`steps`/`gateDetail` (round 1) and then `reason`/`commitSubject`/`retriedFile`/`retryWarning`/`emitCompareTestFiles`/`emitCompareNotHermeticExcluded`/`validatedHead`/`headWarning` (round 2, after a code-review probe found those six still leaking) — see §1 above for the full mechanism. Structural fields (`passed`/`outcome`/`gateType`/timing/concurrency) stay visible — a targeted redaction, not a refusal.

DELIBERATE (owner-reviewed), not an oversight: this SAME call site also serves `deploy`-kind opIds (a manager on another project polling a `deploy` op it was handed) — redaction applies uniformly there too, since the comparison is keyed on `t.record.projectId`, not `t.record.kind`. A `deploy` is daemon-global in EFFECT, but that only entitles another tenant to know it ran and whether it failed — never to the deploying tenant's own build output or host paths.

### §2 Do not

- Do not scope this call site to the caller's own project — it is deliberately unscoped so a manager can resolve any project's settled op by opId, with redaction (not refusal) doing the access-control work.
- Do not special-case `deploy`-kind opIds out of this redaction — the SAME uniform treatment applies, since the underlying comparison is keyed on `projectId`, not `kind`.

### §2 Source

Inline comment in `packages/daemon/src/mcp/orchestration.ts` (above the `registerGateStatus` call): lines 4130-4149 (pre-tranche-2 numbering), as of commit `f81f9c1108773e559efe78b7166cbf78b6201480`. Relocated by card `a2278b09` (tranche 2).
