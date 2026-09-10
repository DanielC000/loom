# 8e87f3b5 — a session's own pending Request folds into the "nothing else actionable" skip, never short-circuits alone

## Narrative

Card 8e87f3b5 narrowed card `cb56cf80`'s own-Request idle-nudge suppression (see
docs/decisions/cb56cf80-pending-question-idle-suppression-is-session-scoped.md for the session-vs-
agent-lineage scoping half of this same card's fix). Before this card, `idle-watcher.ts`'s manager loop
short-circuited (`continue`) the instant a session had ANY open owner-facing Request of its own — fully
silencing the idle nudge even when OTHER actionable board work sat untouched. Own-Request suppression
should never dominate unrelated dispatchable work.

The fix computes `hasOwnPendingRequest` at the same point as before, but no longer acts on it there —
it folds into the existing `nothingElseActionable` skip alongside `openCards`/`stranded-worker`/
`review-lane`/`undocumented-deferral`, so a session parked on its own Request WITH other actionable work
in play still gets nudged for that work, while one with NO other actionable work stays silently
suppressed (`cb56cf80`'s original intent, preserved for that narrower case). It also OVERRIDES the
"truly empty board still nudges" carve-out: a session correctly parked on its own Request with zero
cards at all is exactly `cb56cf80`'s original "blocked on the owner, stay quiet" case, not a
dropped-the-loop case that should `idle_report 'done'`.

This skip is evaluated AFTER the ESCALATE-INSTEAD-OF-NUDGE block, so a session that slept through its
unanswered-nudge cap still escalates to the human even while its own-Request suppression would otherwise
apply — the escalation is a distinct human-facing signal, never itself gated by this predicate.

Card `275ac184`'s `board_quiet_cause` visibility event (see its own record) later confirmed this is not
an academic distinction: on a real fleet, boards silenced entirely by owner Requests and boards that had
genuinely converged were structurally indistinguishable from outside — this card is what stopped an
owner-gated card from generating nudge pressure in the first place.

## Do not

- Do not short-circuit (`continue`) the moment a session has its own pending Request — compute the flag
  and fold it into the broader "nothing else actionable" skip, so other actionable board work still
  nudges.
- Do not let the escalate-on-unanswered-cap branch be gated by own-Request suppression — escalation is a
  distinct human-facing signal evaluated first.

## Source

Inline comments in `packages/daemon/src/orchestration/idle-watcher.ts` (the own-Request computation
site and the `nothingElseActionable` skip site). As of commit `a7af0d96af9cd0c4545500751a51ba441e6d6340`
("fix(orchestration): narrow when an own Request suppresses the idle nudge"). Relocated by card
`b072e5d4` (tranche 1 on `idle-watcher.ts`).
