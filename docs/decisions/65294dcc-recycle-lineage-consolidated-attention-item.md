# 65294dcc — surface `recycle_split_lineage_consolidated` as its own web attention kind

## Narrative

From Code Review `21883d96` on `a4c5f234` (finding 3). `a4c5f234` consolidates a halted recycle's
fleet back onto the predecessor P when both P and its successor S1 are dead this boot — stamping a
`[loom:orphaned-fleet]`-prefixed `lastError` banner on P and filing a `recycle_split_lineage_consolidated`
audit event — but neither reaches a human deliberately. The LEAD (gen 409) decided this needs a dedicated
web attention item, not just an accidental side effect.

**Why a separate kind, not just the existing generic ORPHANED FLEET item.** `a4c5f234`'s consolidation
branch deliberately reuses the `[loom:orphaned-fleet]` lastError prefix (mirroring `stampStranded`,
`08c81809`) purely so the banner is visible on the live rail — not because this is the same situation
`isOrphanedFleet` was built for ("a manager/platform exited while it still owned ≥1 live worker"). Reusing
the prefix means P's row ALSO matches `isOrphanedFleet` incidentally. Rendering both would double-signal
the same lineage, so the new `RECYCLE LINEAGE CONSOLIDATED` item (keyed off the actual
`recycle_split_lineage_consolidated` event, which `08c81809`'s sibling `recycle_fleet_stranded_across_restart`
case never files) takes priority and the generic ORPHANED FLEET loop skips any predecessor id already
covered by it.

**Why its own kind-filtered query.** The event is filed under `managerSessionId: predecessorId`, and P is
by construction NOT a live manager (that's the whole premise of landing in this branch) — so the existing
per-live-manager `eventQueries` fan-out (`useAttention`) structurally cannot see it, for the exact reason
card `43084723` already states for `claude_boot_dialog_stuck`/`codex_isolation_gap_disclosed`: a kind filed
under a session that may never be live again needs its own cross-session query, not a per-manager fan-out.

**Why the clearing condition is `isOrphanedFleet(P)` re-checked live, not a second event.** `a4c5f234`'s own
"Do not" list excludes `recycle_split_lineage_consolidated` from `EVENT_TRIGGER_EVENT_KINDS` and friends —
there is no "resolved" counterpart event for this kind, by design (it's a one-shot, idempotent boot-time
bookkeeping marker). Rather than add a new daemon signal (out of scope for this card — "the WEB attention
list only"), the item re-derives "is this lineage still open" from P's own current row on every poll: once
a human resumes P (processState leaves `exited`), archives/deletes P, or a later episode overwrites P's
`lastError` (no longer starting with the orphaned-fleet prefix), `isOrphanedFleet(P)` goes false and the
item disappears on its own — no explicit dismiss needed. This mirrors every other non-dismissable kind in
this file (`isOrphanedFleet`/`isCrashLooped` themselves), which also clear off live session state rather
than a "cleared" counterpart event.

**Residual, accepted:** the Lead's banner names three remedies ("resume this session, reassign its
workers, or start a new manager"). Only the first two (resuming P, or archiving/deleting P once its fleet
is reassigned elsewhere) actually flip `isOrphanedFleet(P)` false. A human who starts a fresh manager and
reassigns P's *workers* without ever touching P's own row leaves this item open indefinitely — same
residual the generic ORPHANED FLEET item already has, not a new gap this card introduces.

**Companion attention-push:** explicitly out of scope per the card — the Lead called that a separate
companion-routing decision requiring Code Reviewer sign-off before merge. This card does not touch
`companion/attention-push.ts`, and the crash path's `manager_crash_resume_failed` resume attempt (the only
other owner signal this lineage produces today) is left firing exactly as `a4c5f234` requires.

## Do not

- Do not render BOTH the generic `ORPHANED FLEET` item and this one for the same predecessor — exclude any
  predecessor id covered by an active `RecycleLineageConsolidatedAlert` from the `isOrphanedFleet` loop.
- Do not fan this event out through the per-live-manager `eventQueries` query — P is not live; give it its
  own kind-filtered query (card `43084723`'s rule).
- Do not add a "resolved"/"cleared" counterpart event to make this clear — `a4c5f234` deliberately omits one
  for this kind; clear it off `isOrphanedFleet(predecessorId)` re-checked live instead.
- Do not touch `companion/attention-push.ts` or any companion-routing path from this card — that is a
  separate, Code-Reviewer-gated decision the Lead carded independently.
- Do not suppress or alter the crash path's `manager_crash_resume_failed` resume attempt — it is required by
  `a4c5f234` and is unrelated to this web-only signal.

## Source

`packages/shared/src/config.ts` (`BROWSER_NOTIFICATION_KINDS` gains `"recycle-lineage-consolidated"`),
`packages/web/src/lib/fleet.ts` (`activeRecycleLineageConsolidatedAlerts`), `packages/web/src/lib/
attention.ts` (`BROWSER_NOTIFICATION_LABELS` entry + `useAttention`'s new query/item + the `ORPHANED FLEET`
loop's exclusion). Tests: `packages/web/test/fleet.mjs`, `packages/web/e2e/recycle-lineage-consolidated-
attention.spec.ts`. Landed by card `65294dcc`.
