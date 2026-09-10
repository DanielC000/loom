# ba04d607 — the manager-facing and internal escalation classifiers deliberately stay divergent

## Narrative

Escalation status is classified in two different places, on purpose, and they must never be made to
agree:

- **`deriveEscalationStatus`** — the manager-facing `escalation_status` read's FULL classification.
  Below the terminal column it matches `columnEscalationStatus` (`pending`/`in_progress`). Once in the
  terminal column, `resolved` is no longer asserted from the column alone (that was the pre-fix
  defect this card closes) — it's DERIVED from the linked destination task's own git-verified merged
  state (`db.findEscalationTriage` + `getTaskMergedInfo`, the same check `tasks_get` exposes as
  `merged`). No link, or a link whose destination isn't proven merged, reads `triaged`: the Lead
  finished its OWN triage on the Platform board, nothing more is claimed — a `triaged` reading must
  never be misread as "confirmed still broken".
- **`columnEscalationStatus`** — the CHEAP, column-only classification `platformEscalate`'s own
  internal "is there a still-open escalation under this title" dedupe/reuse gate uses. It still
  returns `resolved` straight from the terminal column, unchanged behavior from before this card.
  This is BY DESIGN, not a bug: `columnEscalationStatus` is an internal reuse heuristic never
  reported to a manager, so it doesn't carry the same asserted-vs-derived trust problem the
  manager-facing read does — column-only is the correct, cheap answer for "should I reuse this
  still-open card" here. Keeping it synchronous and narrow also means the write path
  (`platformEscalate`, and its roughly 30 synchronous test call sites) never has to go async just to
  file an escalation.

**Don't make the two agree.** The read path must never assert `resolved` from the column alone (the
defect this card fixed); the write path is fine doing exactly that.

**`triaged` is deliberately NOT lumped in with `resolved`** in the manager-facing "open" list filter
either: it makes no stronger claim than "the Lead acted," and a manager checking in on open work
still wants to see a merely-triaged escalation by default.

## Source

`packages/daemon/src/sessions/service.ts` — `deriveEscalationStatus`, `columnEscalationStatus`, and
the inline "open" filter in `escalationStatus` (extraction tranche 32).
