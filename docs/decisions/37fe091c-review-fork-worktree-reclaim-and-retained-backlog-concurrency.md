# 37fe091c — a shared base-ref helper closes Pass B's review-fork blindness; bounded concurrency fixes the retained-backlog timeout

## Narrative

Owner-reported disk growth: ~485 worktree dirs under `.loom-worktrees/<Loom project>` (~100+ GB), all
belonging to non-merged sessions. Investigation (read-only; git + the daemon's own fast GET endpoints,
never the DB) found:

- Boot-reconcile Pass B's `worktreeHasWork(repoPath, worktreePath, s.branch, "HEAD", …)` call hardcoded
  `"HEAD"` as the comparison base for EVERY session, including a REVIEW spawn whose branch is cut from the
  REVIEWED branch's tip (`createWorktree`'s `forkFrom` param, card 47bbdc3f). A review worktree therefore
  starts out already carrying every commit the reviewed branch had at fork time — none of which the
  reviewer authored — so comparing against mainline `HEAD` counted those inherited commits as "the
  reviewer's own ahead-of-base work" and kept the worktree forever, even when the reviewer added nothing.
- This exact defect had already been fixed ONCE, in a sibling caller: `precheckWorkerDone`'s caller (the
  `worker_report(done)` ahead-of-base check) computes `worker.reviewBaseSha ?? "HEAD"` (card b866ab64),
  specifically because "a reviewer that authors nothing is unconditionally refused the very `noChanges:true`
  report its role exists to file" otherwise. Pass B's own `worktreeHasWork` call was never updated to match
  — the two-path asymmetry that let the bug persist.
- `GET /api/worktrees/retained` (`SessionService.getRetainedWorktrees` → `classifyRetainedWorktree`) timed
  out at 120s. Measured directly: each classify entry issues two bounded git subprocess calls
  (`git status --porcelain -z`, `git rev-list --count`), ~0.9-2s each on the investigating host, ~2.5s
  combined per entry. At ~475-485 retained entries, run fully SERIALLY (a plain `for…of await` loop), that
  is ~20-24 minutes wall clock — cleanly explaining the timeout. No single git call was pathologically
  slow; it was pure lack of concurrency.
- A third caller with the identical base-ref defect was found during the mandated sweep:
  `SessionService.commitsAheadOfMain` (backing `getDanglingWorkers`, card ba41b402) also hardcoded `HEAD`
  — a taskless, zero-added-commit review spawn's stopped/archived worktree would be wrongly surfaced as
  "dangling" purely from commits it only ever inherited.
- `SessionService.listNodeModulesReclaimCandidates` was checked and found NOT applicable — it has no
  ahead-of-base logic at all (eligibility is `resumability === "dead"` + age + `node_modules` presence
  only).

## The fix

1. `workerBaseRef(reviewBaseSha)` (`git/worktrees.ts`) is the ONE place that resolves `reviewBaseSha ??
   "HEAD"`. Every caller that measures a worker's OWN ahead-of-base work now routes through it:
   `precheckWorkerDone`'s caller (refactored from its own correct-but-inline computation),
   boot-reconcile Pass B's `worktreeHasWork` call, `classifyRetainedWorktree` (the retained-backlog
   display — `RetainedWorktreeRecord`/`RetainedWorktreeEntry` both now carry `reviewBaseSha`, stamped by
   Pass B at KEEP time, so the display never re-derives it and never falls out of sync with the KEEP
   decision), and `commitsAheadOfBase` (renamed from `commitsAheadOfMain` in CR round 2 — see below — to
   reflect what it actually measures now).
