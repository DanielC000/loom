# 8d8a3647 — `recycleManager` refuses a session that is itself a currently-unresolved halted successor

## Narrative

Code Review `f643b83a` of `af165ec7` (item 3), reasoned from source, flagged a gap that af165ec7's own
one-hop `isSanctionedHaltedPartner` exemption left open: during an UNRESOLVED halted recycle A->B, nothing
stopped the halted SUCCESSOR B from itself recycling to a brand-new successor C. `recycleManager` only
guarded `hasSuccessor(old)`, and `hasSuccessor(B)` is false (B has no successor of its own yet) — so the
call went through.

### Reproduced, hermetically, before any fix

`packages/daemon/test/recycle-halted-successor-self-recycles.mjs` (see its own git history for the
pre-fix version) proved the full chain against a REAL `Db`+`SessionService` (no real `claude`):

1. A recycles to B with a forced, permanent `reparentWakes` failure — the A->B recycle HALTS
   (`recycle_ownership_transfer_failed` filed, naming B). A and B are both alive; this is the sanctioned
   coexistence window `isSanctionedHaltedPartner(A,B)` already protects.
2. `recycleManager(B, ...)` (no stub) succeeded, unrefused — confirming the premise exactly.
3. B->C was clean (B had nothing of its own to transfer); B reached ready via C and was stopped normally
   by `settleRecycleHandoff` (the ordinary, unrelated path).
4. `currentHaltedSuccessor(A)` still returned B — now itself dead and superseded by C, since B's own
   unrelated recycle never touches A's halt event. `isSupersededByRecycle(A)` read FALSE: A was (wrongly)
   still treated as a live, non-superseded resume candidate.
