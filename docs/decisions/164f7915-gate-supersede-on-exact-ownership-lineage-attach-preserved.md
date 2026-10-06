# 164f7915 — `supersedeQueuedSelfCheck` is gated on exact ownership; lineage-based `attach()` stays unconditional

## `supersedeQueuedSelfCheck`'s own design (card `8d585277`, the manager's own primary ask)

The live incident that motivated card `8d585277`: three gate-green branches serialized behind a single merge lane while each worker's OWN now-moot self-check still occupied a queue slot. A manager calling `worker_merge_confirm` as a worker's EXACT owner has, by construction, already decided that worker's queued `run_gate` self-check is moot — its own merge gate re-validates independently (or REUSE-A-GREEN-SELF-CHECK reuses a settled one; see `confirmWorkerMerge`'s own doc, and the Round 3 residual below for when that reuse can't apply). `supersedeQueuedSelfCheck` reclaims that slot the instant the decision is made, unconditional on what the confirm call goes on to decide (idempotent-already-merged, stranded-work refusal, a gate rejection, or a clean merge all equally mean the self-check's own result is no longer relevant to anyone) — unconditional across OUTCOMES, never across CALLERS: as of Round 3 below it fires for exactly two caller shapes (the exact owner, or a lineage-only caller attaching to an already-RUNNING op), never a lineage-only caller with nothing attachable.

QUEUED ONLY is a deliberate, manager-approved shape (a Report-and-STOP checkpoint at the time): if the self-check has already been ADMITTED (a real process is running), this method does NOTHING — no process is ever killed on this automatic, no-human-judgement path, which would otherwise mean this card's easiest-to-get-wrong hazard (a freed slot over still-running work) firing on every ordinary merge instead of only a deliberate escalation. The structural per-worktree exclusivity guard (`GateDescriptor.worktreePath`, `GateSemaphore`) still ensures the merge gate can't run CONCURRENTLY with an already-running self-check regardless — it just queues behind it instead, exactly as it would without this method existing at all. Cancelling an ALREADY-RUNNING self-check is the explicit manual `gate_cancel` escalation (`cancelGateOp`), never this automatic path.

`confirmWorkerMergeTracked`'s lineage ownership pre-check (card `656e326f`) runs before `supersedeQueuedSelfCheck`, but `confirmWorkerMerge`'s own, STRICTER exact-id ownership check (`worker.parentSessionId !== managerSessionId`) still lived deep inside its body, reached only once `pendingOps.attach()` actually re-invokes it — well after the supersede side effect.

`reparentLiveWorkers` (db.ts) only repairs a worker row whose `process_state = 'live'` at recycle time. A worker that is NOT live when its manager recycles keeps a stale `parent_session_id` pointing at the now-dead predecessor. The predecessor and its successor share a lineage ROOT, so the successor's `confirmWorkerMergeTracked` call passed the lineage pre-check, fired `supersedeQueuedSelfCheck` (cancelling the worker's queued `run_gate` self-check), and was then refused by the deeper exact-id check once `confirmWorkerMerge` actually ran — a self-check cancelled by a confirm that never ran.

Verified hermetically (no real spawn): a recycled-manager + non-live-worker fixture reproduced exactly this shape against pre-fix code — lineage pre-check passed, self-check settled `cancelKind:"superseded-by-merge"`, and the confirm itself settled `ok:false` with a `NotYourWorkerError`.

