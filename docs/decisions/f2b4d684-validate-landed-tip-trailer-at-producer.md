# f2b4d684 — validate the landed-tip trailer at its producer for held-branch paths

Follow-up from card `b8122303`'s Code Review (reviewer `201f0fa5`), round 2 finding 2: `readLandedTipTrailer`
(`git/worktrees.ts`) returned `parseLoomTrailerBlock(body)?.landedTip`, shape-checked only, with no
exact-object-id resolution — the same "a 41-64-hex value can resolve as a REF NAME instead of the literal
object id when a same-named ref also exists" ambiguity `c0d0eac9` round 7 closed for `Loom-Worker-Base`
and `b8122303` closed for `verifyReviewedTipChain`'s `live` parameter, left open at this producer.

Seven rounds (and counting — do not trust this count either; read the section headers below, the one
place it cannot drift). Round 1 (reverted by CR1) and round 2 (reverted by CR2) are kept below as
specimens, not designs to copy — each closed a real gap and introduced a new one; read "Do not" before
implementing against anything in the history sections. Round 3 is the producer's current (kept) design,
below. Round 4 (its own section, after "Real repros") is a SEPARATE, additive fix at the caller's outer
verdict-cache layer — it does not revise the producer's three-state split at all. Round 5 (its own
section, after Round 4) closes a SIBLING gap at a DIFFERENT caller — an already-HELD branch's own early
owed-range refusal — found by CR4 after round 4 shipped; it also does not touch the producer's
three-state split. Round 6 (CR5) makes `isBranchHeld` the ONE chokepoint for this branch's own
unverifiable-trailer status, closing a THIRD caller (`finishAlreadyMerged`'s own `heldAtFinish` refusal)
with the identical disease. Round 7 (CR6) goes further still — STRUCTURAL this time: it makes `isBranchHeld`
read the trailer EXACTLY ONCE and never re-read it within one evaluation, closing two TOCTOU-shaped
regressions round 6 itself introduced/left open. See "Round 6 + Round 7" below for both.

## Current design (round 3) — the producer returns THREE states

`readLandedTipTrailer` (`git/worktrees.ts`) returns ONE of:
- **ABSENT** (`null`) — the commit message was read successfully AND genuinely carries no
  `Loom-Landed-Tip` field. This is the ONLY way to get `null` as of round 3.
- **VALID** (the resolved tip, a real commit sha) — a trailer was recorded AND resolved to its own exact
  commit object via `resolveExactTrailerObjectId` (never re-implemented elsewhere).
- **UNVERIFIABLE** ({@link `TRAILER_TIP_UNVERIFIABLE`}, a reserved non-hex sentinel string, never equal to
  any real tip, and NEVER PERSISTED anywhere — see the round-2 Major below for why) — covers THREE
  distinct failure shapes, all collapsed to the same state: a trailer parsed but failed exact-object-id
  resolution (malformed, nonexistent, a same-named decoy ref/tag); the validation call itself threw; OR
  (round 3) the OUTER `git log` read itself threw, so the commit message could not be read at all.

Round 3's reversal: rounds 1-2 mapped the outer log-read throw to ABSENT ("no evidence a trailer
existed"). CR2 ruled this backwards — "could not read the message" is "could not confirm either way,"
never "confirmed nothing's there" — and CR1/CR2 both reproduced the real cost: an unreadable trailer
reaching `pinnedTipForLandedSquash`'s ABSENT branch (`legacyTip`, a fresh live read) and deleting a late,
ungated commit. The accepted cost of the reversal is a merely-transient hold that self-releases on the
next readable call (see the round-2-Major fix below for WHY it self-releases rather than sticking).

## Per-caller mapping (read this before touching either caller)

| Caller | ABSENT (`null`) | VALID | UNVERIFIABLE |
|---|---|---|---|
| `heldRecordedTip` (→ `isBranchHeld` ONLY — round 7 made this the single reader; every other consumer reads `isBranchHeld`'s own `recorded` field) | stays held / refuses (unchanged) | the resolved tip | **`tip` folds to `null` for `isBranchHeld`'s own RELEASE check only** — round 5/6/7 correction: the `unverifiable` flag does NOT fold away, and travels verbatim in `isBranchHeld`'s own return (`recorded.unverifiable`) to every consumer, which must classify it distinctly (never-cached) from a genuinely absent tip (stably cacheable) |
| `pinnedTipForLandedSquash` | falls back to `legacyTip` (cc9bce38's pre-card design for "no trailer") | the resolved tip | **returns `{}`** (no `landedTip` key) — never `legacyTip`, and (round 3) never the `SOLO_TIP_UNVERIFIABLE` literal either |

**Why `pinnedTipForLandedSquash` must NOT fold UNVERIFIABLE into ABSENT:** `legacyTip` is a FRESH live
read of the branch's current tip. Finalize's own CAS (`soloFinalizeTipGuard`'s `expectedBranchTip`,
checked in `finalizeMerge`) compares `expectedBranchTip` against a SEPARATE live read made moments later
— if `expectedBranchTip` is `legacyTip`, it is the SAME value as that later live read by construction, so
the CAS trivially MATCHES and finalize DELETES the branch (and any late, ungated commit on it) instead of
retaining it. Pre-card, an unresolvable/forged trailer's LITERAL text was pinned verbatim — the CAS never
matched it (fail-closed: RETAINED).

**Why `pinnedTipForLandedSquash` must return `{}`, not `{landedTip: SOLO_TIP_UNVERIFIABLE}` (the round-2
Major, CR2):** `soloFinalizeTipGuard` ALREADY maps an absent/undefined `landedTip` to the
`SOLO_TIP_UNVERIFIABLE` sentinel for `expectedBranchTip` (`a.landedTip ?? SOLO_TIP_UNVERIFIABLE`), so the
CAS behaves identically either way, in THIS call. The difference is what gets PERSISTED into the
`merge_branch_retained` event's `detail.landedTip`:
- Round 2 (`{landedTip: SOLO_TIP_UNVERIFIABLE}`): the event durably records the literal sentinel STRING.
  `heldRecordedTip`'s own FIRST branch (`typeof retain.detail?.landedTip === "string" ? retain.detail.landedTip : ...`)
  reads that field back VERBATIM on every LATER call — no re-read of the real trailer, ever again — and
  hands it straight to `resolveOwedRange`'s `base`, which reaches `resolveGitRef`'s `${base}^{commit}` as
  a LIVE GIT REVISION ARGUMENT. CR2 planted a ref literally named `"unverifiable-landed-tip"` and
  `rev-parse` RESOLVED it — the sentinel failed closed only by the accident of no such ref existing in
  the repo at CR time, not by any structural guarantee. Persisting it ALSO makes a transient fault
  PERMANENT: once the string sits in `detail.landedTip`, no later call ever calls `readLandedTipTrailer`
  again for this retain, so a since-cleared transient fault (or a since-un-pruned gc) can never self-heal.
- Round 3 (`{}`): the event records `landedTip: null`. `heldRecordedTip`'s first branch no longer matches
  (not a string), so it falls through to `assembledTip` (absent) then to
  `landedSha ? await readLandedTipTrailer(...) : null` — a FRESH re-read, every single call. A transient
  fault clears → the next call's fresh read resolves VALID → `isBranchHeld`'s own release check
  (`currentTip === recordedTip`) can now fire → the hold self-releases (or the branch finalizes normally
  through the ordinary early-finish path) with no residual trust in a stale value — **PROVIDED the call
  actually reaches this logic at all.** Round 3 proved this only through the UNCACHED `confirmWorkerMerge`
  entry point. See Round 4 below for the gap that left open: the real `worker_merge_confirm` entry point
  (`confirmWorkerMergeTracked`) has its OWN, separate verdict cache sitting in front of all of this, which
  used to replay the first call's retain forever without ever reaching this self-heal at all. See
  `landed-tip-trailer-unverifiable-retains-branch.mjs` scenario (d) for the permanent, THROUGH-TRACKED proof.

**Why folding `tip` to `null` for the RELEASE check is safe (but folding `unverifiable` away is NOT):**
`isBranchHeld` uses the returned `tip` ONLY in a plain string equality against a live-read current tip to
decide whether to RELEASE the hold — `null` (from ABSENT or an UNVERIFIABLE read) makes that equality
false either way, so the branch STAYS HELD either way, never released more readily. That is the ONE place
folding `tip` to `null` is harmless. The `unverifiable` flag is a DIFFERENT question — not "does this
release the hold" but "may a REFUSAL caused by this be stably cached" — and round 6/7 found THREE
separate callers that got this wrong by reasoning from the first question alone. See "Round 6 + Round 7"
below.

## Real repros

**The gc'd-genuine case (CR1):** land a branch, `commit --amend` the landed commit on the worker's own
branch (same tree — a legitimate operation, not an attack), add a late whole-file revert, then
`git reflog expire --all` + `git gc --prune=now` on the canonical repo. The ORIGINAL `Loom-Landed-Tip`
object — genuinely written by Loom — is now unreachable AND actually pruned, so it no longer resolves.
Round 1: `branchKept:false` (deletes the late revert). Rounds 2/3 (plus pre-card): `branchKept:true`.

**The persisted-sentinel / planted-ref case (CR2):** with round 2's own fix live, a durably-retained
UNVERIFIABLE trailer's sentinel STRING, read back verbatim by a LATER confirm call, reaches
`resolveGitRef`'s revision argument unvalidated. CR2 planted a ref literally named
`"unverifiable-landed-tip"` and had `rev-parse` resolve it. Round 3 closes this by never persisting the
sentinel at all (see the mapping table above).

**The outer-read-fail-open case (CR2):** with round 1/2's outer-read-maps-to-ABSENT design live, a
transient `git log` failure on a branch that is otherwise perfectly fine (no divergence at all) still
reaches `pinnedTipForLandedSquash`'s ABSENT branch, falls back to `legacyTip`, and the live tip trivially
matches it — CR2 reproduced the deletion. Round 3 closes this by mapping the outer-read throw to
UNVERIFIABLE too.

See `packages/daemon/test/landed-tip-trailer-unverifiable-retains-branch.mjs` for the permanent
regression tests of all of the above — RED-proofed against both round 1's and round 2's committed code.

## Round 4 — the outer verdict cache replayed the retain forever (CR3, session `8beac71d`)

Round 3's self-heal (above) is real, but it lives INSIDE `confirmWorkerMerge` — the uncached method. The
real entry point a manager actually calls, `worker_merge_confirm`, goes through
`confirmWorkerMergeTracked`, which sits a SEPARATE verdict cache (`retainVerdictUntilSuperseded`, keyed on
the branch-head `verdictIdentity`) in FRONT of all of it. `classifyOutcome` (`sessions/service.ts`) mapped
an UNVERIFIABLE-cause retain to plain `"merged"` — the SAME string a genuine late/moved-commit retain
gets, and `"merged"` is not in `NEVER_CACHED_OUTCOMES` (`orchestration/pending-ops.ts`). Since the branch
head never moves while the fault is merely transient, a plain re-confirm at the SAME identity was served
the FIRST call's cached retain verbatim — `confirmWorkerMerge` was never invoked a second time, so Round
3's self-heal never had a chance to run. The CR's own repro: a toggled validation fault retains on call 1,
clears, and calls 2/3 still report the stale retain with a `cacheHit` on the identity — a transient fault
held the branch FOREVER unless the manager happened to pass `forceRemoveWorktree` (which bypasses both
caches) or the daemon restarted (which clears the in-memory cache).

**The fix:** thread a new, distinct signal out of the retain path — `pinnedTipForLandedSquash` now returns
`{ tipUnverifiable: true }` instead of `{}` when the trailer was UNVERIFIABLE (still never a `landedTip`
key: the Round 2 prohibition on persisting the sentinel is untouched). `soloFinalizeTipGuard` threads it
through its own `onBranchRetained` closure into a new `tipUnverifiable()` accessor (mirroring `warning()`),
read by `finishAlreadyMerged` AFTER finalize into `ConfirmMergeResult.landedTipUnverifiable` — set ONLY
when a retain actually fired for this specific cause. `classifyOutcome` checks it BEFORE the
merged-else-rejected fallback, classifying it as its own outcome, `"landed-tip-unverifiable"`, now a member
of `NEVER_CACHED_OUTCOMES`. A genuine late/moved-commit retain never sets this field, so it is unaffected
and stays classified `"merged"` — exactly as cacheable as before this round (see scenario (d-control)).
`describeSoloRetained` also now words an UNVERIFIABLE-cause retain distinctly ("could not verify the
landed tip ...; a transient git error is possible — re-confirm once it clears") rather than the
late/moved-commit comparison wording, which is meaningless when the trailer itself couldn't be trusted.

## Round 5 — a held branch's own early owed-range refusal had the identical gap (CR4, session `d5cf586f`)

Round 4 fixed the RETAIN path (a fresh `pinnedTipForLandedSquash` call, reached through
`finishAlreadyMerged`). CR4 found a SECOND, independent path with the exact same disease: once a branch is
ALREADY held (a retain event already exists from a prior call), `confirmWorkerMerge` takes a DIFFERENT,
EARLIER branch — `resolveOwedRange` (card `13fc5227`'s "what range does a held branch still owe main"
resolver) — reached BEFORE the ALREADY_MERGED/preLanded shortcut round 4 fixed. `resolveOwedRange` calls
`isBranchHeld` → `heldRecordedTip`, which re-reads the SAME `Loom-Landed-Tip` trailer — but pre-round-5,
`heldRecordedTip`'s own `readLandedTipTrailer` call had **no injectable git-factory seam at all** (it
ignored both `alreadyLandedGitFactory` and the pre-existing `heldProbeGitFactory`, which was wired only to
`isBranchHeld`'s OWN sibling `findLaterBranchSquash` call). A refusal caused by this unverifiable read
carried no distinguishing flag, so `classifyOutcome` fell through to plain `"rejected"` — stably CACHED —
and a transient fault that genuinely cleared was replayed FOREVER (the CR's own repro,
`cr4/repro2.mjs`: R1 retains correctly with Round 4's own fix; R1b, a second confirm while the SAME fault
still persists, refuses with the OLD "records no readable assembledTip/landedTip... inspect by hand"
wording; R2/R3, after the fault clears, are served R1b's exact `cacheHit`'d opId verbatim, forever, until
`forceRemoveWorktree:true`). The SAME class of gap exists for `isBranchHeld`'s own `gitUnverified` (the
`findLaterBranchSquash` probe itself failing) — its refusal ALSO carried no flag and was cached the same
way; this round closes both under one mechanism, since both are "could not confirm", never "the branch is
stably in a bad state".

**The fix:** `heldRecordedTip` now returns `{ tip: string | null; unverifiable: boolean }` instead of a
bare `string | null` — `unverifiable:true` only when the trailer parsed but failed validation, or the read
itself threw (mirroring the producer's own UNVERIFIABLE state one layer up); `tip:null` with
`unverifiable:false` for a genuinely ABSENT trailer (no `landedSha`, or a successfully-read message with no
`Loom-Landed-Tip` field at all). Both still collapse to `tip:null` for `isBranchHeld`'s own release check
(unchanged — a `null` recorded tip can never trivially match a live one, so the hold never releases more
readily than before). Its `readLandedTipTrailer` call now passes `gitFactory: this.heldProbeGitFactory` —
the SAME seam `findLaterBranchSquash` already used, closing the "no seam at all" gap. `resolveOwedRange`
now classifies a refusal caused by EITHER transient source (`held.gitUnverified`, or `heldRecordedTip`
itself coming back `unverifiable`) with `transient:true` on its own `"refuse"` return, worded with the
SAME transient language round 4 introduced ("a transient git error is possible — re-confirm once it
clears") rather than the old "usually transient, retry"/"inspect the branch by hand" guidance — a
genuinely absent or invalid recorded tip keeps the EXISTING wording and the EXISTING stably-cached
refusal (see scenario (d2-control)). `confirmWorkerMerge`'s own early owed-range refusal return threads
`transient` into a NEW `ConfirmMergeResult.heldRangeUnverifiable` field (kept distinct from round 4's
`landedTipUnverifiable` — a different call site, a `merged:false` refusal rather than a `merged:true`
retain — but `classifyOutcome` maps EITHER field to the SAME `"landed-tip-unverifiable"` outcome string
already in `NEVER_CACHED_OUTCOMES`, since both mean the identical thing to a cache: re-derive, don't
replay). The catch-recovery finalize path (`confirmWorkerMergeTracked`'s own error-recovery branch) and
boot-reconcile Pass A/the sibling-cleanup path now also thread `tipUnverifiable` through their own
`soloFinalizeTipGuard` constructions, for the same reason round 4's own fix needed it at every
`finishAlreadyMerged`-reaching call site, not just the two main ones.

**Why `heldRecordedTip`'s return-shape change makes a single bisectable test infeasible:** the function's
SIGNATURE changed (`string | null` → `{tip, unverifiable}`), so a fixture built to prove RED against the
pre-round-5 code and GREEN against the post-round-5 code via the SAME mechanism cannot use a real
git-factory DI seam — pre-round-5, no seam reaches this call at all (any `gitFactory` option is silently
ignored), so `heldRecordedTip` always resolves the REAL (genuinely intact) trailer regardless of a
fixture's injected fault, which trivially self-releases the hold and masks the bug under round 4's
already-correct ALREADY_MERGED fallback instead of ever reaching `resolveOwedRange`'s refusal at all.

**Round 6 correction (CR5 item 2):** the sentence above — "a DI-only repro shows IDENTICAL,
correctly-flagged output before and after round 5" — holds ONLY for a repro that injects its fault via
`alreadyLandedGitFactory`: `heldRecordedTip` never read that option, before OR after round 5, so of
course identical. It does NOT hold for `heldProbeGitFactory` specifically — round 5 wired THAT option
into `heldRecordedTip`'s own `readLandedTipTrailer` call, so a repro injecting through
`heldProbeGitFactory` genuinely IS bisectable post-round-5 (CR5's own `repro3-realseam.mjs`, no-preset
run, confirmed this on real git). `landed-tip-trailer-unverifiable-retains-branch.mjs` scenario (d3) is
the committed version: a real-DI-seam test, no `heldRecordedTip` monkeypatch, guarding the wiring itself.

The CR's own repro, and this round's own committed regression test, both monkey-patch the `heldRecordedTip`
method directly (mirroring the CR's technique) rather than inject through git — the ONLY way to force this
exact path deterministically. The bug/fix pair's RED/GREEN evidence against the REAL committed code is the
CR's own unmodified `repro2.mjs`, re-run independently against this round's diff reverted (RED: confirmed
fresh) and restored (GREEN: confirmed fresh); the committed test
(`landed-tip-trailer-unverifiable-retains-branch.mjs` scenario (d2)) is written against the FINAL shape
only and is its own, separately-meaningful RED/GREEN pair when reverted/restored (it fails differently —
without a thrown error — against the old code, since the monkey-patched object doesn't match the old
signature; see that scenario's own comment).

## Round 6 + Round 7 — the ONE chokepoint, and reading it ONCE (CR5 session `99b8769a`, CR6 session `27f4a167`)

Round 6 fixed a THIRD caller with the identical disease rounds 4/5 already closed elsewhere:
`finishAlreadyMerged`'s own `heldAtFinish` refusal (reached via the terminal-task/worktree-gone early
block, BEFORE `resolveOwedRange` ever runs) carried no classification flag at all and was stably cached
forever, with wording that FALSELY claimed a late commit existed when the real cause was an unverifiable
trailer. **The fix: `isBranchHeld` became the ONE chokepoint for this branch's own unverifiable-trailer
status** — it returned `{retain, gitUnverified, tipUnverifiable}`, reading `heldRecordedTip` once
internally and exposing the derived boolean to every caller, so `finishAlreadyMerged`'s `heldAtFinish`
could classify this cause too (never-cached `heldRangeUnverifiable`, honest wording) and `resolveOwedRange`
could read the SAME flag instead of re-deriving it.

**Round 6's own regression (CR6 found it the very next review):** `resolveOwedRange` still called
`heldRecordedTip` a SECOND, independent time to get the actual tip VALUE (`tipUnverifiable` alone doesn't
carry it) — so `isBranchHeld`'s own internal read (read #1) and `resolveOwedRange`'s second read (read #2)
were two SEPARATE git reads of the identical trailer, and they could DISAGREE under a transient fault:
read #1 valid (a genuine late-commit hold, `tipUnverifiable:false`) + read #2 faulted (`recorded.tip:
null`) → `resolveOwedRange` classified off read #1's flag (false) while using read #2's null tip →
the STABLE, cacheable "records no readable assembledTip/landedTip" refusal, despite the hold being a
perfectly real, resolvable one. CR6's own repro: `repro6.mjs toctou-owed` (real git, `heldProbeGitFactory`
ordinal-targeted). A SEPARATE, independent instance of the identical root cause reached `finalizeMerge`'s
own held-branch check — see below.

**`finalizeMerge`'s own held check is a THIRD, genuinely separate read within one confirm pass (TAKEN IN
THIS CARD, pre-existing before round 6):** `finishAlreadyMerged` calls `isBranchHeld` once at `heldAtFinish`,
then (if not held) proceeds through real elapsed time — `pty.stop()`, `retireWorkerSession()`, a
death-poll loop — before calling `this.finalizeMerge(args)`, which makes ITS OWN, LATER, independent
`isBranchHeld` call as a final defense-in-depth check. If THAT call's own trailer read faults while
`heldAtFinish`'s earlier read did not, the branch appears newly held NOW — but the fault signal was
discarded entirely: `finalizeMerge`'s held-check only ever called `args.onBranchRetained?.(null,
"at-finalize")` with no way to say WHY, producing a retain with FALSE wording ("now unreadable" read as a
genuine moved-tip comparison) and no `landedTipUnverifiable` flag — cached as plain `"merged"` forever.
CR6's own repro: `repro6.mjs toctou-finalize 3`.

**The ruling: READ THE HOLD ONCE PER CONFIRM — but "once" means something different at each of the two
sites, and both choices are documented here on purpose (CR6 asked which design and why):**
- **`resolveOwedRange` (bug #1): TRUE single-read, no second call at all.** `isBranchHeld` now reads
  `heldRecordedTip` ONCE and returns the result VERBATIM as its own `recorded: {tip, unverifiable}` field
  (replacing the flat `tipUnverifiable` boolean round 6 introduced). `resolveOwedRange` uses
  `held.recorded.tip`/`held.recorded.unverifiable` directly and never calls `heldRecordedTip` itself —
  there is no second read left to disagree with the first, so this TOCTOU window is CLOSED STRUCTURALLY,
  not merely handled. This is safe because nothing of substance happens between `isBranchHeld`'s own
  internal read and `resolveOwedRange`'s use of it — they are, in effect, the same instant.
- **`finalizeMerge`'s own check (bug #2): KEPT as a genuinely separate, later read — on purpose.**
  Reusing `heldAtFinish`'s earlier snapshot here would be WRONG, not just different: real time passes
  (the death-poll loop) in which a GENUINELY NEW retain could be filed for this branch, and this check
  exists specifically to catch that case — collapsing it into a single earlier read would reopen that
  race in the other direction (a late-arriving real hold silently missed). What changes instead: this
  check's own transient-fault signal, which used to be discarded entirely, now flows through a NEW
  `onBranchRetained` parameter, `causeUnverifiable`, into the SAME `soloFinalizeTipGuard` machinery round 4
  already built (`tipUnverifiableAtRetain` now ORs the guard's own captured `a.tipUnverifiable` with the
  firing call's own `causeUnverifiable`) — so it classifies correctly (never-cached `landedTipUnverifiable`)
  without removing the check's own real defense-in-depth value.

**Consumer table — every `isBranchHeld` / `heldRecordedTip` read site, round 7's final shape:**

| Call site | Reads `isBranchHeld` | Reads `heldRecordedTip` directly | Round 7 change |
|---|---|---|---|
| `resolveOwedRange` | once | never (round 7: removed) | stopped re-reading; uses `held.recorded` |
| `finishAlreadyMerged`'s `heldAtFinish` | once | never | unchanged (round 6's own single read) |
| `finalizeMerge`'s own held check | once, LATER, separate | never | now threads its own fault into `onBranchRetained`'s `causeUnverifiable` |
| `mergeBatchTracked`'s per-candidate retain loop (`retainedOutstanding`) | once per candidate | never | now also captures `recorded.unverifiable` for `heldReason`'s wording (item 3, below) |
| `finalizeMerge`'s own (batch/Green-path) `releaseHold` short-circuit | skipped entirely when `releaseHold:true` | never | unchanged |
| Boot-reconcile Pass A (`heldA`) | once | never | unchanged — a per-boot retry, not a verdict cache, out of scope for both bugs |
| Branch-reclaim sweep | once (truthy check only) | never | unchanged |
| `isBranchHeld` itself | — (producer) | once, internally | now returns `recorded` verbatim instead of a derived boolean |

**Item 3 (MINOR, same round):** the batch `heldReason` helper (`mergeBatchTracked`'s per-candidate
reporting) ignored `tipUnverifiable` entirely, giving an unverifiable-trailer cause the same "its
unreviewed commit(s) were never gated" wording a genuine hold gets — now checked alongside
`gitUnverified`, with the SAME "if it persists, inspect the branch by hand…" fallback appended either way.

**Named residual:** `finalizeMerge`'s own held-check is still, by design, a SEPARATE read from
`heldAtFinish`'s — this is the kept, deliberate asymmetry above, not an oversight. A future reader must
not "fix" this by collapsing it to a shared snapshot; that would reopen the race this section's own
ruling explains.

## Tests

- `packages/daemon/test/landed-tip-trailer-producer-validation.mjs` — the PRODUCER's own three-way split
  in isolation: GENUINE (VALID), a well-formed-but-nonexistent hex (UNVERIFIABLE), a ref-name-shaped decoy
  (UNVERIFIABLE), a thrown validation call (UNVERIFIABLE), and a thrown OUTER log-read call (UNVERIFIABLE
  as of round 3 — pins the ABSENT/UNVERIFIABLE seam itself).
- `packages/daemon/test/landed-tip-trailer-unverifiable-retains-branch.mjs` — END-TO-END, through
  `SessionService.confirmWorkerMerge`/`confirmWorkerMergeTracked`: (b) the gc'd-genuine repro; (c-i) a
  forged decoy-ref trailer; (c-ii) a thrown validation call; (c-iii) a thrown outer log read (round 3);
  (d) a transient validation fault with NO late commit retains on the first `confirmWorkerMergeTracked`
  call (asserting `landedTipUnverifiable:true` on that result), then — ROUND 4 — a PLAIN re-confirm (same
  branch head, no `forceRemoveWorktree`) must NOT be served from either verdict cache
  (`cacheHit == null`, a genuinely fresh `freshMint`) and must finalize normally; (d-control) the OPPOSITE
  polarity — a genuine late-commit retain (no fault) — IS still served from the until-superseded cache on
  an identical plain re-confirm, proving the fix is scoped to the UNVERIFIABLE cause only. All scenarios
  also assert the retain event's `detail.landedTip` is `null` or a real hex sha, never the sentinel
  literal. RED-proofed against round 1's, round 2's, AND (scenario (d)) round 3's committed code — round 3
  alone still replays the stale retain forever through `confirmWorkerMergeTracked`, the exact round-4 bug.
  (d2) ROUND 5: an ALREADY-held branch (a retain event seeded directly, mirroring (d)'s own post-retain
  state) refused via `resolveOwedRange` while a `heldRecordedTip` fault persists across TWO confirms, both
  carrying `heldRangeUnverifiable:true` and neither served from cache, then self-heals and finalizes once
  the fault clears — the method itself is monkey-patched (see this record's own "why a single bisectable
  test is infeasible" paragraph for why); (d2-control) a direct unit check on `heldRecordedTip` proves a
  genuinely-absent trailer (the repo's own genesis commit, no `Loom-Landed-Tip` field at all) returns
  `unverifiable:false`, keeping the ordinary, stably-cached refusal shape.
  (e) ROUND 6: the terminal-task/worktree-gone early block reaches `finishAlreadyMerged`'s OWN
  `heldAtFinish` refusal (a DIFFERENT call site from both (d) and (d2)) while the SAME fault persists
  across TWO confirms — carrying `heldRangeUnverifiable:true`, never cached, self-heals once cleared.
  (d3) ROUND 6/7: the SAME `resolveOwedRange` path (d2) exercises, but through the REAL
  `heldProbeGitFactory` DI seam (no method monkeypatch) — guards `heldRecordedTip`'s own wiring directly;
  mutation-tested against compiled dist (dropping the `gitFactory` option, or mis-mapping
  `TRAILER_TIP_UNVERIFIABLE`) with a sha256-verified byte-identical restore both times.
  (f) ROUND 7: a genuine late commit, with ONLY the now-removed second `heldRecordedTip` read faulted
  (ordinal-targeted, matching CR6's own `toctou-owed` repro) — must refuse transiently (never cached,
  never the genuinely-absent-cause wording) and, once cleared, correctly land the late commit through the
  gate rather than silently releasing the hold on a stale value.
  (g) ROUND 7: `finalizeMerge`'s own, LATER, separate `isBranchHeld` check faults (ordinal-targeted,
  matching CR6's own `toctou-finalize` repro) — must classify as `landedTipUnverifiable` via the new
  `causeUnverifiable` threading, never the FALSE "now unreadable" moved-tip wording, and never cached.
- `packages/daemon/test/batch-merge-late-range-reunion.mjs` (scenario `(unverified)`) — **round 5 updates
  this file's own pinned wording.** It asserts `isBranchHeld`'s `gitUnverified` refusal text via
  `heldProbeGitFactory`; the text changed from "usually transient, retry" to the unified transient wording
  this round introduces, and the result now also carries `heldRangeUnverifiable:true` — both updated in
  place, not re-derived from an old PR description.
- `packages/daemon/test/merge-trailer-block-only.mjs` (scenarios 5/6/7) and
  `merge-confirm-solo-finalize-tip-cas.mjs` (scenario O) — pre-existing VALID-path coverage, updated from
  round 1 to use real, resolvable commit shas instead of shape-only fake hex strings.
- `packages/daemon/test/batch-fallback-already-landed-lookup-fault-injection-absorbed.mjs` (scenario C) —
  **round 3 REVERSES this file's own prior, pinned contract.** Its fault is exactly the outer-log-read-
  throw shape; under rounds 1-2 that mapped to ABSENT and was silently absorbed (byte-identical to the
  unfaulted control) — that absorption WAS this card's own fail-open bug, reproduced on a batch-fallback
  candidate instead of a solo squash. As of round 3 it RETAINS candidate `a`'s branch (while candidate `b`,
  untouched by the fault, still finalizes normally) — the file's header, inline comments, and final
  summary message are all rewritten to state the reversal explicitly rather than silently flip meaning.

## Do not

- Do not re-implement `resolveExactTrailerObjectId`'s resolve-and-exact-match logic a second time at a
  new call site — if a future producer needs the same protection, add it to this function's own callers.
- Do not map the OUTER (log-read) catch to ABSENT — round 3 corrected this; an unreadable commit message
  must be UNVERIFIABLE, same as a failed validation call. Both are "could not confirm", never "nothing to
  pin". (Rounds 1-2 did this and CR2 reproduced the resulting deletion on a real repo.)
- Do not fold `TRAILER_TIP_UNVERIFIABLE` into `null` at `pinnedTipForLandedSquash`, or anywhere a caller's
  `null`-handling branch is a FRESH LIVE READ rather than an unconditional refusal/hold.
- Do not have `pinnedTipForLandedSquash` return `{landedTip: SOLO_TIP_UNVERIFIABLE}` (or the sentinel
  value by any other name) — round 2 did this and CR2 found it PERSISTS the sentinel into the retain
  event's durable `detail.landedTip`, where a LATER call reads it back as a live git revision argument
  (CR2 planted a matching ref and had it resolve) and makes a transient fault permanent (no later call
  ever re-reads the trailer once a string sits in that field). Return `{}` instead — `soloFinalizeTipGuard`
  already computes the sentinel for `expectedBranchTip` from an absent `landedTip`, so the CAS is
  unaffected; only the PERSISTED value changes, and that's the entire point.
- Do not assume a per-caller table built only from "is `null` safe here" generalizes to "is a validation
  MISS safe here" — round 1's own table asked the first question and missed the second; always ask both,
  separately, for every state a producer can return, AND ask whether the caller's result ever gets
  PERSISTED somewhere a later read trusts verbatim (round 2's own miss).
- Do not treat this fix as closing the review-time (`reviewWorkerMerge`) diffstat/commit-list display as
  independently load-bearing beyond what's stated here — it was already a defence-in-depth closure (the
  trailer is Loom's own, written from `resolvedBranchHead`, and `112b8d5d` strips worker-authored
  subjects), not a response to a demonstrated live exploit against a real worker. `heldRecordedTip`'s own
  fold into `null` keeps that display path's existing (refuse-on-null) behavior unchanged either way.
- Do not re-derive `batch-fallback-already-landed-lookup-fault-injection-absorbed.mjs`'s expected outcome
  from memory or an old PR description — read its own header, which states the round-3 reversal plainly;
  a stale mental model of "this one proves absorption" is now backwards.
- Do not classify a NEW never-cache-worthy retain cause by folding it into an EXISTING cacheable outcome
  string (round 4's own finding — `"merged"` covered both a genuine retain and an UNVERIFIABLE one, since
  round 3 never updated `classifyOutcome` at all). Always
  ask, for every new retain/rejection shape a producer can introduce: does its cause clear on its own
  without the branch head moving, and if so, does `classifyOutcome` give it its OWN string in
  `NEVER_CACHED_OUTCOMES` — never reuse an existing one just because the outer shape (`merged:true`,
  `branchRetainedWarning` set) looks the same.
- **Named residual (round 4, documented not fixed):** an amend that STRIPS the `Loom-Landed-Tip` trailer
  line entirely (rather than corrupting its value) parses as ABSENT, not UNVERIFIABLE — `pinnedTipForLandedSquash`
  then falls back to `legacyTip` (a fresh live read), which can trivially match finalize's CAS and delete a
  late, ungated commit exactly like the pre-card bug this whole chain fixes. This is inherent to the
  ABSENT→`legacyTip` fallback (`cc9bce38`'s pre-card design for "no trailer was ever written," e.g. a
  worker landed before this card existed) and predates this card entirely — round 3/4 only closed the
  UNVERIFIABLE (present-but-untrusted) and outer-read-failure cases, never the absent-by-removal case. Do
  not treat ABSENT as safe-by-construction on the strength of this record; it remains an open gap.
- **(Round 5) Do not assume fixing the RETAIN path (round 4) also fixed every OTHER caller that can reach
  the identical unverifiable-trailer condition.** `resolveOwedRange`'s own early owed-range refusal is a
  SEPARATE code path from `finishAlreadyMerged`'s retain, reached only once a branch is ALREADY held — a
  fix proven against one does not prove the other; CR4 found this one by testing a SECOND confirm while
  the fault still persists, not just the fault-then-clear sequence round 4's own tests covered.
- **(Round 5) Do not add a new DI-seam-reachable test for `heldRecordedTip`'s own unverifiable path without
  first checking whether `isBranchHeld`'s release check (a plain string-equality against a live tip) will
  self-release the hold before your fault ever reaches `resolveOwedRange` at all** — a hold that was never
  "already held" when your fixture's confirm runs skips the refusal entirely; seed the retain event
  directly (this round's own (d2) scenario) rather than relying on a real first confirm to produce it,
  and verify your fixture actually reaches a HELD state before asserting on the refusal it's supposed to
  produce.
- **(Round 5) Do not monkey-patch `heldRecordedTip` with the OLD `string | null` return shape** — the
  surrounding code (`isBranchHeld`/`resolveOwedRange`) now unconditionally destructures `.tip`/
  `.unverifiable`; a bare `null`/string return crashes or silently misbehaves (confirmed: it does NOT throw
  cleanly against old code either — see this record's own infeasible-bisection paragraph for the exact,
  non-obvious failure shape this produces against reverted code).
- **(Round 6, since fixed in round 7 — kept as a specimen) Do not give a caller a DERIVED BOOLEAN
  (`tipUnverifiable`) when it ALSO needs the underlying VALUE** — round 6 did exactly this, leaving
  `resolveOwedRange` with its own second, independently-faultable `heldRecordedTip` call just to get the
  tip, and the two reads could disagree under a transient fault. If a caller needs both the classification
  AND the value, the producer must return BOTH from the SAME read (`isBranchHeld`'s own `recorded` field),
  never a boolean alongside a promise that the value is "available separately."
- **(Round 7) Do not assume closing ONE independently-readable call site also closes every other one that
  reaches the identical condition.** `finalizeMerge`'s own held-check is a THIRD, genuinely separate read
  within the SAME confirm pass that round 6 never touched — CR6 found it by testing the SPECIFIC ordinal
  of a multi-read confirm, not just the fault-then-clear sequence round 6's own tests covered. Before
  declaring a classification bug "fixed," enumerate EVERY site that calls the producer (or a function that
  internally calls it), not just the one the current repro happens to exercise.
- **(Round 7) Do not collapse `finalizeMerge`'s own held-check into a shared, earlier-computed snapshot**
  — it is DELIBERATELY a separate, later read (real elapsed time passes after `heldAtFinish`'s own check,
  during which a genuinely NEW retain could be filed), and reusing a stale snapshot there would silently
  miss that case. The fix is to thread this check's OWN transient-fault signal through
  `onBranchRetained`'s `causeUnverifiable` parameter, not to make the read go away.
- **(Round 7) Do not design a regression test for a multi-read confirm with a PLAIN boolean toggle** when
  the bug is that TWO (or more) reads within one confirm can DISAGREE — a toggle gives every read in that
  confirm the SAME fault state, so it can never reproduce a disagreement. Use an ORDINAL-targeted fault
  (count trailer-shaped git calls globally, fail only a named ordinal) exactly as CR6's own `repro6.mjs`
  does, and find the correct ordinal empirically for your own fixture shape — it is NOT guaranteed to
  match another fixture's own measured ordinal for a superficially similar scenario (verified directly:
  this round's own (g) scenario needed ordinal 4 against its fixture, not the ordinal 3 CR6's own
  `repro6.mjs` needed against a differently-shaped one).
