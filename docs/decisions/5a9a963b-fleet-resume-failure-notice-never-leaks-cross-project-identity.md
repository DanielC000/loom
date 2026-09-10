# 5a9a963b — a fleet-resume-failure notice never names cross-project identity to a manager requester

## Narrative

Card 5a9a963b fixed two problems in how `resumeFleetOnBoot` tells the requesting session about
OTHER sessions, elsewhere in the fleet, that failed to resume after a `daemon_restart`.

The old wording told the requester to "check `worker_list` across projects" — but `worker_list` is
scoped server-side to the caller's own direct children and can never run cross-project, and the
platform Lead (the one recipient who genuinely has cross-project reach) doesn't even have
`worker_list` on its tool surface (it isn't on `PLATFORM_TOOLS`). The one recipient the old text told
to investigate was structurally unable to follow that instruction.

**Deliberate boundary decision, settled once and not to be re-derived:** a cross-project session
identity — project id, session id, task — must never appear in a PROJECT MANAGER's own notice
(`fleetParenthetical`/`fleetSentence`). Surfacing it would leak another project's internals across an
isolation boundary a project manager has no standing to see; the specimen behind this card would have
disclosed a private Codescape session to a Loom manager. A manager requester therefore gets, at most,
an accurate failure COUNT plus "the Lead has been notified" — never identity, and never an instruction
it structurally cannot carry out.

The platform Lead is NOT bound by that same restriction: `list_all_sessions` already grants it
cross-project visibility, so it is the correct, sole owner of the identifying detail. It is notified
with the full detail (project/session/role/task/in-flight state) via `enqueueDurableNudge`, using the
same role-branching (`reqRole === "platform"` vs. not) this site already uses elsewhere.

A separate, brief re-citation of this same id appears where `resumeFleetOnBoot`'s non-requester
manager/platform branch explains why the Lead is exempt from the `reasonClauseFor` redaction — see
`11b847e1`'s own record for that facet; this record is the primary site for the "check worker_list"
wording fix and the boundary decision itself.

## Do not

- Do not tell a manager requester to "check `worker_list` across projects" — the instrument cannot run
  cross-project, and the platform Lead (who could) doesn't have the tool at all.
- Do not surface cross-project session identity (project id, session id, task) in a PROJECT MANAGER's
  own fleet-resume-failure notice — count plus "the Lead has been notified" is the ceiling for that
  recipient.
- Do not withhold the full identifying detail from the platform Lead — it already has cross-project
  reach via `list_all_sessions`, so withholding here is pure capability degradation with no isolation
  benefit.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts`, above `resumeFleetOnBoot`'s
fleet-resume-failure handling: line 4722, as of this tranche's HEAD (tranche 13). A second,
brief restating mention appears at line 4630 (tranche 13 HEAD), anchored to `11b847e1` there —
see that record's own doc for the facet it covers.