**Why this didn't surface via `worker_merge_confirm` in production:** that MCP tool's handler calls `selfHealWorkerLink` (`mcp/orchestration.ts`) before calling into `confirmWorkerMergeTracked` at all. `selfHealWorkerLink` uses the SAME lineage-root predicate to decide whether to repair, and when it does, it RELINKS the worker's `parent_session_id` to the live caller first — so by the time `confirmWorkerMergeTracked` runs, the row is no longer stale and the deep exact-id check passes. `mergeBatchTracked`'s own fallback path is self-consistent for a different reason (it derives `managerSessionId` directly from the worker's own current `parentSessionId` at the moment of each call, so it can never disagree with itself). The REST route is NOT self-consistent the same way — see Round 2 below, which corrects this paragraph's original claim about it. `confirmWorkerMergeTracked`/`confirmWorkerMerge` are still exercised directly by tests (`gate-cancel.mjs`'s B2-1/"wording" blocks) and are meant to be correct independent of any particular caller's own pre-processing — relying on an upstream caller's incidental self-heal to mask a service-layer inconsistency is fragile, not a documented invariant.

## The fix (round 1 — see Round 2 below, which replaces part of this)

One shared predicate, `SessionService.isExactWorkerOwner(managerSessionId, worker)`, used by `confirmWorkerMerge`'s own existing deep guard (unchanged in behavior — now calling the shared predicate instead of re-deriving the same comparison inline) and, after Round 2, by a guard around the `supersedeQueuedSelfCheck` call site instead of an early pre-check (see below).

`isExactWorkerOwner` is deliberately NOT widened to lineage-tolerant (that was rejected — see below): it stays the same strict exact-id check `confirmWorkerMerge` always had, matching its sibling "not your worker" guards elsewhere in `sessions/service.ts` (`stopWorker`/`messageWorker`/`redirectWorker`/`recycleWorker`/`worker_revive`/...).

## Round 2 (card `2471d6b8`'s Code Review of commit `71022460`, CRITICAL, NOT mergeable) — round 1's hoisted pre-check regressed `656e326f`

Round 1 (above) hoisted a SECOND early return into `confirmWorkerMergeTracked` — an exact-id refusal right after the lineage pre-check, before `pendingOps.attach()` is ever called. That put an exact-id comparison on the attach-reachable path `656e326f`'s own "Do not" explicitly forbids, and broke two real callers that `656e326f` exists to let through:

- `merge-spawn-ownership-attach.mjs` (`656e326f`'s own positive control: a recycled successor re-confirming within the retention window must get the cached opId) — went RED on `71022460`, green on its parent.
- The REST human Merge loop (`confirmWorkerMergeUntilSettled`): it captures `managerSessionId` from `worker.parentSessionId` ONCE (`gateway/server.ts`'s `worker.parentSessionId` read, before the retry loop starts) and reuses that SAME value on every retry inside the loop — it is self-consistent only at the instant of that one read, not across the loop's own lifetime. A manager recycle landing mid-wait (reparenting a LIVE worker — see `reparentLiveWorkers`) makes every subsequent retry's captured id a lineage-matching-but-not-exact one. Round 1's early refusal answered every one of those retries 400 "not your worker" even while the already-running op it should have attached to kept going and genuinely landed the merge — this is the correction to this record's earlier "the REST route is self-consistent" claim, which was true only for the route's FIRST call, not its retry loop.

**The fix:** remove round 1's early exact-id return entirely — the only ownership gate before `pendingOps.attach()` stays the lineage check (`656e326f`). Instead, gate ONLY the `supersedeQueuedSelfCheck` side-effect call on `isExactWorkerOwner`. Reasoning: a lineage-matching-but-not-exact caller that will ATTACH to an already-SETTLED result (a TTL'd retained hit, or the until-superseded cache hit) represents a decision an exact owner already made (at mint time, or via `selfHealWorkerLink`'s relink) — superseding again here is unnecessary, not unsafe, and skipping it costs nothing, because there is no still-queued self-check left for a settled op to supersede. A lineage-matching-but-not-exact caller for whom NOTHING is attachable is about to MINT a fresh op that `confirmWorkerMerge`'s own deep exact-id guard will refuse — superseding for that call cancels the self-check for nothing, the original bug this card fixes. Gating the single `supersedeQueuedSelfCheck` call on `isExactWorkerOwner` covers both of those cases correctly without needing to predict, ahead of `attach()`, which of them a given call is.

**The honest trade-off this round accepts:** a THIRD case sits between those two and is not free. A lineage-matching-but-not-exact caller that attaches to an op still genuinely RUNNING (the worker's exact owner already minted it, but it hasn't settled yet) also skips the supersede now, by the same gate — and for that case no exact owner has decided anything about THIS caller's own queued self-check yet. The worker's queued `run_gate` self-check stays queued behind the running op purely via the per-worktree `GateSemaphore`'s structural exclusivity, which re-introduces, in this one rare shape, exactly the serialization cost card `8d585277` was filed to remove: the self-check occupies a queue slot for a lineage-only attach that will never itself call `supersedeQueuedSelfCheck`, until whichever call eventually reaches this gate as the EXACT owner (or the running op simply settles on its own and frees the slot the ordinary way). This is a real, if rare and bounded, regression relative to 8d585277's original goal — not a cost-free skip — and it is accepted here because the alternative (round 1's early refusal, or superseding on a lineage-only attach) breaks `656e326f`'s own guarantees instead. The window is bounded by however long the running op takes to settle, and by how soon an exact-owner call happens to arrive; it is not bounded by this gate's own logic. The check-to-mint race windows this round's gate placement leaves open — where the exact-ownership check and the op's actual mint can observe different worker state across the awaits between them — are a KNOWN RESIDUAL, not fixed by this round: see follow-up card `86c3286a` ("decide the self-check supersede at the mint, after the awaits"), filed to close them.

`confirmWorkerMerge`'s own deep guard throw (`NotYourWorkerError`) was already, and remains, never cached: it classifies to the `"not-your-worker"` outcome (card `6325bc74`), which `pending-ops.ts`'s `NEVER_CACHED_OUTCOMES` set excludes from both the TTL'd `retained`-cache write gate used by `usableRetainedHit`/`attach()`'s own re-check and the `untilSupersededVerdicts` write — true before this card, unaffected by either round of it, verified directly rather than assumed.

## Round 3 (card `86c3286a`) — closes the check-to-mint window Round 2 left as a known residual, and the running-op serialization gap in the same pass

Round 2's gate (`isExactWorkerOwner`, evaluated synchronously right after `key` is computed — BEFORE `confirmWorkerMergeTracked`'s own two identity-resolving awaits, `resolveGitRef`/`readMainlineHead`) left a real window: the worker's `parentSessionId` can change between that check and the actual mint (reached only once `pendingOps.attach()` invokes its `run()` callback, inside `confirmWorkerMerge`'s own deep guard). Two directions, both verified hermetically against pre-Round-3 code (`merge-confirm-supersede-mint-window.mjs`):

- **Stale at the check, exact at the mint** — a missed optimization only: the worker is relinked to the caller DURING the window, but Round 2's early check already observed the stale row and skipped the supersede, so the self-check runs for real alongside a merge that ultimately succeeds (GateSemaphore's own per-worktree exclusivity still serializes them — nothing races unsafely, it is purely a wasted self-check run).
- **Exact at the check, stale at the mint** — the real bug, narrowed to this window: the worker is relinked AWAY from the caller during the window. Round 2's early check still observed the (now-stale) exact match and fired the supersede, cancelling the self-check for a confirm that `confirmWorkerMerge`'s own deep guard then refuses once it re-reads the row fresh at the real mint — the ORIGINAL 164f7915 incident shape, reproduced via this one await window instead of a manager recycle.

**The fix:** move the decision to **immediately before `pendingOps.attach()` is called**, in the SAME synchronous step (zero `await` between this check and that call — `attach()`'s own mint-vs-attach decision, reached synchronously once invoked, is thereby GUARANTEED to observe identical state to what this check just read; there is no JS event-loop opportunity for anything to run in between). Both the worker row and `key`'s own pending-op state are re-read fresh at that point — never the `worker`/`inFlight` locals captured earlier in the method, above the two awaits, which can already be stale by the time this check runs.

**Also folded into the same round:** the THIRD case Round 2 flagged as an accepted residual (a lineage-matching-but-not-exact caller attaching to a still-RUNNING op skips the supersede, re-opening card `8d585277`'s serialization) is closed too — the same post-await check now fires whenever `pendingOps.peek(key)?.state === "running"` at that instant, in addition to the exact-owner case. Safe per `8d585277`'s own finding ("QUEUED is zero-risk for any gate type, regardless of what it's superseded in favor of") — this never touches the RUNNING op itself, only the worker's own still-queued self-check. This `attachingToRunningOp` arm itself relies on the LINEAGE pre-check (`656e326f`) made at the very top of `confirmWorkerMergeTracked`, BEFORE the same two identity-resolving awaits — by the time this arm fires, that lineage verification is itself two awaits stale, and this is accepted as bounded rather than fixed: the caller is still project-scoped, and a genuinely RUNNING merge on this worktree makes the worker's own queued self-check moot regardless of which lineage member happens to be attaching to it.

**A secondary finding, orthogonal to correctness, ACCEPTED as a named residual (not fixed by this round):** moving the decision past the two real git-subprocess awaits means a caller who releases a cap-saturating holder essentially concurrently with firing the confirm can let the self-check win ADMISSION into the just-freed slot before this (now later) decision ever runs — an entirely different race from the one above (GateSemaphore admission latency vs. this call's own git reads). This does **not** get absorbed by `confirmWorkerMerge`'s own reuse-a-green-self-check optimization: that optimization reads `this.lastWorkerGateCheck.get(workerSessionId)` ONCE, at the moment `confirmWorkerMerge` reaches it, and that map is written only at a self-check's own SETTLE (`runWorkerGate`'s settle path) — never while one is merely running. A self-check that won admission via this race is, by construction, still RUNNING (not yet settled) when the merge's own reuse check executes moments later, so there is nothing fresh to reuse: the merge runs a genuine, REDUNDANT SECOND gate invocation on the identical tree. Measured directly (Code Review, Round 2) with a 3-second fake gate: two real gate invocations, not one. No correctness loss — both the self-check's own caller and the merge both still see a true, passing result — but it is real wasted work this card does not close. A structural mitigation is tracked as a separate, later card: `5f7d7a01`. Observed directly in `gate-cancel.mjs`'s "(e2e single-admission)" block, which now holds the unrelated holder until this decision has genuinely run (pausing on `confirmMergeMainlineHeadReader`, mirroring `merge-confirm-supersede-mint-window.mjs`'s own technique) so the self-check reliably stays queued long enough to be superseded, and asserts the single `cancelled:true, cancelKind:"superseded-by-merge"` shape again — proven RED against a no-op `supersedeQueuedSelfCheck` stub, confirming the block is no longer vacuous.

## Round 4 (card `5f7d7a01`) — closes the redundant-second-gate residual Round 3 named, WITHOUT touching the supersede decision at all

Round 3's own residual: a self-check that wins GateSemaphore ADMISSION during `confirmWorkerMergeTracked`'s
two identity-resolving awaits defeats `supersedeQueuedSelfCheck` (QUEUED-only, per 8d585277) and keeps
running for real; `confirmWorkerMerge`'s own gate step then queues behind it (per-worktree exclusivity) and
mints a second, genuinely redundant real gate invocation once the self-check releases.

Two directions were considered: (a) teach GateSemaphore to stand down a self-check AT ADMISSION by
consulting whether a merge confirm is pending/minting for the same worktree; (b) have the merge wait for
and reuse the in-flight self-check's verdict. (a) was rejected: making it SAFE (never standing down a
self-check for a confirm that is later refused — the original 164f7915 bug, in a new shape) requires
re-deriving `isExactWorkerOwner`/`attachingToRunningOp` fresh at the exact admission instant, which either
duplicates that decision (forbidden below) or threads a new SessionService→GateSemaphore callback that
must stay registered for confirmWorkerMerge's ENTIRE pre-gate lifetime (the race can recur during its own
later awaits too — e.g. the union-merge — not just the two awaits before the Round 3 decision). That is new
cross-module coupling with its own leak/staleness risk, for no correctness gain over (b).

**The fix (b):** `confirmWorkerMerge`'s existing e50600d2 reuse block (`sessions/service.ts`, immediately
before `const lastCheck = this.lastWorkerGateCheck.get(workerSessionId)`) first checks
`this.pendingOps.peek(\`gate:${workerSessionId}\`)?.state === "running"` — the SAME key
`supersedeQueuedSelfCheck` already reads, and the SAME key/kind (`"gate"`) `runWorkerGate`'s own
`pendingOps.attach()` call uses. If running, it `await`s `this.pendingOps.waitBriefly(key, gateTimeoutMs)`
(an existing, already-used-elsewhere bounded-wait primitive) before falling through to the reuse block,
unchanged. `runWorkerGate`'s settle path writes `lastWorkerGateCheck` synchronously, inside the same `run()`
callback, BEFORE `attach()` ever resolves any attached waiter — so by the time the wait resolves, the
existing reuse-eligibility checks (branch match, `passed`, `headCurrent`, fresh stamp/dirty, `freshBehindMain
=== 0`, `onBranch`) have real, current data to evaluate. This adds NO new trust logic: it only changes
WHETHER those checks get a value to look at, never WHAT they trust once they have one.

