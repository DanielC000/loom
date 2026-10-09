# 1e5dd7c4 — a manager recycle's forward transfer onto a stopping successor: REFUSE at the reattempt pre-check, but NEVER gate the shared settle path

## Narrative

Raised as the direct follow-up to `fcf8a0f8` (docs/decisions/fcf8a0f8-reclaim-onto-a-stopping-predecessor.md): that card ruled "reclaim, never refuse" for the dead-successor RECLAIM branch inside `recoverFleetAfterFailedRecycleSuccessor` — refusing there strands the fleet on a confirmed-dead, unresumable successor with no durable trace. This card asks the SAME question — does `isStopping` ever belong as a gate on a manager recycle's ownership handoff — of a DIFFERENT branch of the SAME function (`reattemptManagerOwnershipTransfer`, `sessions/service.ts`): the FORWARD transfer onto a successor that `isAlive`/`hasReachedReady` both pass, but whose own `stop()` is ALSO in flight (`isStopping` true). `fcf8a0f8`'s own binding lesson is to decide by comparing END STATES, not by analogy to the prior ruling.

**This card's own history now has THREE traces, not two** — the first round compared only PROCEED vs. a pre-check REFUSE, missed a third outcome, and shipped a regression that Code Review `d2a1fdcf` caught before merge. All three are recorded below so nobody re-derives the same mistake.

**Why `fcf8a0f8`'s RECLAIM branch and this card's REATTEMPT pre-check are not the same question**, even though both can read `PtyHost.isStopping`:

- `fcf8a0f8`'s RECLAIM branch is asked "is the predecessor still viable" when the fleet's only other candidate owner (the successor) is ALREADY confirmed dead — refusing there means *actively choosing* the worse of two already-committed outcomes (a dead, unresumable M2 over a stopping-but-still-recoverable M1).
- This card's REATTEMPT pre-check is asked "should I even BEGIN a forward transfer onto this successor" while the predecessor is still the live, fully-functional, UNTOUCHED owner, and nothing has been reparented onto the successor yet. Refusing here commits to **nothing new** — the predecessor just keeps running exactly as it already was.

### Trace A — PROCEED (the gap before this card)

`attemptManagerOwnershipTransfer` (service.ts:14460) synchronously reparents workers/wakes/questions/triggers/pollJobs/webhooks/pendingOwnerMessage/capQueue onto the successor regardless of its `isStopping` state. The caller then fires `settleRecycleHandoff` (service.ts:13686), whose own loop stops the predecessor the INSTANT `hasReachedReady(freshId)` reads true — with no check on whether that same successor is concurrently mid-stop. `live.stopping` is a monotonic latch (`pty/host.ts` — set once at the top of `stop()`, never cleared except by a brand-new `Live` on respawn) and `stop()` is documented as deterministic. So a successor observed `isStopping` is **guaranteed** to exit soon. Proceeding via the halted-reattempt path specifically — where the reparent is CONDITIONAL on this exact gate, not already-committed — manufactures a fleet-dark window needing a human to notice the `[loom:orphaned-fleet]` banner and resume by hand. **Rejected for the REATTEMPT pre-check only** — see Trace C below for why the identical-looking fix is wrong at the shared settle chokepoint.

### Trace B — REFUSE at the reattempt pre-check (adopted, REATTEMPT path only)

The predecessor is simply left exactly as it was — still live, still the untouched owner, nothing mutated. Because `stop()` is deterministic, the successor's already-in-flight exit lands on its own shortly regardless; once it does, the VERY NEXT call takes the pre-existing `!isAlive` branch inside `recoverFleetAfterFailedRecycleSuccessor`.

**That branch does NOT always reclaim "cleanly" — correction to this record's own first-round claim.** It is gated (pre-existing, card `09b14f15`, unrelated to this card) on `isDurablyResumable(successor) && turnSeq > 0`:

- `turnSeq === 0` (no real context ever ran) — reclaims unconditionally, as this record originally said. Zero downtime, no human needed, genuinely self-resolving.
- `turnSeq > 0` (a real turn DID run before the successor's already-in-flight stop landed) — REFUSES instead, with "escalate: a human must resume successor `<id>`, then retry" (or, rarely, "wait for its automatic recovery" if a real crash-recovery trigger is still genuinely pending — see `09b14f15`'s own record). This is CORRECT: an intended stop with real context must never be silently discarded by an automatic reclaim.

**What survives from the original claim, stated precisely:** refusing at the reattempt pre-check costs the predecessor NOTHING either way — it is never touched or stopped by the refused call, in BOTH outcomes. "Zero downtime" is a true, unconditional property of the predecessor. "Self-resolves automatically" is true ONLY when `turnSeq === 0`; at `turnSeq > 0` it correctly escalates to a human instead, exactly like any other intended-stop death with real context. Test: `recycle-forward-transfer-onto-a-stopping-successor.mjs` scenarios (G2) (`turnSeq===0`, reclaims) and (G2b) (`turnSeq>0`, escalates — added after this correction).

