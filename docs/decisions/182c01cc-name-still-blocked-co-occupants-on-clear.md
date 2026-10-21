# 182c01cc — name still-blocked co-occupants when a quarantine clear lands

From `a4481c3b`'s investigation (worker `f90974ce`): `clearMergeQuarantine(sub)` could return bare `void`
even though a co-occupant (X, a placeholder degraded occupant physically sitting in sub's own key file)
was still blocked afterward — re-homed to its own standalone `pending-<hex>.json` latch under a NEW id.
This fails CLOSED (X stays safely quarantined), but the clear's own result said nothing about it.

## Root cause

`deleteMergeQuarantineLatchByKey` calls up to three "protect" wrappers
(`protectDegradedOccupantBeforeDelete`, `protectUnincorporatedOccupantBeforeDelete`, and the inline
`foreignPending` branch calling `protectOccupantContentBeforeDelete` directly) before unlinking a
physical latch file. Each of these ALREADY has the foreign occupant's repoPath in hand before calling
`protectOccupantContentBeforeDelete` — but that function returned a bare `boolean`, discarding both the
repoPath and the NEW filename (`reconcilePendingDivertTarget`'s own `filename`) it re-homed the occupant
to. The caller's own `keptClaimants` tracking (`sharedClaimants`/`contentClaimants`,
`survivingSharedClaimRepoPaths`/`survivingTokenHolderRepoPaths`) is keyed on the OLD filename being
deleted — by construction, nothing references that name anymore once the occupant has just been moved
OFF it, so these checks can never see a successful re-home.

## Fix

`protectOccupantContentBeforeDelete` (and its two wrappers) now return `{ ok, persisted?: {repoPath,
sourceFile} }` instead of a bare `boolean` — `persisted` is set across every branch where the occupant
survives somewhere nameable (the mint, the union/re-point onto an existing same-identity slot, and the
in-memory-only double-fault fallback), using state the function already computed, never a second lookup.
`deleteMergeQuarantineLatchByKey` collects every protect call's own `persisted` into its return value
alongside the pre-existing `keptClaimants`. `clearMergeQuarantineByKey` folds both into a
`stillBlockedCoOccupants: BlockedCoOccupant[]` field (each `{repoPath, route: {repoPath, id}}` —
`id` via `pendingLatchIdFor(sourceFile)`, mirroring `stillQuarantinedReason`'s own route-naming pattern)
threaded through `clearMergeQuarantine` → `clearMergeQuarantineReporting` →
`POST /internal/merge-quarantine/clear` / `/clear-by-path`, additively alongside the pre-existing
`latchKept`/`referencingRepoPaths` fields.

## Scope: feedback only

Zero change to what gets lifted or kept — over-blocking stays the safe direction. Verified by asserting
the on-disk latch-file set and in-memory lift set are byte-identical before/after this change, for the
card's exact repro shape plus the union/re-point and double-fault branches.

## Round 2 (Code Review): three more findings, all fixed

1. **Under-report**: `protectForeignTmpResidueBeforeSweep` (the sweep that finds a foreign occupant whose
   content lives ONLY in a `.json.tmp-<pid>` residue, never at `final` itself) called
   `protectOccupantContentBeforeDelete` and discarded its result too — the SAME bug, a third site. Fixed
   the same way: it now returns its own relocated list, folded into `deleteMergeQuarantineLatchByKey`'s.
2. **A relocation is NOT "kept"**: round 1 folded a relocated co-occupant into the SAME tracking as a
   genuinely kept one, so a pure relocation (old file genuinely deleted, content moved to a new latch)
   incorrectly set `latchKept:true` and reused the "stays on disk … clear by its 24-hex id" wording —
   false, since the old file is gone. `deleteMergeQuarantineLatchByKey` now returns `{kept, relocated}` as
   two separate buckets; only `kept` ever sets `latchKept`/`referencingRepoPaths`; a relocated-only result
   gets its own honest reason clause (`relocatedCoOccupantsReason`/`composeReasonWithRelocated`).
3. **Field consistency**: every branch of every function in this card's own chain now carries
   `stillBlockedCoOccupants` (required in the type whenever the function returns an object at all — only
   a bare `void` return, preserved from round 1, omits it) — including `clearMergeQuarantineLatchFile`'s
   pending-match branch, its raw fallback, and `clearMergeQuarantineReporting`'s `stillQuarantined` early
   return, none of which can ever produce a relocated entry themselves but must still report `[]`
   explicitly rather than an absent field.
4. `clearMergeQuarantineByToken` has no human route to report through; its two internal call sites
   (inside `clearTokenFromPendingIndices` and `clearActiveEntryTokenAtKey`) now `console.warn` any
   relocation they caused (repoPath + pending id only, never content) instead of discarding it silently.

### A fourth finding, discovered while writing round 2's own tests (not CR-named) — SUPERSEDED BY ROUND 3

A repoPath can be found as BOTH kept (the pre-existing `sharedClaimants`/`contentClaimants` checks, which
read `final`'s raw bytes or scan for a self-referencing `orphanLatchFiles` entry — independent of this
card's own relocation tracking) AND relocated (this card's own protect-call tracking) IN THE SAME CLEAR.
Round 2 named this correctly but drew the WRONG conclusion: it deduped `stillBlockedCoOccupants` down to
ONE entry per repoPath, with RELOCATED always winning, reasoning that the KEPT route's own id "hits
`clearMergeQuarantineLatchFile`'s raw-fallback branch and sweeps dead orphan debris without actually
lifting the occupant" — true, but incomplete: that framing treated the kept file as disposable DEBRIS.
**It is not debris — it is the occupant's own durable record.** See "Round 3" below for the empirical
proof this was itself a bug, and `docs/decisions/4900c365-*.md`'s own amended "Do not" bullet (nit1) for
a related but DIFFERENT claim (about a sweep-gating mechanism, not this one) that must not be conflated
with this correction.

## Round 3 (Code Review CR2 80217ba5): M1 — the round-2 dedupe itself under-reported

**The round-2 dedupe (above) was wrong.** Empirically verified — a REAL reboot, in a fresh child process,
same `LOOM_HOME`, never reasoned about by hand — against all four possible orderings for the AE repro
shape (X's placeholder sitting in sub's own key file; `clearMergeQuarantineReporting(sub)`; X ends up
both RELOCATED to a new latch and KEPT under its OLD name).

**(Round 4, nit 3) All FOUR rows below are now committed tests with a real reboot** —
`test/merge-quarantine-clear-by-path.mjs` scenarios (AE) (relocated-alone, relocated-then-kept),
(AE2) (kept-alone), (AE3) (kept-then-relocated). Earlier drafts of this table asserted all four "measured"
while only (AE)'s own two orderings were actually committed with a reboot assertion — (AE2)/(AE3) close
that gap rather than just re-wording the claim.

| order tried | in-process result | survives a reboot? |
|---|---|---|
| clear relocated id ALONE | X reads as lifted | **NO** — the old kept file still durably holds X's own record; X re-quarantines |
| clear kept id ALONE | X still reads as blocked | **NO** — a no-op: nothing in memory matches the old file's id anymore (it was moved off it), so this only sweeps dead debris without touching X at all; a reboot confirms X was never lifted |
| clear kept id, THEN relocated id | X reads as lifted | **NO** — clearing kept first, before anything references it as a live orphan, strands it on disk; the later relocated-clear never revisits it |
| clear relocated id, THEN kept id | X reads as lifted | **YES** — the only durable ordering |

So the kept route's id is not disposable debris to discard — it is the occupant's OWN durable record, and
clearing it (second, after the relocated route) is the only way to lift the occupant for good. **Fix:**
`BlockedCoOccupant` gained an optional `alsoClear?: {repoPath, id}` field (see that type's own doc in
`merge-quarantine.ts`) — a repoPath found BOTH kept and relocated is now named ONCE, carrying BOTH routes:
`route` (relocated, clear FIRST) and `alsoClear` (kept, clear SECOND, required for durability). Both
dedupe sites (`clearMergeQuarantineByKey` and `clearMergeQuarantineByRecordedPath`) were fixed the same
way. `relocatedCoOccupantsReason` states the required order explicitly in the text (`'<id> FIRST ... THEN
<id> ...'`) whenever `alsoClear` is set. `splitCoOccupants` is no longer mutually-exclusive for such an
entry — it now lands in BOTH the `kept` and `relocated` buckets (a combined entry both IS kept, named in
`referencingRepoPaths`, AND still needs the relocated reason clause) — see that function's own doc.

### m3 — `clearMergeQuarantineReporting`'s latchKept branch composed the relocated clause TWICE

When `clearMergeQuarantine`'s own result ALREADY carries a `reason` (the unresolvable/ByRecordedPath
dispatch, which composes its own relocated clause before returning), `clearMergeQuarantineReporting`'s
`latchKept` branch used to compose `composeReasonWithRelocated` again on top of it — appending the SAME
clause a second time. Fixed: compose fresh ONLY when `clearResult.reason` is `undefined` (the resolvable/
ByKey dispatch, which has no `reason` field of its own); otherwise pass `clearResult.reason` through
unchanged. Idempotent — compose at most once, ever, for a given clear.

### m4 — `clearMergeQuarantineReporting`'s still-quarantined branch silently dropped the relocated clause

The `if (after)` branch (the SAME identity is still blocked post-clear) returned `stillQuarantinedReason`
alone, with no `composeReasonWithRelocated` call at all — unlike `clearMergeQuarantineLatchFile`'s own
still-quarantined branch, which already composed it. Fixed to match: `composeReasonWithRelocated(
stillQuarantinedReason(after, before), splitCoOccupants(stillBlocked, clearResult?.referencingRepoPaths)
.relocated)`.

### m2 — M9 (the ByRecordedPath pending fold's own reachability) — the reachability argument, not "structural equivalence"

Why `clearMergeQuarantineByRecordedPath`'s own matched-pending loop (which ALSO calls
`deleteMergeQuarantineLatchByKey` per owned armed key, the same fold site `clearMergeQuarantineByKey`'s
own pending loop uses — M6, below) never needs a SEPARATE correctness argument from that sibling site:
any same-identity pending entry that OWNS an armed key already puts a same-identity entry into
`activeQuarantines` under that key (arming is what "owns an armed key" means) — so that key is `matched`
by this function's OWN matched-ACTIVE loop first, and the delegated `clearMergeQuarantineByKey` call for
THAT match removes or REDUCES the tied pending twin already, before this function's own pending loop ever
re-visits it. A twin this function's pending loop still finds has therefore already been reduced by the
active-match delegation — it can only revisit a key `clearMergeQuarantineByKey` has already handled, never
a fresh one. (This replaces an earlier, retracted "structural equivalence" framing that was never written
into this record.)

