# 54434e27 — survive a crash between a halted recycle's reparent and its banner/archive/event

## Narrative

Found by Code Review `21883d96` on `a4c5f234` (finding 5). `reconcileHaltedRecycleSuccessorsEarly`
(`sessions/halted-recycle-reconcile.ts`) durably nulls the successor's `recycled_from` and reparents its
workers/wakes/questions/event-trigger/poll-job/webhook/pending-owner-message onto the predecessor P as
its FIRST act when classifying a lineage `recovered` or `consolidated`. That reparent makes
`db.hasSuccessor(P)` false immediately. The later phase
(`SessionService.finishReconcilingHaltedRecycleSuccessors`) — which archives the dead successor,
restores/banners P (consolidated) or files the recovery event (recovered) — runs ~1300 boot-lines later,
once `SessionService`/`PtyHost` exist. If the daemon dies in between, the next boot's early-phase loop
hits `if (!db.hasSuccessor(predecessorId)) continue;` at its very top and skips the lineage entirely
forever: P stays archived, silent, no banner, no event, and its workers sit on it with nobody told.

`08c81809` (round 3, finding 4) fixed the structurally identical gap on the ordinary (non-halted) settle
path with a durable marker (`recycle_settle_pending_for`) set atomically with the reparent and cleared
only by the later phase, on success, as its LAST statement. This card mirrors that exact pattern one
level down the recycle-recovery stack.

## Mechanism

**Marker**: a new nullable `halted_recycle_pending_for TEXT` column on `sessions`, stored on the
PREDECESSOR row only, holding the successor's id — byte-for-byte the same shape/placement as
`recycle_settle_pending_for`. Never exposed on `Session`/`toSession` (same as its precedent).

**Write + atomicity**: `Db.reparentHaltedRecycleLineage(freshId, predecessorId)` wraps the
`recycled_from`-null (if still linked) + all 7 existing reparent calls + the marker UPDATE in ONE
`this.db.transaction()`. This is the load-bearing fix, not merely the marker's existence: a crash
mid-sequence either leaves NOTHING changed (`hasSuccessor` still true — discoverable via the EXISTING
`recycle_ownership_transfer_failed`-driven loop) or EVERYTHING changed INCLUDING the marker (discoverable
via the new `listHaltedRecyclePending()` loop) — no partial-reparent-no-marker state is possible. Setting
the marker any later than this call (e.g. as a separate statement after some reparent calls already ran)
would reopen exactly the gap this card closes, only worse (a partial reparent with no trace at all).
Pinned by test scenario (F6): a stubbed `reparentWebhookTargets` throw mid-transaction leaves the worker
still on the dead successor, `recycled_from` still linked, and NO marker at all.

**Read + continuation**: `reconcileHaltedRecycleSuccessorsEarly` runs a NEW loop over
`db.listHaltedRecyclePending()` FIRST, before its existing `listWorkerSessionIdsWithEventKind`-driven
loop (which can never rediscover a marker-pending lineage on its own — `hasSuccessor` reads false the
instant the reparent nulled `recycled_from`). For each pending row it re-derives the bucket FRESH from
CURRENT `isDurablyResumable(predecessor)` — never trusting a stale decision, mirroring the posture
`reconcileStrandedRecycleSettlesEarly` already uses for its own `deferred`/`stranded` buckets — and
re-runs `reparentHaltedRecycleLineage` (idempotent: every step moves zero rows on a pure continuation,
same "always redo, 0 is fine" precedent `reconcileStrandedRecycleSettlesEarly` already relies on for its
own `recovered` branch).

**Clear**: only `finishReconcilingHaltedRecycleSuccessors`, in each of the `recovered`/`consolidated`
branches — after the banner/archive/event has actually happened, never before. The completion EVENT
append and the marker clear are now ONE transaction (`Db.finishHaltedRecyclePending`, Code Review round
1 m2) — a crash between two separate statements used to leave a COMMITTED event with the marker still
set, which would re-fire a duplicate event on the next boot's retry; see the Code Review section below
for the full fix and its test coverage. Each branch's existing per-row try/catch means a throw anywhere
before that atomic pair leaves the marker set, so the row is retried (not lost) on the next boot. Pinned
by test scenario (F5): a stubbed `unlinkAndArchiveDeadRecycleSuccessor` throw leaves the marker set and
nothing banner/event-stamped; a subsequent run completes it cleanly, exactly once.

