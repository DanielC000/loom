# 4775165f — page the owner when a recycle lineage is consolidated

## Narrative

Follow-up to `65294dcc` (the web attention item) and `a4c5f234` (the consolidation itself). Before this
card, the only chat page for a both-dead halted-recycle lineage was the ACCIDENTAL crash-path
`manager_crash_resume_failed` → `attention-push.ts` "worker-crashed" push, and only when a reparented
worker also happened to match `deriveCrashOrphanedWorkers`'s own candidate filter. This card gives the
lineage its own dedicated, direct page and removes the now-redundant crash-path one for the predecessors
it actually covers.

**Per-lineage dedupe in `attention-push.ts` — defense in depth, not trust in the source event.** The LEAD
ruling on this card's plan explicitly rejected "the source event fires at most once ever" as a safe
assumption to build the companion push on: in-flight card `54434e27` (landed after this card's plan was
approved) adds its own duplicate-event guard for exactly this event, which means the event's own
single-firing property is no longer something `attention-push.ts` can treat as structurally guaranteed —
it is an implementation detail of a DIFFERENT subsystem that could change again. `consolidatedLineagesSurfaced`
(a `Set<string>`, keyed `` `${predecessorId}|${deadSuccessorId}` ``) is stamped only at actual push time
(mirrors `escalationSurfaced`'s own discipline, and reconstructed the same way on restart via
`seedWatermark`), plus a SEPARATE, same-tick-only `seenConsolidatedLineageKeysThisTick` guard —
discovered necessary by this card's own test: two genuinely duplicate events landing in the SAME
`scanned` window both pass the classify/qualify loop before either one's actual push stamps the
persistent set (the stamp happens strictly after that whole loop finishes), so without the per-tick guard
both would be pushed. The per-tick guard never touches the persistent set early, so it can't reopen the
"not-yet-flushed digest row gets wrongly self-suppressed before ever delivered" hazard the persistent
set's own stamp-at-push-time discipline exists to avoid.

