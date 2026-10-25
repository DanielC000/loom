# c13666c6 — the branch-gone trailer-only arm is gated against Loom's own mainline ledger, via a durable boundary + a per-sha chain lookup

From f224632d's Code Review (reviewer 5e586b56). f224632d ("fix(git): verify the solo squash's own
trailers before trusting it") and 95940402 ("fix(git): verify batch-landed commits and their trailers
before pinning") verify a landed commit's parent, tree and Loom trailers — but only at the moment
Loom's own merge code produces that one commit. The verdict (`landedVerify`/`landedBase`) reaches ONLY
the mainline ledger row and the trust stamp (`advanceMainlineWatermark`/`advanceMainlineWatermarkForBatch`
in `sessions/service.ts`). Every trailer READER — `findLandedSquashCommit`, the merged-commit map
(`scanMergedCommitMap`/`resolveMergedCommitMapHit`/`getMergedCommitMapCached`/
`findLandedSquashCommitViaMap`), `getTaskMergedInfo` — parses whatever is on main directly, with no
cross-check against that verdict at all.

For a branch that is still LIVE, this is already closed: `branchContentLandedInCommit` requires the
candidate commit's content to be byte-identical to the live branch, over every file the branch itself
touched. The forgery surface is specifically the BRANCH-GONE arm (`verifyPersistedPathSet`): it checks a
commit's own `Loom-Worker-PathSet` trailer against its own diff — a purely SELF-REFERENTIAL check. Anyone
with write access to the shared, worker-writable `.git` (decision `356538ef`) can mint an arbitrary
commit with a self-consistent `Loom-Worker-Branch`/`Loom-Worker-PathSet` trailer naming ANY branch name
that happens to be currently gone (including one that never existed), and every reader above accepts it
as a real landing — bypassing gate/review entirely for whatever task that branch name maps to.

## Round 1 (superseded by round 2 below — kept for the "why a half-open range" rationale, which still holds)

Round 1 shipped `findLandedSquashCommit`/`resolveMergedCommitMapHit`'s branch-gone arm gated against a
PER-SCOPE snapshot: the ledger's EARLIEST-recorded row's own `base` as a "pre-ledger" cutover, plus the
50 most-recent rows scanned for a half-open `(base, tip]` first-parent range match. Round 1's Code Review
(reviewer d038aefe, real git + 260 real rows) confirmed the half-open range + laundering exclusion are
CORRECT and the wiring is COMPLETE, but found the WINDOW itself defective:

- **M1 (Major):** `mainline_landed_commits` was ALSO pruned to 200 rows per branch at the time
  (`pruneMainlineLedger`). Combined with the 50-newest-rows scan, a real landing 51-199 rows old read
  NOT LANDED — the window was `[oldest-retained, 50-newest]`, not `[earliest-ever, now]`.
- **M2 (Major):** pruning SLIDES the pre-ledger boundary forward over time, so a wedged forgery correctly
  refused today becomes ACCEPTED after enough further landings prune the row that used to anchor the
  boundary — measured: refused at 71 rows, accepted at 260.
- **Perf:** an old candidate cost ~2000+1 git spawns per lookup (one per scanned row's own range walk),
  with no cache — and `tasks_list` fans this lookup out across every card on a board read (measured 22s
  for one lookup 49 rows back).
- **Finding 5:** the ledger facts were always resolved from the project's current mainline-WATERMARK
  branch — but the candidate `sha` was found by scanning whatever `ref`/`base` the CALLER actually passed
  (often bare `"HEAD"`), which can diverge from the watermark (e.g. right after a manager's
  `project_checkout_branch` onto a fresh branch, before a real landing ever updates the watermark). A
  branch created this way lost its gate.
- **Finding 6:** the escalation-triage display (`deriveEscalationStatus`, service.ts) scoped its ledger
  lookup to the DESTINATION PROJECT's primary repo, ignoring the destination TASK's own `repoKey`.

Round 1's decision record also never actually stated two things its own code and tests already knew: the
ledger-absence BOOTSTRAP residual (see round 2, below) and the fact that a (project, repoKey) scope's
FIRST-EVER landing never writes a row at all (see round 2, below too) — a worker-report-only disclosure is
not a disclosure the next reader of this file can see. Restated here, in the record itself, this time.

## Round 2 — the actual fix

### (1) A durable, branch-independent boundary — never the dynamically-recomputed "earliest row"

`Db.resolveGoneBranchLedgerBoundary(projectId, repoKey)` reads a NEW `app_meta` key
(`gone-branch-ledger-boundary:<projectId>:<repoKey>` — `goneBranchLedgerBoundaryKey`, git/mainline-watch.ts;
no schema change, no migration, no new table) holding a single sha: the scope's pre-ledger cutover
boundary, SET ONCE and NEVER UPDATED afterward. It is write-if-absent:

- `recordMainlineLandedCommit` seeds it the moment a scope's FIRST-EVER row lands (the new row's own
  `base` IS the boundary at that instant, by definition — nothing landed before it).
- A scope that already carried rows before this round existed (an upgrade) gets it seeded LAZILY, inside
  `resolveGoneBranchLedgerBoundary` itself, from whatever that scope's CURRENT oldest row's own base
  happens to be at the moment it is first read.

Once set, "pre-ledger" means "an ancestor of (or equal to) THAT stored sha", forever — unaffected by
anything that happens to the ledger table afterward (pruning, if it ever came back; a gap; anything).

**Named residual, stated honestly, not hidden:** for an UPGRADED scope, the boundary is seeded from
whatever the oldest RETAINED row happened to be at the moment of the lazy read — under round 1's now-
removed pruning, that could already be later than the TRUE earliest-ever landing. Any commit between the
true earliest landing and that (now-fixed-forever) seeded boundary is grandfathered permanently, exactly
as if it genuinely predated the ledger. This is accepted: there is no way to recover a row pruning has
already deleted, and the alternative (refusing such a commit) would be worse — it would retroactively
"un-merge" real history. For a FRESH scope created after this round (never pruned), this residual cannot
occur at all, since the boundary is seeded at the scope's genuine first-ever row.