**"Exactly once"** falls out structurally: once the later phase's clear succeeds, the row is gone from
`listHaltedRecyclePending()` on every subsequent boot and can never be reprocessed; until that clear,
every boot re-discovers and re-attempts the SAME pending row, idempotently, never losing it.

**NEVER RESURRECT**: `finishReconcilingHaltedRecycleSuccessors` calls `resume()`/
`restoreLiveAfterConfirmedAlive` in NEITHER the `recovered` nor `consolidated` branch (verified by
reading both) — it only archives the dead successor, carries pending messages, appends an event, and
(consolidated only) un-archives P and stamps the banner, never resuming it. The marker-driven
continuation path reuses these exact same completion branches unchanged, and the early-phase
continuation loop itself only re-derives `isDurablyResumable` (a pure DB/filesystem check) — no new
`resume()` call is introduced anywhere by this card, including the staleness check below.

**Banner/event count** (Lead review before implementation; refined by Code Review round 1 n2): the
`consolidated` branch's human-facing `[loom:orphaned-fleet]` banner used to quote the threaded
`reparentedWorkers` return value, which is 0 on a marker-driven continuation (nothing left to reparent) —
misreporting a real, nonzero fleet as "0 worker(s)". Fixed in two steps: first to read
`db.listWorkers(predecessorId).length` at banner time; Code Review then found THAT also wrong even on a
FRESH (non-continuation) boot — by the time this banner is stamped, the crash-path archive backstop
(`snapshotAndArchiveRecovered`, earlier in `runBootRecoveryPrefix`) has already archived a reparented
worker that was live pre-restart, and `listWorkers` filters out archived rows. Now reads
`db.listChildSessions(predecessorId).length` (no archived filter) instead. **n2 wording choice**: rather
than additionally filtering that count to children whose task is still non-terminal (real complexity —
a join through each child's task + the project's resolved terminal column, for a count that is purely
informational in a banner), the banner's noun was changed from "worker(s)" to "child session(s)" — honest
about what `listChildSessions` actually counts (every current child, unconditionally, never scoped to
role or task state) rather than implying a precision the count doesn't carry. The `recovered` branch's
event detail still carries `reparentedWorkers` (audit-only, never shown to a human as a banner count) —
the 0-on-continuation value there is an accepted, narrow residual, same as
`reconcileStrandedRecycleSettlesEarly`'s own precedent for `recycle_fleet_recovered`'s detail.

## Code Review round 1 (`9fe8f672`) — fixed before merge

**m1 — a stale marker could act on a predecessor that has already moved on.** The marker-driven loop used
to process every pending row unconditionally, ALWAYS adding its predecessor to the skip-set that keeps
the event-kind-driven loop from also touching it. If P was later resumed (by any path) and halt-recycled
AGAIN to a brand-new successor S2 — all while S1's marker sat unprocessed, because the early reconcile
only ever runs at boot — the marker loop would still try to complete S1's (stale) decision, AND the
skip-set would wrongly block S2's own, genuinely current, lineage from ever being reconciled by the
event-kind loop. Fixed: `isHaltedRecyclePendingMarkerStale` (halted-recycle-reconcile.ts) treats a marker
as stale when `db.hasSuccessor(predecessorId)` is true (P has a new, active successor) OR P's latest
`recycle_ownership_transfer_failed` event names a successor other than the marker's own `freshId` (a
newer halt has already superseded it, even if THAT successor has since been unlinked too). A stale
marker is cleared WITHOUT acting — no reparent, no bucket push, no event, no nudge, no banner — and its
predecessor is NEVER added to the skip-set, so the event-kind loop is free to reconcile whatever is
actually current. Pinned by test scenario (F4): a marker for S1 is left pending, P is resumed and
halt-recycled to S2 (S2 also dies unresumable) entirely in-process (no reboot), then a real boot
correctly reconciles S2 while clearing S1's stale marker with no event/nudge/banner naming S1 anywhere.

