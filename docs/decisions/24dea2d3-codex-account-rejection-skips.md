# Codex real-spawn family skips when codex rejects the account/model (card 24dea2d3)

## Context

The real-codex-spawn family (`CODEX_REAL_SPAWN_BASENAMES`, `test/_codex-real-spawn-lock.mjs`) runs automatically in the merge gate. A host can have a logged-in codex CLI whose ACCOUNT rejects the configured model, e.g. `{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The 'gpt-6-astra' model is not supported when using Codex with a ChatGPT account.","code":"model_not_found"}}`. The existing `codex login status` check passes, the first turn fails, and the gate reddens for hours for a reason no code change can fix.

## Decision

The shared `acquireCodexRealSpawnLock()` preflight (already used by every family member, and already running one `codex exec` probe for the usage-limit skip, card fb119c4c) now also classifies that probe's output with `detectCodexAccountRejection`. On a positive match it prints the loud `WARN  SKIP ...` line with the vendor reason and exits 0. The probe runs before any expensive wait, and its result is cached host-wide with the usage-limit result.

## What skips

Only a PARSED structured vendor error: HTTP status 400, 401 or 403 AND an error code in `ACCOUNT_REJECTION_CODES` (model_not_found, unsupported_model, model_not_supported, not_logged_in, invalid_api_key, token_expired, account_deactivated, account_not_supported).

## What never skips

A timeout, an empty reply, a wrong reply, a 429, any 5xx, a 400 with any other code, unparseable JSON, or prose that merely mentions the message. Those stay real failures, because that is real coverage. The status gate applies even when the code matches (a 429/503 carrying `model_not_found` does not skip).

## Nature of the skip

This is an environment precondition, not a product failure. A skip is not a pass of the codex behaviour; it is surfaced on the runner's WARN channel so the missing coverage stays visible.

## Do not

- Do not widen the match to unstructured text or to any non-4xx-auth status.
- Do not add a per-file copy of this check; the shared helper is the single site.

Tests: `test/codex-usage-limit-skip.mjs` (classifier on the exact captured string and near-misses, plus end-to-end through the real `acquireCodexRealSpawnLock()` with fixture codex binaries). No real-spawn file was run to produce this change.
