# af165ec7 — resume() and forkSession close 0368c784's remaining second-live-manager doors

## Narrative

0368c784 guarded `startNew`/`startManager` against minting a second live-or-starting manager for one
agent (`refuseSecondLiveManager`). Its own decision record named two doors it deliberately left open:
`resume()` of an exited, non-recycled manager while a different manager of the same agent is already
live (reachable via the event-trigger/webhook/poll wake-mode fire() sites, `wake_me` due wakes, the crash
watchdog, boot's `resumeFleetOnBoot`/`recoverCrashOrphanedWorkers`, the companion `session-steer` lever,
and manual REST `/resume`/`/restore`), and `forkSession` of a live manager (which carries `role:
src.role` forward, minting a second live row exactly like a fresh spawn).

Both doors are closed here. The investigation (`85bcfbe0`), the fork correction, and the four
failure-bucket verifications are recorded in the card's own history, not restated here.

## resume() — unconditional, with exactly one exemption

`resume()` calls `refuseSecondLiveManagerUnlessHaltedPartner(session)` (sessions/service.ts) for
`role === "manager"` only, immediately after the existing `pty.isAlive` short-circuit — before the
codex/transcript/cwd checks, before `isSupersededByRecycle`, and **never gated by `opts.allowSuperseded`**.

`allowSuperseded`'s documented scope is overriding recycle-RETIREMENT bookkeeping (a human deliberately
resurrecting a retired/recycled row to inspect or recover it) — it is not, and must never become, "I
accept minting two live managers." Conflating the two would let a deliberate recycle-override reopen
0368c784's exact bug. This is reversible for a human: stop the live holder first, then the same
`allowSuperseded` resume succeeds (see `resume-refuses-retired-recycle-successor.mjs`'s restructured test
(3), and the REST 409 mapping below).

### The one exemption: a session's own still-unreconciled halted-recycle partner

`isSanctionedHaltedPartner(db, a, b)` (`orchestration/crash-orphaned-workers.ts`) is the only carve-out.
Two sessions are exempted from each other's refusal when, and only when, one is CURRENTLY the other's
unresolved halted-recycle successor — the exact state cards f1969787/386e4eb5/08c81809 built and protect:
a halted recycle's predecessor is deliberately kept live, and its successor may independently reach ready
and also be live, until a human or `recycle_reattempt` reconciles the split. `resumeFleetOnBoot` and
`recoverCrashOrphanedWorkers` legitimately resume BOTH halves of such a pair across a restart today —
three pre-existing tests prove it
(`recycle-fleet-resolved-after-halted-boot-reconcile.mjs`, `resume-arms-halted-successor-observer.mjs`,
`recycle-manager-halted-successor-dies.mjs`), and a literal, unconditional "unrelated-manager" refusal
broke all three before this exemption existed.

**A durable marker for this state already exists — `isSanctionedHaltedPartner` reuses it, never a new
one.** `currentHaltedSuccessor(db, predecessorId)` (0368c784/386e4eb5's own predicate, already consulted
by `isSupersededByRecycle`) returns the predecessor's current successor ONLY while the LATEST event among
`{recycle_ownership_transfer_failed, recycle_ownership_transfer_resolved}` filed under the predecessor is
`recycle_ownership_transfer_failed` — i.e. "halted, and still unresolved, right now." A
`recycle_ownership_transfer_resolved` (filed by a successful `recycle_reattempt`) or a clean reclaim
(which unlinks `recycled_from` outright) both make it return `undefined`. `isSanctionedHaltedPartner`
checks this in BOTH directions (either session could be the one calling `resume()`):

```ts
export function isSanctionedHaltedPartner(db: Db, a: Session, b: Session): boolean {
  return currentHaltedSuccessor(db, a.id)?.id === b.id || currentHaltedSuccessor(db, b.id)?.id === a.id;
}
```

**One hop only, never a chain walk.** `currentHaltedSuccessor`/`db.getSuccessor` only ever follow the
DIRECT successor link — there is no transitive walk anywhere in this predicate, so a third session
elsewhere in a longer lineage (or any unrelated manager) is never exempted by construction, not by a
role/id check bolted on afterward.