**No new ownership/race surface, by construction — but the merge OP's OWN cancel-visibility genuinely
regresses while this wait is outstanding, corrected here (Code Review, round 2):**
- A self-check CANCELLED while running (`gate_cancel`, or the manual RUNNING-cancel path, 8d585277) returns
  before ever reaching the `lastWorkerGateCheck.set` call (`runWorkerGate`'s "CANCELLED-WHILE-RUNNING"
  branch returns strictly earlier in the same function) — the wait resolves, `lastCheck` is whatever it was
  before (stale or absent), and the existing `hasLastCheck`/`checkPassed` checks correctly refuse reuse and
  fall through to a fresh gate. No stale/wrong reuse is possible either way.
- **The merge op's own cancel-visibility is NOT "identical in kind" to before this fix — it is a real,
  named trade-off.** PRE-fix, a self-check that won the admission race left the MERGE'S OWN gate call
  QUEUED (visible in `gate_queue`/`gateQueueForManager`, cancellable via `gate_cancel(mergeOpId)` per
  8d585277's "QUEUED is zero-risk for any gate type"). POST-fix, that same window is this wait instead — an
  in-process `await` with no GateSemaphore registration at all, so it is INVISIBLE to `gate_queue` and
  `gate_cancel(mergeOpId)` returns `not_found` for up to `gateCommandTimeoutMs`. **The remedy: `gate_cancel`
  the SELF-CHECK's OWN opId instead** (visible and cancellable the whole time, QUEUED-or-RUNNING per
  8d585277) — cancelling or killing it settles its `pendingOps` entry, which ends this wait immediately
  (whichever branch of `Promise.race` it's blocking on) and falls through to the pre-existing real-gate
  path, exactly as a `hasLastCheck:false` miss always has. A follow-up card (filed separately, NOT part of
  this round's scope) tracks making the wait itself visible/cancellable as a merge-op-shaped thing instead
  of relying on a caller knowing to target the self-check's opId.
- Dead-owner eviction while waiting: unchanged, pre-existing (27ea069e) — an evicted entry's orphaned
  `run()` keeps executing in the background regardless of this wait's existence.
- A self-check that PASSES but whose branch tip moved mid-run (`headCurrent:false`, 39196378) is caught by
  the EXISTING `checkHeadCurrent` condition exactly as it always was — this fix changes nothing about that
  check, it only gives it a fresher (or the same) `lastCheck` to evaluate.

**Lock audit — nothing held during the wait (cited by call, not a bare line number that drifts on the
next edit above it — card `5f7d7a01`'s own record cited lines that were already 7 off by the time this
round's text settled; re-grep the call name below rather than trusting any number here):**
- `withCanonicalIndexLock` (`git/repo-lock.ts`'s `withCanonicalIndexLock`, a plain promise-chain mutex
  scoped to its own callback) is acquired-and-released around the three canonical-dirt probes
  (`detectCanonicalStagedDirt`/`detectCanonicalDirtyOverlap`/`detectCanonicalUntrackedOverlap`) in
  `confirmWorkerMerge`, well before this wait — released by the time its own `await` resolves.
- The union-merge (`mergeMainIntoWorktree`, called directly from `confirmWorkerMerge`) runs with NO lock
  of its own at all — see this record's own Round 2/3 text above.
- GateSemaphore's per-worktree/per-repo admission guards (`activeWorktrees`/`activeMergeRepos`) are only
  taken inside `gateSemaphore.runExclusive`, called for THIS merge's own gate (the `"low"`-priority call
  passing `gateDescriptor`/`gateCap`) — strictly AFTER this wait.
- `acquireRepoGuardOnly` (the inert-diff-skip path's own `releaseInertRepoGuard = await
  this.gateSemaphore.acquireRepoGuardOnly(...)` call) and `beginSquash`/`endSquash` (the squashing slot)
  are both reached later still.
- The only thing held across the wait is the outer `pendingOps.attach(key: "merge:"+workerSessionId, ...)`
  entry `confirmWorkerMergeTracked` wraps this whole call in — a per-WORKER dedupe entry, never a cross-
  worker/cross-repo lock. A long wait here can never block a sibling merge's admission on this repo or any
  other.

**Accepted residual:** if the self-check is still QUEUED (not yet admitted) behind unrelated cap pressure
when this check runs, `gateTimeoutMs` alone may not cover the remaining queue wait plus its full run —
`waitBriefly` simply times out and falls through to the pre-existing, safe-but-costly real-gate path. Never
an incorrect reuse, only a missed optimization in that one sub-case.

**Test:** `merge-confirm-self-check-admission-race.mjs`, mirroring `merge-confirm-supersede-mint-window.mjs`'s
rig but inverted — releases the held slot FROM INSIDE the `confirmMergeMainlineHeadReader` override's first
call (i.e. during the two identity-resolving awaits, before the Round 3 decision runs), forcing the self-
check to win admission mid-window. Asserts the self-check settles `ran:true`/`passed:true` with no
`cancelled` (supersede genuinely defeated, not avoided by test luck), the confirm's own merge succeeds, and
exactly one real gate call total. RED on main at `86c3286a` (two real gate invocations, matching this
record's own Round 3 measurement) — green after this round. A sibling case drives a commit onto the
worktree WHILE the self-check's fake gate is executing, producing a PASS with `headCurrent:false`; asserts
the merge does NOT reuse it and runs its own fresh gate instead (two real gate invocations in THAT case,
by design) — the behavioural control proving reuse still goes through the unchanged existing checks.

## Do not

- Do not widen `isExactWorkerOwner` (or either call site) to lineage-tolerant — that would let a lineage-matching-but-exact-mismatched caller actually MERGE, a materially bigger behavioral change than this card's own scope, and would make this one method's ownership strength diverge from its 7 untouched siblings in the same file.
- Do not re-derive a second exact-id comparison anywhere in `confirmWorkerMergeTracked`/`confirmWorkerMerge` — always call `isExactWorkerOwner`, or the two can silently drift apart again exactly as they did before this card.
- Do not assume `selfHealWorkerLink` makes this check redundant — it is an MCP-layer convenience for ONE caller (`worker_merge_confirm`/`worker_merge`/`merge_batch`'s initial list), not a guarantee `confirmWorkerMergeTracked` itself can rely on; `mergeBatchTracked`'s own fallback and any future caller must still go through a self-consistent `confirmWorkerMergeTracked`.
- Do not reintroduce an early exact-id refusal before `pendingOps.attach()` in `confirmWorkerMergeTracked` — that is exactly round 1's regression of `656e326f`. The only pre-`attach()` ownership gate there is the lineage check; exactness is enforced only (a) deep inside `confirmWorkerMerge`'s own guard, reached on a genuine mint, and (b) around the `supersedeQueuedSelfCheck` call, per Round 2 above.
- Do not read a refusal reached via `confirmWorkerMerge`'s deep guard as new/different depending on which round of this card is live — same error type, same message, same "never cached" treatment throughout (see the `NEVER_CACHED_OUTCOMES` verification in Round 2 above).
- Do not move the Round 3 supersede decision back to an earlier point in `confirmWorkerMergeTracked` (e.g. before the identity-resolving awaits) — that reopens exactly the check-to-mint window this round closes. The ONLY correct placement is the same synchronous step as the `pendingOps.attach()` call, with zero `await` in between.
- Do not decide the Round 3 check from the `worker`/`inFlight` locals captured earlier in the method (above the two awaits) — re-read `this.db.getSession(workerSessionId)` and `this.pendingOps.peek(key)` fresh at the check site, or it can observe the same stale state the pre-Round-3 bug did.
- Do not drop the `attachingToRunningOp` arm of the Round 3 condition on the theory that it duplicates `isExactWorkerOwner` — it is the fix for a SEPARATE, independently-discovered gap (the accepted residual named in Round 2 above), not a redundant restatement.
- Do not move the supersede decision back to BEFORE the identity-resolving awaits to "fix" the redundant-second-gate residual above — that reopens the exact→stale window this round exists to close (a real, narrow bug) in exchange for closing a wasted-work residual that has no correctness cost. The two defects are not the same severity; do not trade the real one away for the cosmetic one.
- Do not "fix" the `attachingToRunningOp` arm's own lineage staleness (noted above) by re-checking exactness for it — that would require the attaching caller to BE the exact owner, defeating the entire purpose of this arm, which exists specifically for a lineage-only, non-exact caller. The staleness here is accepted as bounded, not a defect to close.
- Do not move Round 4's wait earlier than immediately before the reuse block's own `lastCheck` read, and do not let it decide reuse itself — it must only feed the existing, unchanged eligibility checks a fresher value; deciding reuse from "something finished" alone would bypass `checkPassed`/`checkHeadCurrent`/the fresh-stamp/`freshBehindMain` checks entirely.
- Do not revisit direction (a) (admission-time stand-down in GateSemaphore) without a story for the "minting" window too — the Round 4 narrative above explains why it needs the decision registered for confirmWorkerMerge's whole pre-gate lifetime, not just the two awaits before the Round 3 decision, and why that is worse than (b).
- Do not widen Round 4's wait bound past `gateTimeoutMs` to try to also cover a self-check still queued behind unrelated cap pressure — the residual there is accepted (falls through to a real gate, never an incorrect reuse); a larger bound trades a known-safe fallback for an unbounded wait with no new correctness benefit.