### M6 (m1) — the ByKey pending-loop fold IS reachable, but its own report can read as a clean lift when it is not

`clearMergeQuarantineByKey`'s pending-filter loop (the "remove" branch) ALSO calls
`deleteMergeQuarantineLatchByKey` once per `plan.ownedArmedKeys` member, folding `r.kept`/`r.relocated`
into the SAME `keptReferencingRepoPaths`/`relocatedCoOccupants` maps the function's own OUTER
(matched-key) loop uses. The CR built a reachable repro for this: a pending entry `P`, armed at a
synthetic key `K` (an `883e29bc`-style degraded dual-arm), with a foreign occupant's record at
`hash(K).json`; `P` then becomes resolvable and `clearMergeQuarantine(P)` is called, which has no ACTIVE
entry at `canonical(P)` (only `P`'s own pending entry, armed at the DIFFERENT key `K`) — the pending loop
drops `P`'s own tied pending record and, processing its `ownedArmedKeys = [K]`, reaches
`deleteMergeQuarantineLatchByKey(K, ...)`, which finds and relocates the foreign occupant at
`hash(K).json`, correctly folding it into this clear's own `stillBlockedCoOccupants`. **Known, pre-existing,
SEPARATELY-CARDED gap (NOT fixed by this card — feedback-only, no change to what gets lifted/kept):** the
pending-filter's own `.filter()` callback (`packages/daemon/src/git/merge-quarantine.ts`, the
`pendingUnresolvedQuarantines = pendingUnresolvedQuarantines.filter((p) => {...})` loop) can drop `P`'s own
record from the array WITHOUT the foreign occupant's own NEW pending-divert entry (minted by
`deleteMergeQuarantineLatchByKey`'s own protect call) ever landing back IN that same array for THIS
process — so in-process, right after this exact clear, the foreign occupant can read as unblocked
(`activeMergeQuarantineFor` false) even though `stillBlockedCoOccupants` correctly named it and its record
genuinely still exists ON DISK. A reboot (a fresh process re-scanning disk) re-discovers and re-blocks it.
**Do not fix this drop on this card** — it is a different, narrower bug than M1 (an IN-PROCESS reporting
gap after the fold already ran, not the fold itself), filed as its own follow-up (card `07e3ad30`).

