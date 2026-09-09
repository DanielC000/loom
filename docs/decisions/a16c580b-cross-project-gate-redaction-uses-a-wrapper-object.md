# a16c580b — Cross-project redaction for gate output/diagnostic fields uses a wrapper object, not a bare optional string

## Narrative

Card a16c580b, widened by card 5ef78900: cross-project REDACTION for the output/diagnostic fields (`outputFile`, `outputTail`, `steps`, `gateDetail`) — see `redactCrossProject`'s own doc above for why this is a wrapper object, not a bare `string | undefined`, and separate from `scopeProjectId`'s FILTERING. `redactCrossProject === undefined` (the worker call site never constructs the wrapper at all) means "nothing to redact" — that path's hard filter already made a foreign project's row unreachable before this line runs. Whenever the wrapper IS present (every manager call), `t.record.projectId` (typed `string | null`) is compared against `redactCrossProject.callerProjectId` (`string | undefined`) — a `string | null` value can never equal a bare `undefined`, so an UNRESOLVED caller project (a failed `db.getSession` lookup) fails safe to `true` (redacted) automatically, with no separate branch or sentinel value needed. The SAME `!==` also correctly redacts the legacy `projectId:null` row for the identical reason.

WHAT'S REDACTED, AND WHY IT GREW (card 5ef78900): originally (card a16c580b) this covered `outputFile` ONLY — an absolute host path into another project's full gate output — leaving `outputTail` (a bounded excerpt of the SAME output) and `gateDetail` (whose `failingTest`/`stderrTail` can name another project's test file/paths verbatim) unredacted on the identical unscoped manager path. That was a real, unintentional gap, not a second deliberate posture: `outputTail`/`gateDetail` are the SAME field CLASS as `outputFile` (all three are ways to read another tenant's captured gate output/diagnostics) and get the SAME treatment now. `steps` (bare `{step,durationMs,status}` timings, no captured output) is lower risk but redacted too for consistency — a `step` label is a verbatim fragment of the OWNING project's configured `gateCommand`, itself project-specific text this caller has no legitimate reason to read cross-project. NOT touched: this is a `redact, don't refuse` fix (mirroring `gate_queue`'s own `redacted:true` precedent for that sibling tool) — a foreign read still resolves (`state`, `passed`/`outcome`, timing/concurrency fields all survive), only the payload fields above lose their content.

## Do not

- Do not represent cross-project redaction here as a bare `string | undefined` — use the `redactCrossProject` wrapper object, kept distinct from `scopeProjectId`'s own filtering.
- Do not add a separate branch or sentinel value for an unresolved caller project or a legacy `projectId:null` row — the plain `!==` comparison against `redactCrossProject.callerProjectId` already fails safe (redacted) for both.
- Do not redact `outputFile` while leaving `outputTail`/`gateDetail`/`steps` unredacted on the same unscoped manager path — all four are the same field class (ways to read another tenant's gate output/diagnostics) and must get the same treatment.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`gateStatus`): lines 5072-5082, as of commit `6faf27824c7f550d57bfdeb9e4724c7070b82315`. Relocated by card `5b8d2b0c`; no wording changed.
