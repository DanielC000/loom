# b13df292 — a self-terminal Request kind gets its own `QuestionState`, never reusing `"answered"`

Code Review round 2 on card 59fa6403 (the Requests→Inbox generalization) came back NOT SHIP — 1 Critical,
2 Major — against Phase 1's original choice to insert a `type:"notice"` row directly as
`state:"answered"` (self-terminal at ask time, since a notice has nothing for a human to answer).

## The defect

Every existing `state === "answered"` reader in the codebase treats that state as a specific, narrow
claim: "the owner answered this, and the asking agent hasn't `question_pull`ed it yet." A notice is not
that — nobody answered it, and nothing is waiting to be pulled. Reusing `"answered"` for it broke three
readers that all rely on that narrow claim being exclusive:

- `IdleWatcher.tickAnsweredStuckQuestions` (via `Db.listAnsweredStuckQuestions`) picked up every notice
  older than 15 minutes and fired a false `[loom:answered-stuck] … call question_pull` nudge at the
  manager — for a row with nothing to pull. Worse, the dedupe Set lives only in memory, so this re-fired
  on every daemon restart.
- `wake-impact.ts`'s `hasUnconsumedAnswer` (consulted by `restart.ts`'s `isNoOpManagerWake`) read `true`
  for a manager holding only a notice, defeating the no-op-wake optimization and producing a wrong
  re-orient message ("you have an answered question awaiting question_pull").
- `mcp/tasks.ts`'s `summarizeTaskRequests` folded a notice into its `answered` bucket, miscounting a
  task's connected-requests summary.

## Do not

- Do not give a new self-terminal Request kind the `"answered"` state, ever — if it needs a FIFTH bucket
  distinct from pending/answered/consumed/cancelled, add a new `QuestionState` member instead (see
  `QUESTION_STATES` in `packages/shared/src/types.ts`) so every existing "answered" reader excludes it BY
  CONSTRUCTION, rather than relying on each reader remembering to special-case the new kind.
- Do not treat "ignored/excluded by default" and "safe" as the same question only for READ paths — a
  reader that legitimately wants to show the new kind (e.g. an inbox list, a history view) must opt IN
  explicitly; the state itself staying out of the narrow buckets is what makes that opt-in safe either way.
- Do not re-derive a bucketed count as `total - (the other known buckets)` once a new terminal state
  exists — `mcp/tasks.ts`'s own prior doc comment on `TaskRequestsSummary` already warned about exactly
  this (a cancelled row was the THIRD state that broke that assumption; a notice is the fourth) — give the
  new state its own explicit, additive bucket instead.
- Do not let the party a rate limit governs raise that SAME limit, even at an elevated/trusted tier — the
  owner ruled `orchestration.maxNoticesPerHour` human-only even on the Platform Lead's own elevated
  `project_configure` (listed in `HUMAN_ONLY_NESTED_PROJECT_CONFIG_KEYS`, `mcp/platform.ts`, NOT the
  Lead-settable `gateCommand`/`alertWebhook` tier), since the Lead is itself the agent lineage the limit
  would otherwise let loosen its own governor.
