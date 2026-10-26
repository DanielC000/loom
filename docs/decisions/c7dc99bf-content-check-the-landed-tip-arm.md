# c7dc99bf — content-check the Landed-Tip arm of stale-generation attribution

From `45036494`'s Code Review (reviewer `04cfeb36`), verbatim: "the caller of `findAllLandedTrailerCommits`
does NOT run `recordedTipContentLanded` on every candidate — a candidate carrying `Loom-Landed-Tip` goes
to `verifyReviewedTipChain(reviewedTip, candidate.trailers.landedTip)` (sessions/service.ts, inside
`attributeStaleGenerationOwnLanding`) — a chain check of the trailer VALUE, never `candidate.sha`'s
content. That arm's 'independent non-trailer verifier' is itself trailer-derived."

## Investigation (checkpoint, approved before any `src` edit)

**What a positive verdict on this arm grants.** `attributeStaleGenerationOwnLanding` is called only from
`resolveStaleGenerationOwnLanding`, itself reached only by boot-reconcile's Pass A2 for a STALE worker
generation whose worktree path was reused by a re-task, leaving its own `merge_request` dangling. A
positive verdict writes one `merge_done` event for that session with `detail:{branch:null,
staleGenerationAttributed:true, attributedLandedSha}` — per decision `e5458ccd`, `branch:null` is
deliberate so this event is INERT to every branch-scoped reader (`task.mergedSha`, board "merged" state,
gate decisions, hold release, worktree/branch deletion are all untouched). The one real effect: it
suppresses the one-shot `[loom:merge-orphaned]` human escalation that otherwise says the stale worker's
own unresolved work "may need to be redone." So this is not a mainline-forgery or gate-bypass vector — it
is a FALSE-REASSURANCE vector that can let a stale worker's genuinely unlanded work go silently unredone,
exactly the risk `e5458ccd`'s whole design exists to avoid (escalate instead of risking a wrong
attribution).

**Real-git repro (scratch, never committed — reproduced again through the full `reconcileOrchestrationOnBoot`
pipeline by this card's own test file, scenario FORGED).** A stale worker's own branch commit (never
landed anywhere) is `reviewedTip`. An attacker (anyone with shared-`.git` write access, per decision
`356538ef` — the same baseline capability every worker on the project already has) plants an UNRELATED,
garbage-content commit on main carrying only `Loom-Worker-Branch: <branch>` + `Loom-Landed-Tip:
<reviewedTip>` (no `Loom-Worker-Base`). `verifyReviewedTipChain(reviewedTip, candidate.trailers.landedTip)`
returns `{ok:true, hops:0}` on the very FIRST comparison (`cur === reviewed`) — zero ancestry/content
checks ever run against the candidate commit's own sha. `reviewedTip` is not cryptographically secret (DB-
stored, worker-report-visible), but the planted commit's own CONTENT is 100% irrelevant to whether this
arm accepts it. Negative control: an unrelated, non-descendant `landedTip` value is correctly refused
("not a merge of main — a commit made after the review") — the chain check is not vacuous; the exploit
specifically needs `landedTip === reviewedTip` (or a genuine Loom-union descendant of it).

**What `c13666c6`'s branch-gone ledger gate adds here: nothing.** It is wired only into
`findLandedSquashCommit`/`scanMergedCommitMap`'s branch-gone arm (`confirmWorkerMerge`, boot-reconcile
Pass A, `runBatchedMerge`, `getTaskMergedInfo`, the Git tab) — `attributeStaleGenerationOwnLanding`'s own
signature carries no `deps.goneBranchLedger` at all, confirmed both by inspection and by the repro never
touching any ledger code.

**On the reviewer's "no new attacker capability" framing.** Both arms need the SAME baseline capability
(shared-`.git` write access) to reach at all — in that narrow sense the framing is defensible. But
exploitability differs sharply: the `landedTip` arm demanded only exact knowledge of a non-secret sha
(`Loom-Landed-Tip === reviewedTip`), with the planted commit's own content never examined at all — the
sibling (`Loom-Worker-Base`) arm DID at least run `recordedTipContentLanded`, so a garbage-content forgery
with no real `Loom-Worker-Base` value fails it outright. **Round 2 correction (Code Review `80828e41`):
this round-1 framing of the sibling arm was ITSELF wrong, for the identical underlying reason** — see
"Round 2" below. Neither arm "demands genuine file-content equality" once the ATTACKER controls which
base the content check diffs against; both can be partially satisfied by copying only some of the real
content. The true discriminator was never "which arm runs a content check," but "whose value feeds that
check's own notion of which files are the worker's own."

## The fix

In `attributeStaleGenerationOwnLanding`'s `landedTip` branch (`sessions/service.ts`), after `chain.ok`,
also require `recordedTipContentLanded(repoPath, reviewedTip, candidate.sha, candidate.trailers.base ??
`${candidate.sha}^`, { timeoutMs: this.gitOpMs })` to resolve `"attributed"` — treating its `"zero-delta"`
exactly like the sibling (no-`landedTip`) arm already does (`return { kind: "zero-delta" }`) — before
returning `"attributed"`. This mirrors the content check the sibling arm already runs; it does not
introduce a new verification primitive.