**STATUS: verified with a new test, scenario (AH) in `test/merge-quarantine-clear-by-path.mjs`.** The
construction: write P's raw latch DIRECTLY (a hand-built `883e29bc`-shaped degraded dual-arm — a raw file
carrying a pre-set `resolvedKey`/`armedKeys` gets ARMED into `activeQuarantines` under that recorded key
even though P's own path can't currently resolve, AND is simultaneously reachable via the identity-matched
pending loop), boot with ONLY P's file present, THEN write X's foreign record at `hash(K).json` — the key
step: X's file must be written AFTER this boot (never scanned into memory), so the clear-time discovery is
a genuine fresh MINT, not a re-point onto a pre-existing record (a re-point mutates an existing array
element in place and never triggers the drop; only a fresh push does). `mkdir(P)` then
`clearMergeQuarantine(P)` reaches the pending loop exactly as traced above. Verified in-process: X reads
as UNBLOCKED right after the clear (`activeMergeQuarantineFor`/`listActiveMergeQuarantines` both miss it)
even though `stillBlockedCoOccupants` correctly names it — confirmed NOT a durable lift via a REAL reboot
(fresh child process, same `LOOM_HOME`), which re-discovers and re-blocks X from disk. "The route that
actually works": clearing the fold's own named id in THIS SAME (contaminated) process is a no-op (nothing
in memory matches it there); clearing that SAME id works, durably, in the NEXT real boot — proven via one
more child process that boots then clears by that id in one call. **Control S8**: commenting out this
pending loop's own `for (const kc of r.kept) ...`/`for (const rc of r.relocated) ...` fold lines (the
"remove" branch, `merge-quarantine.ts`) and rebuilding makes the "fold names X" check fail — confirmed by
hand (manual revert/rebuild/run/restore/rebuild, byte-identical restore confirmed via `git diff`), not via
the `negative-control` script (which operates by git ref — these two lines are from round 1, far enough
back that a ref-based revert would also remove dependent round-2/3 APIs this test file itself references).

### m5 — S21 (the kept route's own sourceFile, when it comes from `sweepOwnLatchFileUnlessOwnedElsewhere`)

