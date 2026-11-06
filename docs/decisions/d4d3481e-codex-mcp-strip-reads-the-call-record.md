# d4d3481e — a codex session's MCP strip reads the per-call record, and shows only what the record carries

Card `d4d3481e`. Code: `packages/web/src/lib/mcpCallRecord.ts`, `components/McpActivity.tsx`. Test: `packages/web/test/mcp-call-record.mjs`, e2e `packages/web/e2e/session-mcp-activity.spec.ts`.

## Why the record, not a second parser

The codex transcript parser (`packages/daemon/src/pty/codex-transcript.ts` `parseTranscriptFile`) keeps message text only and drops every function/tool-call item, so there is nothing in a codex transcript to parse. The daemon already records every Loom MCP call for both harnesses at the answering router (`mcp_call_log`, card `8ef582d0`). A codex session's strip maps those rows into the strip's `McpCall` shape; every other harness keeps reading the transcript exactly as before.

## What the record carries, and what the strip shows

Router, tool, start time, the handler's own duration, outcome class (`ok` / `refused` = returned an `{error}` envelope / `error` = threw or `isError`). No arguments, no answer, no turns. So for a codex session:

- Every call sits in ONE group, labelled "All calls · codex records no turns". No turn numbers, no turn causes.
- Sentences have no object ("Updated card", "Checked worker"); a lead that would hang on a preposition reads as the bare tool name ("Ran decisions_for").
- Durations carry no "≈": they are the router's own measurement, not the transcript-ts approximation.
- The detail says "Arguments and answer aren't recorded for codex calls." and hides "Touched".
- No call is ever `pending` (a row is written after the handler returns).

## Polling

Codex reads `["mcp-calls", id]` at the same `mcpPollInterval` cadence; the transcript query is disabled for codex. A claude session's query is unchanged (same `["transcript", id]` key and cadence) and never fetches the record (`mcpRecordQuery`'s `enabled`).

## Do not

- Do not widen `mcp_call_log` to carry arguments or answers to enrich this strip (`8ef582d0`'s own Do not).
- Do not invent turns for recorded calls (e.g. by bucketing `startedAt` between transcript turn timestamps). That is an inference, and the strip shows facts.
- Do not show "≈" or the "includes hook and harness time" wording on a recorded duration, or the transcript's "refused is a guess" wording on a recorded refusal: each source keeps its own semantics.
- Do not make a claude session fetch the record, or move its transcript query off the shared key.