**m2 — the completion event and the marker clear were two separate statements; a re-run had no duplicate
guard.** Fixed: `Db.finishHaltedRecyclePending` appends the completion event (`recycle_fleet_recovered`
or `recycle_split_lineage_consolidated`) AND clears the marker in ONE transaction (see "Clear" above).
Both branches in `finishReconcilingHaltedRecycleSuccessors` additionally check, BEFORE firing anything,
whether a completion event for this exact `(predecessorId, freshId)` pair already exists
(`detail.deadSuccessorId === freshId`) — if so, the event/nudge are skipped and only
`clearHaltedRecyclePending` runs, finishing the cleanup without duplicating the audit trail. The
`recovered` branch ALSO clears a stale banner it finds on the predecessor — left over from a PRIOR boot's
`consolidated` attempt that stamped it before throwing, on a row that THIS boot's fresh
`isDurablyResumable` re-derivation now classifies `recovered` instead. **Round 1 shipped this clear
scoped to a bare `[loom:orphaned-fleet]` substring match — Code Review round 2 (below) found that too
broad and narrowed it.** Pinned by test scenario (F5).

**m3 — two tests the Code Review named explicitly.** (a) A throw anywhere in the later phase's branch
body leaves the marker set and nothing banner/archived/eventful; a subsequent run (same process, or a
genuinely later boot) completes it cleanly, exactly once, with no duplicate event — scenario (F5). (b) A
throw mid-`reparentHaltedRecycleLineage` (a stubbed `Db.prototype.reparentWebhookTargets`) rolls back the
WHOLE transaction — the worker stays on the dead successor, `recycled_from` stays linked, and no marker
is left behind — scenario (F6).

**m4 — the schema-migration guard's legacy fixture.** The original draft built its "pre-migration" DB by
opening a FULLY-migrated DB with THIS branch's `Db` and then physically `ALTER TABLE ... DROP COLUMN`ing
the one new column — faithful for the migration step itself, but one layer short of "this is what a
genuinely pre-card install's `sessions` table looked like." Rewritten (card `54434e27`,
`halted-recycle-pending-schema-migration.mjs`): the legacy fixture is now a GENUINELY BLANK database
holding only a hand-derived `sessions` table — its CREATE TABLE SQL read straight off a reference DB's
own `sqlite_master` (never hand-typed) with just the one new column's definition line stripped —
plus the `projects`/`agents` tables `sessions`' own inline `REFERENCES` clauses need to even PREPARE an
INSERT (this build's SQLite defaults `foreign_keys` ON; FK enforcement itself is turned back off for the
insert, since row-level FK integrity isn't what this test is about). The static check for "no base-schema
DDL references the column" is now STATEMENT-scoped (the whole `SCHEMA` template literal split on `;`,
never a single line) and covers `CREATE INDEX|TRIGGER|VIEW`, not just `INDEX` — a multi-line DDL
statement with the column name on a different line than the `CREATE` keyword is now caught, where the
old line-only scan would have missed it. Both halves were RED-proofed directly: removing the
`SESSION_ADDED_COLUMNS` entry reproduces the exact real crash (`SqliteError: no such column:
halted_recycle_pending_for`); inserting a genuine multi-line `CREATE INDEX ... ON
sessions(halted_recycle_pending_for)` into `db.ts`'s own SCHEMA (placed AFTER the real `sessions` table
definition, so it doesn't also break every fresh-DB build) reproduces that same crash and fails the test.

**m5 — temp-dir cleanup.** `halted-recycle-pending-schema-migration.mjs` now calls
`cleanupPathSync(tmpHome)` (`_tmp-fixture.mjs`) at the end, mirroring `db-legacy-boot.mjs`, instead of a
hand-rolled per-file `fs.rmSync` loop.

**n1 — two checks that claimed to assert the column but didn't.** "halted_recycle_pending_for exists on a
freshly built DB" asserted `db.getSession(predecessorId) !== undefined` (true regardless of the column,
and meaningless anyway since the column is deliberately never exposed on a `Session` projection); "the
column is still there, same single occurrence" asserted `db.getSession(predecessorId)?.id ===
predecessorId` (tests the row's id, not the column at all). Both now read `PRAGMA table_info(sessions)`
directly — the first via a reference DB before stripping, the second checking the column name appears
EXACTLY ONCE after a third re-open (never zero, never duplicated by a mis-guarded repeated `ALTER TABLE
ADD COLUMN`).

## Code Review round 2 (`daf19b4c`) — fixed before merge

**1 — BLOCKING: the recovered branch's banner-clear was scoped to a bare `[loom:orphaned-fleet]`
substring, which ALSO matches `archiveOnExit`'s own real "Resume this session" banner (service.ts, the
automatic-archive-on-exit path) and `08c81809`'s `stampStranded` banner (the ordinary, non-halted settle
path) — both of which stamp lastError with that same tag for an entirely unrelated reason. The recovered
branch would have silently wiped either of those out from under them. Fixed: the clear is now scoped to
THIS mechanism's own exact text, tied to THIS freshId —
`` `A halted recycle's successor ${freshId.slice(0, 8)}` `` — which only the `consolidated` branch's own
banner (above) ever produces. RED-proofed directly: reverting to the bare substring match makes test
scenario (F7a) (below) fail exactly as the bug would predict, restored and reconfirmed green afterward.
Pinned by two new scenarios: (F7a) an unrelated orphaned-fleet banner on P survives the recovered branch
untouched; (F7b) this mechanism's own banner, for the SAME freshId, is cleared.