`clearMergeQuarantineByKey`'s own `for (const f of sourceFilesToSweep) { const result =
sweepOwnLatchFileUnlessOwnedElsewhere(f); ... }` loop folds a kept result's `referencingRepoPaths` in
using `f` (the SWEPT pending entry's own `sourceFile`) as the `BlockedCoOccupant`'s route basename — a
DIFFERENT source than the `deleteMergeQuarantineLatchByKey`-derived kept entries (which use `finalBasename`
instead).

**STATUS: verified with a new test, scenario (AI) in `test/merge-quarantine-clear-by-path.mjs`.** The
construction: P (the identity being cleared) is a hand-built degraded dual-arm (same technique as AH), with
its own `sourceFile` DELIBERATELY chosen to equal `hashKey(K2)` for an independently-invented synthetic key
`K2`; R (a SEPARATE, SURVIVING identity, also a hand-built degraded dual-arm) is armed at exactly `K2`, so
`physicalOwnerRepoPaths(P's own sourceFile)` finds R via its OWN `armedKeys`/`quarantineHashForKey` claim —
no real two-file collision needed, since both sides are derived from the SAME hash function used by the
real code, not coincidental. Verified: R stays genuinely blocked both before and after P's clear;
`stillBlockedCoOccupants` names R; `route.id` equals the REAL sourceFile's own stem (`hashK2AI`) — with an
inline negative control (checked against a bogus id and against P's OWN unrelated key hash, confirming
neither accidentally matches); clearing R by that exact id genuinely lifts R (`liftedRepoPaths` includes
it, not a dead/raw-fallback id). **Control S21**: replacing the real `f` with a bogus sourceFile at this
exact fold site (same manual revert/rebuild/run/restore/rebuild discipline as S8, byte-identical restore
confirmed) makes the "route id equals the real sourceFile's stem" check fail.

## Round 4 (Code Review CR3): a round-3 regression (the double-fault bucketing bug), plus coverage gaps

### MAJOR — a double-fault was bucketed as RELOCATED, producing false "clear id X FIRST, THEN id X" text

Round 3's own fix (above) treated EVERY protect call's `persisted` return as relocated. But
`protectOccupantContentBeforeDelete`'s own double-fault fallback (the pending-divert write itself FAILS)
ALSO returns `persisted` — naming the occupant's OWN PRE-EXISTING file, which it never moved: nothing new
was minted, the occupant genuinely stays KEPT at its old name. Bucketing that as "relocated" produced,
for a repoPath whose SAME physical file is ALSO independently found kept (e.g. via `sharedClaimants`'s own
self-referencing-orphan check): `route.id === alsoClear.id` (the SAME id, twice) and reason text claiming
"durably RELOCATED ... clear id X FIRST ... THEN id X" — every clause false (the file still exists, no
new latch was ever written, one clear suffices). The SAME bug applies to the pre-existing (pre-round-3)
tmp-residue double-fault (`protectForeignTmpResidueBeforeSweep`'s own call into the SAME function) —
there it claimed "durably RELOCATED ... just removed" while the `.tmp` residue genuinely survives.

**Fix:** `ProtectResult` gained an explicit `relocated?: boolean` — `true` ONLY on the success path (a
genuinely new/re-pointed latch was written); `false`/absent on the double-fault path. Every caller
(`deleteMergeQuarantineLatchByKey`, `protectForeignTmpResidueBeforeSweep`) now splits its OWN collected
`persisted` entries by this flag — a double-fault joins the `kept` bucket, never `relocated`. A SAFETY
NET also lives in `blockedCoOccupantBothRoutes`/`mergeKeptAndRelocatedCoOccupant` themselves — belt-and-
suspenders, not a substitute for the real fix above — but the two do NOT compare the SAME thing:
`blockedCoOccupantBothRoutes` compares the two raw `sourceFile` strings directly; `mergeKeptAndRelocatedCoOccupant`
instead compares the two already-DERIVED `.route.id` values (round 5, nit — see that record section).
`pendingLatchIdFor` is not injective (a `<hash>.json` and its own `<hash>.json.tmp-<pid>` residue reduce to
the SAME id), so an id-equality collapse is a strictly WEAKER condition than a sourceFile-equality one —
it can fire on two genuinely different physical files. Both still collapse to one plain route when they
fire; nothing observed depends on this distinction being closed, but a future reader comparing the two
functions side by side should not assume they test the same thing.

**Verified** in `test/merge-quarantine-protect-write-failure.mjs`'s existing final-path and tmp-path
double-fault scenarios (each now asserts: no `alsoClear`; the reason never says "RELOCATED" or "just
removed"; ONE clear of the fold's own named id genuinely lifts the occupant) — negative control: reverted
to round-3 HEAD via the `negative-control` script, confirmed RED, fix restores GREEN, byte-identical
restore confirmed. One PRE-EXISTING assertion in the tmp-path scenario ("latchKept is ABSENT") was itself
WRONG under the new, correct bucketing — D's double-fault genuinely IS kept now (at its own tmp file, a
DIFFERENT file than R's own) — corrected in place to assert `latchKept:true` with D named in
`referencingRepoPaths`, rather than silently left to rot as a stale assumption.

### (b)/(c) — untested sites the CR proved GREEN when broken

(c) `clearMergeQuarantineReporting`'s own compose-once branch (the m3 fix) and the surrounding
`clearMergeQuarantineByRecordedPath` kept/relocated split-and-recombine machinery (b) are now covered by
a NEW scenario (`cr3-m3` in `test/merge-quarantine-protect-write-failure.mjs`, reusing the CR's own probe
construction verbatim: P unresolvable at boot, armed at a synthetic `resolvedKey` K — never `mkdir`'d, so
it dispatches via `clearMergeQuarantine` → `clearMergeQuarantineByRecordedPath`, never `clearMergeQuarantineByKey`
directly; X's foreign record at `hash(K).json`, written AFTER boot; the pending-divert write injected to
fail). A clean (non-injected) positive control sits alongside it.

**(b)'s "never invoked"/"unproven reachable" claim above was REFUTED by Round 5's own CR4 — see the
"Round 5" section below for the real construction and why `cr3-m3`'s own compose-once assertion (line
~557 in `test/merge-quarantine-protect-write-failure.mjs`) is VACUOUS for it (`relocated.length=0,
kept.size=1` in that exact construction — true, and still the honest finding FOR `cr3-m3` ITSELF, but the
"therefore the combine call can never fire" conclusion drawn from it was wrong).** What IS verified by
`cr3-m3` stands unchanged: `clearMergeQuarantineByRecordedPath`'s own `splitCoOccupants` call, its
kept/relocated Map-building, and its final-return assembly.

### m4's own "still-quarantined AND relocated" construction: UNPROVEN, reachability argument only

The CR's own probe (`mode="m4"`) constructs sub (resolvable, raised only via raw boot-scan — never a real
`enterMergeQuarantine` raise), with X foreign at sub's own key file and Y a degraded occupant sharing
sub's own canonical key via a manufactured `resolvedKey`. Measured directly (re-running the CR's own
probe against this round's code): `clearMergeQuarantineReporting(sub)` does NOT reach the
"still-quarantined" branch at all — `post: sub blocked false`. Reachability argument for why: Y, sharing
sub's own canonical key via its own `resolvedKey`, gets ARMED at that SAME key during boot (the
`883e29bc`-shaped dual-arm) — so clearing sub (which resolves to that SAME key) finds `entry = Y's own
object`, not `undefined`, and the clear's own `keysToLift` (driven by `entry.armedKeys`) deletes Y's own
ACTIVE slot as a side effect of clearing "sub". Y's OWN pending-tier twin (if the dual-arm pushed one)
is keyed by Y's OWN identity, never reachable from a query addressed at sub. So this exact construction
closes sub's own query cleanly rather than leaving anything to report "still quarantined" about. No
construction producing the true "still-quarantined AND relocated" combination was found. Left UNPROVEN,
consistent with the Lead's own hedge for this item.

