# 59489267 — `listQuestionsForAudit` is the audit-scope sibling of `listQuestionsForTask`, non-consuming, unpaginated

## Narrative

Card 59489267: `listQuestionsForAudit` returns every request (any state), newest-first — the backing read for the Platform Auditor's cross-project `requests_list`. It is the audit-scope sibling of `listQuestionsForTask` (one-task-scoped) and is deliberately NON-CONSUMING (never touches `state`/`consumed_at`), same as `listQuestionsForTask`.

Card 988bb585 (follow-up): the SAME read backs the manager's own project-scoped `requests_list` — filters are optional/AND'd, so omitting all of them (no `projectId`) returns the whole platform for the Auditor's use, while the manager surface always passes its own `projectId` so it can never read another project's requests.

`excludeConsumed` (default off, so the Auditor's "no filters returns the whole platform" behavior is unchanged) drops `state:'consumed'` AND `state:'cancelled'` rows UNLESS `state` itself is explicitly set — an explicit `state:'consumed'`/`'cancelled'` always wins, mirroring `listOpenQuestions`'s `includeConsumed` toggle (which folds both terminal states in together too).

`agentId` is NOT a column on `questions` itself (only the asking session carries it), so this LEFT JOINs `sessions` to surface it — a hard-deleted asking session reads `agentId: null` rather than dropping the row. `agentId` is ALSO an optional filter (task f724d65a), matched against that same joined `sessions.agent_id` — the identical AGENT-LINEAGE ownership definition `pullAnsweredQuestionsForAgent` uses (not one exact `session_id`), so `requests_list`'s `mine` scoping stays consistent with what `question_pull` will later find/consume for that same lineage.

Returns every matching row unpaginated (mirrors `list_sessions`: the MCP layer applies the default cap / explicit limit+offset, not this read).

## Do not

- Do not let this read mutate `state`/`consumed_at` — it is deliberately non-consuming, same as `listQuestionsForTask`.
- Do not let the manager-scoped surface omit its own `projectId` — that is what keeps it from ever reading another project's requests; only the Auditor's cross-project surface omits it.
- Do not drop `state:'consumed'`/`'cancelled'` rows when `state` itself is explicitly requested — the explicit filter always wins over `excludeConsumed`.
- Do not filter `agentId` against `questions.session_id` directly — match the joined `sessions.agent_id` via the same agent-lineage ownership definition `pullAnsweredQuestionsForAgent` uses, so `mine` scoping stays consistent with what `question_pull` will later resolve.
- Do not paginate this read internally — the MCP layer owns the default cap / explicit limit+offset, mirroring `list_sessions`.

## Source

Inline comment in `packages/daemon/src/db.ts` (`listQuestionsForAudit`'s doc comment), as of this tranche's HEAD.
