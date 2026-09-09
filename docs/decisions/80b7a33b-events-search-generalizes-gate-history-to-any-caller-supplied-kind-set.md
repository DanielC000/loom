# 80b7a33b — generalize the gate-history page shape to an arbitrary, caller-supplied event-kind set

## Narrative

Card 80b7a33b: `listOrchestrationEventsBounded` is a BOUNDED, kind-filterable, newest-first page of `orchestration_events` across the whole platform (or scoped to one project/session/task), plus the total matching count. It generalizes `listGateEvents`'s own bounded/paginated/JOIN-enriched shape (same project/agent/branch/task-title enrichment, same clamp-and-report-effective-limit contract) to an ARBITRARY caller-supplied `kind` set instead of the hardcoded `GATE_HISTORY_KINDS` — the read that closes the gap a Lead's forensics repeatedly fell back to raw sqlite for: a fleet-down incident isn't limited to gate-run kinds (it may need `kill_switch`/`recycle_begin`/`merge_rejected`/`platform_escalate`/etc.).

The SHARED `eventsSearchQuery` helper (`mcp/eventsSearch.ts`, card `39f79291`, widened to a second caller by card `60c1fff8`) validates `kind` against the real `OrchestrationEventKind` set BEFORE it ever reaches this function, rejecting an unrecognized value with an explicit error instead of letting it fall through to a silent empty page — shared verbatim by BOTH the `events_search` MCP tool on the platform surface (`mcp/platform.ts`) and its manager-surface sibling (`mcp/orchestration.ts`), so neither can drift from the other's validation.

## Do not

- Do not read this function's own zero-rows-on-a-bad-kind behavior as "`events_search` returns `[]` on a bad kind" — that gap is closed one layer up, in the shared `eventsSearchQuery` validator, not here.
- Do not let the platform-surface and manager-surface `events_search` tools validate `kind` independently — both must share `eventsSearchQuery` (card `39f79291`/`60c1fff8`), or the two can silently drift apart.

## Platform config agent-redaction is a fail-open denylist, audited field-by-field (unrelated decision, same card id, `mcp/platform.ts`)

Strip host-secret-adjacent fields from a platform config payload before it reaches an AGENT MCP tool (`platform_config_get`) — the human REST `GET /api/platform/config` returns this same shape UNREDACTED, but the human is the trust boundary there; the agent isn't (same reasoning as the gateCommand/alertWebhook project-config split). Audited every `PlatformConfig`/`PlatformConfigOverride` field (card 80b7a33b): the gateway TOKEN itself is never part of this shape — it's stored in a keyed table, never in config (see `RemoteAccessConfig`'s own doc) — and no other field carries a literal credential. Two fields are still host-path-shaped and stay off the agent surface: `integrations.codescape.path` — DROPPED ENTIRELY. Codescape is a private product with NO user/agent-visible surface anywhere Loom ships (project memory `codescape-is-private-no-user-visible-surface`); `resolveConfig`'s own `ResolvedConfig` already omits `integrations` for the identical reason (card 3bd8ef17 — it flows into the web client bundle), so the RAW override blob — which still carries a human-set value there, validated independently of `ResolvedConfig` — is the one place this tool must not just forward verbatim. `remoteAccess.tls.{certPath,keyPath}` — redacted by `redactRemoteAccessTls`. Host filesystem paths to TLS private-key material; the path string itself isn't the secret, but handing an agent the exact on-disk location of key material is the same shape of exposure `gateCommand`/`obsidian.path`/`python.interpreterPath` are kept human-only for. Every other field (rate-limit numbers, watcher cadences, timeouts, backup/gateRetry tuning, connections bounds, `coalesceAgentMessages`/`companionVoiceEnabled`/`operatorEnabled`/`schedulerEnabled`, the concurrency caps, usage-sample cadence/retention, `updateCheckIntervalMs`, `remoteAccess.enabled`/`bindHost`/`rateLimit`) is plain operational tuning with no credential/secret shape — exposed as-is.

This is a fail-OPEN denylist (spread-everything-else, minus the two fields named above) — correct only as long as no FUTURE secret/host-path field is added to `PlatformConfigOverride` without a matching redaction here.

- Do not add a new secret/host-path field to `PlatformConfigOverride` without adding a matching redaction to `sanitizePlatformConfigForAgent` AND updating `PLATFORM_CONFIG_TOP_LEVEL_KEYS`'s expected list — `test/platform-config-redaction-drift.mjs` fails until both are updated, forcing an explicit redact-or-expose call on the new key (card 07ce7c0c).
- Do not assume a field is safe to expose just because it isn't in the two-field list above — the list was reached by an explicit audit (card 80b7a33b) of every field as of that audit; re-audit before trusting it against a schema that has since grown.

Source (this section only): inline JSDoc in `packages/daemon/src/mcp/platform.ts` (`sanitizePlatformConfigForAgent`'s own doc, lines 361-390 as of this tranche's HEAD, prior to compression). Relocated by card `b721401b` (tranche 1 on `mcp/platform.ts`); NOT the same decision as the db.ts narrative above — the two happen to share a card id.

## Source

Inline comment in `packages/daemon/src/db.ts` (`listOrchestrationEventsBounded`, minus the class-A parameter-binding safety guard left inline): lines 5897-5918, as of this tranche's HEAD.