5. Simulated restart (close + reopen the same `LOOM_HOME`'s `Db`): `isSanctionedHaltedPartner(A,C)` was
   false (A's partner-of-record is B, not C). Resuming C then A: A's resume threw `SecondLiveManagerError`
   naming C. Reverse order (A first, then C): C's resume threw `SecondLiveManagerError` naming A.
   Whichever resumed second was refused — exactly the `fleet_resume_failed` the card described.

### The ruling: refuse, don't widen the exemption into a chain walk

Two options were on the table:

- **(a) Refuse** — `recycleManager` refuses to recycle a session that is ITSELF a currently-unresolved
  halted successor of some other predecessor.
- **(b) Widen the exemption** — extend `isSanctionedHaltedPartner`/`currentHaltedSuccessor` to walk "A's
  halted successor's forward lineage" (a multi-hop chain).

(a) was chosen. (b) directly contradicts af165ec7's own deliberate decision (`isSanctionedHaltedPartner`'s
doc comment: "never a chain walk... a third session anywhere else in the lineage is never exempted by this
function") — reversing it, rather than sidestepping it, would need its own justification. Worse, an eager
"re-point A's halt record at C" variant of (b) doesn't actually bound the problem: if B's own B->C recycle
ALSO halts (a second permanent failure), the lineage grows to three live managers (A, B, C) with two halt
events, and the one-hop invariant has to be re-litigated for every additional hop depth — unbounded
complexity for a failure mode that is already rare and already escalated. (a) keeps the one-hop invariant
exactly as af165ec7 designed it, closes the vulnerability at its root (never let the lineage grow a second
hop while the first is unresolved), and is a small, easily-tested addition right next to the existing
`hasSuccessor`/blank-continuation/barred-project guards in the same function.

### What a context-full B does when the predecessor is LIVE (never a dead end)

The refusal is not a trap in this case. The existing remedy for an unresolved halt is already wired for
exactly the PREDECESSOR side: `recycle_reattempt` (`mcp/orchestration.ts`, calling
`SessionService.reattemptManagerOwnershipTransfer`) is documented as "the PREDECESSOR of a `recycle_me`
that returned `halted:true`'s own remedy." B's refusal message tells B plainly: ask your predecessor to
call `recycle_reattempt` (it received `halted:true` from its own `recycle_me` and is expected to retry
once the failing step is fixed), or escalate to a human/Platform Lead to ask them to do so on A's behalf.
B is never silently stuck in this branch: either the predecessor resolves it, or a human/Lead nudges it to.

**⚠️ RETRACTED, round 2 (Code Review `f643b83a` MAJOR on the round-1 commit `bd1a20e7`): the round-1 text
here used to also say "or (if B itself dies first) the existing `watchHaltedRecycleSuccessor`/boot-reconcile
machinery reclaims everything back onto the predecessor," and round-1's own refusal text told B to
"escalate... e.g. hard-stop it, which triggers the existing automatic reclaim back onto it."** Both claims
are FALSE, and worse, naming them as a remedy actively encourages the thing that traps B — see ROUND 2
below. `watchHaltedRecycleSuccessor`/the reclaim mechanism only ever fires for a SUCCESSOR that dies BEFORE
reaching ready (`recycle-manager-halted-successor-dies.mjs` scenario (A)); it has no branch for a
predecessor dying, and hard-stopping a READY B (`turnSeq>0`) does not reclaim anything at all — it just
leaves B dead too, with NOTHING to resolve the halt. Never repeat this framing anywhere this card is cited.

### Making the refusal durable on the predecessor's side, not just a message to B

A context-full B calling `recycle_me` and getting an actionable error back is necessary but not
sufficient — A (the predecessor who can actually resolve this) has no reason to look unless told. So the
refusal ALSO files a durable, per-episode-deduped notification to A:

- A new audit-only event kind, `recycle_self_recycle_blocked` (`packages/shared/src/types.ts`), filed under
  the PREDECESSOR (`managerSessionId`), naming the blocked session (`workerSessionId` + `detail.
  blockedSuccessorId`).
- A durable nudge to A via the existing `enqueueDurableNudge`, telling A plainly what happened and that
  calling `recycle_reattempt` (or escalating) is what unblocks its successor.
- **Deduped per episode**, keyed on `blockedSuccessorId` (B's own id, a never-reused UUID) — a repeat
  attempt by the SAME still-unresolved B files nothing more and sends no second nudge; once the episode
  resolves (a different successor, or none), a NEW blocked attempt gets its own fresh notification.

Both the event-filing and the nudge are wrapped in a single best-effort try/catch
(`notifyPredecessorOfBlockedSelfRecycle`) — this is pure notification, never an ownership-transfer step the
caller's own refusal depends on; a DB or nudge failure must never suppress or soften the throw to B.

### ROUND 2 — the liveness hole: a DEAD predecessor traps B forever

Code Review `f643b83a` on `bd1a20e7` (the round-1 commit) found a CRITICAL regression: round 1's guard
refused `old`'s self-recycle UNCONDITIONALLY whenever `currentHaltedSuccessor(ownPredecessor)` matched,
with no regard for whether the predecessor (A) was still LIVE. If A dies — a crash (its pty killed), a
human/automatic hard-stop, or a kill-then-archive — while A->B is still unresolved, B is trapped forever:

- `currentHaltedSuccessor(A)` keeps returning B (A dying resolves nothing on its own).
- `old`'s recycle is refused by round 1's guard, every time.
- `reattemptManagerOwnershipTransfer(A, ...)` throws `"this session is not live"` — A can never call
  `recycle_reattempt` again, dead.
- At a later boot, `reconcileHaltedRecycleSuccessorsEarly` does nothing: its own pre-check only reclaims a
  halted successor that is itself UNRESUMABLE; B is durably resumable (it's the live, healthy one here), so
  it hits that function's own `continue` and never reaches a reclaim branch at all.
- `watchHaltedRecycleSuccessor`'s in-process watch already returned the instant B reached ready — it has no
  branch for the PREDECESSOR dying, only for the successor dying.

So nothing in the system ever resolves this episode. Reproduced hermetically via all three of the
reviewer's repro methods — killing A's pty directly (crash), `stopSession(A, "hard")`, and kill +
`archiveSession(A)` — see this card's test file scenarios (5)/(6)/(7). **Pre-8d8a3647 (before round 1), B
could still recycle in exactly this shape** — round 1's own guard was a strict regression for a dead
predecessor, not merely an incomplete fix.

**The fix (approved, the reviewer's option (i)):** when `ownPredecessor` isn't live
(`!this.pty.isAlive(ownPredecessor.id)`), `recycleManager` settles the split handoff FORWARD from `old`'s
own side BEFORE deciding, reusing the identical primitives `reattemptManagerOwnershipTransfer`'s own
live-predecessor branch uses: `attemptManagerOwnershipTransfer(ownPredecessor.id, old.id)`,
`attemptPendingQueueCarry(...)`, and — on a clean result — the SAME `recycle_ownership_transfer_resolved`
marker that function's own resolved branch files (never `settleRecycleHandoff`: the predecessor is already
dead, there is nothing live left to stop). Filing that marker makes `currentHaltedSuccessor(ownPredecessor)`
return `undefined` and `isSupersededByRecycle(ownPredecessor)` flip to `true` — the SAME mechanism that
already protects an ordinary resolved/reclaimed lineage from ever being auto-resumed again — so no later
boot or human resume can bring the dead A back alongside a future C. If the forward settle is STILL split
(some step fails again), `recycleManager` refuses — but now with ACCURATE text: it names A, says
`recycle_reattempt` needs a LIVE predecessor, and says a human must RESUME A (e.g. the Sessions UI, or
`POST /api/sessions/:id/resume` — no override flag needed, since `isSanctionedHaltedPartner(A,B)` already
sanctions exactly this pair to coexist live, so an ordinary resume succeeds). It never again suggests
hard-stopping A.

**The human-visible signal, for the still-split-and-dead case:** A has no live pty to receive a session
nudge, so `notifyPredecessorOfBlockedSelfRecycle` (extended with a `predecessorLive: boolean` parameter)
dispatches to a DIFFERENT channel when `predecessorLive` is `false`: a `[loom:orphaned-fleet]`-prefixed
`lastError` banner stamped directly on A's session row, preceded by `db.restoreSession(A.id)` in case A was
archived (an archived row is invisible to every list the banner needs to reach). This is the EXACT same
role-agnostic, session-row idiom this file's own `finishReconcilingRecycleSettles`'s `stampStranded` helper
and `finishReconcilingHaltedRecycleSuccessors`'s "consolidated" branch already use for "no live session to
notify, a human must act" — reused here rather than inventing a new mechanism. The web's `isOrphanedFleet`
(`packages/web/src/lib/attention.ts`) already renders any row matching this prefix on the Overview
attention queue + bell, with zero further wiring. The SAME per-episode dedupe (keyed on
`blockedSuccessorId`) covers both channels — a repeat attempt by the same still-trapped B re-stamps nothing
new (the banner is already there from the first attempt; re-stamping would be harmless but redundant).

**Why `[loom:orphaned-fleet]` even though this isn't literally "a worker outlived its manager":** the exact
prefix is reused purely as the established VISIBILITY mechanism, not because the situations are identical
— this file's own sibling card `a4c5f234` (the halted-recycle "both predecessor and successor dead"
consolidation) already set this precedent, stamping the same prefix on a predecessor for a reason that
also isn't literally "a worker outlived a manager." `isOrphanedFleet`'s own derivation reads only
`processState === "exited"` + the lastError prefix — it has no opinion on WHY.

### ROUND 3 — Code Review `9555e1ef` (narrow re-review of round 2's commit `c175221a`): the dedupe keyed on the wrong axis, the forward settle left no trail, and a deliberate asymmetry needed recording

Confirmed the round-2 Critical (the liveness hole) stayed fixed, but found one MAJOR and one MINOR, plus
settled a product question raised during the re-review.

**MAJOR — the per-episode dedupe ignored `predecessorLive`, so a LIVE→DEAD transition silently lost its
banner while the refusal text kept claiming one was raised.** `notifyPredecessorOfBlockedSelfRecycle`'s
own `alreadyNotified` check (round 2) matched on `blockedSuccessorId` alone. Sequence: B attempts while A
is LIVE (files one event with `predecessorLive:true`, sends the live-channel nudge) → A dies/is archived
→ B attempts again, now DEAD-channel — the dedupe check matches the SAME `blockedSuccessorId` from the
live attempt and returns early as "already notified", so NEITHER `restoreSession` NOR `setLastError` ever
runs. No banner is ever stamped, A is never un-archived if archived — yet `recycleManager`'s still-split
refusal text unconditionally asserted "A `[loom:orphaned-fleet]` banner has been raised on your
predecessor for visibility." Reproduced hermetically (scenario (8)): live attempt, then A killed+archived,
then a second (dead) attempt — pre-fix, no banner and no un-archive, despite the claim.

**Fix:** the dedupe now keys on `(blockedSuccessorId, predecessorLive)` — a per-CHANNEL key, not a bare
episode key. `notifyPredecessorOfBlockedSelfRecycle` returns a `boolean` ("banner confirmed present",
meaningful only when `predecessorLive` is `false`): `true` either because this call just stamped it, or
because an earlier dead-channel attempt for this same `blockedSuccessorId` already did (that banner
persists on the session row — a repeat dead attempt correctly reports it present without re-stamping, so
the dead→dead dedupe scenario (7) already proved stays exactly as deduped as before). `recycleManager`'s
still-split refusal text is now CONDITIONAL on that return value — it only claims the banner was raised
when the call actually confirms it, and says plainly "could NOT be confirmed... escalate to a human/
Platform Lead directly" otherwise, rather than asserting a side effect that may not have happened.

**MINOR — a still-split forward settle filed no durable trail of which steps moved or failed.** Only the
notification (event + banner/nudge) was filed; nothing recorded `failedSteps`/`failedMessageRefs` for the
forward-settle attempt itself. Fixed by filing an event with the SAME shape `recycle_reattempt_failed`'s
own still-split branch already uses — reusing that kind rather than minting a new one, distinguished by a
new optional `detail.source: "forward-settle"` (absent for an ordinary `recycle_reattempt` retry). Checked
against all four exclusion lists (`EVENT_TRIGGER_EVENT_KINDS`/`GATE_HISTORY_KINDS`/`ORCH_ACTIVITY_KINDS`/
`REPORT_RESOLVED_EVENT_KINDS`) — `recycle_reattempt_failed` is already excluded from all four (dfc3b014),
and a new detail field on an already-excluded kind needs no further change there. Filed via
`bestEffortPostSpawn` (pure audit bookkeeping — see `2fd55955`'s own posture for this file's post-spawn
steps), before the notification call, inside the SAME still-split branch.

**Settled product question — a deliberate, accepted asymmetry with `watchHaltedRecycleSuccessor`'s
wait-for-recovery rule (card `91ac2b79`).** `watchHaltedRecycleSuccessor` (the mechanism that watches a
SUCCESSOR after a halt) deliberately waits for crash recovery before reclaiming a successor's fleet when
that successor dies but is durably resumable and `willRecoverAutomatically` says a real resume attempt is
expected — reclaiming a successor that will genuinely come back discards real, completed-turn context
(see that method's own doc). `recycleManager`'s forward-settle branch here does NOT apply the same
wait-for-recovery check to a dead PREDECESSOR: the instant `!this.pty.isAlive(ownPredecessor.id)`, it
settles forward immediately, even for a predecessor the crash-recovery watchdog would auto-resume within
one tick. This is ACCEPTED, not an oversight: the predecessor is the RETIRING side of this handoff — once
the forward settle comes out clean, `isSupersededByRecycle(ownPredecessor)` flips `true` and nothing about
that predecessor is lost that wasn't already being retired by the ordinary (non-halted) recycle path; a
clean settle leaves nothing "split" for a resumed predecessor to come back to. The successor case is
different in kind: there, the thing at risk of being discarded is a COMPLETED TURN'S worth of context on
the session being evaluated for reclaim itself. Here, the predecessor was never going to keep running
past this handoff either way — the only question was whether its outstanding ownership transfer settles
via `recycle_reattempt` (requires it to come back live) or via this forward-settle branch (does not). A
predecessor that WOULD have auto-resumed within a tick, had B not called `recycle_me` first, simply
resolves the handoff the other way instead — no context is lost, no live session is wrongly archived, and
B is not left waiting on a race against the crash-recovery tick for a predecessor it never actually needs
to interact with again. Widening this to wait for recovery would reintroduce exactly the kind of
unbounded-wait dependency round 2 already removed for `recycle_reattempt` itself (09b14f15) — but for a
caller (B) that has no live predecessor to retry against even if it waited.

### Caller audit — every path that can reach `recycleManager`

A full-source grep (`grep -rn "recycleManager(" packages/daemon/src`) finds exactly TWO occurrences in the
whole daemon source: the method's own definition (`sessions/service.ts`) and ONE call site
(`mcp/orchestration.ts`, the `recycle_me` tool handler). There is no automatic/daemon-initiated path that
calls it — no context-ceiling auto-recycle, no crash/boot path, nothing scheduled. `recycle_reattempt`
(`reattemptManagerOwnershipTransfer`) is a SIBLING method that never calls `recycleManager` at all — it
retries ownership-transfer FORWARD on the EXISTING predecessor/successor pair, never minting a third
session — so this guard is structurally unreachable from `recycle_reattempt`, by construction, not by a
role check.

The one real caller, `recycle_me`'s tool handler, already wraps the ENTIRE `recycleManager` call in a
try/catch that converts any thrown `Error` into `ok({ error: message })` — no silent swallowing, no retry
loop, no double-dispatch. Either way the guard throws BEFORE any teardown/insert/spawn of a NEW session
(immediately after the pre-existing `hasSuccessor`/blank-continuation checks, before
`const agent = this.db.getAgent(...)`): a refused B is always left completely untouched as a SESSION — still
live, no successor row ever created, nothing to undo on `old` itself. **Round 2 nuance:** when the
predecessor is dead, the forward-settle attempt (`attemptManagerOwnershipTransfer`) can still reparent
whatever it's able to, even when the OVERALL result is still-split-and-refused — this mirrors
`recycle_reattempt`'s own still-split branch (also a partial-success-then-refuse shape) and is intentional,
not a leak: whatever successfully transfers is strictly more correct than leaving it stranded on a session
that will never again be able to claim it.

## Do not

- Do not widen `isSanctionedHaltedPartner`/`currentHaltedSuccessor` into a multi-hop chain walk to handle
  this instead of refusing in `recycleManager` — see "The ruling" above; it reverses af165ec7's own
  deliberate decision and doesn't actually bound a doubly-halted chain.
- Do not key the guard, or its dedupe, on anything but `old.recycledFrom` + `currentHaltedSuccessor(ownPredecessor.id)?.id === old.id` —
  this is the SAME one-hop predicate `isSanctionedHaltedPartner`/`isSupersededByRecycle` already use; a
  second, independently-derived check would drift from it.
- Do not gate the predecessor-side notification (event + nudge) on the refusal itself succeeding or being
  read by B — `notifyPredecessorOfBlockedSelfRecycle` is called, and must fire, regardless of whatever the
  `recycle_me` tool handler does with the thrown error afterward.
- Do not drop the per-episode dedupe — a context-full B retrying `recycle_me` every few minutes while
  genuinely blocked must not spam its predecessor with a fresh nudge each time. **Round 3: the key is
  `(blockedSuccessorId, predecessorLive)`, never `blockedSuccessorId` alone** — see ROUND 3 below for the
  regression a bare-id key produced (a live-channel notification silently suppressing the dead-channel
  banner once the same predecessor later died while still split).
- Do not add `recycle_self_recycle_blocked` to `EVENT_TRIGGER_EVENT_KINDS`/`GATE_HISTORY_KINDS`/
  `ORCH_ACTIVITY_KINDS`/`REPORT_RESOLVED_EVENT_KINDS` — audit-only, same posture as
  `recycle_ownership_transfer_failed`'s own sibling kinds; checked against all four, none apply.
- Do not re-derive the caller audit by hand later without re-running the grep — if a new caller of
  `recycleManager` is ever added (an automatic context-ceiling recycle, a scheduled path, anything else),
  re-check that it surfaces this guard's throw the same honest way `recycle_me` does, and extend this
  record's caller-audit section rather than assuming it's still exhaustive.
- **Round 2:** do not refuse `old`'s self-recycle unconditionally the moment `currentHaltedSuccessor`
  matches, without first checking `this.pty.isAlive(ownPredecessor.id)` — a dead predecessor can never call
  `recycle_reattempt`, so an unconditional refusal traps `old` forever (the exact regression Code Review
  `f643b83a` found on round 1's own commit, `bd1a20e7`).
- **Round 2:** do not tell B (or write into any refusal text/decision record) that hard-stopping the
  predecessor "triggers the existing automatic reclaim" — it does not, for a ready (`turnSeq>0`) predecessor
  or successor; that framing is retracted above and must never be repeated. The real remedy for a dead,
  still-split predecessor is a human RESUMING it (ordinary resume, no override flag — the pair is already
  sanctioned), never stopping anything further.
- **Round 2:** do not call `settleRecycleHandoff` from the dead-predecessor forward-settle branch — the
  predecessor is already dead; there is no live pty left to stop, and calling it anyway risks acting on a
  session that no longer exists in any meaningful sense.
- **Round 2:** do not invent a NEW human-visible-alert mechanism for the still-split-and-dead case — reuse
  the existing `[loom:orphaned-fleet]` lastError-banner idiom (`stampStranded`/the "consolidated" branch),
  including the `restoreSession` call if the predecessor might be archived, exactly as implemented.
- **Round 3:** do not let `recycleManager`'s still-split refusal text unconditionally claim a banner was
  raised — word it off `notifyPredecessorOfBlockedSelfRecycle`'s own return value, which is the only thing
  that actually knows whether the dead channel ran (or was already satisfied by a prior attempt).
- **Round 3:** do not add a wait-for-automatic-recovery check (mirroring `watchHaltedRecycleSuccessor`'s
  own `willRecoverAutomatically` gate, card `91ac2b79`) to the dead-predecessor forward-settle branch — see
  the "Settled product question" section above for why this is a deliberate, accepted asymmetry, not a gap.

## Source

`packages/daemon/src/sessions/service.ts` (`recycleManager`'s guard — both the live- and dead-predecessor
branches, now also filing a `recycle_reattempt_failed`/`source:"forward-settle"` audit event on a
still-split forward settle — and `notifyPredecessorOfBlockedSelfRecycle`, which carries the
dead-predecessor `[loom:orphaned-fleet]` banner path and now dedupes per-channel, returning whether that
banner is confirmed present). `packages/shared/src/types.ts` (`recycle_self_recycle_blocked`,
`detail.predecessorLive`; `recycle_reattempt_failed`, `detail.source`). `packages/web/src/lib/
attention.ts` (`isOrphanedFleet`, read not modified — the reused visibility mechanism). Test:
`packages/daemon/test/recycle-halted-successor-self-recycles.mjs` (scenarios (1)-(4) round 1; (5)/(6)/(7)
round 2 — crash/hard-stop clean-settle, and kill-then-archive still-split; (8) round 3 — live-then-dead
transition proving the per-channel dedupe fix). See also
`docs/decisions/af165ec7-resume-fork-second-live-manager.md` (the one-hop invariant this guard keeps
true), `docs/decisions/f1969787-recycle-manager-ownership-transfer-retry-and-halt.md` (the halt branch
this guard's precondition reads), `docs/decisions/91ac2b79-*.md` (`watchHaltedRecycleSuccessor`'s
wait-for-recovery rule — the asymmetry round 3 records), and `docs/decisions/a4c5f234-both-dead-halted-
recycle-consolidation.md` (precedent for reusing the `[loom:orphaned-fleet]` banner outside its original
meaning).