**The `${candidate.sha}^` fallback, when `Loom-Worker-Base` itself is absent** (the documented degraded
capture-failure shape, `worktrees.ts` ~10106 — "Loom-Worker-Base/PathSet/tree capture failed... commit
lands with Loom-Landed-Tip only"): sound per decision `d62dad73`, which defines `base` as literally `sha^`
for the solo path — this fallback recovers the SAME value the trailer would have held, never a new
assumption. And `worktrees.ts` ~4720 confirms a `landedTip`-carrying candidate is NEVER a batch tip (a
batch tip never carries `Loom-Landed-Tip` at all) — so this fallback only ever applies to a solo squash,
never a batch intermediate candidate.

## Positive control (hops > 0, a real Loom-style union merge)

Before implementing the fix, built a real-git scenario (this card's own `stale-generation-landedtip-
content-check.mjs`, scenario GENUINE) where the `landedTip` arm SHOULD attribute: a worker's own branch
tip (`reviewedTip`), main independently advancing on an UNRELATED file, a real `git merge --no-edit`
unioning main's advance cleanly into the worker's own worktree branch (producing `unionTip`, parents
`[reviewedTip, mainAdvanceTip]`), then a real solo squash landing that union onto main with BOTH
`Loom-Landed-Tip: unionTip` and `Loom-Worker-Base: mainAdvanceTip` stamped. `verifyReviewedTipChain`
walks `unionTip` back to `reviewedTip` in exactly one hop (via the clean-union branch of its own walk,
never the trivial `cur===reviewed` shortcut). Confirmed attributing on today's (pre-fix) code, confirmed
STILL attributing after the fix — the content check passes because the union never touched any file the
worker itself changed, so `candidate.sha`'s content on those files is byte-identical to `reviewedTip`'s.

## Accepted residual: the OVERLAP case (named ahead of time by the manager's own ORDER)

**Scenario OVERLAP** (same test file): identical shape to GENUINE, except main's own independent advance
ALSO touches the exact file the worker changed — a clean, conflict-free 3-way merge (the two edits sit far
enough apart in the file to auto-merge without a textual conflict), but one whose COMBINED content
legitimately differs from the worker's own tip in isolation. Measured: this attributes pre-fix (the bug
this card closes) and correctly reads `"no-match"` → escalates post-fix, because
`recordedTipContentLanded` diffs `candidate.sha` against `reviewedTip` restricted to the files
`reviewedTip` itself changed, and that diff is now non-empty (main's own line is present in the landed
union but absent from `reviewedTip` alone).

**This is accepted, not fixed, and not "fixed" by loosening the check.** Escalating `[loom:merge-orphaned]`
for a genuine landing that happens to collide, content-wise, with a later legitimate main advance is the
SAFE direction under `e5458ccd`'s own design (escalate instead of risking a wrong attribution) — a human
reviewing the escalation can see the real landed sha and confirm it by hand; the alternative (loosening
the content check to tolerate a partial/structural match) reopens exactly the forgery this card closes,
since a forged commit's own content could then also be excused as "a plausible overlap." Measured shape:
reproduced directly in `stale-generation-landedtip-content-check.mjs`'s OVERLAP scenario — pre-fix
attributes to the genuine landed sha, post-fix escalates instead (`db.listStaleGenerationUnresolved()`
carries the worker's session id).

## Round 2 (Code Review `80828e41`) — the content check's own BASE was still attacker-controlled

Round 1 fixed WHICH value `verifyReviewedTipChain` chains against, but left the content check's own
notion of "which files are the worker's own" sourced from the CANDIDATE's own `Loom-Worker-Base` trailer
(or, in round 1's fallback, `${candidate.sha}^` — also candidate-derived). Both are attacker-controlled.

**The hole, verbatim from the reviewer:** "pointing base at an intermediate commit on the worker's own
branch narrows the checked file set, so a commit landing only PART of the worker's work gets attributed.
Worker branch c1 adds A.txt, c2 adds B.txt, reviewedTip=c2; a forged main commit copies ONLY B.txt with
Loom-Worker-Branch + Loom-Landed-Tip: c2 + Loom-Worker-Base: c1 ⇒ verifyReviewedTipChain(c2,c2) =
{ok:true,hops:0}; recordedTipContentLanded(c2, forged, base=c1) = 'attributed'; A.txt never landed." The
sibling (no-`landedTip`) arm had the SAME hole, pre-existing and never gated behind any chain check at
all — reachable even more directly than the arm this card originally fixed.

Reproduced directly against round 1's own commit (`40c9301343882f8cd0020e873b1a4fab6f5e8d0d`) using the
reviewer's own probe scripts (`probe.mjs`): `narrowed base=c1 -> attributed` — confirmed real, not merely
theoretical.

### The fix: `recordedBase` is now ALWAYS Loom-owned, never a candidate's own trailer

`recordedTipContentLanded`'s `recordedBase` parameter (git/worktrees.ts) must now always be fed the
resolved mainline ref (`base` — `expectedMainlineRef ?? "HEAD"`, already computed once per call in
`attributeStaleGenerationOwnLanding` before the candidate loop even starts), for BOTH arms — never
`candidate.trailers.base`, never `${candidate.sha}^`. This closes the hole structurally: `merge-
base(reviewedTip, base)` can only ever resolve to the worker's TRUE fork point (or its last genuine union
point) — squash landings never put worker commits into mainline ancestry, so no forged trailer value can
influence this computation at all. Reproduced closed with the reviewer's own `probe2.mjs`: passing `"main"`
(the Loom-resolved ref) in place of the candidate's forged `c1` resolves `"no-match"`.

**The `${candidate.sha}^` fallback this card's round 1 added is now REMOVED, not merely unused** — it
existed only to cover a candidate with no `Loom-Worker-Base` trailer, but the function no longer reads
that trailer for this purpose at all, so there is nothing left to fall back from.

`candidate.trailers.base` is NOT deleted from the code — the sibling arm's `else if (candidate.trailers.base)`
condition still gates which candidates are even ELIGIBLE for a content-match attempt (does this candidate
look like a Loom landing shape at all). It is simply never read as a VALUE fed into the content check
anymore — eligibility gate, never trust input.

### The cross-check: a second, independent Loom-owned signal

`merge_request.detail.filesChanged` is stamped, UNCONDITIONALLY, at the single call site that creates
every `merge_request` event (`sessions/service.ts`, `reviewWorkerMerge`) — confirmed present since this
mechanism's very first version (`ba83e9eb`, 2026-05-27) through its current form; every `merge_request`
row this path reads carries it as a number. `resolveStaleGenerationOwnLanding` now reads it
(`expectedFilesChanged`) and threads it into `recordedTipContentLanded`, which cross-checks it against the
freshly-computed own-files count BEFORE deciding zero-delta vs. a content match — a mismatch fails closed
to `"no-match"` (escalate), regardless of which direction it would have resolved otherwise.

**Independent assessment, stated honestly:** for the specific A.txt/B.txt forgery above, the Loom-derived
`recordedBase` fix ALONE already closes it — confirmed directly (`probe2.mjs`, no `expectedFilesChanged`
argument at all, still resolves `"no-match"`). The cross-check did not reveal a SEPARATE exploit the base
fix leaves open; it is defense-in-depth between two independently-computed Loom-owned signals (review-time
diffstat vs. reconcile-time merge-base-derived diffstat), implemented exactly as instructed. Its own gate
is proven LIVE (not dead code) by a direct unit-style check in the test file: a deliberately wrong expected
count refuses an otherwise-genuine content match on real content.

### Zero-delta: confirmed no longer forgeable; wording corrected, `return` kept

With `recordedBase` Loom-owned, the zero-delta decision (`files.length === 0`) is computed ONLY from
`reviewedTip` and the resolved mainline ref — both Loom's own values, invariant across every candidate in
the loop and never touched by the candidate's own (possibly forged) sha or trailers. Zero-delta can
therefore only mean "genuinely no changes" now; it is NOT reachable by forgery (verified directly: the
ZERO_DELTA_FORGERY test scenario, which forges `Loom-Worker-Base: reviewedTip` trying to force this exact
verdict, resolves `"no-match"` post-fix, never `"zero-delta"`). Per the reviewer's own instruction, since
it is confirmed non-forgeable, `return` is KEPT (not changed to `continue`) — every candidate in the loop
would recompute the identical zero-delta-or-not verdict anyway, since it depends on nothing candidate-
specific.

The round-1 WORDING is still corrected regardless (Code Review item 2, minor): both human-facing strings
that described this as "relative to its own recorded landing base" implied a candidate-derived value that
no longer exists in the design — reworded to "relative to the resolved mainline" in both
`resolveStaleGenerationOwnLanding`'s `reason` and `checkedNote` strings.

### Tests (round 2)

- **OVERLAP** now asserts escalation UNCONDITIONALLY — round 1's own test branched on the observed outcome
  (pass either way), which is weaker than pinning the one correct behavior.
- **GENUINE** now asserts `hops > 0` explicitly via a direct `verifyReviewedTipChain` call, not merely a
  scenario label.
- **FORGED_BASE_LANDEDTIP** / **FORGED_BASE_NOLANDEDTIP**: the reviewer's own A.txt/B.txt repro, for both
  arms. RED on `40c9301343882f8cd0020e873b1a4fab6f5e8d0d`, GREEN after round 2 — verified via
  `negative-control`.
- **ZERO_DELTA_FORGERY**: forges `Loom-Worker-Base: reviewedTip`; asserts the escalation reason is the
  GENERIC one, never the zero-delta wording. RED on round 1 (resolves the misleading wording), GREEN after.
- A direct unit-style proof that the `expectedFilesChanged` cross-check is live (see above).

### Named residual: a rename is invisible to the plain file-count cross-check (not a new attack surface)

**Reviewer's nitpick, not fixed.** A rename between the Loom-resolved base and `reviewedTip` (old path
deleted, new path added) is invisible to a plain `git diff --name-only` (no `-M` rename detection) the
same way either side of this check already computes it — the cross-check only compares a COUNT, which
cannot distinguish "one rename" from "one unrelated add plus one unrelated delete." This makes the check
LOOSER on that shape (a renamed-away old path's own deletion isn't separately required), never a false
NEGATIVE — the content-diff step still runs over whatever `files` names, and a candidate that doesn't
actually carry the renamed file's new-path content under that name still fails the content diff. Not
fixed here; named so a future reader doesn't mistake the count-based cross-check for a content-aware one.

## Round 3 (second Code Review of round 2, reviewer `80828e41`) — TWO more Majors, same root cause

Confirmed round 2's own trailer-narrowing fix closed (its negative control: 6 FAILs on round 1
`40c9301343882f8cd0020e873b1a4fab6f5e8d0d`, all pass at round 2 `bdbe82374e93f59cb70c8a3a2809baedf0177623`),
but found round 2's OWN fix was STILL forgeable — the same underlying mistake (trusting a non-Loom-owned
value to decide "which files are the worker's own") recurring in a different shape, twice over.

### Finding 1 (MAJOR): `base` is a LIVE REF, not a Loom record

Round 2's `recordedBase` was `expectedMainlineRef` (`resolveMainlineWatermarkRef`'s `refs/heads/<branch>`),
which **git resolves live** at call time. A ref-writer (the `branch -f`/`update-ref` adversary decision
`2a6a292a` already models) can `git merge -s ours <intermediate>` to fold a worker's own intermediate
commit into main's ancestry with NO content change, then land a forged commit copying only PART of the
worker's real work. `merge-base(reviewedTip, liveRef)` now resolves to that intermediate, narrowing the
own-files set exactly like round 1's trailer-forge did — CR1's hole again, via a different input.
Reproduced directly against round 2 (REFMOVE scenario in the test file): attributes wrongly pre-fix.

**Fix:** `recordedBase` is now `Db.getMainlineBranchTrust(projectId, repoKey, branch)` — a Loom-DURABLE
sha, written only by a verified landing (`advanceMainlineWatermark{,ForBatch}`), `project_checkout_branch`,
or a human reset (decision `2a6a292a`'s own trust mechanism) — never by a bare ref move. No trust record
yet (`null`) fails toward escalation (`{kind:"no-match"}`), never toward attribution. The candidate SCAN
(`findAllLandedTrailerCommits`) stays on the live ref — only the CONTENT CHECK's own anchor changed.

**Corrected claim:** round 2's own "base is Loom-resolved… no forged value can influence this computation
at all" was TRUE only for the trailer-forgery vector it was written against — a live ref is a second,
independent way to feed a non-Loom-owned value into the same computation. The honest claim is: `base`
MUST be a value no git write (trailer OR ref move) can influence — which only `getMainlineBranchTrust`
actually is.

### Finding 2 (MAJOR): `merge_request.detail.filesChanged` is filter-dependent

`reviewWorkerMerge` stamps `filesChanged: diff.filesChanged`, which is `diff.files.length` — the FILTERED
count whenever `worker_merge` was called with `files`/`pathGlob`. `resolveStaleGenerationOwnLanding` reads
the LATEST `merge_request`, so (a) a genuine landing whose last review happened to be scoped would
false-escalate under round 2's EXACT-equality cross-check, and (b) a narrowed expected value sitting next
to a SIMILARLY-narrowed scan (finding 1's hole, laundered through this field instead) would wrongly agree.

**Fix:** `filesChangedTotal` (`diff.allFiles.length` — already computed by `diffBranch`, no extra git call)
is now stamped UNCONDITIONALLY on every `merge_request` row. The cross-check reads ONLY this field, never
`filesChanged`. Absent (a pre-round-3 row) is UNKNOWN, not zero, and fails the WHOLE attribution attempt
toward escalation before any git work runs (`resolveOwnFilesForAttribution` checks this first). Also
threaded `diffBranch`'s own `resolvedTip` seam with the already-read `reviewedTip`, so the reviewed tip
and the diffed tip are one read (closes the reviewer's separate race sub-point — a commit landing between
two previously-independent reads could otherwise make the stamped total describe a different tip).

**The cross-check's comparison changed from EXACT equality to NARROW-only** (`fileCount <
expectedFilesChanged` refuses; a WIDER count is tolerated) — a necessary consequence of finding 1's own
fix, not an independent choice: a Loom-owned `recordedBase` can legitimately LAG one landing behind the
worker's true fork point (`advanceMainlineWatermark`'s own documented race-skip, `head.tip !== mergeSha`),
which only ever WIDENS the computed own-files range — the extra files are content both sides already
share identically (inherited from the same mainline history), so the content check still passes. Exact
equality would have false-refused that case. Verified with real git (ADVANCE_SKIP_LAG scenario in the test
file): a genuine landing still attributes when trust is seeded one landing behind the worker's true fork
point, across several further unrelated main commits landed after the worker's own fork.

**Honest assessment, not overstated:** for finding 1's own A.txt/B.txt repro specifically, the durable-sha
anchor fix ALONE already closes it (verified: the reviewer's own `probe2.mjs`, with no `expectedFilesChanged`
argument at all, already resolves `"no-match"` against the ref-move shape). The `filesChangedTotal`
cross-check is genuine defense-in-depth between two independently-computed Loom-owned signals (review-time
diffstat vs. reconcile-time merge-base-derived diffstat), not something found to independently close a
SEPARATE exploit the anchor fix leaves open. It IS load-bearing for a genuine landing's own correctness
(see the SCOPED_REVIEW_GENUINE scenario and the MUTATION test below), proven live by a direct unit-style
check, not dead code.

### Finding 3 (pre-existing minor, same function): rename-blind `--name-only`

`git diff --name-only` resolves a clean rename to its NEW path only — the OLD path's own non-deletion is
invisible to the pathspec. A candidate that adds the new path (matching content) but never removes the old
one still "matched" on the single checked path. Fixed: `--name-status`, taking BOTH sides of an `R`/`C`
row into the pathspec (counted as ONE change toward `fileCount`, matching `git diff --stat`'s own
rename-counting — verified empirically, git 2.47.0: both `--stat` and `--name-status` detect a clean
rename by default, with `diff.renames` unset, and both count it as one changed file).

**Corrected residual text:** this was previously undocumented in this record (it predates round 3's own
discovery) — now fixed, not a residual; see "Named residual" below for what DOES remain one.

### NIT: hoisted out of the per-candidate loop

`reviewedTip`/`trustedSha`/`expectedFilesChanged` are all candidate-INVARIANT — `resolveOwnFilesForAttribution`
is now called ONCE per attribution attempt (before the loop even starts), never once per candidate.

### Tests (round 3)

- **REF_MOVE** (new) — finding 1's own repro. RED on round 2 (`bdbe8237`), GREEN after.
- **SCOPED_REVIEW_GENUINE** (new) — finding 2a: a genuine landing whose last review was scoped
  (`filesChanged:1`, `filesChangedTotal:2`). Must still attribute — and does, both before and after round 3
  (the narrow-only redesign tolerates the filtered count being smaller; RED only under the MUTATION below).
- **RENAME_PARTIAL** (new) — finding 3's own repro (`old.txt` seeded at GENESIS itself, so the rename is
  visible as a rename across the merge-base..reviewedTip range — collapsing add+rename into one diff range
  with no earlier snapshot holding the old path is indistinguishable from a plain add, a real trap this
  record names so a future reader doesn't repeat it). RED on round 2, GREEN after.
- **LEGACY_NO_TOTAL** (repurposed from round 2's NOBASE) — a genuine landing with no `filesChangedTotal` at
  all (the pre-round-3 shape) now escalates, where round 2 attributed it off the base-fix alone.
- A direct unit-style proof `resolveOwnFilesForAttribution`'s cross-check is NARROW-only, not exact-match:
  an expected count LARGER than the true own-files count refuses; SMALLER is tolerated.
- **ADVANCE_SKIP_LAG** real-git verification (not a pipeline scenario — a focused direct check, per finding
  1's own instruction): trust seeded one landing behind the worker's true fork point, several further
  unrelated main commits landed after the worker's own fork — a genuine landing still attributes.
- **MUTATION test** (hand-run, not committed as a permanent test): the `expectedFilesChanged` threading
  (`resolveStaleGenerationOwnLanding`'s own read of `filesChangedTotal`) was temporarily forced to `null`,
  rebuilt, and re-run. GENUINE, SCOPED_REVIEW_GENUINE, and ADVANCE_SKIP_LAG flip to RED (a genuine landing
  can no longer be attributed at all without the threading) — closing the stated test gap ("no pipeline
  scenario makes the cross-check load-bearing"). REF_MOVE/RENAME_PARTIAL/FORGED/OVERLAP/FB_LANDEDTIP/
  FB_NOLANDEDTIP/ZERODELTA/LEGACY_NO_TOTAL all stay GREEN under this same mutation — their own security
  property comes from the durable-sha anchor and the rename fix, not from this cross-check; the mutation
  cleanly isolates which fix each scenario actually depends on. The mutation was reverted immediately after
  observing the RED result; `git diff` confirmed byte-identical to the committed fix before re-confirming GREEN.

### Named residual: the HEAD-vs-watermark-ref mismatch (reviewer's own sub-point, not fixed)

`reviewWorkerMerge`'s own `diffBranch` call diffs against the literal string `"HEAD"`, which can differ
from the watermark-resolved ref `attributeStaleGenerationOwnLanding` scans against elsewhere (a canonical
checkout diverted off the real mainline branch between review time and reconcile time). This is a
PRE-EXISTING shape (not introduced by this card), fails safe as-is (a mismatch can only make the review's
own diffstat describe a different base than the eventual reconcile-time scan does — not a forgery vector,
since neither value is attacker-chosen), and is left unchanged here per the manager's own ruling. Named so
a future reader doesn't rediscover it as new.

### Follow-up grep: other readers of `merge_request.detail.filesChanged`

Grepped the whole daemon/web/shared tree for `filesChanged` (not just the `.detail.filesChanged` dotted
form, to not miss an indirect read). Every OTHER hit is a different field entirely, unrelated to the
PERSISTED `merge_request` event: `lateRange.filesChanged` (a HELD branch's owed-range diffstat, a
different sub-object, correctly the filtered/owed count by design), `reviewWorkerMerge`'s own TOOL RETURN
VALUE (`filesChanged: diff.filesChanged`, correctly reflecting whatever the caller's own `files`/`pathGlob`
asked for — this is the manager-facing display, not a trust decision), and two web-side types
(`DiffNumstat.filesChanged`, `BranchDiff.filesChanged`) that parse/display that SAME return value
client-side. No other reader treats the stored event's `detail.filesChanged` as a full/unfiltered count —
`resolveStaleGenerationOwnLanding` was the only one, and it now reads `filesChangedTotal` instead. Nothing
else needed fixing.

## Round 4 (third Code Review, reviewer `bc701e99`) — the COUNT itself was the wrong shape

Confirmed round 3's own closures held (CR3 findings 1-3 all closed; REF_MOVE/RENAME escalate at round 3,
attribute at a further-hardened round 4 for an UNRELATED reason — see below). But a NEW finding showed the
count-based cross-check (`expectedFilesChanged`/`filesChangedTotal`), and the trust-anchored diff it
guarded, were themselves the wrong shape — not merely forgeable again, but WRONG on a genuine landing with
no attacker involved at all.

### Finding 1 (BLOCKING, measured): a trust-anchored diff can both DROP a worker's own real file and ADD
an unrelated one

Reproduced with the reviewer's own `probe.mjs` (`revert` scenario): main has `A=old, Z=z0` at genesis,
where a Loom-durable trust record would sit (round 3's anchor). An out-of-band main commit moves
`A=old→mid, Z=z0→z1` — trust STAYS at genesis (the chronic advance-skip lag CR3 itself measured, not a
race). The worker forks from this moved main, REVERTS `A` back to `old` (a genuine edit of its own) and
adds `B`. A partial landing lands only `B` — the worker's own revert of `A` never lands.

Diffing `trust(genesis)..reviewedTip` (round 3's mechanism) computes `{B, Z}`: `A` nets to NO CHANGE
against the stale anchor (old→mid→old is a no-op relative to genesis's own `old`), so it DROPS out of the
own-files set even though the worker genuinely touched it; `Z` ADDS into the set even though the worker
never touched it at all (it's main's own unrelated drift, picked up only because the anchor is stale). The
cross-check then compares `fileCount` (2: `B`,`Z`) against `expectedFilesChanged` (2, from the review's own
`filesChangedTotal`) — narrow-only, `2 >= 2` passes — and the partial landing's content check runs over
`{B, Z}`, never `{A}`, so the missing revert is invisible. Pre-round-4 (`db459d5a`): WRONGLY ATTRIBUTES.

A second repro (`lag` scenario, same probe) shows the SAME trust-anchored mechanism failing in the
OPPOSITE direction: a genuine landing (worker adds `B` only) under the same frozen-trust shape, with main
drifting on `Z` (a file the worker never touched) BOTH before the worker's fork AND again, to a DIFFERENT
value, after it. Round 3's widening tolerance lets `Z` into the own-files set (the anchor lags, so the
diff against it widens past the worker's true delta) on the stated premise that "the extra files are
content both sides already share identically" — but that premise is false here: `Z` moves AGAIN between
the worker's fork and the landing, so the landed commit's own `Z` value differs from the worker's
recorded-tip `Z` value, and the content check correctly (by its own logic) reads that as a mismatch and
escalates — a GENUINE landing, wrongly refused. Verified directly against `db459d5a`'s own build: `lag`
WRONGLY ESCALATES there (`attributed=false`), confirmed via this card's own `probe.mjs` run below — this is
a second, independent failure mode of the SAME root cause (trusting an anchor-derived file set instead of
the review-time one), not a regression this round merely guards against having already been fixed.

### The Lead's ruling: replace the count with the REVIEW-TIME SET itself, and stop re-deriving it

1. **`reviewWorkerMerge` now stamps the review-time PATH SET** (`merge_request.detail.filesChangedPaths`)
   — `diff.allFiles`'s paths, rename-aware (both sides of an `R`/`C` row — `diffstatPathSet`,
   `git/worktrees.ts`), UNFILTERED by any `files`/`pathGlob` review-display narrowing, ALWAYS stamped.
   Bounded (`FILES_CHANGED_PATHS_MAX_COUNT`=500 paths / `FILES_CHANGED_PATHS_MAX_BYTES`=32000 chars): over
   either cap, `filesChangedPathsTruncated:true` is stamped instead of a partial (and therefore
   misleading) list.
2. **The content check's pathspec is now EXACTLY that stamped set**, used as-is — never unioned with any
   anchor-derived set. The reviewer measured that a union keeps the chronic-lag false-escalation risk a
   trust-derived set carries; using the stamped set alone has no such risk, because it was never computed
   against any anchor in the first place. **Named residual (CR3 item 4, restated honestly below): the
   check is only as strong as the review-time HEAD** — a review that ran against a diverted/stale
   canonical checkout stamps whatever that checkout's diff found, and nothing downstream re-verifies it.
   This is not new exposure (round 3's `filesChangedTotal` had the identical dependency on review-time
   correctness); round 4 just makes the dependency the WHOLE mechanism instead of half of it.
3. **The count comparison and `filesChangedTotal`'s role in attribution are deleted.** Grepped the whole
   daemon/web/shared tree first: nothing else reads `.detail.filesChangedTotal` (the stamp itself is also
   removed — `filesChangedPaths` replaces it at the one call site that stamped it). A `merge_request` row
   with no `filesChangedPaths` (absent, or `filesChangedPathsTruncated:true`) is UNKNOWN — escalates, same
   posture as round 3's "absent is unknown" for `filesChangedTotal`.
4. **The Loom-durable trust anchor (`Db.getMainlineBranchTrust`) is REMOVED from this path entirely**, not
   merely re-justified. Its only remaining use after (1)-(3) was the zero-delta check — superseded by "the
   stamped set is empty" (a fact Loom recorded at review time, never recomputed against anything). The
   Lead's own instruction preferred this over keeping trust for zero-delta alone, since CR3 had already
   measured the chronic lag making the trust-anchored common path near-inert, and verified empirically
   here (see below) that it was never load-bearing for anything else on this path: `attributeStale-
   GenerationOwnLanding` no longer resolves or reads `expectedMainlineBranch`/`trustedSha` at all — only
   `expectedMainlineRef` (the live ref), unrelated, still scopes the candidate SCAN (`findAllLandedTrailer-
   Commits`), never the content check.

**Round 4 originally KEPT the trust seeding in the two shared fixture files
(`worktree-recycle-alias-protection.mjs`'s M/Q/R/U, `merge-landing-aborted-batch-refusal-mayhavelanded.mjs`'s
D/E/F), on a FALSE premise — corrected in Round 5 (finding 4) below.** The claim made here at the time —
that these fixtures' own `boot()`/`baseSetup()` helpers "already seed a mainline watermark for the general
mainline-tripwire mechanism unrelated to this card" — was wrong: `git show 732764e1` shows round 3 of THIS
card added both the watermark seed AND the trust seed to both files, for THIS card's own purpose, not a
pre-existing unrelated mechanism. See "Round 5, finding 4" for the actual fix (the trust lines are removed;
the watermark lines are kept, correctly, because they ARE still read — for the candidate scan's own `base`,
never for the content check).

### Finding 2: the record's premise was already corrected once, restated here for round 4's own benefit

Round 3's own "Corrected claim" section already walked back round 2's overstated "no forged value can
influence this computation at all" to "only for the trailer-forgery vector it was written against." Round
4 extends the same correction one more step: round 3's own `Db.getMainlineBranchTrust` anchor was NOT
forgeable by an attacker, but it was still the WRONG VALUE on a genuine, attacker-free lagging-trust
landing — "Loom-owned" and "correct" are different properties, and round 3 conflated them. Round 4's fix
removes the anchor rather than hardening it a third time, closing both properties' gap at once: the
review-time set is Loom-owned AND (named residual above aside) the right value for what actually happened.

### Finding 3 (minor, producer side): a real `reviewWorkerMerge` test, scoped review

Added directly through the REAL `reviewWorkerMerge` (not a hand-constructed `merge_request` event, unlike
every other fixture in this file): a worker with two files, reviewed with `files:["A.txt"]` (the
display-narrowing filter). Asserts the stamped `filesChangedPaths` is still `["A.txt","B.txt"]` — the full,
unfiltered set — while the display-facing `filesChanged` stays narrowed to `1`. MUTATION: stamping the
FILTERED set (`diff.files` instead of `diff.allFiles`) at the producer call site would make this test RED.

### Finding 4: "two independent Loom-owned signals" (round 3's own framing) is retracted

Round 3 called the `filesChangedTotal` cross-check "defense-in-depth between two independently-computed
Loom-owned signals (review-time diffstat vs. reconcile-time merge-base-derived diffstat)." That framing is
now moot by construction (the reconcile-time recomputation this described no longer exists), but the
reviewer's underlying point survives and generalizes: the REVIEW-TIME diffstat was never independent of
anything — it is a single read of a live `HEAD` at one point in time, and "two signals" overstated what a
single read contributes just because it gets stamped into two differently-named fields. Round 4 removes
one of the two fields rather than re-justifying the "two signals" framing for it.

### NIT (round 3's own, now moot): zero-delta wording

Round 3's own nit-5 instruction ("make the zero-delta wording match the final design") is satisfied by
round 4's actual final design, not round 3's: both `resolveStaleGenerationOwnLanding`'s `reason`/
`checkedNote` strings now say the review recorded no changes of its own, not "relative to the resolved
mainline" (which described a value — the live-ref-anchored diff — that no longer exists either).

### Tests (round 4)

- **REVERT** (new) — the reviewer's own `revert` repro, reproduced through the REAL `reconcileOrchestration-
  OnBoot` pipeline (not the probe's standalone harness). RED at `db459d5a` (verified directly against that
  commit's build via the probe itself — see below), GREEN after.
- **LAG** (new) — the reviewer's own `lag` repro, same pipeline. RED at `db459d5a` (wrongly escalates a
  genuine landing — the opposite failure direction from `revert`, same root cause), GREEN after.
- **Mutation proof (REVERT)**: `recordedTipContentLanded` called directly with the FULL stamped pathspec
  (`["A.txt","B.txt"]`) correctly refuses the partial landing; called again with `A.txt` DROPPED
  (`["B.txt"]` only) WRONGLY attributes — demonstrating the mechanism is load-bearing, not merely present.
- **Cap proof**: `diffstatPathSet` directly — a small set resolves `{paths}`; a set over
  `FILES_CHANGED_PATHS_MAX_COUNT` resolves `{truncated:true}`; a rename row contributes both sides.
- **Producer proof** (Finding 3 above).
- All round 1-3 scenarios (FORGED, GENUINE, OVERLAP, LEGACY, FB_LANDEDTIP, FB_NOLANDEDTIP, ZERODELTA,
  REFMOVE, SCOPED_REVIEW_GENUINE, RENAME_PARTIAL) kept GREEN, now stamping `filesChangedPaths` instead of
  `filesChangedTotal`. REFMOVE's own finding is now structurally moot (the live ref it narrowed is never
  consulted for the own-files set at all), not merely re-closed — its own content mismatch still escalates
  it, so the scenario stays meaningful as a regression guard even though its original narrowing vector no
  longer applies.
- **Negative control**: the reviewer's own `probe.mjs`, run against a real build of `db459d5a` (round 3's
  final commit, via a disposable `git worktree add db459d5a` under this card's own scratch dir, never the
  canonical repo) — `revert` WRONGLY ATTRIBUTES (`attributed=true`, should be `false`) and `lag` WRONGLY
  ESCALATES (`attributed=false`, should be `true`); both RED, in opposite directions, same root cause. The
  same probe against the round-4 build: `revert` escalates (`attributed=false`), `lag` attributes
  (`attributed=true`) — both GREEN.

## Round 5 (fourth Code Review, reviewer `7fb963b2`) — round 4's own stamp was itself lossy

Confirmed round 4's set-based design correct on every CR2/CR3 shape the reviewer re-ran (revert, lag,
refmove-after, file/directory renames, delete, mode change, bracket names, spaces, long paths, truncation,
legacy), and confirmed the pre-review ref move ("refmove_before") is a named residual, not a new surface.
But round 4's own producer — `diffstatPathSet`, which parsed `git diff --stat`'s DISPLAY text — was itself
lossy in two measured, exploitable ways.

### Findings 1+2 (CRITICAL ×2, measured false ATTRIBUTIONS — the unsafe direction)

`diffstatPathSet` (round 4) read file names off `git diff --stat`'s own rendering, via
`normalizeDiffstatPath`/`diffstatRenameSource`. Two shapes defeat that rendering:
1. A non-ASCII name is C-quoted by `--stat` (`"caf\303\251.txt"`) — as a pathspec that string matches
   nothing, so the file silently drops out of the content check.
2. A name genuinely containing `{`/`}` (e.g. `{{tpl}}/a.txt`) collides with `normalizeDiffstatPath`'s own
   rename-collapse syntax and is rewritten into a path that doesn't exist at all. (NEW in round 4 — not
   present in round 3's design, which never ran this parser on review-time names.)

Both let a partial landing's missing file go unchecked: `recordedTipContentLanded`'s diff, restricted to a
pathspec that resolves to nothing on either side, is vacuously empty — read as "attributed." Reproduced
directly against `4f7bab44` (round 4's own commit) with the reviewer's `probe.mjs`: `nonascii` and `braces`
both WRONGLY ATTRIBUTE a partial landing that is missing the special-named file.

### The Lead's ruling

(a) **Stamp the set from a DEDICATED machine-readable call** — `git diff --name-status -z <range>`, the
SAME `range` `diffBranch` already resolved (never independently re-derived), NUL-delimited, unquoted,
taking both rename/copy sides as separate fields. Never from `--stat` text, never through
`normalizeDiffstatPath`/`diffstatRenameSource`. `machineReadablePathSet` (`git/worktrees.ts`) replaces
`diffstatPathSet` as the stamp's producer; same cap constants, same truncate-not-partial semantics.
**Self-correction, caught by running the fix rather than trusting the git-level reasoning alone:** the
first implementation ALSO added `-c core.quotepath=false` to the call, reasoning (correctly, on its own)
that `core.quotepath` governs C-quoting — but `-z` alone already disables C-quoting outright, regardless of
`core.quotepath` (verified empirically: a non-ASCII name's raw UTF-8 bytes come through unquoted under `-z`
alone, no override needed), and the call THREW, making EVERY call read as `{truncated:true}` and every
attribution attempt escalate. The probe caught this immediately (every scenario, including ones that
should attribute, read `escalated:true`) — removing the redundant `-c` flag closed it.
**Round 6 correction (Code Review `e319ea92`, finding 1a): the diagnosis of WHY it threw, written here at
the time, was wrong — measured directly.** This was NOT `blockUnsafeOperationsPlugin` rejecting the key:
a global `-c core.quotepath=false` placed BEFORE the subcommand works fine through a real `canonicalGit`
call (measured; `core.quotepath` is not on that plugin's fixed block-list at all — see `@simple-git/argv-
parser`'s own `K`/`Y` source arrays for the current list rather than trusting a restatement here). The
real cause was PLACEMENT: the flag was positioned AFTER the subcommand (`["diff", "-c",
"core.quotepath=false", ...]`), which git parses as `git diff -c` — COMBINED-DIFF mode, an unrelated flag
meaning — followed by an unrecognized revision, producing a plain `fatal: ambiguous argument`. The
observed symptom (every call throws, every attribution escalates) was identical either way, which is why
the original misdiagnosis went unquestioned. The corrected rule: **a global `-c` must precede the
subcommand**; a key on the plugin's own fixed block-list (see `@simple-git/argv-parser`'s own `K`/`Y`
source arrays, cited above — never a restatement here) needs the explicit `allowUnsafe*` opt-in on
`boundedSimpleGit`/`canonicalGit`'s own `extraUnsafe` param
(see `attemptCodexAutoCommit`'s own `cfg` + `extraUnsafe` wiring in `worktrees.ts` for a real example) —
`core.quotepath` was never on that list, so this call never needed one. `GIT_CONFIG_COUNT`/
`GIT_CONFIG_KEY_N` env vars ARE genuinely rejected by the plugin (a different mechanism, env-based rather
than argv-based) and were never used as an alternative here regardless.
**A second self-caught bug, same shape (caught the same way — running the fix, not just unit-testing the
helper in isolation):** `diffBranch`'s own `machinePathSet` field was computed but never included in its
final `return` statement. The helper function itself worked correctly when called directly; every
`diffBranch` CALLER still got `machinePathSet: undefined`, so every stamp still read as
`filesChangedPathsTruncated:true` and every attribution attempt STILL escalated, even after the `-c` fix.
Found by re-running the adapted probe end-to-end a second time and seeing the SAME all-escalate pattern;
fixed by adding the missing field to the `return`.

(b) **Run the content check with `--literal-pathspecs`** — `recordedTipContentLanded`'s `git diff
--name-only` call now passes it, so no stamped name (e.g. `pages/[id].tsx`) is ever reinterpreted as a
pathspec glob/magic.

(c) **A fail-closed plausibility net** — `stampedPathsPlausible` (`git/worktrees.ts`), run once per
candidate before trusting `recordedTipContentLanded`'s verdict against it: a stamped path absent from BOTH
`reviewedTip`'s own tree AND its merge-base with the CANDIDATE being checked means the stamp and the repo
disagree, and that candidate is rejected (never attributed on a stamp this check cannot corroborate). Every
tree read uses `--literal-pathspecs` too (via `git ls-tree`), for the same reason as (b).

(d) **Tests through the REAL PRODUCER plus the real reconcile** (`SPECIAL_NAME_*`, this card's own test
file) — four scenarios, one per hazardous name shape (non-ASCII+CJK, a literal `{{x}}/` directory, a space,
a leading `-`), each going through the ACTUAL `reviewWorkerMerge` (never a hand-written
`filesChangedPaths`), paired with a partial landing missing that file (must ESCALATE) and one combined
genuine landing including all four (must ATTRIBUTE).

**Round 6 correction (Code Review `e319ea92`, finding 1b): this round-5 "does NOT measurably flip"
conclusion was FALSE — measured directly, through the real shell-less spawn path, not through MSYS/Bash.**
A `git diff --name-only <A> <B> -- "pages/[i].tsx"`, invoked exactly as `recordedTipContentLanded` invokes
it (an argv array, no shell in between — real git, real commits, no probe-harness artifact), resolves the
bracket pathspec onto the UNRELATED, unchanged `pages/i.tsx` instead when the literal flag is absent:
WITHOUT `--literal-pathspecs`, the diff vacuously returns empty (the real added/removed
`pages/[i].tsx` is never matched by the glob form, and the coincidental `pages/i.tsx` never changed in the
diff so there's nothing TO match); WITH the flag, the diff correctly reports the real difference. Pinned
by `stale-generation-landedtip-content-check.mjs`'s own "bracket precision" test, which runs BOTH forms
side by side on an identical scenario and would go RED if the flag were ever dropped from
`recordedTipContentLanded`'s one call site. **Round 5's own negative result was real but not
representative** — its probe happened to construct a scenario where the coincidental match target (`i.tsx`)
itself changed between the two diffed commits, which is a DIFFERENT shape than "the real bracket file is
missing and the coincidental target is unchanged" (the shape that actually matters for a partial-landing
escalation). The flag remains load-bearing, now on MEASURED grounds rather than reasoned-only defense-in-
depth.

### Finding 3 (MAJOR, doc-as-guard): the record's own `## Do not` section told readers to restore deleted code

The `## Do not` section below is injected verbatim on every anchor `Read` (the `decision-records.mjs`
hook) — it is not narrative history, it is the thing a future reader is told to FOLLOW NOW. Through round
4 it still carried round-3 bullets instructing readers to "Always anchor on `Db.getMainlineBranchTrust`,"
"Read `filesChangedTotal` only," and "Do not drop the `expectedFilesChanged` cross-check" — all describing
mechanisms round 4 itself had already deleted. **Rewritten in place** (not appended to) so the section is
current through round 5; every stale symbol name (`resolveOwnFilesForAttribution`, `expectedFilesChanged`,
`filesChangedTotal`, `diffstatPathSet`, `trustedSha`) is now confined to the numbered Round N sections above
(clearly-labelled history), grepped and confirmed absent from the Do-not section itself.

### Finding 4: the trust-seeding claim in Round 4's own record was false — fixed for real this time

Round 4 (above) claimed the two shared fixture files' trust seeding predated this card and served an
unrelated mechanism — **false**: `git show 732764e1` (round 3) adds BOTH the watermark seed and the trust
seed to `worktree-recycle-alias-protection.mjs` (M/Q/R/U) and `merge-landing-aborted-batch-refusal-
mayhavelanded.mjs` (D/E/F) in the same commit, for THIS card's own round-3 design. Fixed now: the
`Db.setMainlineBranchTrust(...)` lines are REMOVED from all five call sites (round 4 already stopped
reading trust on this path; round 5 just stopped lying about why the lines were still there). The
`db.setMeta(mainlineWatermarkKey(...), ...)` lines are KEPT — verified, not assumed: without a watermark,
`resolveMainlineWatermarkRef` returns `{state:"ok", ref:undefined}` and the candidate scan falls back to a
bare `"HEAD"` instead of the ref-scoped `refs/heads/main` these fixtures are meant to exercise (card
`77b8319b`'s own "never fall back to a live/bare-HEAD read" posture is about the WATERMARK read, a separate
concern from this card's content check). Both files' comments are corrected to say so, and both files were
re-run after the change and still pass.

## Round 6 (fifth Code Review, reviewer `e319ea92`) — two doc-as-guard corrections, a measured cost fix, and two test gaps

Confirmed round 5's safety goal met (all 21 CR4 shapes plus braces/brackets genuine match, zero false
attributions, negative control confirmed). Round 6 is five findings on TOP of that: two places where this
record's own prose (injected verbatim as a guard on every anchored `Read`) stated something FALSE, one
measured performance defect on the boot-reconcile path, a parse-robustness gap, and a test-assertion gap —
plus a NOT-fixed residual that round 6's own fix introduces as a regression against this branch's round-5
tip while correcting one of the two false claims (see Finding 4's own "Named residual" below, and card
`1cf79e64` for the tracked fix).

### Finding 1 (BLOCKING, doc-as-guard, MEASURED false): the `-c` rejection and `--literal-pathspecs`
"no measured flip" claims

Both corrected in place above (see "Round 2"'s own fix section and the "Round 5" ruling (a)/(b) text, and
the three `## Do not` bullets this round rewrote) rather than restated here — this record's own rule is
to fix stale prose where it stands, not accrete a second copy. Summary: (a) a global `-c` is not
blanket-rejected by simple-git's `blockUnsafeOperationsPlugin` — only a small fixed key list is, and
`core.quotepath` was never on it; the real round-5 failure was placing `-c` AFTER the subcommand (`git
diff -c` = combined-diff mode, an unrelated flag meaning), which throws `fatal: ambiguous argument` with
the identical visible symptom (every call escalates) that masked the real cause. (b) `--literal-pathspecs`
DOES measurably flip the function's VERDICT through the real shell-less spawn path, in the RIGHT scenario
shape — this round's own first attempt at pinning it got the shape backwards and had to be re-measured
and rebuilt (see the self-correction in Finding 4 below for the same pattern on the backslash net). The flip needs the TRUE
stamped file UNCHANGED between candidate and `recordedTip` (so the correct verdict is `"attributed"`)
sitting next to an UNRELATED, independently-drifting file that glob-matches the stamped name's bracket
shape — without the flag, the drifting file gets swept into the diff and a GENUINE landing wrongly
escalates. A shape where the TRUE stamped file itself differs (e.g. it's simply missing from the
candidate) does NOT flip the verdict either way — measured directly: git matches the literal changed
path regardless of the flag whenever that literal string is itself a real changed entry in the diff —
which is why an add/omission scenario, including this round's own first draft of this test, found no
flip and would have wrongly re-confirmed round 5's false conclusion for the wrong reason.

### Finding 2 (BLOCKING, measured cost): `stampedPathsPlausible`'s per-path design dominated the
boot-reconcile path

The round-5 design spawned up to 2 `git ls-tree -- <path>` calls PER STAMPED PATH, per candidate, BEFORE
the (single, cheap) content-check diff ever ran. Measured directly (this round, via the reviewer's own
timing probe, run against the round-5 build): 500 existing paths took ~29.5s for one candidate; 500
DELETED paths (the 2-reads-per-path case) took ~98.4s. A real stale-generation scan can run this net
across several candidates per unresolved worker at every boot.

**Fix:** read each tree ONCE as a full recursive listing (`git ls-tree -r --name-only -z <ref>`, no
pathspec) into a `Set`, then test path membership locally — 3 total git spawns per candidate (one
merge-base, two tree reads) regardless of how many paths are checked, down from up to `2N+1`. Also
reordered the call site (`attributeStaleGenerationOwnLanding`, `sessions/service.ts`): the content check
now runs FIRST, and `stampedPathsPlausible` only runs to CONFIRM an `"attributed"` result — the net can
only ever REJECT a positive attribution (see its own doc), never rescue a `"no-match"`, so running it
against a candidate that already failed the content check was pure waste. Most candidates in a real scan
fail the content check; only the one candidate that would otherwise be attributed now pays the net's cost
at all.

**Side effect, also measured and fixed:** the full-tree listing carries no pathspec, so it sidesteps a
correctness bug the old per-path pathspec design had — git normalizes `\` in a pathspec argument
(Windows), so a path genuinely containing a literal backslash never matched its own pathspec on either
side, even when the file truly existed unchanged on both sides. Measured against the round-5 build: even
a TRIVIAL self-comparison (`stampedPathsPlausible(tip, tip, [backslashPath])`) read `false` — a genuine
landing would have been wrongly escalated (safe direction, per `e5458ccd`, but wrong). The round-6
full-tree-listing redesign reads this case correctly (membership is exact string equality against raw,
unquoted `-z` tree entries — no pathspec left to normalize). Pinned by this round's own "backslash net"
test, built via git plumbing (a literal backslash cannot be created through the real filesystem on
Windows).

### Finding 3 (MINOR): the `-z` parse silently dropped a short record instead of failing closed

`machineReadablePathSet`'s own `-z` token parse used `if (!p) continue` when an R/C row's declared second
path (or any status's only path) ran past the end of the token stream — this silently DROPPED just that
one field and kept going, producing a PARTIAL list (missing exactly the field that ran out) rather than
the `{truncated:true}` the caller actually needs to treat the whole stamp as unknown. Fixed: any record
whose declared path field(s) run past the stream end now fails the WHOLE parse closed to
`{truncated:true}`. Also: byte accounting now uses `Buffer.byteLength` (UTF-8 bytes) instead of `.length`
(UTF-16 code units) — the two diverge for any non-ASCII path, so the old code could under-count against
`FILES_CHANGED_PATHS_MAX_BYTES` and stamp a wide-char-heavy set that actually exceeds the real byte cap.
Extracted the parse into a pure `parseNameStatusZ` function so both are unit-tested directly rather than
only through a real git spawn.

### Finding 4 (MAJOR, round 7 re-graded — CORRECTED premise): what the backslash net actually catches, and
the regression its own fix introduces

**The original round-6 kickoff for this item claimed `stampedPathsPlausible` is "the one thing keeping a
partial landing missing a backslash-named file escalated." That premise is FALSE — re-derived here rather
than implemented against, per this card's own standing rule to verify a manager's claim before building
on it.** Measured directly: for an ADDED path (the shape a "partial landing omits it" scenario needs),
`recordedTip`'s own tree ALWAYS contains that path by construction (it's the worker's own real addition)
— so the net's own OR-check (`recordedTip`'s tree OR its merge-base with the candidate) can **never** fail
on it, regardless of what the candidate does. The net's own documented job (see its doc comment) is
narrower: reject a stamp naming a path that was **never real at either reference point** — a genuinely
FORGED/bogus stamp entry, not a candidate's real omission of a real file. Round 5's own `plausible=false`
for a backslash-named ADD (measured, both genuine and partial, in the round-5 build) was never this net
discriminating the two cases — it was round 5's per-path pathspec bug making `existsIn(recordedTip, p)`
itself wrongly read "absent" for a path that WAS present, breaking the net identically for BOTH shapes.

**What the net genuinely catches, pinned by this round's own test:** a `filesChangedPaths` stamp
containing a backslash-shaped path that was **never real anywhere** (an outright forgery) — the content
check alone (`recordedTipContentLanded`) cannot detect this either, because git's own backslash-as-
separator handling on Windows defeats that pathspec too (verified: neither `--literal-pathspecs` nor
`:(literal)` magic nor `MSYS_NO_PATHCONV` changes this — there is no override), so it vacuously reads
`"attributed"` for the bogus path. `stampedPathsPlausible` is the only thing that rejects it.

**The false-escalation bug round 6's own perf fix REPAIRS** (distinct from the forgery-detection property
above, and distinct from the NEW regression two paragraphs down — do not conflate the three): round 5's
per-path pathspec bug made even a **genuine** backslash-named landing read as implausible — a false
escalation, safe but wrong. The round-6 full-tree-listing redesign has no pathspec left to defeat, so this
now correctly reads plausible. Pinned by this round's own test as a SEPARATE assertion from the
forgery-detection one. **This very fix is what removes round 5's accidental protection on the DIFFERENT,
omission-shaped case below — read that paragraph before concluding round 6 was a net negative here.**

**Named residual (round 7 correction — NOT merely "newly discovered"):** a partial/forged landing that
genuinely OMITS a real backslash-named file it was stamped for is still wrongly attributed —
`recordedTipContentLanded`'s own pathspec-based diff is defeated by the same backslash-as-separator
handling (vacuous empty diff), and `stampedPathsPlausible` cannot rescue this shape by design (see above —
the omitted path is always present in `recordedTip`'s own tree). This is **a REGRESSION against THIS
BRANCH's own round-5 tip, and PRE-EXISTING against upstream `main`** — both true at once, for different
baselines:
- **Regression vs round 5:** round 5's per-path net (bugged as it was) read `plausible=false` for ANY
  backslash-named path, which — by accident, not by design — correctly ESCALATED the omission case (a
  partial landing missing a real backslash file). Round 6's own fix (correctly making a GENUINE
  backslash-named landing read as plausible again) removed that accidental protection along with the bug
  it was riding on, so the SAME omission case now reads `plausible=true` too, and the content check's own
  (pre-existing) vacuous-empty-diff bug then wrongly turns it into `"attributed"`. Round 6 did not
  introduce the content check's own defect — it removed the ONE thing that happened to be masking it on
  this specific shape.
- **Pre-existing vs `main`:** the reviewer measured that `main`'s own pre-this-card content-check arm
  (before round 1 ever touched this function) uses a C-quoted pathspec that likewise matches nothing for a
  backslash-named path, so it ALSO attributes a backslash-file omission wrongly — this is not a hole this
  card opened; it predates the whole investigation. The branch is still strictly better than `main` on
  every OTHER shape tried across all six rounds — this is the one shape where the branch is net-even with
  `main`, not worse, once round 5's accidental (and narrower) protection is accounted for honestly.

**Finding 4b (wider shape, reviewer-measured): an all-backslash stamp can attribute almost ANY candidate,
not just one omitting a single file.** When EVERY path in the stamped `filesChangedPaths` set is
backslash-shaped, `recordedTipContentLanded`'s pathspec resolves to nothing for every one of them — so the
diff reads vacuously empty, and the function returns `"attributed"`, against an ARBITRARY candidate commit
that shares NOTHING with the worker's own tip. Verified directly:
`recordedTipContentLanded(repo, tip, unrelatedCandidate, ["back\\slash.txt"])` resolves `"attributed"` even
when `unrelatedCandidate` has no file, no history, and no ancestry in common with `tip` at all. Because
`findAllLandedTrailerCommits` is scanned OLDEST-first (`e5458ccd`'s own ordering), the FIRST eligible
candidate for the stale worker's branch name — which could be a PRIOR GENERATION's own, completely
unrelated landing on that reused branch/worktree — would be the one attributed, not necessarily a
candidate that even superficially resembles a forgery. This widens Finding 4's severity beyond "one
omitted file" to "a whole stamp dominated by backslash-shaped names defeats the content check against
essentially anything" — still bounded by `e5458ccd`'s own threat model (a false `merge_done` attribution,
never a mainline forgery or gate bypass; see the "What a positive verdict grants" section at the top of
this record), but a materially wider blast radius than Finding 4's original framing implied.

Not fixed here — closing either shape would require `recordedTipContentLanded` itself to stop using a
pathspec at all (diff with none, then filter the full changed-path list against the stamped set in JS,
mirroring this round's `stampedPathsPlausible` fix) — a real behavior change to the content check's own
cost profile (an unbounded diff instead of a pathspec-filtered one) outside this round's own scope.
Tracked by card `1cf79e64` ("fix(git): compare stamped tree entries instead of a pathspec diff in
attribution", p1).

### Finding 5 (NIT): a truncated/absent stamp could trivially satisfy a SPECIAL_NAME_* "escalated" assertion

Each `SPECIAL_NAME_*` partial scenario asserted only that the session escalated — which is ALSO what a
truncated or absent `filesChangedPaths` stamp produces, without ever exercising the special-name handling
the scenario exists to test. Each scenario now also asserts its own `merge_request.detail.filesChangedPaths`
genuinely names the special path, so a truncated stamp (the exact intermediate-bug shape) can no longer
satisfy the assertion by accident.

## Do not

- Do not trust `chain.ok` alone as proof of attribution for a `landedTip`-carrying candidate — it proves
  only that the TRAILER VALUE chains back to `reviewedTip` via a Loom-authored union/ff walk, never that
  `candidate.sha`'s own content does. Always pair it with `recordedTipContentLanded` before returning
  `"attributed"`.
- Do not loosen `recordedTipContentLanded`'s own content-equality check to "fix" the OVERLAP residual
  above — that reopens the forgery this card closes. Escalation is the correct, safe outcome for that
  shape; it is a named, measured residual, not a defect.
- **Do not derive the own-files pathspec from ANY anchor at reconcile time** — not a live ref
  (`resolveMainlineWatermarkRef`), not a candidate's own trailer, not `${candidate.sha}^`, and not
  `Db.getMainlineBranchTrust` (round 3's own anchor, since removed — it was Loom-owned but still the WRONG
  value on a genuine lagging-trust landing, see "Round 4, finding 1/finding 2"). Read it from the
  review-time stamped `merge_request.detail.filesChangedPaths` directly, as-is; it was never computed
  against any anchor in the first place, so there is nothing left for a live ref or a lagging record to
  narrow. The candidate SCAN (`findAllLandedTrailerCommits`) may still stay on the live ref — only the
  content check's own pathspec must never be anchor-derived.
- Do not read `candidate.trailers.base`'s presence as anything more than an ELIGIBILITY gate for the
  sibling (no-`landedTip`) arm — it decides whether to attempt a content match at all, never what value
  that content match diffs against.
- **Do not parse the stamped path set from `git diff --stat`'s DISPLAY text** (via
  `normalizeDiffstatPath`/`diffstatRenameSource` — round 4's `diffstatPathSet` did this, and it is why that
  function no longer exists). A non-ASCII name is C-quoted by that rendering, dropping it from the pathspec
  entirely; a name genuinely containing `{`/`}` collides with the rename-collapse syntax and is rewritten
  into a nonexistent path. Use `machineReadablePathSet`'s dedicated `git diff --name-status -z` call
  instead — `-z` alone disables C-quoting (no `-c core.quotepath=false` needed), and `--name-status` never
  does `--stat`'s own `{old => new}` collapsing.
- **(Round 6 correction) A global `-c <config>=<value>` on a `boundedGit`/`canonicalGit` call is NOT
  blanket-rejected** — simple-git's `blockUnsafeOperationsPlugin` only blocks a small FIXED key list; read
  `@simple-git/argv-parser`'s own `K`/`Y` source arrays for the current list, never a restatement here.
  `core.quotepath` was never on it. The real rule: **a global `-c` must be placed BEFORE the subcommand**, or git parses it
  as a subcommand-specific flag with an unrelated meaning (`git diff -c` = combined-diff mode) and throws
  `fatal: ambiguous argument` — the exact mechanism that was misdiagnosed as a plugin rejection earlier in
  this record (see "Round 6" below). A key that genuinely IS on the fixed block-list needs the explicit
  `allowUnsafe*` opt-in via `boundedSimpleGit`/`canonicalGit`'s `extraUnsafe` param (`attemptCodexAutoCommit`'s
  own `cfg`/`extraUnsafe` wiring in `worktrees.ts` is a real example) — `GIT_CONFIG_COUNT`/
  `GIT_CONFIG_KEY_N`/`GIT_CONFIG_VALUE_N` env vars ARE genuinely rejected by the plugin (a separate,
  env-based check), unaffected by this correction.
- **Do not forget to thread a newly-added optional field through to a function's final `return` statement**
  — `diffBranch`'s own `machinePathSet` field was computed but omitted from the `return`, silently making
  every caller see `machinePathSet: undefined` regardless of what the helper computed, which (combined with
  the bullet above) made every attribution attempt in this card escalate for a long stretch of round 5 with
  no error anywhere. Caught only by re-running the fix end-to-end a second time, not by unit-testing the
  helper function in isolation — see "Round 5" above for the full specimen.
- **Do not run `recordedTipContentLanded`'s content-check diff without `--literal-pathspecs`** — simple-
  git's own documented behavior is that this flag disables ALL pathspec magic unconditionally; a stamped
  name containing glob-magic characters (e.g. a bracket expression) risks being reinterpreted as a glob,
  resolving onto an unrelated coincidental file instead of being matched literally. **(Round 6 correction)
  This IS measured, not merely reasoned** — but the exploitable shape needs the TRUE stamped file
  UNCHANGED (sitting next to an unrelated, independently-drifting file that glob-matches the bracket
  shape), not a missing/added file — git matches a genuinely-differing literal path regardless of the
  flag. See "Round 6" Finding 1 below for the full, corrected scenario and why an earlier, backwards
  attempt at this test found no flip.
- **Do not skip `stampedPathsPlausible`'s per-candidate plausibility net "because the content check already
  covers it"** — it is a SEPARATE fail-closed defense against a FORGED stamp (a path that was never real
  at either the reviewed tip's own tree or its merge-base with the candidate), which the content check
  alone cannot detect (an absent path that vacuously diffs empty on both sides looks identical to a
  genuinely-matching one from `recordedTipContentLanded`'s point of view). **Do not read this as "the net
  detects a candidate that omits a real added file"** — it structurally cannot: an added path is always
  present in the reviewed tip's own tree, so the net's OR-check can never fail on it regardless of what
  the candidate does; that omission is the content check's job alone. See "Round 6" Finding 4 below for a
  real, measured, NOT-fixed residual on this exact point (a backslash-named omission).
- **(Round 6) Do call `stampedPathsPlausible` AFTER `recordedTipContentLanded` returns `"attributed"`,
  never before** — the net only ever REJECTS a positive attribution; it can't turn a `"no-match"` into
  anything else, so running it against a candidate that already failed the content check is pure wasted
  cost (this was round 5's own design, and it dominated the boot-reconcile path — see "Round 6" above).
- **(Round 6) Do not reintroduce a per-path `git ls-tree -- <path>` pathspec read inside
  `stampedPathsPlausible`** — besides the cost (up to `2N` spawns for `N` stamped paths, measured
  ~29.5-98.4s/candidate at 500 paths), a pathspec argument containing a literal backslash gets normalized
  by git on Windows, which silently misreports a genuinely-existing backslash-named path as absent (round
  5's design did this, even on a trivial self-comparison). Read each side's WHOLE tree once
  (`ls-tree -r --name-only -z <ref>`, no pathspec) into a `Set` and test membership locally instead.
- **(Round 6) Do not let `machineReadablePathSet`'s `-z` record parse silently drop a short/malformed
  field** (a status with no path, or an R/C row missing its second path) — treat it as a signal the WHOLE
  stamp is untrustworthy (`{truncated:true}`), never as "drop just that field and keep the rest," which
  produces a partial list that looks complete. Use `Buffer.byteLength`, not `.length`, when accounting
  bytes against `FILES_CHANGED_PATHS_MAX_BYTES` — `.length` is UTF-16 code units and under/over-counts
  against a UTF-8 byte cap for any non-ASCII path.
- **(Round 3) When constructing a rename-shaped test fixture, seed the OLD path at GENESIS itself** — a
  rename collapsed entirely within the scanned range, with no earlier snapshot holding the old path, is
  indistinguishable from a plain add and will not exercise the rename-aware pathspec at all (a real trap
  this card's own round-3 test authoring hit once).
- Do not re-derive this card's own positive-control timestamp requirements by guessing — a test
  constructing a stale-generation + re-task scenario must stagger `workerX`'s `lastActivity` and
  `workerY`'s `createdAt` past the shared `now` (mirroring `worktree-recycle-alias-protection.mjs`'s own
  `xLastActivityFor`/`yCreatedAtFor`), or `currentGenerationIds`' recency grouping can pick the STALE row
  as "current" and route it into Pass A's ordinary finalize instead of Pass A2's attribution path — this
  silently changes which code path a fixture actually exercises, not just its outcome.
- **Do not seed `Db.setMainlineBranchTrust` in a new attribution-needing fixture** — nothing on this path
  reads it anymore (round 4 removed the last read; round 5 removed the two shared fixture files' own
  now-dead seed calls, which round 3 had added for a since-abandoned design). DO still seed a
  `mainlineWatermarkKey` watermark (`db.setMeta(mainlineWatermarkKey(...), ...)`) for any fixture whose
  attribution attempt must reach the content check at all — the candidate SCAN still resolves its own
  `base` from it, and without one `resolveMainlineWatermarkRef` falls back to a bare `"HEAD"` scan instead
  of the ref-scoped one real fixtures are meant to exercise.
