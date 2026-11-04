# e1572b69 — recognise AND prevent the nested stranded tmp from a failed orphan-latch rewrite

Found by the 5332762e Code Review (reviewer `a958d2ca`), named a CONFIRMED, OPEN gap by that card's own
"Site B" section. INVESTIGATE-FIRST, QUARANTINE LANE.

## The bug

`rewriteOrphanLatchFilesAfterPartialClear` (merge-quarantine.ts) calls `writePendingDivertFile(orphanFile,
updated, droppedTokens)` directly with `orphanFile` as the target. `orphanFile` can already be
`.tmp-`-shaped — tracked there by an earlier triple-fault raise (card `8d80b736`) or an earlier failed
clear-time narrowing write (card `5332762e`). `writePendingDivertFile`'s own staging tmp name used to be
unconditionally `${final}.tmp-<pid>-<hex>`; when `final` is already `.tmp-`-shaped and this write's own
rename then ALSO fails, the stranded name nests a SECOND suffix onto the first
(`pending-<hash>.json.tmp-<pid1>-<hex1>.tmp-<pid2>-<hex2>`). That shape matches none of this module's
residue regexes (`PENDING_DIVERT_TMP_RE`, `TMP_RESIDUE_FILENAME_RE`, `SAFETY_TMP_RE`, all anchored on the
suffix immediately following `.json`), so it was never tracked, never swept, and never recovered at
boot — permanent, unrecognized disk debris, contradicting the site's own (pre-fix) inline comment
claiming boot's recovery pass "re-arms it as a duplicate."

Reproduced hermetically against the reviewer's own probe (`probe-double.mjs`, copied into this worker's
own scratch dir) run in "all" mode (every rename into `MERGE_QUARANTINE_DIR` faulted during the second
clear): the doubly-suffixed file survived a clean full lift and a real reboot, untracked, unswept,
unrecovered — `stillBlockedEntryFor` stayed `undefined` throughout (no resurrection — this is a leak, not
the fail-open/fail-closed shape 5332762e/8d80b736 are about).

## The fix — (a) track, combined with (b) prevent

**(a)** `rewriteOrphanLatchFilesAfterPartialClear` now tracks its OWN newly-stranded tmp into the entry's
`orphanLatchFiles` too, mirroring 5332762e's established pattern (`path.basename`, Set-deduped, via
`replaceEntryEverywhere`). The function's signature changed from `void` to returning the (possibly
tracking-replaced) `MergeQuarantineEntry` — all 4 call sites were audited and updated to use the return
value for anything they do with their own `updated`/`live.entry`/`writtenTwin.entry` afterward, so none
acts on a stale pre-`replaceEntryEverywhere` local.

