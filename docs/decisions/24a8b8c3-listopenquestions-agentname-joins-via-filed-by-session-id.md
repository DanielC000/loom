# 24a8b8c3 — listOpenQuestions.agentName joins via filed_by_session_id, never session_id

## Narrative

Card 24a8b8c3: `listOpenQuestions`'s `agent_name` is joined via `filed_by_session_id` (the IMMUTABLE filer of the question), NOT `session_id` (the mutable routing target `reparentQuestions` rewrites on every recycle) — the same shape card 5b22b262 fixed one layer up, in the UI's `RequestProvenance`. `session_process_state`/`session_resumability` (→ `sessionLive`/`sessionOrphaned`) stay joined off `session_id` on purpose: those legitimately describe the CURRENT seat the question is routed to, not who filed it — a deliberately different join key on the SAME row for two different questions ("who asked" vs "where is it now").

A legacy row with a null `filed_by_session_id` (unrecoverable — see that column's own doc) or a filer whose session/agent was since hard-deleted both naturally yield no match here, falling back to `agentName: "?"` in `toQuestionInboxItem` — never the routed session's agent, which would silently re-create the bug this card fixes.

## Do not

- Do not join `agent_name` via `session_id` — that recreates the exact bug this card fixed: after a recycle, the question would show the SUCCESSOR's agent name instead of who actually filed it.
- Do not apply the same `filed_by_session_id` join to `session_process_state`/`session_resumability` — those two fields are deliberately about the current routed seat, and joining them off the filer would misreport liveness for a reparented question.

## Source

Inline comment in `packages/daemon/src/db.ts` (`listOpenQuestions`'s doc comment). Relocated by card 4044e834 (tranche 2 on `db.ts`); no wording changed beyond joining wrapped lines.
