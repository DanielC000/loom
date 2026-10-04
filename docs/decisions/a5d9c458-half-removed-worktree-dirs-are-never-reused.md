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
- Do not normalize (`normForCompare`) the `db.getWedgedWorktree`/`recordWorktreeWedgeAttempt` lookup
  inside `reclaimWedgedWorktreePathForSpawn` as a "safety" change — exact-string match is correct there:
  `worktreePath` and every `WedgedWorktreeEntry.worktreePath` ever recorded for it are both the output of
  the SAME `resolveWorktreePath(projectId, taskId, repoKey)` call given the SAME inputs, so they match
  byte-for-byte. ("By construction" overstates this: it holds because `resolveWorktreePath`/`taskKey`
  happen to be pure functions of their inputs today, not because the type system guarantees it — if that
  formula ever stops being a pure deterministic function of exactly those inputs, re-verify this bullet.)
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