**CORRECTED (Code Review):** an earlier draft of this record claimed iterating the live
`orphanLatchFiles` field would risk an infinite loop within the same call. That claim was FALSE as
written: the tracking below always builds a FRESH array/object (`withStrandedTmp`'s own spread), never a
push onto the array the loop is iterating, so nothing in today's code ever mutates that live array at
all — a mutant that reverted the snapshot back to the live field stayed GREEN, with no hang, confirming
there is no current hazard to fix. The function still iterates a SNAPSHOT
(`[...(updated.orphanLatchFiles ?? [])]`) taken before the loop starts, purely DEFENSIVELY: it protects
against a FUTURE change that tracks via an in-place push instead of today's fresh-object pattern, which
would then risk re-visiting the newly-tracked element in the SAME synchronous call for as long as the
underlying fault persists. A newly tracked tmp is left for a LATER call to process either way, mirroring
5332762e's own AFTER-not-before ordering rule.

**(b)** `writePendingDivertFile` now stages its tmp onto the CLEAN `.json` base recovered from `target`
(new helper `cleanJsonDivertBase`) instead of appending onto `target` directly. `cleanJsonDivertBase`
returns `undefined` — falling back to the pre-fix append-onto-`final` construction, byte-identical to
before — whenever `target` does not contain EXACTLY ONE `.json` substring (a never-expected degenerate
case; every filename this module produces, final or any `.tmp-`/`.tmp-safety-`/`-collision-` residue of
one, contains exactly one). For an ordinary, already-clean `.json`-ending target, `cleanJsonDivertBase`
returns `target` itself unchanged, so every OTHER caller of `writePendingDivertFile` is byte-identical —
confirmed by the full regression sweep below, all green.

With (b) in place, EVERY stranded tmp this function can ever produce — regardless of how many times in a
row this same entry's rewrite has failed, and regardless of which caller reached `writePendingDivertFile`
with an already-tmp-shaped target — is a single, ordinarily-shaped residue name. No residue regex needed
widening.

## Why (a) alone and (c) (widen a regex) were rejected

(a) alone would still produce a nested name on EVERY failure of an already-tmp-shaped target (just a
TRACKED nested name). Nesting depth would grow by one level per failed clear against the same entry while
a host-wide fault persists — not dangerous, but the filename grows unboundedly and it still relies on the
recognition regexes never being asked to parse a nested shape anywhere else in the module (several
boot/sweep sites derive a tmp's "hash" via `indexOf(".json.tmp-")`, which is fragile against a nested
name once more than one case needs to special-case it).

(c) (widen a residue regex to admit a nested shape) was investigated and rejected: boot's hash-based
tmp-recovery (`reenterMergeQuarantinesAtBoot`'s `tmpFiles` loop) matches a tmp's hash against CURRENTLY
REGISTERED, RESOLVABLE repos via `hashToRepo` — this module's own "pending-" prefixed, UNRESOLVABLE-
identity files (the exact shape this card's own repro uses) never reach that path at all; recovery for an
unresolvable identity's own orphan tmp is `orphanLatchFiles`-tracking only, confirmed directly by this
investigation's own probes (an untracked single-suffixed tmp is equally leaked as an untracked
doubly-suffixed one — the REGEX never mattered for this shape; only tracking does). Widening a regex would
also still leave the filename-length growth (a) alone has, and adds a THIRD interpretation `indexOf`-style
hash derivation would need to special-case. (a)+(b) combined closes the bug with no regex change at all.

Under a SUSTAINED fault (every rename into the quarantine dir keeps failing across several sequential
partial clears of the same entry), the number of tracked stranded files can roughly DOUBLE per partial
clear — one from the outer write's own failure, one from the orphan-rewrite's own failure on each
already-tracked orphan from the PRIOR clear — bounded above by the entry's own outstanding token count
(each clear drops one token, so the sequence terminates); every one of them is still tracked (fix a) and
single-suffixed (fix b), and all are swept together once the full lift genuinely accounts for every token.

## A related, out-of-scope reachability: a SAFETY-tmp-shaped target

`writePendingDivertFile` can also be called with a `<hash>.json.tmp-safety-<pid1>-<hex1>` shaped target —
a pending entry whose `sourceFile` was relocated there by `attemptDivertSafetyTmpFallback` (see
`mergeTokenIntoPendingEntries`/`divertRaiseEntry`'s own fallback). `cleanJsonDivertBase` recovers the same
clean `<hash>.json` base from THIS shape too (it still contains exactly one literal `.json`), so a rename
failure on such a target now strands an ORDINARY, non-safety-shaped `<hash>.json.tmp-<pid2>-<hex2>` name
— which, per the reviewer's own trace, now enters boot's PASS 1b MAIN tmp-recovery path (the
`hashToRepo`-driven one, disjoint-by-design from `SAFETY_TMP_RE`'s own recovery) rather than the
safety-tmp-specific path the ORIGINAL (still-live, un-renamed) safety tmp would have used. The reviewer's
trace shows this resolves fail-closed, consistent with every other shape in this record — but it is
UNTESTED by this card: no scenario here constructs a safety-tmp-relocated target whose own rewrite then
fails. Fix (b) covers it by construction (the same clean-base logic, no special-casing needed), untested.

## What a reboot BETWEEN clears (before the full lift) does now — confirmed by TRACE

Three distinct shapes were traced (scratch probes, not committed into the test suite — see "Why not
committed as a test" below):

1. **Compound fault** (the OUTER primary write for a clear ALSO fails, not just the orphan-rewrite): the
   primary's own on-disk bytes stay at their PRE-clear, full token set. A reboot before the full lift
   re-arms the FULL original token set as a fail-CLOSED duplicate — over-blocking, never fail-open. This
   is the SAME posture 59e758e5/5332762e already document and accept; this card's own fix neither widens
   nor narrows it.
2. **Isolated fault** (the OUTER write succeeds; ONLY the orphan-rewrite's own write fails — this card's
   own named site, in isolation): **CORRECTED (Code Review) — this IS fail-closed over-blocking too, not
   "not over-blocked" as an earlier draft of this record claimed.** That claim was read off an IMMEDIATE
   `stillBlockedEntryFor` call right after reboot, which happens to return the primary's own first-match
   record ([t3] alone) and looked clean — but it never continued the scenario far enough to see the real
   consequence. The reviewer's own probe (this same shape, taken through a real reboot) shows THREE live
   records after boot: the primary ([t3]), the stale original orphan tmp ([t2,t3] — its own narrowing
   write is what failed, so it never dropped t2), and the newly-tracked, correctly-narrowed sibling tmp
   ([t3]). Clearing the one legitimately outstanding token (t3) reduces all three, but the stale orphan's
   own [t2] remainder survives as a FOURTH live record's worth of state — so the repo stays blocked by an
   ALREADY-CLEARED token (t2) even after every genuinely outstanding token is gone. Fail-closed
   (over-blocking, never a false lift), and PRE-EXISTING on main (not a regression this card introduces —
   the same multiple-independent-pending-records-per-identity mechanic shape 3 below names), but real: an
   immediate, first-match-only read is not evidence this shape stays clean once a later clear actually
   runs. The stale orphan debris and the correctly-narrowed sibling tmp are both tracked on disk and are
   left for a LATER clear's own `rewriteOrphanLatchFilesAfterPartialClear`/sweep to reconcile — which, per
   this correction, does not happen for free just because the IMMEDIATE post-reboot read looked clean.
3. **Isolated fault, THEN continuing to clear through the rebooted module** (deliberately NOT exercised in
   the committed test — see below): an unresolvable identity's own primary `.json` and its orphan tmp(s)
   each boot into INDEPENDENT pending records (nothing yet unifies them by identity at boot time for an
   unresolvable path). Continuing a clear via the rebooted module in this state can touch only the record
   it happens to match first, leaving the OTHER, stale record's own outstanding token(s) visible later as
   "still blocked" — still fail-closed (over-blocking, never a false lift), but this is a SEPARATE,
   pre-existing, orthogonal mechanic (how an unresolvable identity's multiple on-disk records eventually
   unify) that this card's own fix neither causes nor is responsible for closing.

**Why shape 3 is not committed as a regression test here:** it is reachable by continuing to clear through
a rebooted module instance mid-way through a scenario, which is not something 5332762e's own test does
either (its Scenario A never reboots until after the full lift) — doing so exercises a DIFFERENT,
already-existing mechanic this card did not introduce and is not scoped to fix. The committed test
(`merge-quarantine-e1572b69-nested-orphan-tmp.mjs`) reboots only ONCE, after the full lift, matching
5332762e's own precedent exactly; shapes 1 and 2 above are confirmed by scratch probe, not by a committed
assertion, for the same reason — forcing shape 3's own mechanic into this card's test would mischaracterize
a pre-existing, shared property as a regression in this card's own fix.

## Verification

- Hermetically reproduced the pre-fix defect (reviewer's own probe, copied into this worker's own scratch
  dir, run in "all" mode) before any source edit.
- New test `packages/daemon/test/merge-quarantine-e1572b69-nested-orphan-tmp.mjs`: Scenario A isolates
  this card's own site (outer write succeeds, only the orphan-rewrite fails) — by-content assertions for
  no nesting, tracking, full-lift sweep, and no resurrection after a final reboot. Scenario B is the
  manager-approved compound case (every rename into the quarantine dir faulted) — same assertions, plus an
  exact-count assertion (`newFiles.length === 2`) that catches the 5332762e ordering-rule reorder mutant
  (see below) now that fix (b) alone would otherwise make that mutant's own symptom (nesting) disappear.
- Mutation-tested, three mutants, each restored before the next:
  1. (a) disabled only (tracking no-op'd, (b) left active) — turns 6 of the new assertions RED (tracking,
     full-lift sweep, no resurrection); the "not nested" assertions stay GREEN, confirming (b) alone still
     prevents nesting.
  2. (b) disabled only ((a) left active, staging always appends onto `target` directly) — turns exactly
     the 2 "not nested" assertions RED; tracking/sweep/no-resurrection stay GREEN, confirming (a) alone is
     sufficient to prevent the PERMANENT LEAK (a nested-but-tracked name still gets found and swept) even
     though it does not prevent nesting itself. **Caveat: every assertion this mutant flips is a NAME-SHAPE
     check (`tmpSuffixCount(f) === 1`) — there is no BEHAVIOURAL mid-lift-reboot leg exercising (b)
     specifically.** The mid-lift-reboot shapes traced below (and shape 2's correction above) were all
     produced under the real fix (both (a) and (b) active); none was re-run with (b) alone disabled, so
     this record makes no behavioural claim about what a mid-lift reboot would show under that
     combination.
  3. 5332762e's own ordering rule reordered (track the OUTER write's own stranded tmp BEFORE, not after,
     calling `rewriteOrphanLatchFilesAfterPartialClear`) — the pre-existing "not nested"/"no debris"/"no
     resurrection" assertions all STAY GREEN under this mutant (fix (b) means even the reorder's own
     redundant re-processing of a tmp it just minted can no longer nest), which is exactly why the new
     exact-count assertion (`newFiles.length === 2`) was added: it alone turns RED under this mutant
     (3 failed-write attempts become 4; 2 new files become 3), confirming the ordering rule still matters
     even though its ORIGINAL symptom (nesting) is now independently closed by (b).
- Negative-controlled: `node scripts/negative-control.mjs --file packages/daemon/src/git/merge-quarantine.ts
  --test packages/daemon/test/merge-quarantine-e1572b69-nested-orphan-tmp.mjs` (default `--ref HEAD`, the
  pre-fix commit `0d629e2b10ac8b38fd59d48ce97e2eba1bf565c7`) — RED against that sha (6 checks fail), GREEN
  against the fix, working tree restored byte-identical.
- Full named regression sweep, each run individually: `merge-quarantine-5332762e-clear-narrowing-tmp-loss.mjs`,
  all 4 `merge-quarantine-59e758e5-*.mjs` files, both `merge-quarantine-8d80b736-*.mjs` files — all green.
  No file matches a literal `merge-quarantine-9cabd143-*` glob (9cabd143's own fix predates this file-
  naming convention); ran the closest, most directly relevant files instead
  (`merge-quarantine-clear-by-path.mjs`, `merge-quarantine-orphan-sweep-content-aware.mjs`) — both green.
  Additionally ran every OTHER test file this corpus that exercises `rewriteOrphanLatchFilesAfterPartialClear`
  or `clearActiveEntryTokenAtKey` (31 files total, covering the two call sites 5332762e's own test never
  reaches) — all green, one lane, sequential.
- `pnpm --filter @loom/daemon guards` and the lesson-299 ungated-landing list — both green (see the
  worker's own report for the one unrelated EOL finding on the new test file itself, fixed before commit).

## Do not

- Do not pass `orphanFile`/any already-`.tmp-`-shaped filename to `writePendingDivertFile` expecting its
  staging tmp to append directly onto it — the function derives a clean `.json` base itself
  (`cleanJsonDivertBase`); callers never need to, and must never try to, pre-strip the suffix themselves.
- Do not revert `rewriteOrphanLatchFilesAfterPartialClear`'s loop back to iterating the live
  `orphanLatchFiles` field directly, even though today's own tracking (a fresh `withStrandedTmp`
  array/object) never mutates it in place — the snapshot is a DEFENSIVE guard against a future change
  that tracks via an in-place push instead, which would then risk re-visiting the newly-tracked element
  in the SAME synchronous call for as long as the underlying fault persists.
- Do not change `rewriteOrphanLatchFilesAfterPartialClear`'s return type without re-auditing all 4 call
  sites (`clearTokenFromPendingIndices`'s success and failure branches, `clearActiveEntryTokenAtKey`'s
  reduce branch, the dual-tracked-twin branch) for what each does with its own `updated`/`live.entry`/
  `writtenTwin.entry`/`p.entry` afterward — a stale local there silently no-ops a LATER
  `replaceEntryEverywhere` call comparing by reference.
- Do not assume fix (b) makes the 5332762e ordering rule (track AFTER, never before, calling
  `rewriteOrphanLatchFilesAfterPartialClear`) moot just because its own ORIGINAL symptom (nesting) no
  longer reproduces under a reorder — the reorder still causes a real, wasteful redundant rewrite attempt
  (confirmed: exactly one extra failed-write attempt, one extra stranded file). Test it by an exact file
  COUNT assertion, not by a nesting/debris assertion, now that (b) is in place.
- Do not continue clearing through a REBOOTED module instance mid-scenario (before a genuine full lift) in
  a committed regression test for this card — that reaches a separate, pre-existing, orthogonal mechanic
  (multiple independent pending records for one unresolvable identity before anything unifies them at
  boot) this card's fix neither causes nor is scoped to close. Reboot once, after the full lift, mirroring
  5332762e's own test structure.
- Do not treat the missing `merge-quarantine-9cabd143-*.mjs` file as something to create — 9cabd143's own
  fix predates this naming convention; its coverage lives in `merge-quarantine-clear-by-path.mjs` and
  `merge-quarantine-orphan-sweep-content-aware.mjs` among others.
- Do not trust an IMMEDIATE, first-match-only `stillBlockedEntryFor` read right after a mid-lift reboot as
  proof a shape is "not over-blocked" — `ownIdentityEntryFor`'s `.find()` returns only ONE of potentially
  several live records for the same identity; shape 2 above looked clean under exactly this read and was
  not. Continue the scenario through the actual remaining clear(s) before drawing that conclusion.
