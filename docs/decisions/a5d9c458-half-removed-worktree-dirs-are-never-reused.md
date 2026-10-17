# a5d9c458 — `createWorktree` never reuses/recuts a dir that exists but has no `.git` link

## Narrative

A boot/sweep removal attempt against a worktree dir can fail PARTWAY through: `git worktree remove`
drops the worktree's admin record and its `.git` link file, but the directory's actual contents fail to
delete (a held OS handle, commonly on Windows). `gcWorktreeDir` (`sessions/service.ts`) classifies this
outcome as either `wedged` (tracked for slow retry) or `left-on-disk` (a transient handle-lag NOT added
to wedged-retry tracking at all — see that outcome's own doc). Either way, the directory can be left on
disk with real files but no git linkage and no registered branch.

Before this decision, `createWorktree`'s `fs.existsSync(worktreePath)` branch treated ANY existing dir at
the target path as a retained, reusable worktree and called `recutStaleReusedBranch`/
`detectReusedDirtyWorktree` unconditionally. Those assume real git linkage. Against a half-removed dir
they fail with an opaque git error (the confirmed incident shape: `fatal: ambiguous argument
'<sha>…loom/<key>': unknown revision or path not in the working tree`) — a worker_spawn for the
affected task failed outright until a human manually renamed the stale dir aside.

This is the deterministic-naming half of a larger incident (card `a5d9c458`): `taskKey(taskId)` always
resolves the SAME task to the SAME worktree path, so a respawn of a task whose prior worktree was left
half-removed walks straight into this. The DB-tracked half of the same incident (a stale
`WedgedWorktreeEntry` pointing at a path later reclaimed by a brand-new live worktree, deleted by the
next background sweep tick) is fixed separately in `sessions/service.ts` (`gcWorktreeDir`'s
`staleKnowledge` live-claim re-check, and `reclaimWedgedWorktreePathForSpawn` pre-spawn clearing) — this
record covers only the `git/worktrees.ts`-local, DB-free half: detecting the half-removed SHAPE itself,
independent of whether it happens to be wedge-tracked.

## Do not

- Do not call `recutStaleReusedBranch`/`detectReusedDirtyWorktree` (or add a future "reuse" step) against
  `worktreePath` without first confirming `worktreeHasGitLink(worktreePath)` — a dir with no `.git` link
  is not a worktree git can operate on, and treating it as one surfaces an opaque git error instead of a
  clear one.
- Do not delete a half-removed dir found this way — rename it aside (`<path>.stale-<ts>`) and fall
  through to the fresh branch-cut path. It may still hold uncommitted work from whatever wedged the
  original removal.
- Do not assume this path is also covered by the DB-tracked wedge list — a `left-on-disk` removal
  failure (as opposed to `wedged`) is never added to `WORKTREE_WEDGED_KEY` tracking at all, so this
  fs-level check is the only thing that catches that case before a respawn hits it.

## Source

`packages/daemon/src/git/worktrees.ts`, `createWorktree`'s `fs.existsSync(worktreePath)` branch — fixed
on card `a5d9c458` (the wedged-worktree-sweep-deletes-a-live-worktree incident, P1 data-loss class).

## `gcWorktreeDir`'s `staleKnowledge` flag — scoped to callers acting on path-only, stale knowledge

### Narrative

`gcWorktreeDir` (`sessions/service.ts`) is the single removal chokepoint shared by `finalizeMerge`, the
background wedge-retry sweep, and both boot-reconcile Pass B GC sites. The wedge sweep in particular acts
on pure, path-only knowledge recorded minutes-to-hours ago (`WedgedWorktreeEntry` carries no session/task
identity — just `worktreePath`/`repoPath`) and nothing re-validates, at retry time, whether that path
still names the same problem. Because `createWorktree` derives worktree paths deterministically per task
(`taskKey`), a respawn of the same task can create a brand-new LIVE worktree at the exact path an old
wedge entry still names, and the entry never auto-clears on that reuse. The next retry/sweep tick then
destroys the live worktree it now points at — the confirmed incident this card fixes (a lead manually
renamed a half-removed orphan aside, a respawn created a live worktree at the freed path, and ~24 minutes
later the background sweep deleted it, including a live worker's two commits, which only survived because
they happened to already be on the branch).

`finalizeMerge` shares the same chokepoint but is a fundamentally different caller: it removes the
worktree of the worker it JUST merged, while that worker's session is typically still live/non-archived
at that exact moment (the row isn't archived until after cleanup). A blanket "a live session claims this
path ⇒ refuse" check in the chokepoint would therefore refuse nearly every ordinary post-merge cleanup.

The fix is a caller-supplied `staleKnowledge` flag, not a blanket chokepoint check: only a caller that is
genuinely re-validating OLD information sets it. It re-checks whether `worktreePath` is currently claimed
— by a session whose `processState` is `"live"` or `"starting"` (never a bare non-archived filter; see
`findLiveSessionClaimingWorktreePath`'s own section below for why), or (round 2) by an in-flight spawn
that has no session row yet at all — as early as possible: before the nested-repo scan and the process
reap, so a reclaimed live worktree's own processes/content are never touched at all. On a hit, any stale
wedge-tracking entry for that path is dropped and nothing else happens.

### Do not

- Do not set `staleKnowledge` from `finalizeMerge` or any future caller that is acting on information it
  just derived fresh (the session/task it is currently handling) — it exists only for a caller re-acting
  on OLD, path-only, previously-recorded knowledge.
- Do not run the `staleKnowledge` live-claim check after the nested-repo scan or process reap — it must
  be checked first, so a reclaimed live worktree's rooted processes are never swept and its content is
  never scanned/touched.
- Do not treat `reclaimed-by-live-session` as a failure outcome (it is not `wedged`/`left-on-disk`) — it
  means the removal was correctly skipped because the path is legitimately live now; no retry is needed
  and `needsHuman` must never be set for it.

### Source

`packages/daemon/src/sessions/service.ts`, `gcWorktreeDir`'s `opts.staleKnowledge`, `sweepWedgedWorktreesOnce`,
and the two boot-reconcile Pass B call sites — fixed on card `a5d9c458`.

## `findLiveSessionClaimingWorktreePath` — "live" means `processState`, never bare non-archival

### Narrative

The first implementation of the `staleKnowledge` live-claim check (above) matched any NON-ARCHIVED
session whose `worktreePath` equaled the target path. This is wrong: an exited-but-resumable worker's
session row stays non-archived for as long as it remains resumable — the ordinary steady state for
every worktree the wedge sweep is ever asked to retry in the first place (the session that originally
owned a now-wedged worktree is usually still sitting around, non-archived, exactly because its worktree
removal hasn't finished yet). A bare non-archived filter would therefore match that SAME original
owner's row on every retry, and the sweep would conclude the path is "still claimed" forever — never
actually removing anything, which defeats the entire wedge-retry mechanism and is the opposite of what
this card needs. A test written against the naive implementation (the existing `(wedge)`/
`(reclaim-genuine-orphan)` scenarios in `worktree-wedge-retry.mjs`, both of which seed exactly this
"dead-but-non-archived owner" shape) caught this immediately: the genuine-orphan case stopped being
removable.

The fix checks `processState` instead: `"live"` or `"starting"` only, explicitly excluding `"exited"`/
`"none"`. This is what actually distinguishes the real incident (a brand-new respawn, live or mid-spawn)
from the routine case (a dead/exited worker whose worktree boot-reconcile is in the process of
disposing of).

### Do not

- Do not widen `findLiveSessionClaimingWorktreePath`'s session filter to "any non-archived session" —
  that was tried, and it makes the wedge sweep permanently unable to remove anything, because a wedged
  worktree's own original (now-dead) owner session is almost always still non-archived at retry time.
- Do not drop the `"starting"` half of the `processState` check as redundant with `"live"` — a session is
  `"starting"` for a real window right after its worktree is cut, before it flips to `"live"`; dropping it
  reopens a (smaller) version of the same race this whole fix closes.

### Source

`packages/daemon/src/sessions/service.ts`, `findLiveSessionClaimingWorktreePath` — fixed on card
`a5d9c458`, caught by this card's own regression tests in `packages/daemon/test/worktree-wedge-retry.mjs`.

## ROUND 2 (Code Review `ffc2b31b`) — the live-claim guard couldn't see an in-flight spawn, and only ran once

### Narrative

Round 1's `staleKnowledge` guard (above) can only ever see a SESSION ROW — but `spawnWorker` and the
batch worktree cut both insert that row only AFTER `createWorktree` (+ dependency provisioning) returns,
which can run for a long time. A concurrent sweep tick racing an in-flight spawn for the SAME
deterministic path (a respawn always lands on the exact path an old wedge entry still names) saw NO
claimant at all during that whole window, and could destroy the worktree the spawn was about to create —
a narrower recurrence of the exact incident round 1 fixed. Separately, the guard ran exactly ONCE, before
the nested-repo scan and process reap — a claim arriving, or the wedge entry itself changing, during
either of those awaits was invisible to it.

Three fixes, all in `sessions/service.ts`:

1. **`claimedWorktreePaths`** — an in-memory `Set<string>` of normalized worktree paths, the path-keyed
   analogue of the pre-existing `inFlightSpawnTaskIds`. Filled SYNCHRONOUSLY, as the very first action, in
   `reclaimWedgedWorktreePathForSpawn` (the one call site immediately before every real
   `createWorktree(...)` call — both `spawnWorker` and the batch cut) — so the claim exists before
   anything else in that function can throw or await. `findLiveSessionClaimingWorktreePath` consults it
   FIRST, returning the sentinel `IN_FLIGHT_SPAWN_CLAIMANT` on a hit, before ever scanning session rows.
   The claim is released by the CALLER, in its own outer `finally`: `spawnWorker` releases once its
   session row is live or the spawn has failed outright (not right after `createWorktree` returns — the
   window this fix closes extends through to the session row's own insertion); the batch cut has no
   session row to hand the release to at all, so it releases in the SAME `finally` that removes the batch
   worktree, once the whole merge-batch operation has settled.
2. **The staleKnowledge guard now runs TWICE** — once before the nested-repo scan (as round 1 shipped it),
   and again immediately before the actual `removeWorktree` call, after the scan + process-reap awaits.
   Either check can independently bail with `{outcome: "reclaimed-by-live-session"}` (a live claim) or the
   new `{outcome: "wedge-entry-superseded"}` (see next point) — a claim or a supersession arriving during
   either await is now caught by the SECOND check even when the FIRST one ran clean.
3. **Wedge-entry supersession** — `sweepWedgedWorktreesOnce` now passes the `WedgedWorktreeEntry` it
   snapshotted as `opts.wedgeSnapshot`; both guard checks re-read `db.getWedgedWorktree(worktreePath)` and
   bail if it's now GONE (cleared by a `reclaimWedgedWorktreePathForSpawn` call for a respawn) or
   SUPERSEDED (a different `firstWedgedAt` — the path was re-wedged for a genuinely different reason since
   this sweep pass started iterating). Boot-reconcile's two Pass B call sites have no `WedgedWorktreeEntry`
   to hand in (they iterate sessions, not wedge entries) and simply omit it — that half of the guard is a
   no-op for them, by design; their own protection is the live-claim half, unchanged.

A fourth, smaller fix: `reclaimWedgedWorktreePathForSpawn`'s own rename-aside failure used to log a
warning and silently let `createWorktree` proceed against whatever was still sitting at the path, in an
unknown state. It now REFUSES the spawn outright (throws), self-releasing its own claim first since the
spawn goes no further, and leaves the wedge-tracking entry IN PLACE (there is still something there a
later retry needs to deal with). `createWorktree`'s own equivalent branch already threw on this failure;
both now share one helper, `renameWorktreeDirAside` (`git/worktrees.ts`), so the two can't drift — each
caller still decides its own failure policy by checking the returned `{ok, staleAside, error}`.

### Do not

- Do not assume a caller holding a SESSION ROW is the only thing that can legitimately claim a
  wedge-tracked path — an in-flight spawn with no row yet is an equally real claimant; check
  `claimedWorktreePaths` too, not just `listAllSessions()`.
- Do not run the `staleKnowledge` guard only once — a claim or a wedge-entry change arriving during the
  nested-repo scan or the process reap is real and must still be caught; repeat the SAME check
  immediately before `removeWorktree`.
- Do not let `reclaimWedgedWorktreePathForSpawn`'s rename-aside failure fall through to `createWorktree`
  silently — refuse the spawn (throw) rather than letting it reuse/recut a dir whose state is now unknown.
- ⛔ SUPERSEDED (card `1243e342`, CR `3709d686`) — this bullet's "exact-string match is correct there"
  claim does NOT hold: a cross-boot `WORKTREES_DIR` casing drift (an env-level change across daemon
  restarts) falsifies "the same inputs ⇒ byte-identical output" even though `resolveWorktreePath`/
  `taskKey` are pure functions of `(projectId, taskId, repoKey)` — `WORKTREES_DIR` is itself an ambient
  input the formula closes over, not one of the three named args. `db.getWedgedWorktree`/
  `recordWorktreeWedgeAttempt`/`markWorktreeNeedsHuman`/`clearWedgedWorktree` are now identity-keyed
  (`worktreeIdentityKey`, both comparison sides, never the stored field or an fs/git call) — see the
  Follow-up under `docs/decisions/40b63f1c-boot-reconcile-worktree-protection-keyed-on-path-not-row.md`
  for the full mechanism, the two drift sources, and why the consequence of a miss was bounded rather than
  a repeat of this card's own P1 class. Do NOT revert `reclaimWedgedWorktreePathForSpawn`'s wedge lookup
  (or db.ts's own methods) back to raw `===` on the strength of this bullet's original text.
- Do not delete the `.stale-<ts>` dirs this fix (and round 1) leave behind by hand as a one-off cleanup —
  they are SAFE to delete (confirmed by this card: they're an inert, orphaned rename target with no git
  linkage and no tracking entry pointing at them), but nothing auto-reaps them yet; surfacing them for
  reclaim is tracked separately (card `ad34efb5`, out of this card's scope).

### Source

`packages/daemon/src/sessions/service.ts` (`claimedWorktreePaths`, `findLiveSessionClaimingWorktreePath`,
`gcWorktreeDir`'s `staleKnowledgeGuard`/`opts.wedgeSnapshot`, `reclaimWedgedWorktreePathForSpawn`,
`sweepWedgedWorktreesOnce`) and `packages/daemon/src/git/worktrees.ts` (`renameWorktreeDirAside`) — fixed
on card `a5d9c458` round 2 (Code Review `ffc2b31b`), caught by this card's own regression tests in
`packages/daemon/test/worktree-wedge-retry.mjs` and `packages/daemon/test/createworktree-wedge-reclaim.mjs`.

## ROUND 3 (delta Code Review `133a89bc`) — the repeated re-check still missed the awaits INSIDE removeWorktree itself

### Narrative

Round 2's "repeat the staleKnowledge guard right before `removeWorktree`" fix (above) closed the gap
between the nested-repo scan/reap and the removal call — but `removeWorktree` itself is not instantaneous:
its own clean-reject retry loop awaits `removeDir` (bounded by `gitOpMs`) and, on a clean (non-killed)
reject, a further `delay(500)` before trying again, up to `REMOVE_DIR_CLEAN_RETRY_ATTEMPTS` times. A
respawn's `reclaimWedgedWorktreePathForSpawn` racing in during any of THOSE awaits — most plausibly the
500ms retry delay — would see no claim yet (round 2's checks already ran and passed), rename the dir
aside, and let `createWorktree` cut a fresh worktree at the now-freed path. The sweep's NEXT attempt
inside the SAME `removeWorktree` call then proceeds to `removeDir` the brand-new worktree, not the stale
one it started on. A one-more-re-check approach doesn't close this: the race window is now INSIDE a
function whose own internal retry loop has multiple awaits, so no finite number of checks placed only at
`gcWorktreeDir`'s call boundary can cover it.

The fix is MUTUAL EXCLUSION instead of another re-check: `gcWorktreeDir` marks the normalized path
REMOVING in a new `removingWorktreePaths` Set — set synchronously right after its own last
`staleKnowledgeGuard()` passes (no await between the guard and the mark), cleared in a `finally` that
wraps the entire `removeWorktree` call and the outcome handling after it. While a path is marked,
`reclaimWedgedWorktreePathForSpawn` REFUSES outright (throws, naming the path) rather than claiming over
it — a respawn racing in during ANY of `removeWorktree`'s internal awaits now finds the mark and backs
off, instead of a check that might or might not still be looking. `removeWorktree` itself also gained a
belt-and-braces `deps.abortIfClaimed` predicate, re-consulted before EVERY retry attempt (not just once):
if a future CLAIM-side path ever adds to `claimedWorktreePaths` without first checking
`removingWorktreePaths` (bypassing the mutual exclusion above), a claim appearing mid-retry still halts
the loop rather than touching the directory again. This is scoped narrowly — see the "Do not" section's
own correction on what `abortIfClaimed` does and does not cover.

Two secondary fixes landed alongside the mutex: (1) `reclaimWedgedWorktreePathForSpawn` now returns
`{ worktreePath, release }` instead of a bare path string — the UNIT that mints a claim also owns
releasing it (an idempotent `release()` closure), so a caller only ever calls `.release()` and never
touches `claimedWorktreePaths`/`normForCompare` directly, closing the "a third caller forgets to release
correctly" risk a bare-string contract leaves open. (2) the `(entry-superseded)` regression test
(`worktree-wedge-retry.mjs`) now seeds its OLD wedge entry's `firstWedgedAt` via a direct `setMeta` write
to an explicitly past timestamp, rather than via `recordWorktreeWedgeAttempt`'s own `now` stamp — the
test's whole point is that the supersede check discriminates on `firstWedgedAt` changing, and two
`Date.now()` calls landing in the SAME millisecond would NOT have made that assertion pass vacuously —
with equal timestamps the supersede check sees no change, removal proceeds, and `removeDir` is actually
invoked, so the test's own `removeDirCallsForS === 0` assertion would FAIL. It is a false RED (a flaky
test failure from timing coincidence), not a silently-vacuous pass.

### Do not

- Do not rely on a repeated point-in-time re-check alone to guard a removal that itself awaits more than
  once (`removeWorktree`'s own clean-reject retry loop) — use mutual exclusion (`removingWorktreePaths`)
  for the whole duration of the removal instead; no finite number of re-checks at the caller's boundary
  can cover an unbounded number of awaits inside the callee.
- Do not mark `removingWorktreePaths` before the LAST `staleKnowledgeGuard()` call has passed, and do not
  leave any await between that guard passing and the mark being set — a gap there reopens exactly the
  window this fix closes.
- Do not let `reclaimWedgedWorktreePathForSpawn` add a path to `claimedWorktreePaths` while that same path
  is in `removingWorktreePaths` — check `removingWorktreePaths` FIRST and throw before touching
  `claimedWorktreePaths` at all.
- Do not treat `removeWorktree`'s `abortIfClaimed` as the primary defense — it is deliberately
  "belt-and-braces" (its own doc comment says so); the primary defense is the caller-side mutual
  exclusion. Do not remove `abortIfClaimed` on the theory that the mutex alone is sufficient — it is the
  only thing that would still catch a future bypass of that mutex. Scope that claim precisely: it covers
  only a future CLAIM-side bypass — some later `claimedWorktreePaths`-granting path (a future
  `reclaimWedgedWorktreePathForSpawn`, or its replacement) that forgets to check `removingWorktreePaths`
  first, the way the current one does. It gives NO protection against a wholly new caller that invokes
  `removeWorktree` directly without going through `gcWorktreeDir`'s mark/claim machinery at all — such a
  caller would never populate `claimedWorktreePaths` in the first place, so `abortIfClaimed` (which only
  ever reads that Set) has nothing to catch; it would need its own equivalent guard.
- Do not go back to a bare worktree-path string return from `reclaimWedgedWorktreePathForSpawn` — the
  returned `release()` is what lets the UNIT own the claim's lifecycle instead of every caller hand-rolling
  its own `claimedWorktreePaths.delete(normForCompare(path))`.

### Source

`packages/daemon/src/sessions/service.ts` (`removingWorktreePaths`, `gcWorktreeDir`'s mutex mark/release,
`reclaimWedgedWorktreePathForSpawn`'s `{worktreePath, release}` return) and
`packages/daemon/src/git/worktrees.ts` (`BoundedGitDeps.abortIfClaimed`, `removeWorktree`'s retry-loop
re-check) — fixed on card `a5d9c458` round 3 (delta Code Review `133a89bc`), caught by
`packages/daemon/test/createworktree-wedge-reclaim.mjs` section (H),
`packages/daemon/test/worker-spawn-worktree-path-claim.mjs`, and
`packages/daemon/test/worktrees.mjs` section (l4).

## ROUND 4 (card `f487a493`, delta CR `c37f17a2` of round 3) — an abort is a distinct, non-alarming outcome, not a failed removal

### Narrative

Round 3's `abortIfClaimed` (above) stopped the retry loop correctly, but `removeWorktree` reported it
exactly like an ordinary clean-reject-then-give-up: `{removed: false, wedged: false}`, indistinguishable
from a genuine `left-on-disk` failure. Two logs could fire for the SAME event and contradict each
other — "aborting removal ... mid-retry ... Nothing further was touched" immediately followed by "could
not remove dir ... left on disk for a later GC" — and the "mid-retry" wording was itself wrong whenever
the abort fired on attempt 1 (reachable via `finalizeMerge`'s own call, which never sets
`staleKnowledge` and so never pre-checks `claimedWorktreePaths` the way the stale-knowledge callers do —
a concurrent `reclaimWedgedWorktreePathForSpawn` call can populate `claimedWorktreePaths` for this path
in the window before `gcWorktreeDir` marks it `removingWorktreePaths`, so `abortIfClaimed` can trip on
the very first `removeDir` attempt). Downstream, `gcWorktreeDir` folded this into plain `"left-on-disk"`,
and `worker_merge_confirm` surfaced it to the manager as an ordinary failed cleanup — worded as if
something needed fixing, when a respawn claiming the path is correct, safe behaviour.

The fix: `removeWorktree` now returns a third, distinct `aborted: boolean` field. The generic "could not
remove dir" warn is skipped entirely when `aborted` is true (no more contradictory double-log), and the
abort's own log drops "mid-retry" in favor of wording CONDITIONAL on the attempt number — "Nothing was
touched" on attempt 1 (no `removeDir` call has run yet), "Nothing further was touched" on a later one
(prior attempts already called `removeDir`, even though each rejected cleanly). `gcWorktreeDir` checks
`aborted` before `wedged`/`left-on-disk` and returns a new, distinct outcome, `"claimed"`, with its own
non-alarming log line. `finalizeWorktreeAndBranch` excludes `"claimed"` from the outcomes it folds into
`worktreeGcOutcome` (the field `worker_merge_confirm`'s `warning` text is built from) — the same
treatment `"removed"` itself gets, since nothing here is actually wrong.

### Do not

- Do not report an `abortIfClaimed` stop the same way as a genuine removal failure — it is a correct,
  expected outcome (a respawn claimed the path), never a "left on disk" or "wedged" failure to retry.
- Do not word the abort log as "mid-retry" — it fires identically on attempt 1 (reachable via
  `finalizeMerge`'s non-`staleKnowledge` call) and on a later retry; the wording must not imply it is
  retry-specific. Do not make the "nothing was touched" half attempt-INDEPENDENT either: on attempt 1 no
  `removeDir` call has run yet, so "Nothing was touched" is literally true; by attempt > 1 one or more
  PRIOR attempts already called `removeDir` (even though each rejected cleanly), so it must read "Nothing
  FURTHER was touched" — the two cases are not interchangeable wording.
- Do not let both the abort log and the generic "could not remove dir" warn fire for the same event —
  they describe the SAME outcome and previously contradicted each other.
- Do not surface `"claimed"` to a manager via `worktreeGcWarning`/`worktreeGcOutcome` — it is a
  non-alarming, expected outcome, not a cleanup failure needing attention.

### Source

`packages/daemon/src/git/worktrees.ts` (`removeWorktree`'s `aborted` field and its log text) and
`packages/daemon/src/sessions/service.ts` (`gcWorktreeDir`'s `"claimed"` outcome,
`finalizeWorktreeAndBranch`'s exclusion) — fixed on card `f487a493`.

## ROUND 5 (Code Review `f9833ee7` of `73cc6d06`, card `beeae646`) — the claim was never checked BEFORE reap at all

### Narrative

Round 4 (above) gave `"claimed"` a distinct, non-alarming outcome once `removeWorktree`'s own
`abortIfClaimed` (or the post-reap `this.claimedWorktreePaths.has(normPath)` check, for `finalizeMerge`'s
non-`staleKnowledge` call shape) catches a reclaim. But neither of those checks runs until AFTER the
nested-repo scan AND the process reap have already executed. For `finalizeMerge`'s call specifically —
the one real production caller that never sets `opts.staleKnowledge` — `staleKnowledgeGuard()` is a
complete no-op (it returns `null` immediately whenever `!opts?.staleKnowledge`), so there was NO claim
check anywhere before reap: a reclaiming spawn's claim landing during the nested-repo scan's own await, or
even during reap's own await, was only ever discovered once the post-reap check at
`this.claimedWorktreePaths.has(normPath)` ran — by which point `reapProcessesRootedInWorktree` had already
enumerated and killed every OS process it found rooted in that worktree path, potentially including the
reclaiming spawn's own in-flight `createWorktree` provisioning (`git worktree add`, then `pnpm install`,
both genuinely spawned with `cwd: worktreePath`). The removal itself was always safely aborted (the
directory was never deleted) — but reap's kill is a SEPARATE, irreversible side effect that the
removal-abort does nothing to undo.

Reproduced hermetically (no production code path, a direct `gcWorktreeDir` call shaped exactly like
`finalizeMerge`'s own: no `staleKnowledge`, `retainIfUncommitted: true`): seeding
`sessions.claimedWorktreePaths` during the injected `findNestedGitRepos` seam's own await (simulating a
reclaim landing mid-scan) and observing the injected `reapWorktreeProcesses` seam at the instant it ran
confirmed `reap` fired with the claim already present, and `removingWorktreePaths` not yet marked (that
mark only happens after reap, right before the removal itself). A negative control (same shape, no claim
seeded) confirmed reap ran with no claim present and the removal succeeded normally — the assertions
discriminate claim-present from claim-absent rather than passing vacuously.

The fix: one more, UNCONDITIONAL `this.claimedWorktreePaths.has(normPath)` check, placed immediately
before the `reap(...)` call — after the nested-repo-scan block closes, so it also catches a claim that
landed during THAT await, and before `reap` is invoked at all. Unlike `staleKnowledgeGuard`, this check is
never gated on `opts.staleKnowledge` (so it actually runs for `finalizeMerge`) and never gated on
`opts.forceRemoveWorktree` either — a `forceRemoveWorktree:true` caller skips the nested-repo scan
entirely but still reaches reap, so it has the same exposure, just a shorter window (reap's own await
only, not scan+reap). On a hit it short-circuits to `{ outcome: "claimed" }` with the same log wording the
existing post-reap check uses, plus "reap skipped" — `reap` is never invoked at all in that case. The
existing post-reap check is UNCHANGED and still needed: it is what catches a claim landing between this
new check and `removingWorktreePaths.add(normPath)` (the window the mutual-exclusion fix, round 3, closes
only for what happens AFTER that mark).

**Scope: this is not finalizeMerge-only.** The three `staleKnowledge:true` callers — the wedge sweep
(`sweepWedgedWorktreesOnce` ~:24063) and both boot-reconcile Pass B GC sites (~:25302, ~:25333) — had the
SAME scan→reap window exposed: their `earlyStaleKnowledgeGuard()` runs BEFORE the scan, and (pre-round-5)
the next claim check was the late `staleKnowledgeGuard()`, which runs AFTER reap, down past the
`retainIfUncommitted` check. A claim landing mid-scan for one of these callers was therefore just as
unprotected as `finalizeMerge`'s own. Because the new check is unconditional, it protects them too —
with one visible side effect: a mid-scan claim for a `staleKnowledge` caller now resolves as `"claimed"`
instead of what the late guard would have produced, `"reclaimed-by-live-session"`. This is harmless, not
a regression: `reclaimWedgedWorktreePathForSpawn` already unconditionally clears the wedge-tracking entry
for the path it's claiming (`this.db.clearWedgedWorktree(worktreePath)`, ~:24031), the same effect
`"reclaimed-by-live-session"`'s own handler produces explicitly — so the entry ends up cleared either way.
Neither caller inspects the outcome for either value: `sweepWedgedWorktreesOnce` discards
`gcWorktreeDir`'s return entirely, and both Pass B sites branch only on `"needs-human-skip"`/`"removed"`/
`"path-refused"` (plus `"left-on-disk"` for the second site) — `"claimed"` and
`"reclaimed-by-live-session"` both fall through their `else` chains identically, uncounted either way.

**Behaviour change, accepted (dirty-retained vs. claimed):** before this round, a `finalizeMerge` call
against a DIRTY worktree with a mid-scan claim would still reach the `opts.retainIfUncommitted` check
(after reap, since nothing caught the claim earlier) and resolve `"dirty-retained"` —
`onWorktreeRetainedDirty` fires, so the manager sees it. After this round, the new pre-reap check now
catches the claim FIRST and resolves `"claimed"` instead — no manager-facing signal at all; the
dirty-worktree observation never happens for this call, and any uncommitted content surfaces only to the
reclaiming spawn itself, via its own `reusedDirtyWorktree`/`discardedOnRecut` result from `createWorktree`.
Accepted: the new spawn now owns the directory, so it is the right place for that signal to land, not the
old (now-superseded) caller.

**Stated residual, concretely analysed (not assumed away):** this does not close a claim landing DURING
reap's own enumeration await, rather than before it. `reapProcessesRootedInWorktree`
(`packages/daemon/src/pty/host.ts` ~:5572-5584) takes exactly ONE process-list snapshot
(`enumerateWithRetry`, retried only on a timeout-shaped enumeration failure, never re-enumerated after a
kill) and kills whatever in that one snapshot matches `worktreePath` — so the only way a reclaiming
spawn's process could be caught is if it is already rooted in `worktreePath` by the time THAT snapshot is
taken. Checking where the claim and the process both come from: `reclaimWedgedWorktreePathForSpawn` adds
to `claimedWorktreePaths` SYNCHRONOUSLY (`service.ts` ~:24001) — after its own `removingWorktreePaths`
overlap-refusal loop (~:23996-24000, a plain synchronous `for` loop, no `await` anywhere in it), so there
is still no `await` between entry to the function and the claim landing, even though the add is not its
very first statement — and both real call sites (`spawnWorker` ~:8451, the batch cut ~:20194) invoke it and only
THEN `await createWorktree(...)` — so the claim is always registered strictly before `git worktree add`
runs, and `pnpm install` (`git/worktrees.ts`'s `provisionWorktreeDeps`, spawned with `cwd: worktreePath`)
runs later still. That ordering is exactly what makes the new pre-reap check effective in the ordinary
case. But it does NOT make the residual impossible: `reap`'s own enumeration is itself a real async
operation (an OS process-list call, non-blocking I/O) that yields the event loop for a genuine window —
anywhere from sub-millisecond to multiple seconds under `enumerateWithRetry`'s own retry/timeout budget —
and Node's single-threaded cooperative scheduling means a wholly separate, concurrent `worker_spawn`/batch
call can run its own synchronous claim-add and kick off `createWorktree` during exactly that window. If
that concurrent spawn's `git worktree add`/`pnpm install` manages to actually become ROOTED in
`worktreePath` before reap's enumeration snapshot is taken — plausible for a long-lived `pnpm install`
child, less so for a quick `git worktree add` — reap's single snapshot would still catch and kill it, since
reap does not re-check the claim itself. This is a genuine, non-theoretical residual, not a "can't
overlap" case — stated here rather than silently assumed closed. Closing it fully would need
`reapProcessesRootedInWorktree` itself to consult the claim (e.g. re-check immediately before each kill,
or filter the snapshot against a live claim read), which this card deliberately does NOT do — scope was
agreed as the call-site check above only.

### Do not

- Do not read a `"claimed"` outcome (or a reclaimed respawn surviving) as proof reap never ran against
  that worktree — it proves only that the DIRECTORY was never deleted. Reap's own kill is a separate,
  already-irreversible side effect this outcome does not undo and does not report on.
- Do not gate the new pre-reap `claimedWorktreePaths` check on `opts.staleKnowledge` or
  `opts.forceRemoveWorktree` — both would silently exclude `finalizeMerge`'s own call shape, the one this
  round exists to fix, and `forceRemoveWorktree:true` still reaches reap even with the scan skipped.
- Do not remove or weaken the EXISTING post-reap `claimedWorktreePaths` check on the theory that the new
  pre-reap one makes it redundant — it still catches a claim landing between the new check and
  `removingWorktreePaths.add(normPath)`.
- The reap-during-enumeration residual stated below is CLOSED as of round 6 (card `b33a8101`):
  `reapProcessesRootedInWorktree` gained `deps.abortIfClaimed`, wired into `gcWorktreeDir`'s own reap call
  via the shared `reapWorktreeUnlessClaimed` helper — see ROUND 6's own "Do not" section for the current
  rule (do not re-derive a fix for this residual a second time; it is already closed, at this exact site).
- Do not assume this fix is scoped to `finalizeMerge` alone — the `staleKnowledge:true` callers (the
  wedge sweep, both boot-reconcile Pass B GC sites) had the identical scan→reap exposure and are now
  covered too; see the scope paragraph above for why their changed `"claimed"` (was
  `"reclaimed-by-live-session"`) outcome is harmless.
- Do not treat a `finalizeMerge` call against a dirty, mid-scan-claimed worktree resolving `"claimed"`
  (with no `onWorktreeRetainedDirty` call, unlike the pre-round-5 `"dirty-retained"` outcome it would
  previously have reached) as a regression to fix — it is an accepted behaviour change; the reclaiming
  spawn now owns the directory and is the one that observes the dirt, via its own `createWorktree` result.

### Source

`packages/daemon/src/sessions/service.ts` (`gcWorktreeDir`'s new pre-reap `claimedWorktreePaths` check,
and the `finalizeWorktreeAndBranch` comment correction) and `packages/daemon/src/pty/host.ts`
(`reapProcessesRootedInWorktree`, read for the residual analysis, unchanged) — fixed on card `beeae646`
(Code Review `f9833ee7` of `73cc6d06`), caught by
`packages/daemon/test/gcworktreedir-claim-before-reap.mjs` (including its `staleKnowledge:true` case D,
added in this round's own follow-up CR pass).

## `reclaimWedgedWorktreePathForSpawn`'s `release()` is path-keyed, not ref-counted (card `f487a493`)

### Narrative

`release()` (`service.ts` ~:21722) is `this.claimedWorktreePaths.delete(normPath)` — unconditional and
keyed purely on the normalized PATH, never on which caller's claim it is. If two claimants ever held a
claim on the exact same `normPath` at once, EITHER one's `release()` would drop BOTH — there is no
ref-count, so the second claimant's "hold" would silently vanish the instant the first one lets go, even
though the second is still relying on it.

That's safe today only because the two real claimants can never legitimately target the same path at
once — verified, not assumed:

- `spawnWorker` (~:8020) calls `reclaimWedgedWorktreePathForSpawn(project.id, taskId ?? claimKey, ...)`.
  A real `taskId` can't have two concurrent claimants: `inFlightSpawnTaskIds`'s atomic check-and-set
  (`sha:93a496a0`) refuses a second concurrent spawn for the same `taskId` BEFORE this call ever runs. A
  taskless spawn mints a FRESH `randomUUID()` `claimKey` per call (`2514e6e1`) — two taskless spawns never
  share one.
- The batch merge (~:18729) calls `reclaimWedgedWorktreePathForSpawn(finalProjectId, \`batch-${opId}\`)`.
  `opId` is minted via `randomUUID()` exactly once per NEW op under its `PendingOpRegistry.attach` key
  (`pending-ops.ts`'s `attach()`, the `fresh.opId = randomUUID()` mint) — a caller attaching to an
  ALREADY-in-flight op for the same key reuses that SAME opId rather than minting a second one, so there
  is still only ONE live batch claim per key at any time; two DIFFERENT keys get DIFFERENT, freshly-minted
  opIds.
- The two claim-key shapes can never collide with EACH OTHER either: a real `taskId`/taskless `claimKey`
  is a bare UUID string, while a batch's key is always `batch-`-prefixed — different shapes, never equal.

`resolveWorktreePath` is a pure, deterministic function of `(projectId, taskId, repoKey)` (see this
record's own "Do not" on that above), so two claim keys that can never collide produce two worktree paths
that can never collide either — modulo the same baseline UUID-collision-is-negligible assumption every
other claim/identity structure in this codebase already relies on (session ids, task ids).

### Do not

- Do not add a future claimant of `claimedWorktreePaths` keyed on anything OTHER than a provably-unique,
  per-task/per-op identifier (verified the way the two existing claimants are verified above, not
  assumed) — `release()`'s path-keyed Set has no ref-count, so a genuine second claimant on the same path
  would have its hold silently dropped by the first claimant's own release.
- Do not "fix" this by ref-counting `claimedWorktreePaths` preemptively — today's two claimants are
  provably disjoint, so there is nothing to fix yet; ref-count it only if a future claimant actually
  breaks that disjointness, and say so here when it does.

### Source

`packages/daemon/src/sessions/service.ts` (`reclaimWedgedWorktreePathForSpawn`'s `release()`, the
`spawnWorker` and batch-merge call sites) and `packages/daemon/src/orchestration/pending-ops.ts`
(`PendingOpRegistry.attach`'s `opId` mint) — reviewed on card `f487a493`.

## ROUND 6 (card `b33a8101`, discovered from Code Review `74762998` on card `beeae646`) — the same
## claim-after-kill race, on the THREE sweep call sites round 5 never reached

### Narrative

Round 5 (above) closed `gcWorktreeDir`'s own scan-to-reap window, but its fix was scoped to that one
chokepoint. Three OTHER call sites in `sessions/service.ts` invoke `reapWorktreeProcesses` directly,
bypassing `gcWorktreeDir` entirely, and had NO reference to `claimedWorktreePaths` anywhere — confirmed by
reading each method body in full before writing any fix, not assumed from the call shape alone:

1. **`sweepWorktreeStrays`** (the `stopWorker`/`killAllWorkers` path, via `cancelWorkerGateThenSweep`) —
   fire-and-forget, with an enumeration window of up to ~20.5s (`reapProcessesRootedInWorktree`'s own
   worst-case retry budget). Scenario: `worker_stop` on a task, then an immediate `worker_spawn` on the
   SAME task (same deterministic worktree path, per `resolveWorktreePath`'s determinism — see this
   record's own earlier section). The sweep's enumeration can overlap the respawn's `createWorktree`
   provisioning and kill it, because `excludePids` only ever names the STOPPED worker's own pid, never a
   respawn's.
2. **`confirmWorkerMerge`'s pre-gate sweep** (`@decision c21487e8`) — runs BEFORE the confirming worker's
   OWN worktree removal, while that worker is typically still live.
3. **`runWorkerGate`'s post-timeout sweep** (`@decision 3564fd1e`'s own POST-TIMEOUT SWEEP) — runs after a
   worker's own self-check gate times out, while that worker's task is still in progress.

Hermetically reproduced (card `b33a8101`'s own blocked checkpoint, reviewed and approved before the fix
below): seeding `sessions.claimedWorktreePaths` for a worktree path, then driving `stopWorker` for a
worker at that exact path, showed the injected `reapWorktreeProcesses` seam invoked anyway — with a
control proving the SAME harness correctly observes `gcWorktreeDir`'s own (round-5) check blocking reap
for the identical claimed path, ruling out a harness blind to "reap not called" as the explanation.

A SECOND, independent residual (named but not reproduced in round 5 — see that round's own "Stated
residual" paragraph): `reapProcessesRootedInWorktree` itself (`pty/host.ts`) takes exactly ONE enumeration
snapshot, then runs a fully synchronous kill loop with no claim awareness at all — so even a caller WITH a
pre-call claim check (like `gcWorktreeDir`'s own round-5 fix) remains exposed to a claim landing DURING
that enumeration's own await, between the pre-check passing and the kill loop actually running.

### Fix

Two parts, both load-bearing (one without the other leaves a real gap):

1. **`reapProcessesRootedInWorktree` gained `deps.abortIfClaimed?: () => boolean`** (mirrors
   `removeWorktree`'s existing dep of the same name, `git/worktrees.ts`) — checked ONCE, immediately after
   enumeration resolves and before the kill loop starts; the kill loop itself has no further awaits, so one
   check there closes the "claim lands during enumeration" window completely, for ANY caller that passes
   it. Optional: a caller that omits it is byte-identical to before this round. A THROWING `abortIfClaimed`
   is treated as CLAIMED (fail-safe — never kill when the claim check itself is broken), logged distinctly
   from both the generic abort message and an enumeration failure, never falling through to the outer
   catch as a bare, misclassified failure.
2. **A single shared helper, `SessionService.reapWorktreeUnlessClaimed(worktreePath, opts)`** — a
   synchronous `claimedWorktreePaths.has(normForCompare(worktreePath))` pre-check (skip + a non-alarming
   log naming the call site on a hit, via `opts.logPrefix`/`opts.verb`) that ALWAYS forwards
   `abortIfClaimed` to whichever reap impl is active — the production `reapProcessesRootedInWorktree`
   fallback AND an injected `reapWorktreeProcesses` test seam alike. Every call site that needs this
   protection calls the helper directly; none builds its own reap closure anymore.

**Code Review `044d26f1` (on the first cut of this round, commit `ea3f9544`) found a real gap in that first
cut**, before the shared helper existed: `sweepWorktreeStrays`, `confirmWorkerMerge`'s pre-gate sweep, and
`runWorkerGate`'s post-timeout sweep each built their OWN `const reap = this.reapWorktreeProcesses ?? (...
closure wiring abortIfClaimed into the real reapProcessesRootedInWorktree fallback only ...)`. Every
SessionService-level test scenario injects `reapWorktreeProcesses`, which REPLACES that whole closure —
the ONLY place `abortIfClaimed` was ever constructed — so a test seam-based scenario could never observe
whether the forwarding was actually wired. The CR proved this concretely: stripping the
`, abortIfClaimed: () => ...` clause from all three copy-pasted closures in `dist/` left every one of
`sweep-strays-claim-before-reap.mjs`, `worktree-process-reap.mjs`, `worker-stop-reap.mjs`,
`stop-worker-cancels-gate-before-sweep.mjs`, and `gate-timeout-circuit-breaker.mjs` green — nothing would
have caught a future refactor silently dropping the forwarding. The fix is the shared helper above: one
convergence point that threads `abortIfClaimed` into the opts handed to the active impl regardless of
which impl that is, so a test CAN inject a seam that captures and asserts on the callback it received
(`sweep-strays-claim-before-reap.mjs`'s wiring-pin scenarios (J)-(M)).

**`gcWorktreeDir`'s own reap call (the round-5 site) is now ALSO routed through the shared helper** —
closing round 5's own stated reap-during-enumeration residual at that site too. Manager ruling (card
`b33a8101`): in scope for this card now that the helper exists, since it is the same bug class through the
same underlying function and the helper makes it nearly free to wire in everywhere. `gcWorktreeDir` KEEPS
its own existing, distinct pre-check (the one that returns `{outcome:"claimed"}` and skips the ENTIRE
removal, not just the reap sub-step) completely unchanged — that early return controls whether removal
proceeds at all and is orthogonal to the helper's own (now redundant-but-harmless, since there is no await
between the two) internal pre-check. Only the subsequent `reap(...)` call itself was replaced with a call
to `reapWorktreeUnlessClaimed`, adding `abortIfClaimed` coverage for the enumeration window specifically.

**`confirmWorkerMerge` has FIVE reap call sites, not one** — all now routed through the shared helper
directly (no more shared local closure), each with its own `opts.verb` naming which sub-step it guards:
1. The **pre-gate sweep** (this card's originally-named site) — `verb: "swept pre-gate"`.
2. The **inert-reclassify reunion** reap (~L17839 pre-round-2-edit; re-derive the live line, don't trust
   this number — guards the re-union triggered by a main/branch-tip move detected during the inert-diff
   reclassification) — `verb: "swept before the inert-reclassify re-union"`.
3. **`reunionAtAdmission`**'s reap (~L18244 pre-round-2-edit) — guards the admission-time re-union when
   `gateBaseMainHead` moved during the queue wait — `verb: "swept before the admission-time re-union"`.
4. The **attempt-1 post-timeout sweep** (~L18470 pre-round-2-edit) — `verb: "swept post-timeout (attempt 1)"`.
5. The **transient-retry post-timeout sweep** (~L18517 pre-round-2-edit, inside the auto-retry `next`
   callback) — `verb: "swept post-timeout (transient retry)"`.

Every one of these five now gets BOTH the synchronous pre-check (round 1 of this card gave only #1 that)
AND `abortIfClaimed` (round 1 gave all five that, via the shared closure that no longer exists in this
form) — the shared helper makes this uniform instead of a special case for the pre-gate call alone.

**Safety basis for why a claim can legitimately exist on a CONFIRMING worker's own worktree path at all**
(the scenario every one of these five sites, plus `runWorkerGate`'s, must tolerate): `spawnWorker` refuses
a second live worker on an already-live task (`db.liveSessionIdForTask(taskId)`, `~L8274`) — so a
confirming/gating worker that is genuinely LIVE can never be raced by a same-task respawn; the claim this
card protects against can only form when that worker's task is NOT currently live (a crash, a stop/recycle
race, a transitional processState window) WHILE a confirm/gate call is still mid-flight against its
worktree. Every reap call this card touches is already wrapped in a best-effort `try`/`catch` (or,
`sweepWorktreeStrays`, a fire-and-forget `.catch()`) — so skipping a reap on a hit never throws; it yields,
at worst, a reported, retryable merge/gate failure (an escaped build child the reap would have cleared
stays alive, which the EXISTING EPERM-class failure handling already surfaces), never a silent wedge.

A claimed worktree's merge is NOT blocked by any of this: `confirmWorkerMerge` still returns `merged:true`
even when its pre-gate reap (and, independently, `gcWorktreeDir`'s own post-merge reap) are both skipped —
the squash already landed on main before worktree cleanup runs, and a `"claimed"` GC outcome is deliberately
excluded from `worktreeGcOutcome`/`worktreeGcWarning` (round 4/5's own rule), never surfaced as a merge
failure.

### Do not

- Do not assume `gcWorktreeDir`'s round-5 fix covers the other sweep sites — none of them route through
  `gcWorktreeDir` at all; each calls `reapWorktreeUnlessClaimed` directly.
- Do not rely on the synchronous pre-call check alone as a complete fix for any site — it only closes
  "claimed before the sweep fires"; `abortIfClaimed` is what closes "claimed DURING the sweep's own
  enumeration", and both are needed together, which is exactly why they're bundled into ONE helper rather
  than left as two things a caller could adopt only one of.
- Do not build a per-call-site `reap` closure again (the shape this round's own Code Review found broken)
  — route every new or changed reap call through `reapWorktreeUnlessClaimed`. A hand-rolled closure is
  invisible to a test that injects `reapWorktreeProcesses`, since the injected seam REPLACES whatever
  closure would have wired `abortIfClaimed` in — only a shared, caller-independent convergence point lets
  a test assert the forwarding actually happened.
- Do not treat `gcWorktreeDir`'s own pre-check (the one returning `{outcome:"claimed"}`) as redundant with
  the helper's internal one and remove it — they control different things (whether removal proceeds at
  all, vs. whether this ONE reap call fires) and the helper's check firing there is a no-op by
  construction (no await separates the two), not a signal that one of them is unnecessary.
- Do not treat a `"claimed"`-outcome-adjacent merge (pre-gate reap skipped, post-merge reap also skipped)
  as a merge failure or a reason to retry — `merged:true` still holds; see round 4/5's own identical rule.
- Do not re-derive the `confirmWorkerMerge` reuse-site line numbers above as still-current — they are
  stamped to the pre-round-2-edit state and will drift with the next unrelated edit to that (very large)
  method; re-find them by the quoted `verb` strings or the surrounding decision anchors instead.

### Source

`packages/daemon/src/pty/host.ts` (`reapProcessesRootedInWorktree`'s `deps.abortIfClaimed`, including its
throw-safety) and `packages/daemon/src/sessions/service.ts` (`reapWorktreeUnlessClaimed`,
`sweepWorktreeStrays`, `confirmWorkerMerge`'s five reap call sites, `runWorkerGate`'s post-timeout sweep,
`gcWorktreeDir`'s own reap call) — fixed on card `b33a8101` (round 6 of `a5d9c458`, discovered from Code
Review `74762998` on card `beeae646`; folded in after a second Code Review, `044d26f1`, on the first cut),
caught by `packages/daemon/test/sweep-strays-claim-before-reap.mjs`.