### Trace C — the gap this card's FIRST ROUND missed: gating the SHARED settle chokepoint

The first round of this card additionally changed `settleRecycleHandoff`'s own `hasReachedReady(freshId)` check (service.ts ~13702, shared by `recycleManager`'s ordinary recycle_me, `recyclePlatformLead`, AND `reattemptManagerOwnershipTransfer`'s own resolved branch) to `hasReachedReady(freshId) && !isStopping(freshId)`, reasoning — by analogy with Trace B — that deferring the predecessor's stop while the successor is mid-stop would be equally harmless there.

**It is not harmless there, and Code Review `d2a1fdcf` caught it before merge.** `isStopping` is a MONOTONIC latch: once a successor is ever stopped, `isStopping` stays true for that `Live` object FOREVER, including long after the real exit lands. So `hasReachedReady(freshId) && !isStopping(freshId)` does not merely "defer" the ready branch for a ready-but-stopping successor — it makes the ready branch **permanently unreachable** for that successor, no matter how long the loop keeps polling. The loop therefore falls through to the `!isAlive(freshId)` branch the moment the successor's guaranteed exit lands — but that branch's whole job (pre-existing, correct, and load-bearing: see `recycle-manager-fleet-recovery.mjs` scenario (F)'s own comment, "a successor whose ready flag was EVER true is caught by the ready branch... before the not-alive branch could ever run") is to handle a successor that **never reached ready at all** — it unconditionally calls `recoverFleetAfterFailedRecycleSuccessor`, which archives the successor, stamps its resumability "dead", and records a reason implying it never confirmed reaching SessionStart.

A ready, `turnSeq > 0` successor routed into that branch by the gate has its REAL, completed-turn context permanently destroyed (archived + dead + a false reason) — strictly worse than the pre-card behavior, where the SAME successor would have been left stopped-but-resumable (via `archiveOnExit`'s `manager_exited_with_live_workers` skip, `@decision 6cd3ce9e`) with its context intact. Proceeding (stopping the predecessor the instant ready is observed, exactly as `main` already did) is correct here precisely BECAUSE, unlike the halted-reattempt path, the fleet was ALREADY on the successor unconditionally at spawn time — there is no new reparent-onto-a-doomed-successor action being gated; the only question is "when do I retire the predecessor," and `main`'s answer (the instant the successor is confirmed to own the fleet) was already right.

**Decision, final: gate ONLY `reattemptManagerOwnershipTransfer`'s own pre-check (Trace B). Leave `settleRecycleHandoff` completely UNCHANGED from `main` (Trace A, for that one chokepoint) — `isStopping` is read nowhere in it.** Test: `recycle-forward-transfer-onto-a-stopping-successor.mjs` scenario (G3), which locks in that a ready, `turnSeq > 0` successor stopped right after reaching ready is never archived, never marked "dead", and never unlinked, and goes RED if the reverted gate is ever re-added (verified by hand: reintroducing `&& !isStopping(freshId)` there reddens 7 of (G3)'s own checks).

**The two chokepoints now carry DIFFERENT answers to a structurally similar-looking read of the SAME primitive, and that asymmetry is the whole point of this record — do not "fix" it toward uniformity:**

| Chokepoint | Gated on `isStopping`? | Why |
|---|---|---|
| `reattemptManagerOwnershipTransfer`'s forward-transfer pre-check | **YES** | The reparent is conditional on this exact check; refusing costs nothing (predecessor untouched either way) |
| `settleRecycleHandoff` (shared by `recycleManager`/`recyclePlatformLead`/the reattempt resolved branch) | **NO — never** | The reparent already happened unconditionally at spawn time; gating the predecessor's stop here only risks destroying the successor's own context via the monotonic-latch misroute above |
| `recoverFleetAfterFailedRecycleSuccessor`'s dead-successor RECLAIM branch (`fcf8a0f8`) | **NO — diagnostic only** | Refusing there strands the fleet on a confirmed-dead, unresumable row |

### A fourth question considered and dropped as moot: the settle loop's unresolved-alert wording

Before Trace C's revert, there was a real concern that `settleRecycleHandoff`'s TIMEOUT branch (`recordUnresolvedRecycleOutcome`, whose alert text says "never confirmed reaching SessionStart or dying") could fire for a successor that HAD reached ready but was also stuck mid-stop past the settle bound, making that wording false. Investigated: it cannot — the loop checks `hasReachedReady(freshId)` FIRST, every iteration, before the timeout check, and (post-revert) that check is a plain, ungated read; a successor whose ready flag was ever true is caught by the ready branch (and the predecessor stopped) on literally the next poll tick, long before `RECYCLE_SUCCESSOR_SETTLE_TIMEOUT_MS` could ever elapse. The concern was specific to Trace C's own (now-reverted) gate, which could have left a ready-but-stopping successor looping indefinitely without ever taking the ready branch; it does not survive the revert. No wording change was made.

**Investigated at source, not assumed — the other named candidate forward-transfer paths (unchanged from the first round, reconfirmed):**

- **`watchHaltedRecycleSuccessor`'s own "reached ready" branch** (`sessions/service.ts` ~13845-13857): does **not** perform a forward transfer at all. `@decision f1969787`/`91ac2b79` (both pre-existing, unrelated to this card) forbid this loop from ever stopping the predecessor — "recovers to ready" here means only that the loop stops *watching*. No gate needed: there is no mutation here to gate.
- **`waitForHaltedSuccessorReadyThenResolve`** (`sessions/service.ts` ~14373-14407, card `d9512de7`): same shape — "Never stops anything (f1969787), never reclaims." No gate needed.
- **`recycleWorker`**: already investigated and ruled out by `fcf8a0f8` itself, reconfirmed here by grepping `settleRecycleHandoff`'s actual call sites (exactly 3: `recycleManager`, `reattemptManagerOwnershipTransfer`, `recyclePlatformLead` — never `recycleWorker`).

## Mechanism

**`reattemptManagerOwnershipTransfer`** (`sessions/service.ts` ~14935-14939): an `if (this.pty.isStopping(successor.id))` check sits immediately after the pre-existing `!hasReachedReady` check and before the call to `attemptManagerOwnershipTransfer` — same throw-and-retry idiom as its sibling checks. Throws before any mutation: no DB reparenting, no `recycle_ownership_transfer_resolved` event, no handoff nudge.

**`settleRecycleHandoff`** (`sessions/service.ts` ~13701-13705): byte-identical to `main` — `if (this.pty.hasReachedReady(freshId))`, no `isStopping` read anywhere in the function. The doc comment at the top of the loop (@decision 1e5dd7c4) records that this was tried and reverted, and why, so a future reader doesn't rediscover Trace C by shipping it again.

**`PtyHost.isStopping`'s own doc** (`pty/host.ts` ~13472): updated to name this card's one sanctioned gate use (the reattempt pre-check) and explicitly warn off the settle/reclaim paths, replacing a STALE example (restoring a `processState` to "live") that cited a site (`recordUnresolvedRecycleOutcome`) `fcf8a0f8` round 3 had ALREADY made ungated — that example was wrong even before this card.

## Do not

- Do not gate `settleRecycleHandoff`'s `hasReachedReady(freshId)` check on `isStopping` — tried (this card's first round), reverted after Code Review `d2a1fdcf`. `isStopping` is a MONOTONIC latch; gating this permanently misroutes ANY successor that was ever stopped (including one with real, completed-turn context) into the dead-successor recovery branch, which archives it, marks it resumability "dead", and stamps a false "never reached ready" reason — destroying context that `main`'s ungated behavior already preserved correctly via `archiveOnExit`'s own `manager_exited_with_live_workers` skip.
- Do not gate `recoverFleetAfterFailedRecycleSuccessor`'s dead-successor RECLAIM branch on `isStopping` — that is `fcf8a0f8`'s own question, already settled the opposite way.
- Do not read Trace B's "self-resolving" claim as universal — it holds only for `turnSeq === 0`. At `turnSeq > 0`, the pre-existing `09b14f15` gate correctly escalates to a human instead of reclaiming; the only thing that stays true in both cases is that the predecessor itself is never touched by the refused forward-transfer call.
- Do not "unify" the reattempt pre-check's refusal with either `settleRecycleHandoff`'s or `fcf8a0f8`'s own ungated behavior — all three questions look similar (same two primitives, same function family) and have genuinely different correct answers; see the table above before touching any of the three.
- Do not add a parallel "reached ready → stop the predecessor" branch to `watchHaltedRecycleSuccessor` or `waitForHaltedSuccessorReadyThenResolve` — both are forbidden from ever stopping the predecessor by pre-existing, unrelated decisions (`f1969787`/`91ac2b79`/`d9512de7`).
- Do not treat `recycleWorker` as sharing this question — already ruled out by `fcf8a0f8`, reconfirmed here.
- Do not re-derive a fix for `settleRecycleHandoff`'s unresolved-alert wording ("never confirmed reaching SessionStart") on the theory that a ready-but-stopping successor could trip it — investigated and shown unreachable, post-revert, by the ready-check-always-first ordering; see the dedicated section above.

## Source

`packages/daemon/src/sessions/service.ts` (`reattemptManagerOwnershipTransfer` — gated; `settleRecycleHandoff` — deliberately unchanged from `main`). `packages/daemon/src/pty/host.ts` (`isStopping`'s own doc comment). `packages/daemon/src/mcp/orchestration.ts` (`recycle_reattempt` tool description — the 4th refusal reason). Tests: `packages/daemon/test/recycle-forward-transfer-onto-a-stopping-successor.mjs`.
