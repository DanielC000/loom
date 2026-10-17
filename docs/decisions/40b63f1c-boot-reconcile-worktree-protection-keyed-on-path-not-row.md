# 40b63f1c — boot-reconcile worktree protection keys on PATH, never session ROW

## Narrative

Source: a Codescape manager escalation, offered as an explicitly unverified hypothesis ("I have not
read Loom's source for this and am not asserting it"). Confirmed against source + daemon log: a
two-pass cascade, settled by the timeline below. Landed as commit `163877b5`
(full sha `163877b580b15c9f7420f6b5cd8efe150df938b7`).

### Log timeline (epoch-ms, `daemon-output.log`)

```
1787559506522  [pty] spawn 90c3d6a9 … resume=b0e8d86a               <- live successor RESUMED
1787559529018  [worktree] could not remove dir …7db9fa729639
                          (left on disk for a later GC)              <- Pass B reaps it, +22.5s
1787559548341  [reconcile] branch-ref sweep: 5 merged, 2 SKIPPED
                          (checked out elsewhere), 3 deleted: …
                          loom/7db9fa729639                          <- Pass C kills branch, +19s
1787559551768  [boot] reconcile: pruned 3 orphaned worktree(s)
```

The worker was resumed FIRST and already running when its worktree was destroyed 22 seconds later —
not a race against resume; resume had completed.

### Finding 1 — the removal partially failed BECAUSE the worker was alive, logged as routine

`[worktree] could not remove dir … (left on disk for a later GC)` is why the directory still existed
but was empty: deregistered, contents deleted, but handle-locked by the live worker's own process
(its cwd). The strongest possible liveness signal — the OS refusing a delete because something's
still using it — arrived DURING the destruction and was logged as a routine GC retry. A failed
worktree-dir removal is evidence something holds it, not fs flakiness to retry later.

### Finding 2 — Pass C's own log line carries its own positive control

"5 merged branch(es) found, 2 skipped (checked out elsewhere), 3 deleted: … loom/7db9fa729639" — the
checked-out-elsewhere gate fired CORRECTLY for the two intact, non-recycled live workers in the same
sweep, and failed only for the recycled one, because Pass B had deregistered its worktree 19 seconds
earlier. Same gate, same sweep, opposite outcomes — the discriminator is solely whether Pass B got
there first. Not a broken gate; a gate reading state an earlier pass just destroyed.

### Mechanism — two passes, each correct alone, composing into a hole

**Pass B** (`sessions/service.ts`) keys liveness protection on the ITERATED SESSION ROW
(`protectedSessionIds.has(s.id)`), never the worktree path. A recycle chain aliases ONE
`worktreePath` across TWO rows; the dangling predecessor still carries that path, isn't protected,
and is exited/dead — so it passes every filter and reaches the prune, and the live successor's
protection is never consulted. Order can't save it: the protected `continue` fires BEFORE
`handledWorktrees.add(worktreePath)`, so a protected session never claims its worktree.

`worktreeHasWork` (no commits ahead of main AND clean tree, the 2026-06-05 P0 data-loss guard) missed
this because it's a CONTENT test standing in for a LIVENESS test — blind exactly where liveness
matters most: a worker alive but hasn't written anything into its worktree yet. That's every worker
early in its task, and permanently true for a no-commit-by-design card (deliverable in the vault).

**Pass C** then deletes the branch, defeated by Pass B: its own live-worker safety gate reads git's
own `git worktree list` truth and names the exact case it believes it protects — "a just-cut worker
with zero commits yet." That's this worker exactly, but Pass C runs after Pass B, so its gate reads
state Pass B already destroyed.

### The false assurance

`sessions/service.ts`'s restart notice carried a hardcoded string literal, "your worktrees are
intact" — unconditional, computed from a separately-derived resume-facts list, never an actual check.
It could never be false regardless of disk state. The manager was told 3 workers resumed and their
worktrees were intact while one had its worktree emptied and branch deleted by that same boot, seconds
later.

## Do not

- Do not key any worktree-protection filter on a session ROW id — key on the worktree PATH (Mechanism
  above); and claim the worktree (`handledWorktrees.add(worktreePath)`) BEFORE a protected `continue`,
  not after, so "decide once per path" actually holds.
- Do not let a CONTENT test (`worktreeHasWork`) stand in for a LIVENESS test anywhere worktree
  destruction is gated.
- Do not treat a failed worktree-directory removal as fs flakiness to retry — it's a liveness signal;
  abort the reap for that path and surface it.
- Do not assert worktree integrity in a restart notice unless actually checked.

## Limits

n=1 incident, one recycled worker, one host. Fleet-wide exposure — how many recycle chains carry a
dangling predecessor row with a live `worktreePath` — was not audited. A follow-up narrowed one open
question: the same boot logged "pruned 3 orphaned worktree(s)" against only one identified instance;
the reporting manager confirmed exactly ONE recycled worker at that boot, so only one session could
exhibit the flaw — the other two were candidate-identified, not certain, as finished 0-commit rigs
whose removal would've been correct. No data was lost, and the bounding was luck (0 commits by
design, deliverable in the vault), not a safeguard — an ordinary code card with uncommitted work would
have been destroyed silently, with a notice telling the manager it was safe.