### nit 3: the Round 3 table now has all 4 orderings as committed tests

The Round 3 table above originally claimed all four clear-orderings were "verified with a real reboot",
while only 2 of the 4 rows (relocated-alone, relocated-then-kept) were actually committed as reboot-backed
tests — the other two (kept-alone, kept-then-relocated) were only verified by hand (a throwaway probe
script, never committed). Closed by adding scenarios (AE2) (kept-alone) and (AE3) (kept-then-relocated) to
`test/merge-quarantine-clear-by-path.mjs`, each with a REAL reboot (fresh child process, same `LOOM_HOME`).
The table above is updated to drop the stale "N/A" wording for kept-alone (it is now reboot-verified as
"NO" — a no-op that never lifts anything, confirmed durable-absent by a reboot, not merely in-process).

### Finding 4 — `clearMergeQuarantineLatchFile`'s pending branch and raw fallback hard-coded `stillBlockedCoOccupants: []`

Both branches could set `latchKept`/`referencingRepoPaths` (a kept file genuinely survives) while ALWAYS
returning an empty `stillBlockedCoOccupants` — field-inconsistent with every other clear path in this
card, which treats that field as `kept ∪ relocated`, never "kept only when convenient to compute." Fixed:
both branches now build real `BlockedCoOccupant[]` entries (via the existing `blockedCoOccupant` helper)
for every kept repoPath, using the EXACT sourceFile the underlying sweep found it at —
`sweepTmpResidueForHashIfUnreferenced` gained an additive `keptEntries: Array<{repoPath, sourceFile}>`
return (the pre-existing `referencingRepoPaths` alone can't recover which EXACT tmp filename a given
repoPath was found at, needed to build a real `{id}` route).

**Verified for the RAW FALLBACK branch** — scenario (Z1) in `test/merge-quarantine-clear-by-path.mjs` now
additionally asserts `stillBlockedCoOccupants` names BOTH referencing repoPaths, each with the correct
route id (the SAME id this clear was called with, since the raw fallback's own sweep target is `${id}.json`
itself).

**Honest finding for the PENDING branch:** a construction mirroring (Z1)'s own shape — one pending entry
P whose own sourceFile is engineered to be "owned" by a SEPARATE, surviving entry R (so `ownSweep`/`finalSweep`
finds R as a genuinely DIFFERENT kept owner) — was attempted and is UNREACHABLE via `clearMergeQuarantineLatchFile`'s
own entry point: any `id` that makes R a genuine ACTIVE owner of P's sourceFile (via `quarantineHashForKey`)
makes R ALSO match as `activeMatch` for that SAME `id`, tripping the EARLIER active+pending ambiguity
refusal (decision `fd189d91`) before the pending branch's own kept-tracking code ever runs — confirmed
empirically (`{ok:false, reason:"latch id ... matches BOTH an active quarantine ... AND 1 pending entry
for a DIFFERENT repo ... refusing to guess"}`), not merely reasoned. A pending-side (rather than
active-side) "different owner" is structurally impossible to construct from two genuinely separate boot
reads (one real file can't carry two different in-memory records' content at once). The fix is still
correct and non-regressing (byte-identical code pattern to the already-verified raw-fallback half, full
corpus green, build clean) — only the NAMED/attributed-kept sub-case of THIS ONE branch has no passing
positive test; the (also-fixed) unattributed-kept case and the raw-fallback's named case are both covered.

