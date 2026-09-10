# cb7d6998 — a Requests row's `loomSessionId` is the CURRENT routing target, not provenance

## Narrative

`auditRequestItem` (`packages/daemon/src/mcp/questionTool.ts`) surfaces `loomSessionId` (`Question.sessionId`) on the Platform Auditor's cross-project `requests_list` payload. This field is the CURRENT routing target, not provenance: `reparentQuestions` walks it onto every manager/Lead recycle successor, so it answers "which seat currently owns this," not "who filed it."

A reader wanting the actual filer must use `filedBySessionId` instead (see its own doc, `mcp/questionTool.ts`) — set once at ask time, before any recycle can have run, and never touched again. On a row that predates this field, `filedBySessionId` is `null`, and that history is genuinely unrecoverable, not just unmigrated — there is no way to reconstruct who originally filed such a row after the fact.

## Do not

- Do not read a Requests row's `loomSessionId` as "who filed it" — it moves via `reparentQuestions` on every manager/Lead recycle. Use `filedBySessionId` for provenance instead.
- Do not assume a `null` `filedBySessionId` on an old row can be backfilled — that history is genuinely unrecoverable, not merely unmigrated.

## Source

Inline comment in `packages/daemon/src/mcp/questionTool.ts`, above `auditRequestItem` (lines 395-413, pre-tranche-1 numbering), as of commit `beeeb7c2`. Introduced by commit `708ac98ff` ("fix(mcp): stop reporting a reparented session id as request provenance"). Relocated by card `8691d4a0` (tranche 1).