**2 — the duplicate guard and the atomicity fix were never actually exercised by a test.** (F5)'s own
throw-then-retry shape never put the DB into the actual "a completion event already exists while the
marker is still set" state the guard exists to detect — it only proved "a throw survives, a later run
succeeds," which was already true before round 1 too (the try/catch was pre-existing). Fixed: new
scenario (F5b) pre-seeds a `recycle_fleet_recovered` event for `(P, freshId)` directly, sets the marker
via a real `reparentHaltedRecycleLineage` call, then runs the recovered branch and asserts it finishes
with the marker cleared, STILL exactly one event (no duplicate), and ZERO new `enqueueDurableNudge`
calls (spied directly — see item 4). For the atomicity side specifically: `Db.clearHaltedRecyclePendingStatement`
was split out of `finishHaltedRecyclePending`'s inline UPDATE into its own (private) method purely so a
test could stub JUST that statement to throw — new scenario (F5c) does this and asserts the completion
event the SAME transaction had just appended is ALSO gone afterward, proving the pairing is genuinely one
transaction and not two statements that merely happen to run adjacently. Both RED-proofed: reverting
`finishHaltedRecyclePending` to two separate (non-transactional) statements makes (F5c)'s "event also
rolled back" assertion fail exactly as predicted, restored and reconfirmed green afterward.

**3 — (F4) only ever drove staleness through the `hasSuccessor` disjunct** (P gets a literal new,
currently-linked successor). The OTHER disjunct — a newer halt event, with NO successor currently linked
at all, because that newer successor was ALSO already reclaimed — went unexercised. Fixed: new scenario
(F4b) mirrors (F4) up through the second halt (S1 marker pending, P resumed, halt-recycled to S2), but
then kills S2's pty WHILE P is still alive and waits for the live, same-process `watchHaltedRecycleSuccessor`
reclaim (not a reboot) to unlink S2 and reclaim its fleet back onto P — `hasSuccessor(P)` is FALSE again
at that point, so only the "latest halt event names someone else" disjunct can catch S1's now-doubly-stale
marker. The `isHaltedRecyclePendingMarkerStale` doc comment (halted-recycle-reconcile.ts, right above the
function) is corrected to name this in-process reclaim path explicitly, not just "a later boot's own
reconcile," as the other way a superseding successor can already be unlinked.

**4 — (F4)'s own "M1 was NOT nudged/bannered about S1" checks were vacuous.** One compared against the
FULL `s1.id` (a complete UUID) against text that only ever embeds `freshId.slice(0, 8)` — a check that
can never fail regardless of whether the bug is present, since the full id can never appear in the first
place. The other inferred "no nudge was sent" from `listUnresolvedQueuedMessagesForWorker`, which EXCLUDES
an already-delivered message — not a reliable negative signal either. Fixed: both (F4) and (F4b) now (a)
match `s1.id.slice(0, 8)` — the actual substring the banner/nudge text would embed if the bug reappeared —
and (b) assert directly against a `spyOnEnqueueDurableNudge()` call-argument capture (a thin
`SessionService.prototype.enqueueDurableNudge` wrapper), observing the real call rather than a downstream
side effect that can under- or over-report independently of it.

**5 — documentation.** See "Accepted, narrow residuals" below for the stale-clear's own skipped side
effects, and "Forked-lineage exception" for the two-successor edge case the Code Review raised (no code
added for it — documentation only, per Lead direction). A separate card tracks the deferred
`recovered`-branch nudge's own exposure to being lost across a restart (it is enqueued via
`enqueueDurableNudge`, which is itself durable — but see that card for the specific gap being tracked).

