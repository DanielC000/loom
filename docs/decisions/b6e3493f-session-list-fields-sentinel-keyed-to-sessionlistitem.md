# b6e3493f — `SESSION_LIST_FIELDS` is a compile-time totality sentinel against `SessionListItem`, not bare `Session`

## Narrative

Card b6e3493f: `projectSessionList`'s `full:true` path used to return `full:true` rows unprojected — an OPT-OUT shape that ships every column on a `Session` row straight to the wire, with no build error and no test failure when a new one is added. Every caller of this function (`list_all_sessions` on both `platform.ts` + `setup.ts`, and the auditor's `list_sessions` in `transcript-read.ts`) genuinely feeds it `SessionListItem[]` (enriched with `projectName`/`agentName`, not bare `Session`), so the sentinel is against `SessionListItem` — a bare `keyof Session` sentinel would have silently dropped those two fields on every real caller today, not just a hypothetical future one (contrast `agentView.ts`'s `AGENT_LIST_FIELDS`, where the enrichment is only a future-proofing concern).

`pendingMerge` (optional on `Session`, `PendingMerge | null`) is included here rather than excluded like `orchestration.ts`'s `SESSION_ROW_FIELDS` does for `worker_status` — nothing on this path computes or overrides `pendingMerge`, and a DB-sourced row never sets it, so keeping the sentinel genuinely total over `keyof SessionListItem` costs nothing (the resulting `undefined` is dropped entirely by this router's `ok()` envelope's `JSON.stringify`).

`pickFields`, the shared projection helper `SESSION_LIST_FIELDS`/`SESSION_LIST_KEYS` feed into, is exported from `entityRowFields.ts` (also card b6e3493f) so `agentView.ts`/`sessionView.ts`'s `full:true` projections reuse it too, instead of adding two more standalone copies of the same five lines.

## Do not

- Do not narrow this sentinel back to a bare `keyof Session` — every real caller today (`list_all_sessions` on `platform.ts` + `setup.ts`, `list_sessions` on `transcript-read.ts`) feeds it an enriched `SessionListItem`, so a bare `Session` sentinel silently drops `projectName`/`agentName` for real callers today, not just a hypothetical future one.
- Do not exclude `pendingMerge` from this sentinel by analogy with `orchestration.ts`'s `SESSION_ROW_FIELDS` (which excludes it for `worker_status`) — that exclusion is specific to `worker_status`'s own reasons; nothing on this path computes or overrides `pendingMerge`, so including it here costs nothing.

## Source

Inline comment above `SESSION_LIST_FIELDS` in `packages/daemon/src/mcp/sessionView.ts`, lines 79-93, as of commit `97b272a0`. Relocated by card `bbb9c6a1` (tranche 1).