**Named quirk, also stated honestly (this is what round 1's test comments referenced without the record
itself ever saying it):** `expectedMainlineBranch` (service.ts's `confirmWorkerMerge`) is resolved ONCE at
confirm-start, BEFORE that same call's own `advanceMainlineWatermark` can establish a watermark on true
first sight. `recordMainlineLedgerEntry`'s own gate requires `expectedMainlineBranch` truthy, so the VERY
FIRST landing ever confirmed for a (project, repoKey) writes NO ledger row at all — only the second and
later landings do. This is pre-existing behavior, untouched by this card; every round-2 test seeds a
throwaway warm-up landing before the landing it actually asserts against, for exactly this reason.

**Separate, narrower bootstrap residual (inherent to ANY "grandfather by a fixed boundary" design, not
just this one):** if a forged commit `F` becomes the literal `base` of a scope's genuine first-ever row
(i.e. a racer plants `F` on main before the FIRST-EVER real landing for a brand-new project), the
boundary seeds AS `F` itself — and "an ancestor of or equal to the boundary" then trivially accepts `F`,
since `F` IS the boundary. There is no way to distinguish "`F` is genuinely pre-Loom history" from "`F`
was planted moments before the project's first-ever confirm" using pure git ancestry; both look
identical. Narrower than the ongoing-forgery threat this card closes (it requires racing a brand-new
project's very first confirm, a one-time window, not a repeatable attack against an established
project), and the same shape as the pre-existing "first sight silently trusts whatever is checked out"
posture the mainline-watermark mechanism already has elsewhere (decision `2a6a292a`).

### (2) Pruning removed entirely — it was never load-bearing for anything this table actually needs

Investigated before changing anything (per the manager's own instruction): `Db.isMainlineLedgerReachable`
(the pre-existing watermark-TRUST walk, unrelated to this card) resolves each hop via
`SELECT base FROM mainline_landed_commits WHERE ... AND tip = ?` — an INDEXED point lookup
(`idx_mainline_landed_commits_tip`), bounded by its own `MAINLINE_LEDGER_WALK_CAP` (50 hops), with cost
independent of total table size. The old retention constant's own doc already said as much: it was sized
specifically to stay comfortably ABOVE that walk's own cap, "so pruning can never remove a row [it] still
within its own cap could have used" — i.e. pruning was never added FOR that walk's correctness; it was an
unrelated, purely precautionary size bound. Rows are tiny (two 40-char shas, a branch name, a timestamp —
well under a kilobyte each even generously); thousands of landings over years amount to a few hundred
kilobytes, negligible next to everything else already in this sqlite file. `recordMainlineLandedCommit`
now inserts unconditionally, no prune call, ever. The RECORD itself never drops a row for being old.
**Round 3 correction:** that is a claim about the record, not about what the gate's own reader can REACH —
round 2's reader was bounded by a 2000-commit chain-scan cap narrower than this record, so a genuinely
ancient landing could still read `"unrecorded"` even though its row was never pruned. See round 3 below.

### (3) Per-sha lookup via a bounded git chain walk, not a row-count-dependent scan (SUPERSEDED — see round 4/5 below)

**This section's SPECIFIC mechanism (a first-parent chain walk with `sha` prepended) and its acceptance
rule are NOT current** — round 4 replaced both with the `--ancestry-path` walk + per-row first-parent
range membership check, and round 5 further reordered/pruned that leg's own internal work for
performance. Kept for the "why a bounded, cache-friendly per-sha lookup instead of a row-count-dependent
scan" rationale, which still holds; read round 4's and round 5's own sections below for what the code
actually does today.

`classifyAgainstLedgerUncached` (git/worktrees.ts) replaces round 1's per-row scan with ONE bounded
`git rev-list --first-parent <sha>..<refTip>` (capped at `GONE_BRANCH_LEDGER_CHAIN_SCAN_CAP`, round 2's
value of 2000 commits — past it, fails CLOSED to `"unrecorded"`, with a loud named log line, never
silently widened; **round 3 raised this bound — see round 3 below for the corrected, honest horizon**).
`refTip` is the CALLER's own scanned ref, resolved via one `git rev-parse` — the SAME ref `findLandedSquashCommit`/
`resolveMergedCommitMapHit` used to find `sha` in the first place (threaded as a new `ref` parameter on
both — `"HEAD"` for `getTaskMergedInfo`, the caller's own `base`/watermark ref for everything else),
never a separately-resolved watermark branch. This closes round 1's finding 5: a branch found by scanning
bare `"HEAD"` right after a fresh `project_checkout_branch` is now gated against that SAME `HEAD`, not
against whatever the (possibly stale) watermark happens to still say.

The resulting chain — `sha` itself, prepended to the (reversed) rev-list output — is passed to
`Db.getGoneBranchLedgerRowsByTips`, ONE indexed `tip IN (...)` query, scoped to (project, repoKey) only
— branch-INDEPENDENT (a ledger row's `branch` column still exists and is still written, for
`isMainlineLedgerReachable`'s own unrelated use; this gate's own lookup simply never filters on it, for
the same finding-5 reason). Walking the chain nearest-to-`sha`-first, the first matching row whose own
`base` is NOT `sha` itself (the half-open range's lower-bound exclusion) and whose `base` is a genuine
ancestor of `sha` (one more `git merge-base` call) is "recorded". A plain ancestor check suffices for
that leg without a SEPARATE first-parent walk: `row.tip` is already confirmed to sit on `sha`'s own
unique `sha..refTip` first-parent lineage, and `row.base` is always `row.tip`'s own direct first-parent
predecessor by construction (every landing writes its row that way) — first-parent walking from any
commit is deterministic (at most one first parent each), so `row.base`'s position is pinned onto that
SAME lineage, with no "different lineage" ambiguity possible. Total cost: ~2-4 git spawns (ref resolve,
boundary check, chain walk, at most a handful of row-base checks), independent of how old `sha` is or how
many ledger rows exist — closing the perf finding structurally, not by caching alone.

### (4) One fail direction, for every caller

`verifyGoneBranchLanding` returns a plain boolean; every caller already treated `false` as "not landed"
uniformly. Round 1's own row-cap/range-cap overflow handling created a narrower "ambiguous, could be
real" dead band in a couple of places; round 2's bounded-but-cheap chain walk removes the need for it —
an overflow is `"unrecorded"`, exactly like a genuine non-match, logged the same way, with no separate
display-vs-finalize split anywhere in this gate.

### (5) Memoized verdicts, logged once per state, not once per board read

`classifyAgainstLedger` (the memoizing wrapper around the uncached classifier) caches by
`${sha}\u0000${refTip}\u0000${maxRowId}` — `maxRowId` (`Db.getGoneBranchLedgerMaxRowId`) is what
invalidates a stale entry: a new landing bumps it, so a later lookup for the same sha naturally misses
and recomputes, never serving a memo that predates a row that might now matter. Process-local, bounded at
`GONE_BRANCH_LEDGER_VERDICT_CACHE_MAX = 500` entries (simple insertion-order eviction past that). The
"refusing to treat as landed" warning fires only on an actual cache MISS that resolves to `"unrecorded"`
— a repeat lookup for the identical state never re-logs, closing the `tasks_list`-fans-out-across-every-
card noise round 1 left open.

### Scope: the branch-gone arm only, both its sub-cases — unchanged from round 1

Per the manager's round-1 ruling, the branch-LIVE content-equality arm (`branchContentLandedInCommit`) is
left alone — it is already independently content-verified. Within the branch-gone arm,
`verifyGoneBranchLanding` runs the ledger gate for BOTH the pathset-present case and the pre-f621f185
pathset-ABSENT legacy fallback (trusting trailer presence alone) — the absent case is, if anything, an
EVEN weaker check than the self-referential pathset one, so it gets the same gate rather than a weaker
one.

### Wiring — `deps.goneBranchLedger` is opt-in, resolved once per call site that has project/repoKey context

`git/worktrees.ts` is a pure-git module with no DB of its own; `Db.getGoneBranchLedgerFacts(projectId,
repoKey)` returns a small CALLBACK bundle (`resolveBoundary`/`rowsByTips`/`maxRowId` — never a pre-fetched
snapshot, since the exact set of shas worth querying depends on a git-computed chain the DB side can't
know ahead of time), threaded down via the existing `BoundedGitDeps`/`BatchGitDeps` test-seam pattern.
Wired at every skip-gate/finalize-relevant call site found by the card's own investigation:
`confirmWorkerMerge`'s whole family (`shouldSuppressMergeReject`, the reviewed-tip-moved/title-guard/
no-gate-landed checks, `finishSoloAlreadyLanded`/`tipAcrossLandedCheck`, the solo squash's own
ALREADY_MERGED classification via `mergeBranch`), the crash-recovery catch path, boot-reconcile Pass A's
periodic sweep, `runBatchedMerge` (and therefore every per-candidate `landBranchCommitsIndividually`
call, via `BatchGitDeps`), the board's `getTaskMergedInfo` (`mcp/tasks.ts`'s `resolveMergedInfo`, the
escalation-triage display — scoped to the DESTINATION TASK's own `repoKey`, closing finding 6 — and
`listUnmergedWorkerBranches`'s own `project_checkout_branch` refusal check), and the Git tab's
`resolveWorkerBranchInfo` (`gateway/server.ts`).

**`listUnmergedWorkerBranches` (service.ts) deliberately keeps scoping to `"primary"`, per the manager's
round-2 ruling — left as-is, not fixed here:** that function already had its OWN pre-existing
simplification of using one `repoPath` for every candidate regardless of that candidate's real `repoKey`;
fixing the ledger scope alone without also fixing that pre-existing repoPath simplification would be
inconsistent and is out of this card's scope. The failure direction is safe either way: a candidate
scoped to the wrong (non-primary) repoKey reads as unmerged (over-refusal), never as wrongly merged.

**Deliberately left unwired**: `workerDiff`'s squash-content-reconstruction fallback (`git/worktrees.ts`,
the `findLandedSquashCommit` call inside its "branch merged + deleted" leg) — a read-only diff-display
path (not a finalize/skip-gate decision), threaded through `DiffBranchDeps`, a separate interface from
`BoundedGitDeps` that does not carry `goneBranchLedger`; `findIntroducingSquashCommit` and
`findAllLandedTrailerCommits`/`recordedTipContentLanded` are untouched per their own attribution-only /
already-independently-content-verified docs (see those functions' own comments); `pinnedTipForLandedSquash`/
`readLandedTipTrailer` are untouched — they already fail safe via the solo finalize's CAS guard
(`cc9bce38`): a forged `Loom-Landed-Tip` can at worst cause a spuriously-retained branch, never a wrongful
delete.

## Round 3 — the second Code Review's 3 BLOCKING findings, plus the non-blocking nits

Round 2's own Code Review (reviewer `7d8fae16`, real-git probes) confirmed M1/M2 closed and pruning-removal
safe, but found 3 BLOCKING issues — all real-git reproduced — and several non-blocking nits.

### (1) CRITICAL — the first-parent precondition: a forged commit landed as a merge's SECOND parent

Round 2's reader built its chain by scanning `sha..refTip` with `--first-parent` and then **prepending
`sha` unchecked** — it never actually confirmed `sha` sat ON that first-parent line at all. A forged
commit `F` (carrying a well-formed branch-gone trailer, parented directly on a genuine past landing's
tip) landed on main as a merge's SECOND parent — `git commit-tree <tree> -p <mainTip> -p F -m "merge"` —
sits off the first-parent line entirely (the merge's own first parent is `mainTip`, not `F`), yet it is
still an ordinary ancestor of the final tip. Round 2's PRE-LEDGER leg (`merge-base(sha, boundary)`) and
RECORDED leg (the naive prepend) both reached it: the reviewer's probe landed `F`, merged it in as a
second parent, landed a real commit on top, and both `findLandedSquashCommit` and the merged-map's
`ViaMap` path returned `F` as landed.

**Round 3's own fix (WRONG, see Round 4 below):** `classifyAgainstLedgerUncached` computed ONE bounded
`rev-list --first-parent --parents sha..refTip` FIRST, for every candidate, and REQUIRED that `sha` sit on
`refTip`'s own first-parent line before accepting EITHER leg. **This un-merged genuine history**: the
third Code Review (round 4) found it rejected a Loom-landed commit the instant ANY real merge commit sat
between it and `refTip` — including the owner's own sanctioned `project_checkout_branch create:true` flow
(land on a side branch, merge it into main). Round 4 replaces this precondition entirely; do not re-read
this paragraph as the current design.

### (2) MAJOR — the horizon: the 2000-commit cap was narrower than every caller's own scan limit

`GONE_BRANCH_LEDGER_CHAIN_SCAN_CAP` raised from 2000 to **20000** — the honest bound now stated here
instead of round 2's false "independent of how old" claim. This repo lands roughly 33 first-parent
commits/day, so the OLD 2000 cap meant any gone-branch landing read unmerged after ~60 days — narrower
than the merged map's own `MERGED_LOOKUP_SCAN_LIMIT` (5000, unbounded for `findLandedSquashCommit` itself,
which carries no numeric cap of its own at all). **Round 3's "20000 is comfortably above both" claim is
corrected by Round 4 below**: that framing implied the cap bounds the WHOLE gate, but
`findLandedSquashCommit`'s own `git log <base> --grep` scan (what finds `sha` in the first place) stays
genuinely unbounded regardless of this cap, and the PRE-LEDGER leg (round 4) is deliberately uncapped too
— only the RECORDED leg's own candidate-tip walk is bounded by this value. **Measured cost** (this
host, a synthetic linear chain built via `git fast-import`, never a one-spawn-per-commit loop — see
`buildChainCapFixture`'s own doc in the test file for why): a bounded `rev-list --first-parent --parents
--max-count=20001` over a genuine 20000-commit range took 142–478ms; over this repo's OWN real `main`
(only ~4205 first-parent commits total, so well under the new cap) the same walk took 58ms. The overflow
path (past the cap) is unchanged — fails CLOSED to `"unrecorded"`, logged, never silently widened; the
covering test (`CHAIN CAP` in the test file) now builds `GONE_BRANCH_LEDGER_CHAIN_SCAN_CAP + 1` filler
commits via the same real constant (imported from `dist/git/worktrees.js`), never a hardcoded copy of it.

### (3) MAJOR — rebind and delete now sweep the branch-gone ledger too

A repoPath rebind (`Db.resetMainlineBaselinesForRepoChange`, PASS 2) now UNCONDITIONALLY clears this
scope's `mainline_landed_commits` rows AND its durable boundary `app_meta` key the moment a repoKey's path
genuinely changes — never gated on whether a watermark/boot-alert marker also existed for that scope
(ledger rows always imply the watermark was already set, but clearing unconditionally costs nothing and
is simpler to reason about). Before this fix, a rebind left the OLD repo's rows/boundary behind: a
boundary sha from the old repo almost never resolves in the new one, so `Db.resolveGoneBranchLedgerBoundary`
kept returning it anyway (write-if-absent, never re-seeded), and every gone-branch landing in the NEW repo
read `"unrecorded"` forever — the Code Review's reproduction. `Db.deleteProject` now ALSO sweeps the
boundary key (it already swept the ledger rows, for the FK-constraint reason noted in section 3 above) —
the boundary key was the one piece this card's own round-2 landing left behind.

### (4) The `"error"` verdict — fails closed like `"unrecorded"`, but is NEVER memoized

A genuinely transient git failure (a timeout, a read error, or — the NAMED sub-case — a boundary sha that
has stopped resolving in this repo) now returns a dedicated `"error"` verdict, distinct from the semantic
`"unrecorded"` (sha genuinely isn't pre-ledger or reachable). `verifyGoneBranchLanding` refuses on both
identically (fails closed), but `classifyAgainstLedger`'s memo wrapper returns `"error"` BEFORE ever
calling `cacheGoneBranchLedgerVerdict` — so an `"error"` verdict can never wedge a sha behind a permanent
cached refusal; the very next clean lookup for the same sha recomputes from scratch. Three distinct call
sites can produce it: the precondition's own rev-list, a dedicated boundary-existence probe (`git
cat-file -t <boundary>` — **NOT `-e`: measured directly that `simple-git`'s `raw()` resolves `cat-file -e`
on a nonexistent object with EMPTY output instead of rejecting on its nonzero exit; `-t` (type query)
correctly rejects via a real "could not get object info" fatal error, which is what makes this probe
actually distinguish "resolves" from "doesn't"**), and the boundary merge-base call itself.

### (5) Non-blocking nits addressed

- The orphaned JSDoc for the deleted `pruneMainlineLedger` retention constant (dangling since round 2
  deleted the constant itself) is removed.
- The schema's own comment no longer mentions the removed prune; `idx_mainline_landed_commits_branch_id`
  (which served ONLY that prune's own query) is documented as now-unused rather than silently left
  unexplained — kept rather than dropped, since removing a `CREATE INDEX` from this init-schema string
  only stops a FRESH db from creating it; an EXISTING db's copy needs an actual migration to remove, which
  this card's own round-3 ruling said not to add for this.
- `Db.getGoneBranchLedgerMaxRowId`'s own doc now states explicitly WHY a bare `MAX(id)` comparison is a
  safe invalidation signal: `id` is this table's AUTOINCREMENT column — globally increasing, never reused,
  even across the round-3 rebind delete above.
- A transient git error is no longer cached as `"unrecorded"` with a misleading log — see (4) above.
- Project deletion now sweeps the boundary key — see (3) above.

## Round 4 — the third Code Review's BLOCKING finding: round 3's own fix un-merges genuine history

Round 3's Code Review (reviewer `fa18cfea`, real-git probes in `p/probe4.mjs`) confirmed round 2's three
blockers stayed closed, but found round 3's OWN first-parent precondition itself BLOCKING: it rejects a
genuinely Loom-landed commit the instant ANY real merge commit sits between it and `refTip` — including
the owner's own sanctioned `project_checkout_branch create:true` flow (probe4 A: land on a fresh `feat`
branch, merge it into main — every landing on `feat`, plus the merged map, reads NOT landed against main),
a genuine pre-ledger commit merged in via a second parent (probe4 B), and the pre-ledger leg inheriting a
cap it never had before round 3 (probe4 C).

### (1) PRE-LEDGER leg: dropped the precondition and the cap — a bare, unbounded ancestor check

`classifyAgainstLedgerUncached`'s pre-ledger leg is back to round 2's own shape: `merge-base(sha,
boundary)`, accepted iff the result equals `sha` — no first-parent requirement, no cap. This is sound
specifically BECAUSE the boundary is a FIXED sha (write-once, never updated) whose own ancestry can never
change: `canonicalGit` (via `boundedGit`, the readers' own git factory) neutralizes replace-refs, grafts,
shallow clones and the commit-graph cache, so nothing can retroactively alter what `boundary`'s real
ancestry is. A forgery planted AFTER the boundary was established can therefore never become the
boundary's ancestor, regardless of whether it was later merged into history via a first or second parent
— the ancestor relationship itself is the only thing being trusted, and that relationship is tamper-proof
once the boundary sha is fixed. Verified: probe4 B (a genuine pre-ledger commit reachable from the
boundary only via a merge's second parent) and probe4 C (the same shape, but with 20001 ordinary commits
piled on after the boundary — a distance that would have exceeded round 3's cap) both now read `"pre-
ledger"`, correctly, as PRE-LEDGER-B/PRE-LEDGER-C in the test file.

### (2) RECORDED leg: match against the ROW's OWN first-parent range, never `refTip`'s

Replaces round 3's `refTip`-first-parent-line precondition entirely. The new rule:

1. `sha` must be a genuine ancestor of `refTip` (any path — one `merge-base(sha, refTip) === sha` check).
2. Candidate ledger-row tips are found via ONE bounded `rev-list --ancestry-path --max-count=<cap+1>
   sha..refTip` — **`--ancestry-path`, not `--first-parent`**: it restricts the walk to commits that are
   BOTH descendants of `sha` AND ancestors of `refTip`, so it correctly follows a merge's SECOND parent
   (a first-parent-only walk, round 3's mistake, never does). `sha` itself is prepended to this candidate
   list (mirroring round 2/3's own convention) so the trivial `sha === row.tip` case needs no git call.
3. `sha` is `"recorded"` iff, for some candidate row `R` (found via the existing indexed `tip IN (...)`
   lookup, `Db.getGoneBranchLedgerRowsByTips`, unchanged): `sha === R.tip`, OR `sha` appears in `rev-list
   --first-parent R.base..R.tip` — i.e. `sha` is literally a member of THAT ROW's own first-parent range
   (every landing writes its row this way: `base` = the pre-landing tip, `tip` = the final landed commit,
   first-parent-chained between them — a solo landing's range is one commit, a batch's covers every
   intermediate candidate too).

**Why MERGEFORGE still refuses:** a forged `F` landed as a merge `M`'s second parent is never inside ANY
real row's own first-parent range. The row for whatever landed on top of `M` has `base = M` (or later) —
walking that row's OWN `base..tip` range via `--first-parent` never reaches back before `M`, so `F` (`M`'s
OTHER parent) is never a member. Never accept on `rows.length > 0` alone; the PER-ROW first-parent
membership is what discriminates — this is exactly the test file's own `MERGEFORGE` scenario, still
refused.

**Why genuine merged-in landings now resolve (probe4 A, MERGEIN-A/MERGEIN-BATCH in the test file):** a
landing on a side branch (`feat`) writes its own row scoped to `feat`'s own first-parent progression
(e.g. `{base: priorFeatTip, tip: s1Tip}`). Once `feat` is merged into main, `s1Tip` is still reachable
from `refTip` (now on main, past the merge) — `--ancestry-path` finds it as a candidate tip (or `sha`
itself is `s1Tip` directly, the trivial case), and the per-row check (`s1Tip === row.tip`, or a batch
intermediate found inside that row's own range) passes exactly as it would have if `feat` had never been
merged at all. The merge commit's own shape (which parent is "first") is irrelevant to this leg — only
the ROW's own internal shape matters.

### (3) The honest horizon, restated

The `GONE_BRANCH_LEDGER_CHAIN_SCAN_CAP` (still 20000, unchanged from round 3) now applies ONLY to the
RECORDED leg's `--ancestry-path` walk: **≈20000 commits behind `refTip`, ≈700 days at this repo's own
~28 first-parent commits/day.** The PRE-LEDGER leg is UNBOUNDED (section 1 above). `findLandedSquashCommit`'s
own `git log <base> --grep` scan (what finds `sha` in the first place, before either leg ever runs) is
ALSO unbounded, independent of this cap entirely — round 3's "20000 is comfortably above both" sentence
is corrected: the cap was never a bound on the WHOLE gate, only on one specific internal walk. Measured on
this host, `rev-list --ancestry-path --max-count=20001` over a genuine 20000-commit linear chain (the
ancestry-path walk degenerates to a plain linear scan when there's only one path, same cost class as
round 3's own `--first-parent --parents` measurement): comparable sub-second cost, re-confirmed by the
test file's own `HORIZON` timings (2001 commits: 328ms; 6000 commits: 554ms) after this round's rewrite.

### (4) The `"error"` log is rate-limited; the verdict stays uncached

An `"error"` verdict is still never memoized (section 4 of round 3, unchanged) — but a repeatedly-failing
`(sha, scope)` pair (the SAME transient condition hit on every board read, say) used to log on every
single attempt. `logGoneBranchLedgerErrorRateLimited` (git/worktrees.ts) now gates the LOG ONLY: keyed by
`${sha}\u0000${scopeKey}` (`GoneBranchLedgerFacts.scopeKey`, a new `${projectId}:${repoKey}` field added
this round purely for this), at most one log line per key per `GONE_BRANCH_LEDGER_ERROR_LOG_RATE_LIMIT_MS`
(10 minutes), bounded at `GONE_BRANCH_LEDGER_ERROR_LOG_MAX` (500) entries. The classification function's
own return value is completely untouched by this — every call still re-evaluates and fails closed; only
the diagnostic noise is bounded. Verified by the test file's `ERROR LOG RATE LIMIT` scenario: two
back-to-back identical failures produce exactly ONE log line, and a third, clean lookup afterward still
resolves correctly (proving the verdict itself was never cached).

### (5) Named residual: the rebind boundary-seeding race (NOT fixed here — card `26c12fac`)

**Tracked separately: card `26c12fac`, "fix(git): keep a post-rebind ledger row from seeding a foreign
boundary".** The race: round 3's rebind cleanup clears a scope's ledger rows and boundary key the moment
a repoPath genuinely changes, but a landing from the OLD repo can still be mid-flight and record its row
AFTER that clear — seeding the boundary as an OLD-repo sha that can never resolve in the NEW repo. Every
subsequent lookup in the new repo then returns `"error"` (via the boundary-existence probe, section 4
above) forever, never a clean refusal or acceptance, until a human intervenes. Not fixed in this round.

### (6) The bootstrap window reopens on every rebind, not just once

Round 2/3 described the ledger-absence bootstrap residual (section (1) way above) as "a one-time window"
— true only for a scope's genuine first-ever landing. **It is not one-time**: a human-only repoPath rebind
(section 3 of round 3) clears the boundary back to `null`, and the SAME "first landing establishes W but
writes no row" quirk (the `expectedMainlineBranch` timing gap, also described above) means the gate is
effectively OPEN — `resolveBoundary() === null`, a no-op per this card's own "Do not treat a ledger-absent
scope as a refusal" rule — from the moment of rebind until the SECOND landing after it. Every rebind
reopens this window; it is not consumed once and then closed forever.

## Round 5 — the fourth Code Review's perf finding, plus three minor corrections

Round 4's own Code Review (reviewer `24f719fd`, probes in its own scratch dir, `p/probe5.mjs`) VERIFIED the
forgery class CLOSED — every ADV1-ADV4 adversarial forgery is refused, and the writer audit holds (see
"the recorded leg's invariant" bullet in "Do not" below). It found one MAJOR perf issue and three minors.

### (1) MAJOR, perf — an unrecorded sha cost O(candidate rows) git spawns

The RECORDED leg used to spawn one `git rev-list --first-parent row.base..row.tip` PER candidate row until
a match — so a genuinely UNRECORDED `sha` (the case that never short-circuits early) cost one spawn per
candidate row, measured at 11.6s for 200 rows and 64.8s for 1000. The memo key changes on every landing
(`maxRowId`), and `tasks_list` resolves every card on a board read, so this repeated on every board read
after any landing — and is attacker-amplifiable (an attacker can cheaply grow the candidate-row count by
landing many small, legitimate batches).

Fixed in three parts, all in `classifyAgainstLedgerUncached`'s RECORDED leg:

1. **Check `row.tip === sha` directly, FIRST, with zero git spawns** — a plain `ledger.rowsByTips([sha])`
   DB lookup (see (2) below — this is also minor 3's own fix, done at the same call site).
2. **Prune candidates WITHOUT spawning git**, before the per-row membership walk: a row can contain `sha`
   only if `row.base` is a PROPER ancestor of `sha`. Two conditions rule that out for free, using data
   already in hand from the ancestry-path walk: `row.base === sha` (the half-open range excludes the base
   itself), or `row.base` is itself a member of the `candidateTips` set (every member of that set is, by
   construction of `--ancestry-path`, a DESCENDANT of `sha` — and `sha`'s own ancestor can never also be
   its descendant in a DAG). Either condition eliminates the row with a `Set` membership check, no spawn.
3. **Spawn the per-row `rev-list --first-parent` walk only for rows that survive the prune**, capped at
   {@link GONE_BRANCH_LEDGER_ROW_SPAWN_CAP} (8) — past the cap, fails CLOSED to `"unrecorded"`, logged,
   same posture as the chain-scan cap's own overflow. **Round 6 correction:** this does NOT "only ever bind
   for a genuinely unrecorded `sha`" — under the writer invariant, the PRUNE above already reduces an
   unrecorded `sha`'s own survivors to ZERO, so the cap never even sees that case. This cap instead binds
   only on a ledger shape the writers cannot produce — duplicate rows, or an invariant violation — where
   SEVERAL rows genuinely, simultaneously contain `sha`; see round 6's own section below for the measured
   distinction.

Covered by the test file's own `MANY UNRELATED ROWS`, `GENUINE INTERMEDIATE ABOVE CAP`, and `DUPLICATE ROW
OVERFLOW` scenarios (rounds 5/6) — see round 6's own section below for exactly what each one proves, and
why `MANY UNRELATED ROWS` alone does NOT prove the prune is load-bearing (the fifth Code Review's finding).

### (2) Minor 3 — the direct tip check moves BEFORE the capped ancestry-path walk, giving it an unbounded horizon

Previously, `ledger.rowsByTips(chain)` (where `chain = [sha, ...candidateTips]`) ran AFTER the capped
`--ancestry-path` walk — so a genuinely old landing where `sha` IS a row's own tip (the ordinary solo or
batch-final case) could read `"unrecorded"` if the walk's own candidate-tip count happened to exceed
{@link GONE_BRANCH_LEDGER_CHAIN_SCAN_CAP} before the trivial match was ever checked. The reviewer measured
this directly: a solo landing whose row-tip sits 20001 commits back (one past the cap) read NOT landed.

Fixed by moving `ledger.rowsByTips([sha])` to run immediately after the ancestor-of-`refTip` check, BEFORE
the ancestry-path walk/cap. A solo or batch-final landing's horizon is now genuinely UNBOUNDED, at ZERO
additional GIT spawns (one DB lookup — **round 6 correction:** NOT the indexed point lookup this used to
claim; see section (3) below for why this exact query actually resolves via a scope scan, not the tip
index) — the cap applies ONLY to finding an intra-batch INTERMEDIATE candidate, which is the one case that
actually needs the ancestry-path walk at all. Covered by the test file's own `UNBOUNDED TIP` scenario: a
solo row-tip far past the chain-scan cap still resolves `"recorded"`.

### (3) Minor 2 — the db.ts index comments were FALSE; corrected, not re-derived from a kickoff claim

`idx_mainline_landed_commits_tip`'s and `idx_mainline_landed_commits_branch_id`'s own schema comments
(db.ts ~1550/~1552), and `getGoneBranchLedgerRowsByTips`'s own doc (db.ts ~4069), claimed the `tip`-leading
index serves this query as an indexed point lookup and that the `branch_id` index is unused dead weight.
**Measured via `EXPLAIN QUERY PLAN` (verified independently in this round, not merely copied from the
review): FALSE.** `getGoneBranchLedgerRowsByTips`'s own query leaves `branch` unconstrained in its WHERE
clause, and this DB never runs `ANALYZE` (grepped: no `ANALYZE` call anywhere in db.ts) — without gathered
statistics, SQLite's query planner does not attempt the skip-scan that would let it use the `tip`-leading
index with `branch` unconstrained, and instead picks `idx_mainline_landed_commits_branch_id` as a plain
`(project_id, repo_key)` scope scan, filtering `tip IN (...)` row-by-row. (A throwaway probe that first ran
`ANALYZE` showed the OPPOSITE result — the skip-scan DID kick in — which is exactly why "measured on a
fresh `:memory:` db with no `ANALYZE`" matters as the honest reproduction of production's own behavior, not
just "measured.") Both schema comments and the method's own doc are corrected to say what `EXPLAIN QUERY
PLAN` actually shows. **No migration or new index is added for this** (per the manager's own round-5
ruling) — round 5's fix (1) above already bounds this query's own call-site cost (via the candidate-tip
cap and the row-spawn cap), so the underlying query's scan shape no longer matters for correctness or for
worst-case cost; it would only matter for raw per-call latency, which was not the finding here.

### (4) Minor 4 — the record's own first "Do not" bullet below is rewritten for round 4/5's actual rule

See the rewritten first bullet in "Do not" below, and the new bullet stating the writer invariant the
RECORDED leg's own soundness rests on (never re-verified by the reader) — both replace language that still
described round 2's now-superseded chain-walk shape.

### (5) Nit — the chain-scan cap's horizon restated in ancestry-path commits, not first-parent-only ones

See {@link GONE_BRANCH_LEDGER_CHAIN_SCAN_CAP}'s own doc comment (git/worktrees.ts) for the corrected
framing and the freshly re-measured real-repo numbers (4209 first-parent vs 4386 ancestry-path commits
over this repo's own full history, ~298ms walk) — a merge-heavy stretch of history reaches the cap sooner
than a first-parent-commits/day figure alone would suggest, since `--ancestry-path` counts every parent of
a merge, not just the first.

## Round 6 — the fifth Code Review (SOUND), a blocking test gap, and three doc corrections

Round 5's own Code Review (reviewer `3ff64664`, probes in its own scratch dir, `p/probe6.mjs`) ruled round
5 SOUND: the prune provably never drops a row that genuinely contains `sha` (even with the writer invariant
deliberately broken in the reviewer's own probes), the direct tip check accepts nothing round 4 itself
would have refused, and the perf fix holds (~0.5s at 1000 rows, vs the old ~65s). It found one BLOCKING
test gap and three doc corrections. **Round 6 is TESTS + DOCS ONLY — no `src` logic changed.**

### (1) BLOCKING — a mutation that deletes the prune entirely left the whole file green

The reviewer's own mutation run, replacing the prune's filter with `rows.filter(() => true)` (every row
"survives"), left EVERY existing check passing. `MANY UNRELATED ROWS` (round 5's own `ROW PRUNE SPAWN
CAP`, renamed here — see (4) below) passed for the WRONG reason: all 300 of its rows are genuinely
unrecorded candidates, so without the prune they still all become "survivors", still exceed the row-spawn
cap, and still resolve `"unrecorded"` via the SAME overflow path — the exact right answer, reached without
the prune ever mattering. The realistic regression that mutation causes was simply untested: the
reviewer's own probe P6 — a GENUINE batch intermediate with 24 later rows (12 of them merged-in side
batches) — turns FALSE-unmerged under that mutation, hitting the row-spawn-cap overflow instead of its
correct `"recorded"` answer.

Two new scenarios close this gap:

- **`GENUINE INTERMEDIATE ABOVE CAP`** — a genuine batch intermediate candidate (the first of a two-worker
  batch landed on a side branch, mirroring `MERGEIN-BATCH`), with 8 MORE real, unrelated rows piled on
  after it (one more genuine merged-in side batch, matching probe P6's own shape, plus 7 cheap synthetic
  sequential landings) — 9 total candidate rows reachable from the intermediate's own position, of which
  exactly ONE genuinely contains it. With the prune intact this resolves `"recorded"` on a bounded, small
  spawn count (survivors === 1); **proven to go RED without the prune** via a temporary, reverted local
  mutation (`rows.filter((row) => row.base !== sha && !descendantsOfSha.has(row.base))` replaced with
  `rows.filter(() => true)`, the same mutation the reviewer used) — the mutated build resolved `null`
  (false-unmerged) instead of the genuine landed sha, confirming the gap; the mutation was then reverted
  and the file checked byte-identical to its committed form (`git diff` empty) before re-confirming GREEN.
- **`DUPLICATE ROW OVERFLOW`** — the cap's OWN pin, on the pathological shape it actually exists for: the
  SAME real `(base, tip)` row inserted 9 times (a ledger shape the writers cannot produce — see (3) below).
  All 9 copies genuinely contain `sha` and none is prunable, so survivors = 9 > {@link
  GONE_BRANCH_LEDGER_ROW_SPAWN_CAP} (8) and the candidate reads `"unrecorded"` — a real false negative, by
  design, on this pathological shape. Asserts the overflow logs exactly ONCE across two back-to-back
  identical lookups (the SECOND is served from the memoized verdict cache, never re-invoking the
  classifier at all) — proving both "logged once" and "memoized" in one assertion.

### (2) The prune's own rationale was wrong — it is PERF/AVAILABILITY-only, never a soundness guard

Round 5's own record and its `@decision` comment both said removing the prune "reopens the exact
laundering case this card closes." **False, and corrected here and at the two sites named below.** The
prune changes nothing about what the per-row `rev-list --first-parent row.base..row.tip` walk itself
proves — `base..tip` already excludes `base`, so a laundering attempt (ADV1-4) is refused by that walk
regardless of whether the prune ran first. What the prune actually buys is availability: without it, MANY
more rows become "survivors" needing an actual walk, which can push a genuinely recorded candidate's own
survivor count past the row-spawn cap — turning a real landing into a false `"unrecorded"`, exactly what
`GENUINE INTERMEDIATE ABOVE CAP` (above) proves. **Corrected at:** the record's first "Do not" bullet
(below) and the `@decision` comment on `classifyAgainstLedgerUncached` itself (`git/worktrees.ts`). The
"never accept on `rows.length > 0` / merely surviving the prune alone" half of both stays — that remains
true and load-bearing; only the "why" was wrong.

### (3) The cap's own doc had the direction backwards

`GONE_BRANCH_LEDGER_ROW_SPAWN_CAP`'s own doc (`git/worktrees.ts`) and this record's section (1) item 3
both said the cap "only ever binds for a genuinely unrecorded sha" — **backwards.** Under the writer
invariant (the record's own "Do not" bullet on it), a genuinely unrecorded `sha` has ZERO survivors once
the prune has run (every candidate row reachable from `sha` must itself start AFTER `sha`, or `sha` would
genuinely be inside it — contradicting "unrecorded"), so the cap never even sees that case. **The PRUNE,
not the cap, is what closes the unrecorded-sha blow-up** — confirmed directly by `GENUINE INTERMEDIATE
ABOVE CAP`'s own negative control: the cap only fires there once the PRUNE is removed, never otherwise.
The cap instead binds only on a ledger shape the writers cannot produce — duplicate rows (exactly
`DUPLICATE ROW OVERFLOW`'s own shape, above) or some other writer-invariant violation — where SEVERAL rows
genuinely, simultaneously contain the same `sha`. **Named follow-up, not needed today:** deduping survivors
by `(base, tip)` before counting them against the cap (or a DB uniqueness constraint on
`mainline_landed_commits`) would close even that pathological case's own availability cost — out of scope
for this round, since round 6 touches no `src` logic.

### (4) Renamed: `ROW PRUNE SPAWN CAP` → `MANY UNRELATED ROWS`

Round 5's own scenario never actually distinguished "the prune ran" from "the prune didn't run" — both
produce the same bounded spawn count and the same correct `null` answer for its specific candidate (a
genuinely unrecorded sha facing 300 structurally-unrelated rows, all either equal to `sha` or descendants
of it — see (1) above for why that shape can never exercise the cap meaningfully either way). Renamed to
say what it actually proves: a correct, fast resolution against many rows — not a prune-dependence proof.
That proof is `GENUINE INTERMEDIATE ABOVE CAP`'s job now.

### (5) Nits

- The Minor-3 section above ("the direct tip check moves BEFORE...") called `rowsByTips`'s own query "a
  single indexed DB point lookup" — contradicting section (3)'s own finding that this exact query does NOT
  use the tip-leading index (no `ANALYZE` has run). Corrected to say what section (3) actually found.
- The "Covered by..." pointer paragraphs in sections (1) and (2) above cited scenario names (`ROW SPAWN
  CAP`/`PERF`) that don't exist in the test file. Corrected to the real names, including round 6's own
  renames and additions.

## Do not

- Do not accept `sha` as `"recorded"` on `rows.length > 0` alone (round 2's now-superseded shape), nor on
  merely SURVIVING round 5's zero-spawn prune — the prune is an ELIMINATION filter, never a membership
  proof. Membership must be confirmed either directly (`sha === row.tip`, the round-5 trivial-tip check)
  or via the actual `rev-list --first-parent row.base..row.tip` spawn for every row the prune could not
  rule out. **Round 6 correction:** the prune's own two conditions (`row.base !== sha`, `row.base` ∉
  ancestry-path-of-`sha`) are a PERF/AVAILABILITY optimization, not a soundness guard — removing them does
  NOT reopen laundering (ADV1-4 stay refused regardless, since the per-row walk itself still correctly
  excludes a non-containing row's own range; `base..tip` already excludes `base`). The real cost of
  dropping the prune is AVAILABILITY: more rows become "survivors" needing an actual spawn, which can push
  a genuinely recorded candidate past {@link GONE_BRANCH_LEDGER_ROW_SPAWN_CAP}, falsely reading it as
  unmerged (see `GENUINE INTERMEDIATE ABOVE CAP` in the test file, and round 6's own section above). Keep
  the prune anyway — it is what makes an ordinary lookup cheap.
- Do not forget the RECORDED leg's own soundness RESTS on a WRITER invariant it never independently
  re-verifies: every ledger row's `base` is its `tip`'s own first-parent ancestor, and every commit in that
  `(base, tip]` range is genuinely Loom-made. This holds because both landing paths verify each commit they
  write before recording its row — the solo path via `verifyCommitParentAndTree` (git/worktrees.ts ~9315)
  and the batch path via the same function, reused (`batch-merge.ts` ~769). The fourth Code Review's own
  ADV5 probe demonstrated what breaks if a future writer change ever violates this invariant: a row whose
  range contains a commit the writer never actually verified would launder that commit through this leg
  exactly like a genuine landing — the reader has no independent way to catch that.
- Do not resolve the branch-gone ledger scope from a separately-read mainline-watermark branch — always
  the SAME `ref`/`base` the caller scanned to find the candidate sha in the first place (round 1's
  finding 5: a mismatch silently scopes the lookup to the wrong history).
- Do not key the branch-gone ledger gate on `Db.isMainlineLedgerReachable` (the watermark-trust chain
  walk) — that walk requires each hop to itself be a recorded `tip`, which an intra-batch intermediate
  commit never is; it would misclassify every non-final candidate of a real multi-candidate batch as
  unrecorded.
- Do not apply the ledger gate to the branch-LIVE `branchContentLandedInCommit` arm — out of scope
  (already independently content-verified).
- Do not treat a ledger-absent scope (`resolveBoundary() === null`) as a refusal — it must be a no-op
  (today's self-consistent-trailer check alone decides), or every project without ledger history yet is
  permanently unable to confirm any branch-gone landing.
- Do not reintroduce pruning on `mainline_landed_commits`, for any reason, without re-reading section (2)
  above first — it was investigated and found not load-bearing for anything the table's one other reader
  (`isMainlineLedgerReachable`) actually needs, and reintroducing it reopens M1/M2 exactly as measured.
- Do not raise `GONE_BRANCH_LEDGER_CHAIN_SCAN_CAP` without re-checking the overflow log line and the test
  that exercises it — an overflow must always resolve to `"unrecorded"`, never silently widen to "scan
  everything".
- Do not add a new `findLandedSquashCommit`/`resolveMergedCommitMapHit`/`getTaskMergedInfo`/
  `findLandedSquashCommitViaMap` call site in a project/repoKey-aware context without threading BOTH
  `deps.goneBranchLedger` AND the correct `ref` (the one actually scanned) — an un-threaded new call site
  silently reverts to the pre-card, self-referential branch-gone check for that one caller.
- Do not move `verifyGoneBranchLanding`'s ledger gate ahead of the existing `verifyPersistedPathSet`
  self-consistency check, or skip the latter when the former passes — both must hold.
- Do not forget the memo cache's key includes `maxRowId` — dropping it (e.g. keying only on `sha`+`refTip`)
  would serve a stale verdict forever once ANY new landing changes the ledger, including one that should
  flip a previously-"unrecorded" sha to "recorded".
- **RETRACTED by round 4 — do NOT reintroduce this:** round 3 required `sha` to sit on `refTip`'s own
  first-parent line before accepting EITHER leg. That precondition itself was the round-4 bug — it
  un-merges genuine history the instant any real merge commit sits between `sha` and `refTip`. See round
  4's own bullets below for the actual rule.
- Do not cache an `"error"` verdict (`classifyAgainstLedger` returns it BEFORE calling
  `cacheGoneBranchLedgerVerdict`) — a transient git failure must never wedge a sha behind a permanent
  cached refusal.
- Do not probe boundary existence with `git cat-file -e` — measured that `simple-git`'s `raw()` resolves it
  with empty output on a nonexistent object instead of rejecting. Use `cat-file -t` (or re-verify any
  replacement probe actually rejects, the same way, before trusting it).
- Do not let a repoPath rebind or a project deletion skip clearing `mainline_landed_commits` rows and the
  `gone-branch-ledger-boundary:*` `app_meta` key for that scope — a boundary sha from the OLD repo almost
  never resolves in a new one, and (pre-round-3) that left every gone-branch landing in the new repo
  reading `"unrecorded"` forever (write-if-absent never re-seeds over a stale value).
- Do not reintroduce ANY first-parent-of-`refTip` (or first-parent-of-boundary) precondition ahead of
  either leg — round 4's own closed bug. Check genuine Loom-landed history through at least one real,
  non-fast-forward merge commit (the `NONLINEAR`/`MERGEIN-A`/`MERGEIN-BATCH` tests) before trusting any
  future change to either leg's acceptance rule.
- Do not match the RECORDED leg against `refTip`'s own ancestry/ordering — match against each CANDIDATE
  ROW's own `base..tip` first-parent range instead. The two are different on purpose: a row's range is
  fixed at landing time and immune to what happens to history afterward (a later merge, more landings);
  `refTip`'s own first-parent line is not.
- Do not widen `--ancestry-path` to a plain `sha..refTip` listing (dropping that flag) — plain range syntax
  can include commits reachable from `refTip` via an UNRELATED branch that happens to also be excluded-
  from-`sha`'s-ancestry, never actually sitting on a real path between the two; `--ancestry-path` is what
  keeps the candidate-tip set scoped to genuine `sha`-to-`refTip` paths.
- Do not skip the `merge-base(sha, refTip) === sha` ancestor check before trusting an `--ancestry-path`
  result as proof `sha` is reachable from `refTip` — the walk can be well-formed and still empty for an
  unrelated `sha`; the explicit ancestor check is what actually establishes reachability.
- Do not log an `"error"` verdict unconditionally — route it through `logGoneBranchLedgerErrorRateLimited`
  (keyed by `sha` + `GoneBranchLedgerFacts.scopeKey`), or a repeatedly-failing lookup (the same board read,
  every poll) spams the log once per call. This rate-limits the LOG only; the verdict itself must still
  never be cached (the bullet above).
- Do not add a new `GoneBranchLedgerFacts`-constructing call site without setting `scopeKey` to
  `${projectId}:${repoKey}` — the error-log rate limiter's only identity for "which scope is this."

## Found but out of scope (carded separately)

The batch-commit-msg-hook-aborts-the-whole-batch finding and the solo/batch hook-tolerance asymmetry
(solo silently succeeds but produces trailers unreadable to every reader thereafter; batch hard-fails
every candidate) are tracked as card `45036494` — not fixed here, and this card's own ledger-gate rule is
kept independent of that card's eventual fix.