**`consolidatedPredecessorIds` — a new instance-field skip-set on `SessionService`, consulted ONLY from
`recoverCrashOrphanedWorkers`.** Populated in `finishReconcilingHaltedRecycleSuccessors`'s `consolidated`
loop, unconditionally (whether the completion event fired fresh or this was a `54434e27` continuation
clear) — either way this lineage already has (or had) its own dedicated page this boot, so the crash-path's
`manager_crash_resume_failed` attempt for it is redundant. Deliberately a SEPARATE set from
`retiredRecycleSuccessorIds` (keyed on SUCCESSOR ids, a different semantic — "is this id a reclaimed
successor", consulted at other call sites like the queued-message redrive check) rather than merged into
it, to avoid an unintended side effect at those other call sites.

**Why the skip means the worker still lands in `failed`, but the manager does NOT land in `managersFailed`.**
A worker candidate naming a consolidated predecessor as its manager is a REAL, still-existing reparented
child (unlike a worker naming a RETIRED successor as its manager, which is a defunct candidate the existing
`isRetired` check simply drops) — it genuinely isn't live this boot, so it still belongs in `failed`. The
predecessor itself, though, is reported via a NEW `consolidatedSkipped` field, never `managersFailed`:
`managersFailed` is read downstream (`index.ts`'s boot-summary log) as "this manager's own resume attempt
was MADE and failed — check [crash-recovery] logs above for why," which would be actively misleading for a
predecessor whose resume was never attempted at all.

**`resumeFleetOnBoot` is NOT consulted — investigated, not merely asserted.** A consolidated predecessor
is, by construction, already dead THIS boot (no engine id, or a missing transcript, or a missing cwd) —
that is the premise of landing in the `consolidated` bucket at all. `RestartIntent` (what
`resumeFleetOnBoot` resumes from) only exists after a GRACEFUL restart, where none of those three things
spontaneously vanish in the gap between the pre-restart snapshot and the very next boot. No code path was
found that could snapshot a consolidated predecessor into a `RestartIntent` entry; if one is ever found,
this skip-set would need widening to `resumeFleetOnBoot` too, but nothing in today's system reaches that
shape.

**Banner/page count — mirrors `54434e27`'s own `listChildSessions`/"child session(s)" decision exactly,
rather than threading `reparentedWorkers`.** `54434e27` already established (for the predecessor's own
`lastError` banner) that `reparentedWorkers` is unreliable as a human-facing count — 0 on a marker-driven
continuation boot by design, and never accounted for the crash-path archive backstop either — and switched
the banner to `db.listChildSessions(predecessorId).length`, worded "child session(s)" (honest about what
that count actually is: every current child, unconditionally, never scoped to role or task state). The
companion page's own count (`detail.childSessionCount`, added to the `recycle_split_lineage_consolidated`
event at the SAME call site, reading the SAME already-computed `childCount` local the banner uses) follows
that exact precedent rather than re-introducing the bug `54434e27` just fixed under a different name.

## Code Review `a7b6f91a` — fixed before merge

**1 — suppressing `manager_crash_resume_failed` also silently dropped an owner-configured signal, not just
an accidental one.** The crash-path event is a member of `EVENT_TRIGGER_EVENT_KINDS` (a human can wake/spawn
a session off it) and reachable by a project's `orchestration.alertWebhook`; `recycle_split_lineage_consolidated`
was neither. Suppressing the former for an already-consolidated predecessor, with nothing added for the
latter, would silently break a human's own trigger/webhook config the moment this card shipped — a real
regression, not merely a cosmetic one.

- **`EVENT_TRIGGER_EVENT_KINDS`**: `recycle_split_lineage_consolidated` is now a member. This REVERSES
  `a4c5f234`'s own exclusion of this kind from all four lists (`EVENT_TRIGGER_EVENT_KINDS`/
  `GATE_HISTORY_KINDS`/`ORCH_ACTIVITY_KINDS`/`REPORT_RESOLVED_EVENT_KINDS`) — but ONLY from
  `EVENT_TRIGGER_EVENT_KINDS`; the other three exclusions still stand (none of gate-history/orch-activity/
  report-resolution apply to this kind any more than they did before — this reversal is scoped to "a human
  can now configure a trigger off this kind", not to those three unrelated concerns). The reversal is
  itself a direct consequence of this card's own existence: `a4c5f234`'s reasoning ("mirrors every sibling
  recycle_* kind's posture") predates this kind having its OWN dedicated owner-facing role — once it
  became the sole page for a consolidated predecessor (superseding the crash-path's accidental one), it
  stopped being an audit-only bookkeeping marker like its siblings.
- **`orchestration/alert-webhook.ts`**: investigated, no code change needed. The emitter is NOT gated by
  any kind-specific allowlist at all — `alertWebhookSchema` (`mcp/platform.ts`) validates `events` as plain
  strings (`z.array(z.string().min(1))`, by explicit design: "the OrchestrationEventKind union is type-only
  — the emitter just `.includes()`-matches, so an unrecognized kind harmlessly never fires"), and the
  Settings UI's own events field is a free-text textarea, not a curated picker. A human could already type
  `recycle_split_lineage_consolidated` into their webhook config before this card existed, and it would
  already have delivered — this kind was never treated any differently from `manager_crash_resume_failed`
  at this layer. Proven positively (not just read off the code) in
  `packages/daemon/test/alert-webhook.mjs`'s new section: a project configured with
  `events: ["recycle_split_lineage_consolidated"]` receives the POST; an unconfigured one does not.
- **Per-worker detail**: `recycle_split_lineage_consolidated`'s detail now ALSO carries `workers`
  (`{workerSessionId, taskId, reportedState, awaitingReview}[]`, derived via the SAME `deriveAwaitingReview`
  helper every other crash-recovery/boot-resume path already uses) and `workersTruncated` — restoring the
  "a done worker is awaiting your merge" visibility `manager_crash_resume_failed`'s own `detail.workers`
  used to carry, which this card's suppression would otherwise have silently dropped. Scoped to
  `role==="worker"` (the other two fields are meaningless for any other child role) and capped at
  `CONSOLIDATED_WORKER_DETAIL_MAX` (20) so a pathologically large fleet can't grow this event unbounded —
  `workersTruncated` says so honestly rather than silently dropping the tail.

**2 — the mixed case (a consolidated predecessor alongside an UNRELATED crash-orphan in the SAME
`recoverCrashOrphanedWorkers` call) was untested, and so was the skip-set's scoping to the `consolidated`
branch alone.** `recycle-manager-halted-successor-dies.mjs` scenario (F8) now seeds a `consolidated`
predecessor (M1), a `recovered`-bucket predecessor (M_rec, durably resumable), and a genuinely unrelated
crash-orphaned manager (M_crash) in ONE project, runs a real boot, and calls `recoverCrashOrphanedWorkers`
ONCE over the combined candidate set: M1 is skipped as before; M_rec and M_crash both still reach a real
`resumeOne` call (M_rec succeeds, M_crash genuinely fails and still files its own
`manager_crash_resume_failed`). A RED proof directly injects M_rec's id into
`sessions2.consolidatedPredecessorIds` (TS `private` has no runtime enforcement — the same technique
`restart-fleet.mjs` already uses on `retiredRecycleSuccessorIds`) and shows M_rec's own resume attempt gets
wrongly skipped too, proving the test is actually discriminating rather than vacuously passing regardless
of the skip-set's scope.

## Do not

- Do not add `consolidatedPredecessorIds` entries into `retiredRecycleSuccessorIds` — they are different
  semantics (predecessor-already-paged vs. successor-already-reclaimed) and other call sites of
  `retiredRecycleSuccessorIds` (e.g. the queued-message redrive check) assume the latter specifically.
- Do not consult `consolidatedPredecessorIds` from `resumeFleetOnBoot` — no reachable path exists today for
  a consolidated predecessor to be snapshotted into a `RestartIntent`; see the narrative above before
  changing this.
- Do not push a skipped consolidated predecessor into `managersFailed` — that field's downstream log
  wording ("check [crash-recovery] logs above for why") asserts a real attempt was made and failed, which
  is false here. Use the dedicated `consolidatedSkipped` field instead.
- Do not drop the skipped predecessor's real worker candidates from `failed` — unlike a retired-successor
  candidate (defunct by construction), a consolidated predecessor's worker candidates are real and
  genuinely not live this boot.
- Do not stamp `consolidatedLineagesSurfaced` (attention-push.ts) at classification time — stamp it only at
  actual push time, mirroring `escalationSurfaced`. Do not rely SOLELY on that persistent set either — a
  same-tick-only guard is required too, or two duplicate events landing in the same scan window both push.
- Do not thread `detail.reparentedWorkers` into the companion page's own worker/child count, and do not say
  "worker(s)" in that page's alert line — mirror `54434e27`'s `childSessionCount`/"child session(s)"
  wording exactly, for the same reason that record gives.
- Do not add `recycle_split_lineage_consolidated` to `GATE_HISTORY_KINDS`/`ORCH_ACTIVITY_KINDS`/
  `REPORT_RESOLVED_EVENT_KINDS` — `a4c5f234`'s exclusion from those three still stands; only the
  `EVENT_TRIGGER_EVENT_KINDS` exclusion is reversed, and only for the reason given above.
- Do not add a kind-specific allowlist/gate to `orchestration/alert-webhook.ts` or `alertWebhookSchema` for
  this kind (or any other) — the emitter's whole design is kind-agnostic; adding one here would be a
  regression in the OPPOSITE direction (narrowing a mechanism every other kind already relies on being
  unrestricted).
- Do not include a non-`"worker"`-role child in `recycle_split_lineage_consolidated`'s `detail.workers` —
  `reportedState`/`awaitingReview` are meaningless for any other role.
- Do not grow `detail.workers` unbounded — cap it at `CONSOLIDATED_WORKER_DETAIL_MAX` and set
  `workersTruncated` honestly when the real count exceeds it.
- Do not assume `consolidatedPredecessorIds`'s scoping to the `consolidated` branch is self-evidently safe
  without a mixed-case test — scenario (F8) exists because a merge/recovered/unrelated mixture in one
  `recoverCrashOrphanedWorkers` call was previously untested.

## Source

`packages/daemon/src/companion/attention-push.ts` (`classify`/`alertLine` for
`recycle_split_lineage_consolidated`, `consolidatedLineagesSurfaced`/`consolidatedLineageKey`/
`stampConsolidatedLineage`, the same-tick `seenConsolidatedLineageKeysThisTick` guard).
`packages/daemon/src/sessions/service.ts` (`consolidatedPredecessorIds`, `CONSOLIDATED_WORKER_DETAIL_MAX`,
its population in `finishReconcilingHaltedRecycleSuccessors`'s `consolidated` loop alongside the
`childSessionCount`/`workers`/`workersTruncated` detail widening, and its consultation in
`recoverCrashOrphanedWorkers` at both of `isRetired`'s own call sites). `packages/daemon/src/index.ts` (the
`consolidatedSkipped` boot-summary log clause). `packages/shared/src/types.ts`
(`EVENT_TRIGGER_EVENT_KINDS` gains `recycle_split_lineage_consolidated`). Tests:
`packages/daemon/test/companion-attention-push.mjs` (classify/alertLine sanity, the malformed-detail
degrade, an e2e single-push check, the two-identical-events-in-one-tick dedupe test, a different-lineage
discrimination check, a restart-safety re-seed check, and the no-consolidation negative control).
`packages/daemon/test/alert-webhook.mjs` (the positive-demonstration section proving this kind delivers
with zero code change, plus its own negative control). `packages/daemon/test/recycle-manager-halted-successor-dies.mjs`
scenario (F) (flipped: `resumeOneCalls` never includes the predecessor, `consolidatedSkipped` names it,
`managersFailed` does not, the worker still lands in `failed`, and no `manager_crash_resume_failed` is
filed for it) and scenario (F8) (the mixed consolidated/recovered/unrelated case, with its RED proof).
Landed by card `4775165f`.