2. A new boot-reconcile counter, `worktreesReviewForkReclaimed`, is the subset of `worktreesPruned`
   reclaimed specifically because `s.reviewBaseSha` was set — logged as a separate boot-log line (never
   folded into the existing combined summary sentence, per this file's own established convention) so the
   first post-deploy boot shows the fix's own effect at a glance.
3. `mapWithConcurrency` (`src/concurrency.ts`, new file) replaces `getRetainedWorktrees`' serial classify
   loop with a small, fixed-size pool (`RETAINED_WORKTREE_CLASSIFY_CONCURRENCY = 6`) — never an unbounded
   `Promise.all` over the whole retained set, which would just trade "too slow" for "too many concurrent
   git subprocesses at once."

## Do not

- Do not recompute `reviewBaseSha ?? "HEAD"` inline at a new call site — route through `workerBaseRef`.
  That inline duplication is exactly how Pass B drifted from `precheckWorkerDone`'s own already-correct
  behavior in the first place.
- Do not widen `workerBaseRef`'s fallback, or treat an unresolvable `reviewBaseSha` as equivalent to
  `null`/absent — `worktreeHasWork`'s existing fail-safe catch (an unresolvable base makes `git rev-list`
  error, caught, returns `true`) is what keeps a worktree whose review-base record is corrupt; do not add a
  "resolve it first, fall back to HEAD on failure" step, which would silently reintroduce the review-fork
  blindness for exactly that corrupted-record case.
- Do not touch the dirty-tree branch of `worktreeHasWork`/`precheckWorkerDone`/`classifyRetainedWorktree`
  — only the ahead-count BASE changed; a dirty working tree is still an unconditional KEEP regardless of
  base, by construction (untouched code path).
- Do not re-apply the `ba41b402`-rejected branch-name/content-hash equivalence heuristic anywhere in this
  area (this card deliberately avoided it for the "content landed elsewhere" bucket — see that card's own
  "Do not" list) — `reviewBaseSha` is an authoritative, server-stamped field, not a heuristic, and this fix
  does not extend into content-hash/branch-name matching.
- Do not replace `mapWithConcurrency`'s bounded pool with `Promise.all` over the whole retained set "since
  it's simpler" — that is the exact failure mode (unbounded concurrent git subprocesses) this helper exists
  to avoid; see the 2026-07-15 unpinned-gate incident this project already measured (CLAUDE.md's `run_gate`
  concurrency note) for why an unbounded burst of git subprocesses is a real host-starvation risk, not a
  theoretical one.
- Do not assume `RETAINED_WORKTREE_CLASSIFY_CONCURRENCY` fixes the timeout at an arbitrarily large retained
  count — it's a linear speedup (≈6x), not a complexity-class change; if the retained backlog grows an
  order of magnitude beyond what was measured here, re-measure before assuming this bound still lands well
  under a reasonable client timeout.

## Scope note (Phase 2 deferred)

The "content landed elsewhere" bucket (a stopped/recycled worker whose content later shipped via a
DIFFERENT branch) is explicitly OUT of this card — it needs the bound task's `mergedSha`/pathset-verified
merge metadata (the SAME discriminator `ba41b402` already validated for the dangling-worker surface), not
a worktree-local base-ref fix, and the owner wants it carded separately once Phase 1's actual reclaim
volume is observed.

## Round 2: review-spawn worktree aliasing (CR finding)

