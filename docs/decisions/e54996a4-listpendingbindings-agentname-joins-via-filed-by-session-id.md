# e54996a4 — listPendingBindings.agentName joins via filed_by_session_id too

## Narrative

Card e54996a4 (same shape as cb7d6998/5b22b262/@decision 24a8b8c3 — see that decision record for the fuller pattern): `listPendingBindings`'s `agent_name` is joined via `filed_by_session_id` (the IMMUTABLE filer), NOT `session_id` (the mutable routing target `reparentQuestions` rewrites on every recycle). `PendingBinding.agentName`'s own doc calls this "the agent whose session asked for the credential (who requested the grant)" — a provenance surface. Unlike `listOpenQuestions`, `PendingBinding` carries no session-liveness/routing field that would want the current seat instead, so there is no competing join to reconcile here — this is a pure provenance read. A legacy row with a null `filed_by_session_id`, or a filer whose session/agent was since hard-deleted, both naturally yield no match, falling back to `agentName: "?"` — never the routing target's agent, which would silently re-create the bug this card fixes.

## Do not

- Do not join `agent_name` via `session_id` — that would show the CURRENT routed session's agent instead of who actually requested the credential grant, re-creating the same class of bug fixed at 24a8b8c3.

## Source

Inline comment in `packages/daemon/src/db.ts` (`listPendingBindings`'s doc comment). Relocated by card 4044e834 (tranche 2 on `db.ts`); no wording changed beyond joining wrapped lines.