## Source

Cited (causal-fix reference only) in `worktree-vanished-watcher.ts`'s `WorktreeVanishedWatcher` class
doc, lines 107-119, tranche 1 HEAD. Full narrative above is from card `40b63f1c`'s own body — no
source comment carried it before this tranche.

## Worktree path IDENTITY no longer relies on `resolveWorktreePath` purity alone (card `9a7df0a7`)

### Narrative

`git/worktrees.ts`'s own round-2 "Do not normalize" bullet (card `a5d9c458`) argues raw-string equality
is safe for `claimedWorktreePaths`/wedge-tracking because every value compared there is the output of
the SAME `resolveWorktreePath(projectId, taskId, repoKey)` call, given the SAME inputs — and names its
own limit: "if that formula ever stops being a pure deterministic function of exactly those inputs,
re-verify this bullet." That bullet's own guarantee is narrower than it may read: one spawn claims a
path and compares against it synchronously, no await between — it is untouched by this card, and its
own re-verification is tracked separately; do not fix the wedge lookup here.

What card `9a7df0a7` found is that the GENERAL premise — "two `resolveWorktreePath` outputs for the same
inputs always match byte-for-byte" — is false across the WIDER windows this card's own structures
(`handledWorktrees`, `protectedWorktreePaths`, `currentGenerationIds` in `sessions/service.ts`, and
`reviewBaseShaConsensusByPath` in `git/worktrees.ts`) actually span: every past boot, and every past
repo-registry edit. Two concrete mechanisms, neither requiring `resolveWorktreePath` itself to change:

1. **A repoKey re-case between two spawns of the same task.** `Session.repoKey` is stamped once at spawn
   and never re-resolved; a human editing an existing `project.repos` entry's `key` field to a different
   casing (e.g. `"Api"` → `"api"`) makes a later respawn's `resolveWorktreePath(..., "api", taskKey)`
   produce a DIFFERENT string than an earlier row's `resolveWorktreePath(..., "Api", taskKey)` — yet both
   name the SAME directory on win32's case-insensitive filesystem.
2. **A `LOOM_HOME`/`WORKTREES_DIR` casing or slash difference across daemon restarts.** `WORKTREES_DIR` is
   a module constant fixed for one process's lifetime, but boot-reconcile scans rows spanning EVERY past
   boot — an env-level casing change between restarts (CLAUDE.md documents overriding `LOOM_HOME` for a
   throwaway daemon as a real, supported knob) produces the same kind of alias across two rows.

Either way, two session rows can carry genuinely differently-spelled strings for the exact same on-disk
directory, and every Set/Map in boot-reconcile that compared those strings RAW could let one row's
decision (protect a worktree, trust a `reviewBaseSha`, or treat a stale generation as current) miss the
other row's spelling entirely.

### Do not

- Do not key `handledWorktrees`, `protectedWorktreePaths`, `currentGenerationIds`, or
  `reviewBaseShaConsensusByPath`'s own grouping/lookup on the raw `worktreePath` string — route every one
  of those Set/Map identity comparisons through the shared `worktreeIdentityKey` helper (git/worktrees.ts)
  instead.