Code Review on commit `72922fa2` (the Phase 1/3 landing above) found ONE blocking issue, reproduced
hermetically. `createWorktree` resolves `worktreePath`/`branch` from `taskId` alone
(`resolveWorktreePath`/`loom/<taskKey>`) — a review spawn passing `taskId=T` plus
`reviewOfWorkerSessionId`/`reviewOfTaskId` also resolving to T's own branch makes `createWorktree` find
that path/branch ALREADY EXISTS (the author's own worker already created it), so it silently takes the
REUSE/REATTACH path instead of the fresh `-b branch forkFrom` cut — `forkFrom` is never even consulted.

But `spawnWorker`'s stamping line (service.ts ~8617, pre-round-2) computed `reviewBaseSha:
reviewForkFrom?.headSha ?? null` unconditionally, regardless of which path `createWorktree` actually took.
So the ALIASED "reviewer" session row got `reviewBaseSha` stamped to the reviewed (= the author's own)
tip, while the AUTHOR's own row for the same path correctly has `reviewBaseSha: null`.

Boot-reconcile Pass B decides a worktree PATH exactly once, from whichever session row it visits first —
`listAllSessionsIncludingArchived()` orders `last_activity DESC`, so the newer row (the aliased reviewer
spawn) is visited first. Phase 1's own fix made Pass B measure ahead-of-base via
`workerBaseRef(s.reviewBaseSha)` — using THIS row's stamped value, the author's real unmerged commits read
as 0 commits ahead of their OWN tip (trivially true — the "review base" IS the author's own tip), the tree
is clean, so `worktreeHasWork` returns `false`, and the author's worktree directory is DELETED. The branch
ref survives (only the worktree is removed), but the work drops out of every dir-based view, and any
gitignored content in the worktree is lost outright.

This is a genuine regression introduced BY Phase 1's own fix: before it, Pass B always used mainline
`HEAD` regardless of `reviewBaseSha`, so the aliasing defect was inert (the stamped-but-wrong
`reviewBaseSha` was simply never read). Making `reviewBaseSha` load-bearing for a real GC decision is what
turned a harmless mis-stamp into a data-loss path.

### The round-2 fix (both halves, belt and braces)

1. **At the source**: `WorktreeInfo.forkedFromReviewed` (true only for the genuine fresh `-b branch
   forkFrom` cut) gates a new `reviewBaseShaToStamp` function — an aliased spawn now stamps `null`, exactly
   like a non-review worker.
2. **In Pass B, independently**: `reviewBaseShaConsensusByPath` groups every session row by `worktreePath`
   first; a path's `reviewBaseSha` is only trusted when EVERY row aliasing it agrees on the same non-empty
   value, otherwise Pass B falls back to mainline `HEAD` for that path — the same safe behavior as before
   `reviewBaseSha` existed at all.

Either fix alone is sufficient to protect the author's worktree (proven: test (f) in
`worktree-review-base-reclaim.mjs` stays GREEN with either fix reverted alone, and goes RED only when BOTH
are reverted together, via a real revert/rebuild/restore cycle — not merely asserted).

Minors also landed in round 2: `normalizeReviewBaseSha` folds the empty-string predicate into
`workerBaseRef` (the old ad hoc `typeof x === "string" && x.length > 0` check, duplicated at several call
sites); `commitsAheadOfMain` renamed to `commitsAheadOfBase` (plus its own stale doc comment, which still
described a mainline-only check); `mapWithConcurrency` documents and tests its `Promise.all`-inherited
rejection semantics (propagate-first-error, never cancels other in-flight work) and uses a NaN-safe
`!(limit >= 1)` admission guard; `worker-list-dangling.mjs` gained review-spawn cases for
`commitsAheadOfBase` (0 own commits excluded, 1 surfaced) plus a negative control proving the fixture's
inherited commits would otherwise have tripped a non-review-aware check.

### Do not (round 2)

- Do not trust `Session.reviewBaseSha` read off a single row for any GC/reclaim decision without going
  through `reviewBaseShaConsensusByPath` first — a worktree PATH can be aliased by more than one session
  row, and the two rows' own `reviewBaseSha` values can disagree.
- Do not assume `createWorktree`'s `forkFrom` parameter was actually consulted just because it was passed
  — check `WorktreeInfo.forkedFromReviewed` (reuse/reattach silently ignores it).
- Do not duplicate `reviewBaseShaToStamp`'s gating expression inline at a new call site — route through the
  shared function so a test exercising it tests the REAL code, not a copy that can drift.
- Do not treat this as closed by fix (1) alone "because it prevents the bad stamp at the source" — fix (2)
  is deliberately independent defense-in-depth for exactly the case where some OTHER future code path
  stamps `reviewBaseSha` without going through `reviewBaseShaToStamp`.

## Round 3: the legacy residual, a required test gap, and comment trims

CR round 2's own ruling flagged a REQUIRED gap in round 2's own test coverage, and a REQUIRED residual
risk on the first deploy boot against the real DB's pre-round-2-fix rows.

### The legacy residual

Since `b866ab64`'s own era (before this card's round-2 fix existed), a session row created by an aliased
review spawn could already carry a WRONG `reviewBaseSha` — the reviewed (= the author's own) tip,
unconditionally stamped regardless of which path `createWorktree` actually took. `reviewBaseShaConsensusByPath`
protects against this ONLY while the author's own row (carrying `reviewBaseSha: null` for the same path)
still exists to disagree. If that author row has since been hard-deleted (DB cleanup, archival pruning —
anything that drops the row entirely rather than merely archiving it), the consensus computation sees only
the ONE surviving (wrongly-stamped) row for that path, finds unanimous "agreement" with itself, and trusts
the bad sha — reintroducing the exact data-loss path round 2 closed, on the very first boot after this
deploy reconciles against real, pre-existing DB rows.

**The fix:** Pass B trusts a path's consensus `reviewBaseSha` ONLY when the CURRENT row being visited is
TASKLESS (`taskId == null`). A taskless spawn's `worktreePath` is keyed off a fresh per-call UUID (see
project memory `worktreepath-is-per-task-not-per-spawn`) that no other session can ever share — it is
structurally incapable of being the aliased half of the round-2 defect. The round-2 aliasing scenario
requires the reviewer spawn to carry the SAME `taskId` as the author (so `createWorktree` resolves to the
author's own path) — i.e. the aliasing-prone row is always TASKED. Gating on `taskId == null` therefore
excludes exactly the rows that can ever be wrongly stamped, while leaving every genuine taskless review
spawn's reclaim (the card's original Phase-1 goal) untouched. A TASKED row's `reviewBaseSha` is never
trusted here, fails safe to mainline `HEAD` — the exact behavior Pass B had before `reviewBaseSha` was
ever read, so a tasked review spawn simply stops being reclaimed by this mechanism rather than risking the
author's worktree.

### Round-2 test gap (now closed)

Round 2's own fix (the `forkedFromReviewed` gate + `reviewBaseShaToStamp`) shipped with no test asserting
the POSITIVE case (`forkedFromReviewed === true` on a genuine fresh `-b branch forkFrom` cut) or a REATTACH
case (`forkedFromReviewed === false` when a worktree dir was removed but its branch survived, then
re-created with `forkFrom` passed again) — both NC4 (reverting the spawn-time stamping line to its
pre-round-2 unconditional form) and NC5 (hardcoding `forkedFromReviewed = false` in `createWorktree`)
stayed green against the existing suite, meaning the whole fix could silently regress with nothing to
catch it. `worktree-review-base-reclaim.mjs` now asserts both the positive-fork and reattach cases
directly against `createWorktree`'s real return value, and `review-spawn-nochanges.mjs` drives a REAL
`spawnWorker` review spawn (fresh AND aliased) and reads the stamped `reviewBaseSha` back off the row.

### Do not (round 3)

- Do not widen the taskless gate to "trust a tasked row's reviewBaseSha when no other row shares its
  path" — that is exactly the check that already failed once a hard-deleted sibling made the path
  APPEAR unshared; `taskId == null` is a structural guarantee, a liveness scan of current rows is not.
- Do not read a tasked review spawn's being excluded from this reclaim mechanism as a regression — it is
  the deliberate, fail-safe trade: it only ever stops gaining the Phase-1 ahead-of-base reclaim, never
  loses anything it already had (still falls back to `HEAD`, exactly as before `reviewBaseSha` existed).

## Round 3 follow-up: the shared trust primitive is PATH-level, and the two-path asymmetry

CR round 3 came back healthy and mergeable, with one residual: `getDanglingWorkers`'s `commitsAheadOfBase`
(the `worker_list` dangling-worker surface) still read a session row's `reviewBaseSha` RAW, with no
taskless gate at all — a two-path asymmetry against Pass B's now-gated read. A lone TASKED row carrying a
legacy (pre-round-2-fix) `reviewBaseSha` equal to its own tip, with its aliasing sibling row hard-deleted,
would read 0-ahead against itself and silently drop out of the dangling-worker view — the exact same class
of hiding round 3's main fix closed for Pass B, just via a different caller.

**The fix:** `trustedReviewBaseSha(rows)` (`git/worktrees.ts`) is now the ONE shared primitive — trusted
only when EVERY row in `rows` is taskless AND they all agree on the same non-empty value, `null`
otherwise. `reviewBaseShaConsensusByPath` is refactored to group a session set by path and call this
PER PATH (superseding round 3's original "keep the gate at Pass B's own call site" — see below), and Pass
B's own call site no longer re-derives a per-row taskless check at all; it just reads the path's already-
gated consensus. This closes CR round 3's nitpick 2: the OLD per-row gate (`s.taskId == null` at the
VISITING row) depended on which row Pass B happened to visit first for a shared path — the taskless-ness
of the path is now decided once, from every row sharing it, independent of visit order.

`commitsAheadOfBase` now calls the SAME `trustedReviewBaseSha`, fed `w`'s own row plus every sibling
sharing `w.worktreePath` (via the new `Db.listSessionsAtWorktreePath`, read fresh — never cached, since a
dangling check runs against archived rows whose siblings don't change once frozen). `getDanglingWorkers`'s
own branch condition widened from `if (!w.taskId)` to `if (!w.taskId || normalizeReviewBaseSha(w.reviewBaseSha) !== null)`
— a TASKED row that carries a `reviewBaseSha` (a review spawn, aliased or legitimately task-scoped) is now
ALSO judged by its own ahead-count, not left to rely solely on its task's `mergedSha` (which a review-only
task may never carry at all). Test (M) in `worker-list-dangling.mjs`: a lone TASKED row with a legacy
reviewBaseSha equal to its own tip, a real unmerged commit, no sibling row ⇒ APPEARS. Proven to depend on
the fix: reverting `commitsAheadOfBase` to a raw `w.reviewBaseSha` read (NC6) made exactly this one
assertion go RED (clear tsconfig.tsbuildinfo, rebuild, run — then restored byte-identically, rebuilt,
re-ran green).

`precheckWorkerDone`'s caller (the live `worker_report(done)` ahead-of-base check, service.ts ~12621)
deliberately KEEPS its raw `worker.reviewBaseSha` read, ungated — safe because `worker` there is always
the LIVE session reporting on ITSELF. A legacy bad stamp can only exist on a row spawned by the
pre-round-2-fix code; any session alive today was necessarily spawned by code at or after this fix's own
deploy (the daemon restart needed to ship it resumes, never respawns-with-a-bad-stamp, every session that
was already live), so a live row's own `reviewBaseSha` is always correctly gated at the SOURCE
(`reviewBaseShaToStamp`) by construction — there is no live-row case this caller needs to defend against.

`concurrency.mjs`'s scenario (5) now races its `item2Done` hook against a 5s bounded timeout that fails
the check loudly (never a silent hang) if a future regression ever stops item 2 from completing.

### Do not (round 3 follow-up)

- Do not re-derive a per-row taskless check at Pass B's own call site, or at any new ahead-of-base-trust
  call site — route through `trustedReviewBaseSha` (directly, or via `reviewBaseShaConsensusByPath`'s
  own per-path grouping), fed every row sharing the path, never a single row read in isolation.
- Do not add a taskless gate to `precheckWorkerDone`'s caller — it operates on a LIVE row reporting on
  itself, which cannot carry a legacy bad stamp; gating it would be a no-op that just adds a DB query on
  the worker_report(done) hot path for no safety gained.
- Do not drop `getDanglingWorkers`'s widened condition back to bare `if (!w.taskId)` — that was the
  reachability gap that made the dangling-view asymmetry possible in the first place (a TASKED review
  spawn's `commitsAheadOfBase` call was simply never reached).
- Do not read `Db.listSessionsAtWorktreePath`'s result as cacheable across calls — it is a live DB read,
  deliberately uncached (unlike the `commitsAheadOfBase` numeric result itself, which IS memoized per
  archived session, since a frozen archived branch's ahead-count never changes, but the SET of sibling
  rows sharing a path could, if another sibling is spawned/archived/deleted later).

## Source

`packages/daemon/src/git/worktrees.ts` (`workerBaseRef`, `normalizeReviewBaseSha`, `reviewBaseShaToStamp`,
`trustedReviewBaseSha`, `reviewBaseShaConsensusByPath`, `WorktreeInfo.forkedFromReviewed`),
`packages/daemon/src/concurrency.ts` (`mapWithConcurrency`), `packages/daemon/src/db.ts`
(`listSessionsAtWorktreePath`), `packages/daemon/src/sessions/service.ts` (Pass B,
`classifyRetainedWorktree`, `getRetainedWorktrees`, `getDanglingWorkers`, `commitsAheadOfBase`,
`precheckWorkerDone`'s caller, the spawn-time stamping call site), `packages/daemon/src/index.ts` (boot
log line). Tests: `packages/daemon/test/worktree-review-base-reclaim.mjs` (scenarios a-h),
`packages/daemon/test/concurrency.mjs`, `packages/daemon/test/worker-list-dangling.mjs` (scenarios K/L/M),
`packages/daemon/test/review-spawn-nochanges.mjs` (real `spawnWorker` fresh + aliased review spawns).
