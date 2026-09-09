# f88e91f0 — agent-lineage question pull sees a predecessor's decisions

## Narrative

Bug f88e91f0: a fresh (non-recycle) successor on the same agent could not see decisions its predecessor had filed. `reparentQuestions` only rewrites a row's `session_id` on the RECYCLE path — a manual stop + fresh spawn leaves an answered question pointing at the dead predecessor session id, unreachable from `pullAnsweredQuestions(newSessionId, …)`. `pullAnsweredQuestionsForAgent` fixes this by joining through `sessions.agent_id` instead of one exact session id — a session row persists after exit (only `deleteSession`, which cascades its questions away first, removes it), so the join still finds the predecessor's row.

KNOWN LIMITATION (CR, non-blocking): agent-lineage reachability is bounded by the predecessor session row surviving. If `deleteSession` garbage-collects the exited predecessor before a successor ever pulls, its still-'answered' question is cascade-deleted right along with it (the FK on `questions.session_id` enforces this — see `question-orphan-no-successor.mjs`). Not a regression: before this fix the question was ALREADY unreachable from a fresh successor even with the row intact; this only narrows the window where recovery is *possible* down to "the predecessor row hasn't been GC'd yet," rather than closing it further. Both recycle paths — `recycleManager` and `recyclePlatformLead` — are immune: each calls `reparentQuestions`, which moves the row onto the successor's own session_id, so neither is ever at the mercy of the predecessor row's lifetime (card bb4ff73e added the call to `recyclePlatformLead`, which had silently omitted it — its own comment only named the worker re-parent as missing).

## Do not

- Do not scope this pull by `project_id` — a project can run more than one manager/Lead concurrently (e.g. the Platform Lead's reserved project), and project-scoping would let one Lead's pull consume a sibling Lead's still-pending decision.
- Do not assume `deleteSession` GC and agent-lineage reachability are independent — a GC'd predecessor row takes its still-answered questions with it (cascade FK), narrowing but not (pre-existing) creating this gap.

## Source

Inline comment in `packages/daemon/src/db.ts` (`pullAnsweredQuestionsForAgent`'s doc comment). Relocated by card 4044e834 (tranche 2 on `db.ts`); no wording changed beyond joining wrapped lines.