- Do not route an actual fs/git call (`fs.existsSync`, `gcWorktreeDir`, `worktreeHasWork`, …) through
  `worktreeIdentityKey` — it exists only for Set/Map IDENTITY comparisons; a real filesystem/git operation
  must keep using the row's own original, raw path string.
- Do not add a new ad hoc case-fold at a new worktree-identity call site — reuse `worktreeIdentityKey`
  (itself a thin wrapper over `normForCompare`), so every site stays provably consistent with each other.

### Source

`packages/daemon/src/git/worktrees.ts` (`worktreeIdentityKey`, `reviewBaseShaConsensusByPath`) and
`packages/daemon/src/sessions/service.ts` (`handledWorktrees`, `protectedWorktreePaths`,
`currentGenerationIds`, `listNodeModulesReclaimCandidates`/`reclaimNodeModules`, and every call site that
adds to or checks any of them) — fixed on card `9a7df0a7`, caught by
`packages/daemon/test/worktree-path-identity-alias.mjs` and its fixtures for
`currentGenerationIds`/node_modules reclaim. `commitsAheadOfBase` ALSO changed (same card, same shape) but
is currently MASKED — `trustedReviewBaseSha`'s all-taskless gate (this file, `trustedReviewBaseSha`'s own
doc) rejects a TASKED `w` before ever reading the siblings this fix fetches, so no fixture exists for it
and no test caught it; the change is kept for if/when that gate loosens.

## Follow-up (card `1243e342`) — the wedge-tracking lookup this record's own "Do not fix the wedge lookup
## here" bullet scoped out does NOT survive re-verification either

### Narrative

The addendum above explicitly carved `db.ts`'s `WORKTREE_WEDGED_KEY` methods out of `9a7df0a7`'s own fix,
on the strength of `a5d9c458`'s round-2 "exact-string lookup is safe here" bullet (both sides are the
output of the SAME `resolveWorktreePath(projectId, taskId, repoKey)` call given the SAME inputs). Card
`1243e342` re-verified that bullet against the two concrete mechanisms above and found it does NOT hold
for `reclaimWedgedWorktreePathForSpawn`/`getWedgedWorktree`: mechanism 2 (cross-boot `WORKTREES_DIR`
casing drift) reaches it unguarded — a wedge entry recorded in one daemon boot and a respawn's freshly
resolved path in a later boot can differ only in case while naming the identical dir. Mechanism 1
(repoKey re-case) is narrower here than for boot-reconcile: `reclaimWedgedWorktreePathForSpawn`'s repoKey
comes from a LIVE `resolveRepo(project, task)` call every spawn, which THROWS `UnknownRepoKeyError` on a
stale `task.repoKey` rather than silently drifting — so it needs a task's own `repoKey` field to have been
independently re-cased to reach this chokepoint, not merely a registry rename.

The consequence of a missed wedge entry is bounded, not a repeat of the P1 data-loss class: `createWorktree`'s
own independent fs-level half-removed-dir check (`a5d9c458`, keyed on raw `fs.existsSync`/`worktreeHasGitLink`,
both case-insensitive on Windows) still catches and safely renames aside the stale dir, so the respawn itself
does not fail. The orphaned `WedgedWorktreeEntry` self-heals later via the background sweep's
`findLiveSessionClaimingWorktreePath`, which IS already identity-keyed (`623a7a62`) — but only once the sweep
ticks (~30-60min), and in the meantime a second wedged-removal attempt against the same dir under a different
spelling would create a DUPLICATE entry rather than updating the existing one (the write side, `recordWorktreeWedgeAttempt`,
has the identical raw-equality exposure on its own upsert check).

The fix: all FIVE `WORKTREE_WEDGED_KEY` methods (`getWedgedWorktree`, `recordWorktreeWedgeAttempt`,
`markWorktreeNeedsHuman`, `clearWedgedWorktree`, and every internal `.find`/`.filter` on that list) now
compare via `worktreeIdentityKey` on both sides, the SAME shared helper this record's own addendum
established. The STORED `WedgedWorktreeEntry.worktreePath` field stays the original raw string — never
normalized — since `reclaimWedgedWorktreePathForSpawn`/`gcWorktreeDir` pass it straight into real fs/git
calls downstream.