## Round 5 (Code Review CR4 07066272): a real fixed-point bug, plus corrections and open items

### MAJOR — a kept route's `{id}` named the id THIS CLEAR JUST CLEARED — a fixed point, never a working route

`blockedCoOccupant(rp, sourceFile)` was called uniformly for every repoPath in
`sweepOrphanLatchFileIfUnreferenced`'s/`sweepTmpResidueForHashIfUnreferenced`'s own `referencingRepoPaths`/
`keptEntries` — but that set mixes TWO structurally different cases: genuine PHYSICAL OWNERSHIP of
`sourceFile` ({@link physicalOwnerRepoPaths}: `rp`'s own armed key hashes to it, or it's `rp`'s own
pending `sourceFile`), where `sourceFile`'s own id IS `rp`'s own identity — and a mere `orphanLatchFiles`
CROSS-REFERENCE (`rp` merely LISTS `sourceFile`; it does not own it). For the cross-reference case,
`sourceFile`'s own id is the id the CALLER JUST ACTED ON — never `rp`'s own identity — so offering it back
as `rp`'s own clear-by-id route is a FIXED POINT: nothing in memory ever matches that id as `rp`'s own
record, so re-clearing it no-ops forever and `rp` stays blocked. Reproduced exactly in test scenario (Z1)
(`test/merge-quarantine-clear-by-path.mjs`): two registered repos C1/C2 each `orphanLatchFiles`-reference
a third repo's corrupt, unreadable "ghost" latch; round 4's own test asserted `c.route.id === hashOfGhost`
— the id the clear being tested had JUST acted on — as "the real route", never actually clearing it to
prove so.