**This one-hop invariant depends on the lineage never growing a second hop while the first is still
unresolved — card 8d8a3647 is what keeps that true.** Code Review f643b83a found that nothing originally
stopped a session that is ITSELF the live, unresolved halted successor of some predecessor (B, named by
`currentHaltedSuccessor(A)`) from recycling again to a brand-new successor (C): `recycleManager` only
guarded `hasSuccessor(old)`, never "am I someone else's still-unresolved halted successor". B's own
B->C recycle never touches A's halt event, so `currentHaltedSuccessor(A)` kept naming the now-dead,
superseded B forever, and `isSanctionedHaltedPartner(A, C)` was false — on the next restart, A and C were
both captured as resume targets and whichever resumed second was refused with `SecondLiveManagerError`.
8d8a3647's fix refuses the B->C recycle itself (in `recycleManager`, before any teardown/spawn), closing
the hole at its root instead of teaching this predicate to walk a chain — see
`docs/decisions/8d8a3647-halted-successor-self-recycle-guard.md` for the full repro + fix.

### Why a RECONCILED or ORDINARY (never-halted) pair gets no exemption

An ordinary (never-halted) recycle structurally cannot have both halves live at once in steady state:
`settleRecycleHandoff` stops the predecessor the instant the successor reaches ready, or reclaims the
fleet back onto the predecessor (archiving the successor) if the successor dies first — at most one side
is ever alive once settle completes. A RESOLVED halt (a successful `recycle_reattempt`) stops the
predecessor too, via the same `settleRecycleHandoff` call, fire-and-forget. So the only way a caller could
ever observe BOTH an ordinary/resolved predecessor and its successor simultaneously alive is a narrow,
already-accepted transient window (the handoff itself, before settle fires) — during which `resume()`
never reaches this check at all, because the `pty.isAlive` short-circuit returns first for whichever row
is already alive. Outside that window, an ordinary/resolved pair has at most one live side, so there is
nothing for the exemption to even apply to — and `isSanctionedHaltedPartner` correctly returns `false` if
asked anyway (proven directly in `resume-halted-partner-exemption.mjs` scenario (b), including a RED proof
that a widened "any lineage, any state" rule would wrongly say `true`).

### Refusing the right session when the exemption doesn't cover everyone

`refuseSecondLiveManagerUnlessHaltedPartner` is two-pass, never one-pass-and-stop:

```ts
private refuseSecondLiveManagerUnlessHaltedPartner(session: Session): void {
  const holder = this.findLiveManagerForAgent(session.agentId, [session.id]);
  if (!holder) return;
  if (!isSanctionedHaltedPartner(this.db, session, holder)) throw new SecondLiveManagerError(holder.id);
  const other = this.findLiveManagerForAgent(session.agentId, [session.id, holder.id]);
  if (other) throw new SecondLiveManagerError(other.id);
}
```

A first-found holder that IS the sanctioned partner is excluded and the scan runs AGAIN — so a third,
genuinely unrelated live manager for the same agent is still refused even while the sanctioned partner is
present (proven in `resume-halted-partner-exemption.mjs` scenario (c), including a RED proof that a
widened ONE-PASS "stop at the first partner match" rule would wrongly find nobody to refuse at all).

`findLiveManagerForAgent` (the scan `refuseSecondLiveManager` already used) was widened from a single
optional `excludeSessionId` to an `excludeSessionIds: readonly string[]` array to support the two-pass
exclusion — byte-identical for every existing caller, which passes zero or one id.

## forkSession — no exemption, by design

`forkSession` calls `refuseSecondLiveManager` **VERBATIM** — the unmodified 0368c784 helper, no exclusion
array, no halted-partner awareness — right after its existing `managerSessionBarredFrom` check. This is
deliberate, not an oversight:

- A fork's source is normally the session itself, ALIVE (the whole point of forking a live conversation).
  The unqualified scan finds the source itself as the holder and correctly refuses — "stop the live
  manager `<id>` before forking it" (re-thrown as `ForkLiveManagerError`, a distinct typed class from
  `SecondLiveManagerError` because the generic message's "...before starting another" wording doesn't fit
  a fork; same `holderSessionId` field, same REST 409 shape).