### Do not

- Do not revert to raw `===`/`!==` on any of the five `WORKTREE_WEDGED_KEY` methods — re-derive the two
  mechanisms above before assuming exact-string comparison is ever safe for a value that can have been
  written in an earlier daemon boot or under an earlier repoKey casing.
- Do not normalize the STORED `worktreePath` field on a `WedgedWorktreeEntry` — only the comparison key
  routes through `worktreeIdentityKey`; the stored value must stay the raw string a real fs/git call can
  use downstream (this record's own "Do not route an actual fs/git call through `worktreeIdentityKey`"
  bullet, above, applies here too).
- Do not "fix" `listSessionsAtWorktreePath` (`db.ts`) to match this — it is a deliberately exact,
  advisory-only diagnostic signal (its own doc comment), never a destructive-decision gate; out of scope
  here (card `1243e342`'s own kickoff ruling).

### Source

`packages/daemon/src/db.ts` (`getWedgedWorktree`, `recordWorktreeWedgeAttempt`, `markWorktreeNeedsHuman`,
`clearWedgedWorktree`) — fixed on card `1243e342`, caught by `packages/daemon/test/worktree-wedge-retry.mjs`
and `packages/daemon/test/createworktree-wedge-reclaim.mjs` (section (L)/(L-control), win32-gated — the
real end-to-end `reclaimWedgedWorktreePathForSpawn`/`createWorktree` scenario; `worktree-path-identity-alias.mjs`
has no wedge-tracking coverage at all — it's the boot-reconcile sibling fix, `9a7df0a7`, above).

## Round 2 (CR `3709d686` on card `1243e342`) — identity-keying the COMPARISON is not enough while LEGACY
## raw-keyed duplicates can still exist in the stored array

### Narrative

Round 1 (above) made every comparison identity-keyed, but `getWedgedWorktree` still returned only the
FIRST matching entry (`Array.prototype.find`). That is a problem specifically BECAUSE a pre-fix daemon
could already have written TWO separate raw-keyed entries for the SAME dir under two different spellings
(the exact aliasing round 1 fixes) — e.g. one entry (`needsHuman:false`) under spelling X and a second
(`needsHuman:true`) under alias spelling Y, both still sitting in the stored `WORKTREE_WEDGED_KEY` array
from before this card shipped. `getWedgedWorktree`'s `.find()` would surface WHICHEVER one happens to
come first in the array — if that's X, every caller sees `needsHuman:false` and nothing stops
`gcWorktreeDir` proceeding toward the nested-repo scan, reap, and removal attempt against a path a
DIFFERENT stored entry had already flagged as parked for human attention. The converse (X parked, Y not,
`.find()` returns X) is merely overcautious; the case above — a parked duplicate silently overridden by
an unparked one — is the one that matters, because it lets removal machinery run against a path a human
was supposed to have already stopped.

The fix: `getWedgedWorktree` now collects EVERY entry sharing the target's identity key, and when more
than one exists, collapses them into ONE view, fail-closed: `needsHuman` is the OR across all of them (one
parked entry parks the whole identity), `attempts` is the MAX (never under-report how many tries have
already failed), `firstWedgedAt` is the EARLIEST (age is measured from the oldest sighting, not reset by a
later duplicate), and the returned `worktreePath`/`repoPath`/`reason` are the EARLIEST entry's own raw
values (consistent provenance — the "canonical" entry is the oldest one, not an arbitrary pick).
`lastAttemptAt` is the LATEST across all of them (most informative recency), a choice beyond what the CR
asked for explicitly but consistent with every other field: never silently under-report.

⛔ **SUPERSEDED by Round 3 below (CR `601ab6c2`) — `listWedgedWorktrees()` left UN-collapsed was WRONG,
not merely redundant.** The paragraph that stood here argued collapsing `listWedgedWorktrees()` was
unnecessary because `gcWorktreeDir`'s `getWedgedWorktree` gate always runs first — true for the ONE
destructive path it checked, but it missed that the sweep's own ARMING/DISARMING logic and boot-reconcile's
own reporting ALSO read the raw, uncollapsed list directly, with no such gate. See Round 3 for the real
mechanism and fix.

### Do not

- Do not go back to first-match semantics over the RAW, UNCOLLAPSED array in `getWedgedWorktree` — a
  legacy raw-keyed duplicate pair can still exist in production data written before round 1 shipped, and
  matching the raw array directly can silently surface the WRONG (not-parked) one. (Round 3: plain
  `Array.prototype.find` over the ALREADY-COLLAPSED `listWedgedWorktrees()` is fine — there is at most
  one entry per identity in that list by construction, so first-match there is correct, not a regression.)
- ⛔ SUPERSEDED (Round 3) — this bullet claimed "the write side already collapses on every upsert", which
  was false: `recordWorktreeWedgeAttempt`/`markWorktreeNeedsHuman` still matched via raw
  `Array.prototype.find` (first-match) over the UNCOLLAPSED stored array, so a write against a legacy
  duplicate pair could silently ERASE a park (see Round 3's own Do-not for the real rule: reads AND
  writes both route through the ONE identity-collapse, fail-closed, via the shared
  `collapseWedgedByIdentity` helper).
- ⛔ SUPERSEDED (Round 3) — "collapse `listWedgedWorktrees()` only if a future caller bypasses the gate"
  was the wrong conditional: the sweep's OWN arming/disarming and boot-reconcile's own reporting already
  read the raw list directly, with no gate in between — `listWedgedWorktrees()` collapses unconditionally
  now, via the same shared helper `getWedgedWorktree` uses.

### Source

`packages/daemon/src/db.ts` (`getWedgedWorktree`) — fixed on CR `3709d686` (card `1243e342`), caught by
`packages/daemon/test/worktree-wedge-retry.mjs`'s `(unit-alias legacy-duplicate)` scenario, win32-gated,
RED-proven with only the collapse hunk reverted. Superseded in part by Round 3 below.

## Round 3 (CR `601ab6c2` on card `1243e342`) — the READ collapse alone still let a WRITE erase a park,
## and the sweep timer never disarmed on a mixed pair

### Narrative

Round 2 made `getWedgedWorktree` collapse fail-closed on READ, but `recordWorktreeWedgeAttempt` and
`markWorktreeNeedsHuman` still matched `list.find((e) => worktreeIdentityKey(e.worktreePath) === key)`
against the RAW, uncollapsed stored array — first match, not the collapsed view. On a legacy pair
(entry A: not parked, `attempts:1`, earlier `firstWedgedAt`, sorts first in the array; entry B: PARKED,
`attempts:3`, later `firstWedgedAt`), a new `recordWorktreeWedgeAttempt` call would find A FIRST, bump
ITS `attempts` to 2, and write back `[...list.filter(!==key), updatedA]` — which drops B (the identity
filter removes every raw entry sharing the key) and replaces the pair with a single entry carrying A's
`needsHuman:false`. The park is erased: `true → false`, and `attempts` ends up `2`, not the `4` a correct
collapse-then-increment would produce. This is reachable in production: the three dist-importer-check
removal sites (`service.ts` ~22560/22573/22717) call `removeWorktree` and record a wedge with no
needs-human precheck of their own.

Separately, `sweepWedgedWorktreesOnce`'s own `pending = this.db.listWedgedWorktrees().filter((e) =>
!e.needsHuman)` read the RAW array too (pre-Round-3) — on a mixed pair, the UNPARKED duplicate (A) always
satisfies `!e.needsHuman` and lands in `pending`, so the sweep's own "disarm once nothing remains" check
(`const stillPending = this.db.listWedgedWorktrees().some((e) => !e.needsHuman); if (!stillPending...)
clearInterval(...)`) sees A forever and the timer NEVER disarms, even though every actual removal attempt
against A is correctly blocked by `gcWorktreeDir`'s `getWedgedWorktree` gate (Round 2). Boot-reconcile's
own summary reporting reads the same raw list for both its "still pending / retrying" and "needs human"
lines, so ONE physical directory could be reported under BOTH headings at once — confusing, not merely
inefficient.

The fix: ONE shared, module-level `collapseWedgedByIdentity(entries)` helper — groups by
`worktreeIdentityKey`, and for any group with more than one member, folds it fail-closed exactly as
Round 2's inline logic did (`needsHuman` OR, `attempts` max, `firstWedgedAt` earliest with that entry's
own raw `worktreePath`/`repoPath`/`reason`, `lastAttemptAt` latest); a singleton group passes through
unchanged. `listWedgedWorktrees()` now returns `collapseWedgedByIdentity(<raw parsed array>)` directly —
collapsed, unconditionally, for EVERY caller, not just `getWedgedWorktree`'s own internal use.
`getWedgedWorktree` simplifies to a plain `.find()` over that already-collapsed list (there is at most
one entry per identity in it, so first-match is now correct by construction — no separate collapse logic
of its own left to drift from `listWedgedWorktrees()`'s). A NEW private `rawWedgedWorktrees()` holds the
uncollapsed parse+validate that used to live directly in `listWedgedWorktrees()` — every WRITE method
(`recordWorktreeWedgeAttempt`, `markWorktreeNeedsHuman`, `clearWedgedWorktree`) filters/replaces against
THIS raw array (so a write can actually remove every duplicate raw row for an identity, not just the one
it matched), while computing its "existing" value via `this.getWedgedWorktree(worktreePath)` — the
collapsed view — so every write normalizes a legacy pair fail-closed as a side effect of touching it:
`recordWorktreeWedgeAttempt` against the pair above now produces ONE entry, `needsHuman:true`,
`attempts:4` (3, the collapsed max, plus this new attempt), `firstWedgedAt` = A's (the earliest).
`markWorktreeNeedsHuman`'s early return was narrowed from `if (!entry || entry.needsHuman) return;` to
`if (!entry) return;` — even when the collapsed view is ALREADY `needsHuman:true`, the call still
persists the collapse (replacing every raw duplicate row with the one collapsed entry), so a legacy pair
gets physically de-duplicated in storage the first time ANY write touches its identity, rather than
relying on every future reader to keep re-collapsing it forever.

### Do not

- Do not let any WRITE method (`recordWorktreeWedgeAttempt`, `markWorktreeNeedsHuman`, `clearWedgedWorktree`)
  match against the raw, uncollapsed array to decide its "existing" value — always go through
  `this.getWedgedWorktree(worktreePath)` (the collapsed view), even though the array it filters/replaces
  against is the raw one (`rawWedgedWorktrees()`).
- Do not add a second collapse implementation anywhere — `listWedgedWorktrees()` and `getWedgedWorktree`
  (and, transitively, every write method) all route through the ONE shared `collapseWedgedByIdentity`
  helper; a second ad hoc fold is how reads and writes drift apart again, which is exactly what happened
  between Round 2 and this round.
- Do not restore `markWorktreeNeedsHuman`'s `|| entry.needsHuman` early-return — it was the write-side
  no-op that left a legacy duplicate pair sitting in raw storage forever even once a caller tried to park
  it; the call must always persist the collapse once `entry` exists, so storage self-heals the moment any
  write touches that identity.
- Do not read `listWedgedWorktrees()` returning collapsed entries as proof no more than one real
  directory is ever tracked — it proves the STORED representation now has at most one entry per
  identity; a genuinely different, unrelated directory still gets its own entry.

### Source

`packages/daemon/src/db.ts` (`collapseWedgedByIdentity`, `rawWedgedWorktrees`, `listWedgedWorktrees`,
`getWedgedWorktree`, `recordWorktreeWedgeAttempt`, `markWorktreeNeedsHuman`) — fixed on CR `601ab6c2`
(card `1243e342`), caught by `packages/daemon/test/worktree-wedge-retry.mjs`'s re-seeded
`(unit-alias legacy-duplicate)` scenario (earliest entry now seeded SECOND, so "earliest" and "first in
the array" are distinguishable), a new write-side sub-scenario, a sweep-disarm sub-scenario, and an
ungated POSIX-safe variant using a lexical `normForCompare` alias (a trailing separator / `/./`) so
non-win32 CI exercises the collapse too — each RED-proven with only its own hunk reverted.