**Fix:** a new `blockedCoOccupantForReferencer(repoPath, sourceFile)` (`merge-quarantine.ts`) replaces the
bare `blockedCoOccupant` call at every site that can receive a mixed referencing set (the active-match and
raw-fallback branches of `clearMergeQuarantineLatchFile`, both the final-sweep and tmp-sweep halves — 4
call sites). It checks `physicalOwnerRepoPaths(sourceFile).includes(repoPath)` first (physical ownership
→ `sourceFile`'s own id is correct, unchanged); otherwise it resolves `repoPath`'s OWN active/pending
entry and uses `quarantineLatchFileIdsFor(ownEntry)[0]` instead — a genuinely different, working id.
`BlockedCoOccupant.route.id` is now optional (`id?: string`) for the structurally-unreachable case where
no owning entry can be found at all (every real caller's `repoPath` is itself read off a live entry's
`.repoPath` field, so this never fires today) — `mergeKeptAndRelocatedCoOccupant` falls back to the
relocated route alone rather than building a broken `alsoClear` with no id in that case.

**Audited every other `blockedCoOccupant` call site for the same shape** (the MAJOR's own instruction):
`sweepOwnLatchFileUnlessOwnedElsewhere`'s own `referencingRepoPaths` is ALWAYS physical ownership
(`physicalOwnerRepoPaths`/`survivingSharedClaimRepoPaths`, never a cross-reference) — every site consuming
it (lines ~4825, ~4847 in the active-match branch, the `deleteMergeQuarantineLatchByKey`/
`clearMergeQuarantineByRecordedPath` kept/relocated folds) is correct as-is, unchanged. `deleteMergeQuarantineLatchByKey`'s
own `kept` array (`sharedClaimants` ∪ `contentClaimants` ∪ `persistedKept`) is ALSO always physical —
`sharedClaimants` is `survivingSharedClaimRepoPaths` (physical); `persistedKept` always names the
double-fault occupant's own genuine pre-existing file (confirmed: the double-fault branch itself pushes a
matching pending entry at that exact `sourceFile`, so `physicalOwnerRepoPaths` would find it too);
`contentClaimants` (`survivingTokenHolderRepoPaths`, the one genuinely non-structural, content-only check)
is NEVER actually populated by any real call site today — it requires `clearedEntry` to be `undefined`,
and every one of the four call sites of `deleteMergeQuarantineLatchByKey` always passes a real `clearedEntry`
— so it is dead code for this purpose, not a live risk, left as a defensive branch rather than touched.

**Verified:** test scenario (Z1) rewritten to CLEAR the offered route (never the ghost's own id) for BOTH
C1 and C2, confirmed unblocked in-process, confirmed the ghost file is finally swept once both clear
through their OWN routes, and confirmed BOTH stay unblocked after a REAL reboot (lesson 203) — plus a
negative control reproducing round 4's own bug (re-clearing the ghost's id again is a no-op; C1 stays
quarantined). One sanity note: an INTERMEDIATE reboot while the ghost file is still unresolved durably
re-writes a fresh fail-closed latch to disk for the repo passed to it — that is the CORRECT, expected
behavior for an unreadable orphan (not a regression of this fix), but it is a real side effect this test
deliberately avoids triggering before the durability proof, since a stale rewritten file the rest of the
test's in-memory state can't see would contaminate it. Negative control: reverted the source fix to
pre-round-5 HEAD, confirmed the Z1 round-5 assertions (and several downstream ones, cascading from Z1's
own failure within the same single-process test run) go RED, restored the fix via the saved patch
(`git diff`-confirmed byte-identical), rebuilt, confirmed GREEN (370 PASS, 0 FAIL).

### MINOR — one repoPath kept at TWO files under two ids is under-reported — NOT FIXED this round

Real finding, NOT implemented: `deleteMergeQuarantineLatchByKey`'s own two-keys-per-clear loop (and its
twin in `clearMergeQuarantineByRecordedPath`'s pending loop) fold each key's own `{kept, relocated}` into
`Map<string, string>` accumulators KEYED BY REPOPATH — `keptReferencingRepoPaths.set(kc.repoPath,
kc.sourceFile)` (and the `BlockedCoOccupant`-valued equivalents in `clearMergeQuarantineByRecordedPath`).
When the SAME repoPath is independently kept at TWO DIFFERENT physical files across two different keys
(the CR's repro: P degraded and armed at K1 and K2, a foreign X's own tmp residue present at BOTH keys,
both pending-divert writes double-fault), the second `.set()` call overwrites the first — X is named ONCE,
with only ONE of its two surviving files' own route; the other file is silently dropped from the report,
and clearing the one NAMED route alone leaves X still genuinely blocked by the file nobody named.

**Why not fixed here:** the correct fix (per the CR's own direction) is to carry EVERY route per repoPath
— an ordered array, not a single route/alsoClear pair — which means widening `BlockedCoOccupant` itself
beyond its current fixed `route`/`alsoClear` (two-slot) shape to an arbitrary-length list, and updating
every consumer (`relocatedCoOccupantsReason`, `mergeKeptAndRelocatedCoOccupant`, `blockedCoOccupantBothRoutes`,
the REST serialization, and the test corpus's own `.route`/`.alsoClear` assertions) to match. That is a
real type change with a wide blast radius, not a narrow data-structure swap at the 4 named sites alone —
left for its own follow-up rather than risked under this round's remaining scope. The 4 named sites
(`deleteMergeQuarantineLatchByKey`'s own per-key loop in `clearMergeQuarantineByKey`, its twin in the
pending-plan "remove" branch, and `clearMergeQuarantineByRecordedPath`'s matched-active and pending loops)
are where a `Map<string, string[]>` (collecting every sourceFile per repoPath, never overwriting) would
need to replace today's `Map<string, string>`, with the final `BlockedCoOccupant` construction widened to
emit one route per collected sourceFile.

### MINOR — (b)'s "combine call is never reached" claim is REFUTED — record corrected, new test NOT committed this round

CR4 names a genuine construction that DOES reach `mergeKeptAndRelocatedCoOccupant`, refuting the (b)/(c)
section's own "never invoked"/"unproven reachable" conclusion above (now corrected in place, pointing
here): **two distinct same-identity active entry OBJECTS for P** (not one object dual-armed at two keys —
`clearMergeQuarantineByRecordedPath`'s own `matched` loop tracks `seen` PER OBJECT, so two genuinely
separate objects sharing one identity both get delegated to separately), one armed at K1 and the other at
K2, with a foreign X's own content written at BOTH `hash(K1).json` and `hash(K2).json`; the pending-divert
write SUCCEEDS on the first delegated `clearMergeQuarantineByKey(K1, P)` call (X relocates) and FAILS on
the second (`clearMergeQuarantineByKey(K2, P)`, X double-faults, stays kept) — X then lands in BOTH
`relocatedCoOccupants` and `keptReferencingRepoPaths` for the SAME repoPath, and the final combine step
(`relocated.map((co) => { const keptCo = keptReferencingRepoPaths.get(co.repoPath); return keptCo
!== undefined && !co.alsoClear ? mergeKeptAndRelocatedCoOccupant(co, keptCo) : co; })`) fires.

**NOT independently re-verified or committed this round** — this correction records the CR's own repro
(attributed to the reviewer, not to this worker's own independent construction) and is NOT a claim that
this worker built and ran it. Re-pointing `cr3-m3`'s own vacuous compose-once assertion at this
construction, and committing it as a real test, is left for a follow-up round — constructing "two distinct
same-identity active entry objects" correctly (vs. a boot-time union collapsing them into one) is exactly
the kind of subtle setup this card's own history shows is easy to get wrong without independent
verification, and this round's remaining budget did not allow verifying it firsthand before committing it
as fact.

### MINOR — final-path relocated split masked by the safety net — documented as load-bearing, no new test

Per the CR's own offered resolution (either add a shape where `keptClaimants` does NOT also find the file,
or state that the safety net is load-bearing there): `deleteMergeQuarantineLatchByKey`'s own
`collectPersisted`-driven relocated/kept split for the FINAL path IS masked, in every construction this
card's own test corpus exercises, by `keptClaimants`'s own independent discovery of `finalBasename` via
`survivingSharedClaimRepoPaths`/`physicalOwnerRepoPaths` — meaning `blockedCoOccupantBothRoutes`'s own
sourceFile-equality safety net (not the split itself) is what currently keeps the final-path result
correct whenever both mechanisms fire on the SAME file. No new test was added to force the split to run
with `keptClaimants` NOT also finding the file; this note is itself the documentation the CR's second
option asked for. A future change that narrows `keptClaimants`'s own reach without re-deriving this
argument from scratch should re-verify this split still produces a correct standalone result.

### Nits

- `relocatedCoOccupantsReason`'s wording now says "a record of this same identity" (never "this same
  record") for the alsoClear clause — the old file can legitimately hold a DIFFERENT record of the same
  identity (cd5a3cf9/c93e9e7a's own still-open stale-sourceFile gap), not necessarily a byte-identical copy.
- `clearMergeQuarantineReporting`'s own ByKey `latchKept`-only branch (no relocated co-occupant to compose
  a clause from) used to return NO `reason` text at all, unlike `clearMergeQuarantineByRecordedPath`'s own
  equivalent branch. Fixed via a new shared `keptOnlyReasonFor(refs)` helper, used by both.
- The Round 4 "SAFETY NET" wording (above) is corrected: `blockedCoOccupantBothRoutes` compares raw
  `sourceFile` strings; `mergeKeptAndRelocatedCoOccupant` compares derived `.route.id` values instead —
  `pendingLatchIdFor` is not injective, so these are not the same comparison.

## Do not

- Do not read `clearMergeQuarantineByKey`'s pre-existing `referencingRepoPaths: string[]` as deprecated —
  it stays exactly as it was (repoPath-only, KEPT entries only); `stillBlockedCoOccupants` is an additive
  elaboration (kept ∪ relocated, NEVER deduped — see "Round 3" above), never a replacement.
- Do not add `persisted` to `protectOccupantContentBeforeDelete`'s "nothing to protect" early returns
  (ENOENT/corrupt/null/all-tokens-already-cleared) — there is no occupant to name there, and inventing one
  would misreport a clean no-op as a co-occupant.
- Do not derive a `BlockedCoOccupant`'s `sourceFile` from anywhere other than what the protect call (or
  `deleteMergeQuarantineLatchByKey`'s own `sharedClaimants`/`contentClaimants`, which stay at the OLD
  `finalBasename`) actually computed — a second, independent lookup after the fact can race against a
  later mutation in the SAME call (lesson 196: prefer explicit pre-computed arguments).
- **(Round 2, REVERSED BY ROUND 3 — do NOT follow this old direction)** Do not fold a `relocated` entry
  into `latchKept`/`referencingRepoPaths` (this half still holds). The OLD second half of this bullet said
  "and do not dedupe a kept+relocated collision in favor of the KEPT entry" — reasoning that RELOCATED must
  win instead. Round 3 found BOTH directions of deduping wrong: a genuine kept+relocated collision (two
  DIFFERENT real files) must NEVER be collapsed to one route — report BOTH, ordered (`route` relocated
  first, `alsoClear` kept second). See "Round 3" above for the empirical proof. **(Round 4 refinement)** —
  the ONE narrow exception is `blockedCoOccupantBothRoutes`/`mergeKeptAndRelocatedCoOccupant`'s own safety
  net: when the two sourceFiles turn out to be the SAME file (the round-4 double-fault bug, or any future
  mis-bucketing), THAT case correctly collapses to one plain route — there is no second real file to name.
  Never read this exception as license to re-introduce a general collapse; it fires only on genuine
  sourceFile equality, never on "this looks redundant."
- **(Round 5)** Do not call `blockedCoOccupant(repoPath, sourceFile)` for a `repoPath` drawn from a MIXED
  referencing set (`sweepOrphanLatchFileIfUnreferenced`'s/`sweepTmpResidueForHashIfUnreferenced`'s own
  `referencingRepoPaths`/`keptEntries`) without first checking whether `repoPath` PHYSICALLY OWNS
  `sourceFile` (`physicalOwnerRepoPaths`) — a mere `orphanLatchFiles` cross-reference makes `sourceFile`'s
  own id a FIXED POINT for that repoPath, not a working route. Use `blockedCoOccupantForReferencer` at any
  such site instead; see its own doc and the "Round 5" MAJOR section above.

## Follow-up: the stale-sourceFile root (cd5a3cf9/c93e9e7a) stays open

Per the triage note on this same card: `clearMergeQuarantineByRecordedPath`'s own `latchKept` wording used
to say "this (and every other) claimant still depending on it WILL RE-DIVERT on the next restart" — but
the identity JUST CLEARED is, by construction, already fully lifted by the time that branch is reached
and will NOT itself re-divert; only the OTHER named claimants (`refs`) can. Fixed by dropping "this" from
that sentence. The deeper root this triage note flagged — a mismatched twin's `sourceFile` field never
being re-synced by `replaceEntryEverywhere` once its real backing moves elsewhere (so a `refs` member can
still be OVER-reported here) — is `cd5a3cf9`'s and `c93e9e7a`'s own already-tracked, still-open gap, not
fixed by this card; the reworded text now says so explicitly rather than asserting an unconditional
re-divert. Over-warning (reporting a co-occupant that's actually already resolved) stays the accepted,
safe direction until that root is fixed on its own card.