- Forking an EXITED manager source is unaffected by this card (forkSession never checked `pty.isAlive` and
  still doesn't) and is refused only if a DIFFERENT manager is live for the same agent — exactly
  `refuseSecondLiveManager`'s existing, unwidened behavior.
- A halted-partner exemption would have no sane meaning for fork in the first place: forking a manager
  that happens to BE one half of an unreconciled halted pair would carry that role forward onto a THIRD
  row for the same agent (the fork), which is never sanctioned no matter what state the original pair is
  in — fork was never part of the coexistence window 386e4eb5/f1969787 protect, and extending the
  exemption to it would reopen exactly the bug 0368c784 (and this card's own fork half) exists to close.

`startNew`/`startManager` also call `refuseSecondLiveManager` verbatim, unchanged — they mint a session
that does not exist yet, so there is no self-match to begin with and no coexistence window to protect.

## The REST 409 mapping

`/api/sessions/:id/resume`, `/fork`, and `/restore` (which routes through `resume({allowSuperseded:true})`)
each map their new typed error (`SecondLiveManagerError` / `ForkLiveManagerError`) to an honest 409 naming
the holder (`{error, holderSessionId}`), mirroring the existing `/api/agents/:id/sessions` route's own
0368c784 mapping. `gateway/server.ts`'s wiring of `WebhookIngressDeps.resolveWakeTarget` is `typeof`-guarded
(not a bare arrow calling `deps.sessions.resolveWakeDeliveryTarget`) so a hermetic test's hand-built
`sessions` stub that never implements the new method keeps working, exactly like every other optional dep
in this wiring.

## The wake-mode redirect

`SessionService.resolveWakeDeliveryTarget(targetSessionId)` is the non-refusing counterpart for the three
wake-mode `fire()` sites (event-trigger/webhook/poll): when the stored target isn't alive and a DIFFERENT
live manager now covers the same agent, it redirects delivery there instead of resuming (and now being
refused for) the stale target — UNLESS that live manager is the target's own sanctioned halted-recycle
partner (`isSanctionedHaltedPartner`), in which case resuming the target directly is itself allowed
(`resume()`'s own exemption covers exactly that pairing), so it falls through to `resume(targetSessionId)`
instead of redirecting to the wrong half of a still-unresolved pair. The real rule is thus: redirect to
ANY other live manager of the same agent, EXCEPT the target's own sanctioned halted partner — ordinary
recycle targets never reach this at all (recycle already reparents these targets via
`reparentEventTriggerTargets`/`reparentWebhookTargets`/`reparentPollJobTargets`), so in practice the
redirect fires for a target superseded by an ordinary fresh start. The caller files a durable
`wake_target_redirected` event (`source`, `originalTargetId`) on an actual redirect so it is never silent.
Factored out of `refuseSecondLiveManager`'s own scan as `findLiveManagerForAgent` so there is exactly one
definition of "a live manager for this agent" shared by the refusal and the redirect.

Each of the three callers nests the redirect/resume decision INSIDE its own existing `deps.pty.isAlive()`
check, never as a sibling branch that replaces it — `resolveWakeDeliveryTarget` reads `this.pty.isAlive`
(SessionService's own internal pty), which can diverge from a hermetic test's independently-stubbed
`deps.pty` (stubbed specifically to skip a real resume without a real spawn); nesting means the caller's
own stub remains the gate, and `resolveWakeDeliveryTarget` is only ever reached once that gate has already
said not-alive (`webhook-enqueue-durable-nudge-wiring.mjs`'s own stubbed-always-alive `pty` is the
regression this ordering fixes).

`wake_me` (`orchestration/wake.ts`) needed no code change — its existing catch already files a `wake_dropped`
event with the real thrown reason, which now includes `SecondLiveManagerError`'s message automatically.
`wake_me`/`WakeService` never call `resolveWakeDeliveryTarget` at all — a wake fires against `wakes.session_id`,
a row OWNED by the session it belongs to (cascade-deleted with it, `db.ts`'s per-session FK cascade doc), not a
standing human-configured target like the three row kinds below; it has no analogous staleness to fix.

## The wake-mode redirect, made durable (card 162eba4b)

Code Review `f643b83a` (item 7) found that the redirect above was never durable: none of the three `fire()`
sites wrote the resolved holder back onto the row they fired from, so every later fire re-ran the same
redirect and re-filed `wake_target_redirected` under the (same) holder, and — the actual bug — once that
holder itself exited, the next fire fell back to resuming the ORIGINAL stale `targetSessionId` instead of
whatever now-live manager had actually superseded it.

**Fix: `resolveWakeDeliveryTarget` itself durably retargets, at the single chokepoint, inside the actual-
redirect branch only.** Immediately before returning `{sessionId: holder.id, redirectedFrom: targetSessionId}`,
it calls a new private `retargetWakeRows(targetSessionId, holder.id)`, which runs the SAME three DB methods
recycle already calls unconditionally at every recycle/revive site — `reparentEventTriggerTargets`/
`reparentPollJobTargets`/`reparentWebhookTargets` (`db.ts`) — wrapped in one best-effort try/catch so a DB
failure here can never break the delivery that already landed on `holder.id`. All three run unconditionally
regardless of which table actually owns the row that fired (an `UPDATE … WHERE … = oldId` against a table
with no matching row is a no-op) — this is deliberately the SAME pattern `recycleManager`/
`settleRecycleHandoff`/the platform-lead recycle/the worker-revive path already use, not a new one: no
caller needs to tell `resolveWakeDeliveryTarget` which of the three row kinds it was called for.

**Every production caller of `resolveWakeDeliveryTarget` is enumerated, by symbol, not assumed:** the
function is reached ONLY via the `resolveWakeTarget` indirection wired at exactly three places —
`PollServiceDeps.resolveWakeTarget` (`index.ts`, wiring `PollService`), `EventTriggerServiceDeps.resolveWakeTarget`
(`index.ts`, wiring `EventTriggerService`), and `WebhookIngressDeps.resolveWakeTarget` (`gateway/server.ts`,
wiring the webhook ingress route) — each a direct `(id) => sessions.resolveWakeDeliveryTarget(id)` with no
indirection in between. There is no fourth caller anywhere in `src/` (`wake_me`/`WakeService` is NOT one —
see above). The retarget is correct for all three by construction, not by auditing each one separately: it
only ever runs inside the branch that has already confirmed `targetSessionId` is not alive AND `holder` is
the live session THIS SAME call is about to return as `sessionId` — so whichever of the three callers
invoked it, the row is always retargeted to exactly the session the wake was just delivered to, never to
some other candidate.

**The halted-partner exemption holds because of WHERE the call sits, not a new check.** `retargetWakeRows`
is called only inside the `holder && !isSanctionedHaltedPartner(...)` branch — the halted-partner
fallthrough (`this.resume(targetSessionId); return { sessionId: targetSessionId };`) returns before ever
reaching it, and the no-holder fallthrough (ordinary `resume()`, nothing superseded) returns the same way.
Neither of those two paths ever retargets a row — proven directly in `resume-wake-redirect.mjs` scenario
(D) (halted partner) and a new negative-control scenario (ordinary resume, no holder): both assert every
row's target column is byte-unchanged afterward.

**Deliberately silent — no new owner-facing notice.** This is the same category of session-identity churn
Loom already resolves silently for the architecturally-identical recycle case: `reparentEventTriggerTargets`/
`reparentPollJobTargets`/`reparentWebhookTargets` are already called unconditionally, with no owner notice,
from `recycleManager`, `settleRecycleHandoff`, the worker-revive path, and the platform-lead recycle path.
The existing `wake_target_redirected` durable event (filed by each of the three `fire()` sites on an actual
redirect, unchanged by this card) remains the audit trail — it is not acceptable to treat a silent DB write
as literally silent in the "no record exists" sense; it is silent only in the "no owner-facing push/notice"
sense, exactly like a recycle reparent. Leaving the row stale (the pre-fix behavior) is strictly worse than
retargeting it: it produces a permanent bounce-back to a target that cannot even be resumed to directly once
superseded.

## Do not

- Do not gate the resume() check on `opts.allowSuperseded` — that flag overrides recycle-retirement
  bookkeeping, never "accept two live managers." A human who needs the escape hatch stops the live holder
  first; the refusal is reversible, not permanent.
- Do not widen `isSanctionedHaltedPartner` to a bare `hasSuccessor`/`recycledFrom` check, ignoring
  halt/resolved state — a reconciled pair would then wrongly keep the exemption forever (proven RED in
  `resume-halted-partner-exemption.mjs` scenario (b)).
- Do not collapse `refuseSecondLiveManagerUnlessHaltedPartner`'s two-pass scan into one pass that stops at
  the first partner match — a genuinely unrelated third live manager for the same agent would then go
  undetected (proven RED in `resume-halted-partner-exemption.mjs` scenario (c)).
- Do not call `refuseSecondLiveManagerUnlessHaltedPartner` from `startNew`/`startManager`/`forkSession` —
  they call `refuseSecondLiveManager` directly, unmodified; none of them has a self-match or a sanctioned
  coexistence window to protect.
- Do not give `forkSession` the halted-partner exemption — forking a live manager is refused
  unconditionally regardless of lineage state (see "forkSession" above for why this is correct, not an
  oversight).
- Do not widen `findLiveManagerForAgent`'s `excludeSessionIds` call sites beyond what each caller
  genuinely needs to exclude — `refuseSecondLiveManager`'s own callers (startNew/startManager/forkSession)
  pass none; only `resolveWakeDeliveryTarget` and the resume() wrapper pass any.
- Do not route a wake-mode caller's redirect/resume decision through anything but its OWN `deps.pty`
  liveness check first — see "The wake-mode redirect" above for the regression this ordering avoids.
- Do not redirect `resolveWakeDeliveryTarget` to a holder that is the target's own sanctioned halted
  partner — it would wake the wrong half of a still-unresolved pair; fall through to `resume()` instead
  (Code Review f643b83a MINOR, round 2).
- Do not assume this predicate's one-hop design is self-sufficient — it relies on `recycleManager` (card
  8d8a3647) refusing a session that is itself someone's still-unresolved halted successor from recycling
  again. If that guard is ever removed, this file's "one hop only" claim stops being true in practice, even
  though the predicate's own code never changes.
- Do not call `retargetWakeRows` from anywhere but `resolveWakeDeliveryTarget`'s own actual-redirect branch
  (card 162eba4b) — it must never run on the halted-partner fallthrough or the no-holder/ordinary-resume
  fallthrough, or it would retarget a row away from a target that is itself still the right delivery point.
- Do not add an owner-facing notice for this retarget — it is deliberately silent, matching the existing
  recycle-reparent precedent; the `wake_target_redirected` event already filed on every redirect is the
  audit trail, unchanged by card 162eba4b.

## Source

`packages/daemon/src/sessions/service.ts` (`SecondLiveManagerError`, `ForkLiveManagerError`,
`findLiveManagerForAgent`, `refuseSecondLiveManager`, `refuseSecondLiveManagerUnlessHaltedPartner`,
`resolveWakeDeliveryTarget`, `retargetWakeRows`, `resume`, `forkSession`).
`packages/daemon/src/orchestration/crash-orphaned-workers.ts`
(`isSanctionedHaltedPartner`). `packages/daemon/src/gateway/server.ts` (the three REST 409 mappings, the
`registerWebhookIngress` typeof-guarded wiring). `packages/daemon/src/orchestration/event-triggers.ts`,
`packages/daemon/src/orchestration/poll.ts`, `packages/daemon/src/webhooks/ingress.ts` (the redirect
nesting). `packages/shared/src/types.ts` (`wake_target_redirected`). `packages/daemon/src/db.ts`
(`reparentEventTriggerTargets`/`reparentPollJobTargets`/`reparentWebhookTargets`, reused verbatim by
`retargetWakeRows`). Tests:
`packages/daemon/test/resume-halted-partner-exemption.mjs` (new),
`packages/daemon/test/recycle-manager-halted-successor-dies.mjs`,
`packages/daemon/test/resume-refuses-retired-recycle-successor.mjs`,
`packages/daemon/test/setup-session-resume-barred.mjs`,
`packages/daemon/test/manager-session-barred-recycle-resume-rebind.mjs`,
`packages/daemon/test/codex-role-force-start-matrix.mjs`,
`packages/daemon/test/forced-role-resume-retry-safety.mjs`,
`packages/daemon/test/webhook-enqueue-durable-nudge-wiring.mjs`,
`packages/daemon/test/webhook-ingress.mjs`,
`packages/daemon/test/resume-wake-redirect.mjs` (card 162eba4b's durable-retarget scenarios).
See also `docs/decisions/0368c784-second-live-manager-refusal.md`
and `docs/decisions/8d8a3647-halted-successor-self-recycle-guard.md` (the companion guard that keeps this
file's one-hop invariant true in practice).