## Accepted, narrow residuals

**A stale-marker clear deliberately does NOT run the later phase's own side effects for the STALE
successor.** When `isHaltedRecyclePendingMarkerStale` fires for (P, S1), the marker is cleared and
NOTHING else happens for S1 specifically — no `carryPendingToSuccessor(S1, P, ...)` re-mint of S1's own
still-unresolved queued messages onto P, and no `unlinkAndArchiveDeadRecycleSuccessor(P, S1)` (S1 is
neither unlinked — it already was, by whichever mechanism made the marker stale — nor archived, if it
wasn't already). This is intentional, not an oversight: by construction, a marker can only become stale
because SOME other mechanism already took over S1's own fate — either a later boot's own ordinary
reconcile reclaimed/consolidated S1 under ITS OWN completion path (which already ran its own
carry/archive), or the in-process `watchHaltedRecycleSuccessor` reclaim did the same, live. Re-running
those side effects here would either be a harmless no-op (the common case) or, worse, double-carry a
message that the OTHER path already carried. The accepted risk is narrow: if S1 somehow became stale
WITHOUT any other path actually completing its own carry/archive (a shape no code path in this system
produces today — see "Forked-lineage exception" below for the one case the Code Review asked to have
named explicitly), S1's own pending queue would stay uncarried. Nothing in the current system reaches
that shape; if a future change introduces one, this residual would need revisiting.

**Forked-lineage exception (two successors)** — raised by Code Review round 2, no code added, documented
only per Lead direction. `recycleManager`'s own `hasSuccessor` guard (checked before starting a NEW
recycle) is what prevents a predecessor from ever genuinely owning TWO live, simultaneously-linked
successors — a structural invariant this card's staleness check relies on without re-verifying it itself.
If that invariant were ever violated (a fork: P linked to both S1 and S2 at once, by some path outside
this card's scope), `isHaltedRecyclePendingMarkerStale`'s own logic would still behave sanely for ONE of
the two lineages (whichever the LATEST halt event happens to name) but has no way to represent, or warn
about, the fork itself — it was not designed to, and extending it to detect/alert on a fork is explicitly
OUT OF SCOPE for this card. Should the single-successor invariant ever need to be relaxed for a real
feature, this staleness check is one of the places that assumption would need to be re-examined.

## Do not

- Do not clear `halted_recycle_pending_for` before the LATER phase
  (`finishReconcilingHaltedRecycleSuccessors`) has actually completed the lineage (archived the dead
  successor, banner/restored P, filed the event) — clear it only on success, in the SAME transaction as
  the completion event (`Db.finishHaltedRecyclePending`), never as an earlier or separate statement.
- Do not set the marker in a separate statement from the reparent calls — they must share ONE
  transaction (`reparentHaltedRecycleLineage`), or a crash between them reopens a partial-reparent gap
  worse than the one this card fixes.
- Do not add a base-schema index, trigger, or view referencing `halted_recycle_pending_for` — `exec(SCHEMA)`
  runs before `migrateSessions()`, so a schema-time DDL statement referencing a migration-only column
  crashes on any upgraded DB that predates it (the exact P0 class fixed by card `b37750a4`'s own
  precedent, `db-legacy-boot.mjs`; RED-proofed directly for THIS column — see Code Review m4 above).
  Lookups against this column are a full-table scan (`listHaltedRecyclePending`), same as
  `recycle_settle_pending_for`'s own `listRecycleSettlePending` — deliberately no index, since the row
  count is always 0 or 1 in practice.
- Do not call `resume()`/`restoreLiveAfterConfirmedAlive` from the marker-driven continuation loop, the
  staleness check, or from either `recovered`/`consolidated` branch of the later phase — NEVER RESURRECT:
  P is only made VISIBLE (consolidated) or left for the ORDINARY automatic resume paths to pick up
  (recovered), never resumed from this path itself.
- Do not trust the threaded `reparentedWorkers` value in a human-facing count — it is 0 on a continuation
  boot by design (idempotent re-run moves zero rows), AND it never accounted for the crash-path archive
  backstop either. Read `db.listChildSessions(predecessorId)` at display time instead, and say "child
  session(s)" — never "worker(s)", which overclaims a role/task-state precision that count doesn't carry.
- Do not add the `pendingPredecessorIds` skip-set entry for a STALE marker row — only a non-stale marker
  (one whose `freshId` still matches the predecessor's current/latest halt) earns the skip; a stale one
  must leave the predecessor free for the event-kind-driven loop to reconcile its real, current lineage.
- Do not re-fire the completion event/nudge without first checking whether one already exists for this
  exact `(predecessorId, freshId)` pair (`detail.deadSuccessorId === freshId`) — a re-run (the marker
  survived a throw after the event already landed) must finish clearing the marker without duplicating
  the audit trail.
- Do not leave a stale banner in place when a predecessor's bucket flips from `consolidated` (a prior
  boot's partial attempt) to `recovered` (this boot's fresh re-derivation) — clear it; a human reading a
  "no automatic owner" banner on a session that was just automatically recovered is actively misleading.
- Do not scope that clear to a bare `[loom:orphaned-fleet]` substring (Code Review round 2 item 1,
  BLOCKING) — that tag is shared by `archiveOnExit`'s own real "Resume this session" banner and
  `08c81809`'s `stampStranded` banner. Scope it to THIS mechanism's own exact text, tied to the specific
  `freshId` in hand: `` `A halted recycle's successor ${freshId.slice(0, 8)}` ``.
- Do not re-run a stale marker's own `carryPendingToSuccessor`/`unlinkAndArchiveDeadRecycleSuccessor` side
  effects when `isHaltedRecyclePendingMarkerStale` fires — whatever OTHER path made the marker stale
  already ran its own completion for that successor; see "Accepted, narrow residuals" above.
- Do not write a test for "no nudge was sent" by inferring it from `listUnresolvedQueuedMessagesForWorker`
  (it excludes an already-delivered message) or by matching a FULL session id against banner/nudge text
  that only ever embeds an 8-char prefix — both are vacuous. Spy on the real `enqueueDurableNudge` call
  directly, and match `freshId.slice(0, 8)`.
- Do not widen `isHaltedRecyclePendingMarkerStale` to detect or alert on a forked lineage (two
  simultaneously-linked successors) — that shape is prevented upstream by `recycleManager`'s own
  `hasSuccessor` guard, and extending this check to cover its violation is explicitly out of scope; see
  "Forked-lineage exception" above.

## Source

`packages/daemon/src/db.ts` (`halted_recycle_pending_for` column + `SESSION_ADDED_COLUMNS` entry,
`reparentHaltedRecycleLineage`, `clearHaltedRecyclePending`, `clearHaltedRecyclePendingStatement`,
`listHaltedRecyclePending`, `finishHaltedRecyclePending`).
`packages/daemon/src/sessions/halted-recycle-reconcile.ts` (`reconcileHaltedRecycleSuccessorsEarly`'s
marker-driven loop + `isHaltedRecyclePendingMarkerStale` + its existing loop's use of the atomic reparent
method). `packages/daemon/src/sessions/service.ts` (`finishReconcilingHaltedRecycleSuccessors`'s atomic
event+clear, duplicate guard, the freshId-scoped stale-banner clear, and the consolidated banner's
`listChildSessions`-derived count). `packages/daemon/src/git/worktrees.ts`
(`CHANGED_TS_TEXT_SCANNER_REPO_PATHS` — the schema-migration test's own statement-scoped SCHEMA-text scan
qualifies for this list). Tests: `packages/daemon/test/recycle-manager-halted-successor-dies.mjs`
scenarios (B2)/(F3) (crash between the early reparent and the later phase, `recovered`/`consolidated`,
plus 4th-boot idempotency), (F4)/(F4b) (m1 / round-2 item 3 — a stale marker via EITHER staleness
disjunct, reconciled correctly against a brand-new successor, nudge/banner checks via a real
`enqueueDurableNudge` spy), (F5)/(F5b)/(F5c) (m2/m3a / round-2 item 2 — a later-phase throw survives and a
subsequent run completes it; the duplicate guard exercised directly via a pre-seeded completion event;
the append+clear transaction's atomicity proven by stubbing just the clear statement), (F6) (m3b — a
mid-reparent throw rolls back fully, no partial state, no marker), (F7a)/(F7b) (round-2 item 1 — an
unrelated orphaned-fleet banner survives the recovered branch; this mechanism's own banner for the same
freshId is cleared); and `packages/daemon/test/halted-recycle-pending-schema-migration.mjs` (the
legacy-DB migration guard, rebuilt per m4, RED-proofed both ways). Landed by card `54434e27`.
