# 07e3ad30 — `clearMergeQuarantineByKey`'s pending-loop lost a protect call's mid-iteration push to a `.filter()` reassignment

Filed as the named follow-up from `docs/decisions/182c01cc-name-still-blocked-co-occupants-on-clear.md`'s
own "M6 (m1)" section — a foreign occupant's fresh pending-divert mint, minted by a protect call triggered
from inside `clearMergeQuarantineByKey`'s own pending "remove" branch, never survived into THIS process's
own `pendingUnresolvedQuarantines` array.

## Firsthand verification of the card's own premise (required checkpoint, before any edit)

The originating card's own description ("clearing P leaves NO FILES and X is no longer blocked") predates
`182c01cc`'s protect-and-relocate changes. Run firsthand, on today's main (which already carries
`182c01cc`), against the exact (AH) fixture:

- **Files on disk after the clear:** exactly ONE file remains in the quarantine dir — a fresh
  `pending-<hash>.json` holding X's own full, correct record (repoPath/branch/reason/tokens all intact).
  The OLD `hash(K).json` is gone because its content was durably RELOCATED there, not destroyed.
- **A real reboot** (fresh child process, same `LOOM_HOME`) correctly re-blocks X — `assertRepoNotQuarantined`
  refuses, naming X's own latch id and reason.

So on current main, X's record is durably safe; no second, durable-loss root cause exists. The defect is
**purely an in-process read**, until the next reboot re-scans disk. The fix below is scoped accordingly:
"X stays blocked in-process," not "X's file stops being destroyed."

## Root cause

`clearMergeQuarantineByKey`'s pending-processing loop (`packages/daemon/src/git/merge-quarantine.ts`,
originally `pendingUnresolvedQuarantines = pendingUnresolvedQuarantines.filter((p) => {...})`): the
"remove" branch calls `deleteMergeQuarantineLatchByKey` per `plan.ownedArmedKeys` member, which can invoke
`protectUnincorporatedOccupantBeforeDelete`/`protectDegradedOccupantBeforeDelete` → `protectOccupantContentBeforeDelete`.
That function's own "independent mint" branch pushes a NEW pending-divert entry onto the SAME
`pendingUnresolvedQuarantines` array when no existing same-identity slot can be re-pointed instead (e.g. a
genuinely fresh foreign occupant, never before scanned into memory).

`Array.prototype.filter` snapshots its own input length once, before the callback ever runs, and visits
only the indices present at that snapshot. Its RETURN VALUE — built solely from those pre-snapshotted
indices — is what then got reassigned onto `pendingUnresolvedQuarantines`. A push past that snapshot
(appended to the now-discarded original array object) is silently lost the instant the reassignment
completes. In-process, this made a genuinely still-quarantined foreign occupant read as unblocked
(`activeMergeQuarantineFor`/`listActiveMergeQuarantines` both missed it) until the next reboot re-scanned
disk and rediscovered it.

The OUTER `keysToLift` loop (which runs the SAME protect machinery, just before the `.filter()` call ever
starts) is unaffected — any push there lands on the array before `filter`'s own length snapshot, so it IS
visited. The file's two OTHER `.filter()` reassignment sites (`clearMergeQuarantineByRecordedPath`'s own
`matchedPending` drop, both call sites) have pure predicates with no protect calls inside the callback —
their own protect-calling loops run AFTER the reassignment, onto the already-reassigned array — also
unaffected. This bug was isolated to the one site above. `clearMergeQuarantineByRecordedPath`'s
active-match loop delegates to `clearMergeQuarantineByKey`, so it inherited (and is fixed by) the same
change transitively — no separate code change was needed there.

## Reachability via real raise paths

Confirmed real, not merely a reviewer's raw-latch-file test technique. `canonicalRepoLockKey`
(`repo-lock.ts`) → `resolveGitToplevelSync` walks up from a path to the nearest ancestor with a `.git`; when
nothing in the chain resolves at all, it falls back to the nearest EXISTING ancestor directory — which can
be a generic shared ancestor, not anything unique to the repo. Two wholly-unresolvable repos sharing that
same nearest-existing ancestor (e.g. two deleted worktrees under one still-existing parent) legitimately
compute the IDENTICAL "synthetic" key. This is the same class already named (and deferred) as card
`398f476c` / project memory `c9114934`'s own MAJOR #3 ("two wholly-unresolvable identities sharing one
manufactured resolvedKey"), and the same root class `883e29bc`'s own record documents for a real
nested-repo-goes-missing shape. Hand-writing the latch file in a test (as every scenario in
`merge-quarantine-pass1-degraded-union-guard.mjs` and `merge-quarantine-clear-by-path.mjs` already does) is
this suite's standard way of simulating "a prior real process's boot-time write" — exactly what
`reenterMergeQuarantinesAtBoot` treats any on-disk `.json` file as, regardless of how it got there.

## The second listed defect ("relocation double record") — folded in, not a separate code path

Re-examined against `182c01cc`'s own Round 3: the "a relocation leaves the old file kept, still holding X,
so a clear through memory is never durable" shape is the SAME mechanism Round 3 already found, verified
empirically (a 4-ordering table), and fixed at the REPORTING layer via `BlockedCoOccupant.alsoClear` — the
clear's own response already tells the caller "clear `<relocated id>` FIRST, then `<kept id>` SECOND" for
durability, and needing two clears is the documented, accepted, fail-closed (over-blocking) design, not a
bug. The only place it interacted with THIS card's bug: because the relocated entry's in-memory push was
lost, a same-process follow-up clear of the "relocated" id fell through to the raw-fallback path (no
in-memory match) instead of the normal path — functionally correct (the fallback still unlinks the file)
but lower-fidelity. Fixing the push-loss makes the relocated entry genuinely present in memory, so the
already-correct `alsoClear` ordering instructions become fully actionable in-process, with no reboot
required first. Fixed together, as one change, under this card — the second item was a downstream symptom
of the first, never an independent defect.

## The fix

Replaced the `.filter()`-with-reassignment with an in-place loop over a snapshot, mirroring the EXISTING
sibling pattern this same file already uses for exactly this hazard: `mergeTokenIntoPendingEntries`
computes indices to remove in a pre-pass, then splices them out of the live array directly, never via a
`.filter()` reassign (lesson 198: mirror the sibling that handles the same input shape).

Concretely: iterate `[...pendingUnresolvedQuarantines]` (a snapshot of the SAME entries `.filter()` would
have visited) running the unchanged "reduce"/"remove" side effects per `pendingPlan`. The "reduce" branch
(mutates `p.entry` in place via `replaceEntryEverywhere`, keeping the wrapper where it is) needs no
splicing at all — `continue` replaces the old `return true`. The "remove" branch runs its side effects
exactly as before, then resolves `p`'s own CURRENT index fresh via `pendingUnresolvedQuarantines.indexOf(p)`
— never a precomputed one — and splices it out immediately, right then. Any push from that entry's own
protect call (or an earlier entry's) always lands at the array's tail, past every removal index, so it is
never touched by this or any later entry's own splice.

**Removal identity-correctness (manager's condition 2):** `p`'s own wrapper object is never itself
replaced-by-index as a side effect of another entry's own processing in this same loop — every protect
call's own union/re-point branch is gated by `directPathIdentity` checks
(`differentUnresolvableOccupantRepoPathAt`/`unincorporatedOccupantRepoPathAt`) that only ever touch a
DIFFERENT, foreign-identity slot, while every entry reaching `pendingPlan` in the first place already
shares the SAME identity as the repo being cleared (the pre-pass's own `directPathIdentity(p.entry.repoPath)
!== identity` filter). So `indexOf(p)` is expected to always find `p`. It is never trusted blindly anyway:
on `-1` the code does NOT silently treat it as "nothing to do and keep going" — it logs a loud
`console.error` naming the repoPath/sourceFile, surfacing a case that was not expected rather than papering
over it with a no-op. (There is nothing stale left behind either way: absence from the live array means
the entry is already gone by some other path, not that a cleared entry is wrongly kept.)

## Verification

- **(AH)**, `test/merge-quarantine-clear-by-path.mjs` — its own two pre-existing checks were INVERTED per
  that scenario's own prior instruction (X now reads BLOCKED in-process immediately, not unblocked). Its
  "route that actually works" section was rewritten: clearing the fold's own named id DIRECTLY in the same
  process (no reboot-then-clear two-step) now genuinely lifts X, confirmed durable by a further reboot.
- **(AJ)**, new scenario, same file — card `07e3ad30`'s own interleaving requirement (condition 2/3): W
  active; FOUR pending twins coexist in array order `[Before(unrelated), Q_remove(tied, triggers the
  foreign mint via the remove branch), Q_reduce(tied via armedKeys-overlap, interleaved reduce branch),
  After(unrelated)]`. `Q_remove` is armed (via `setActiveQuarantineTestOnly`, the same object also injected
  into pending — mirroring `883e29bc`'s own diverted-pending shape) at a synthetic key where a foreign
  occupant X's real latch sits, written to disk AFTER every inject/boot call (a genuine fresh mint, never a
  re-point). Asserts: X survives in-process (the fix) and is named in `stillBlockedCoOccupants` (condition
  4); W's own token is genuinely gone from every surviving entry; `Q_reduce` survives reduced to exactly its
  own private token (y stays blocked via that alone, mirroring card `64119847`'s own mechanism check);
  `Before`/`After` both survive untouched (condition 3's "nothing else was removed"); durability confirmed
  via a real reboot for both X and y.
- **Negative control:** reverted ONLY the source fix to `HEAD` (`git checkout HEAD --`), cleared
  `tsconfig.tsbuildinfo`, rebuilt, ran `test/merge-quarantine-clear-by-path.mjs` — 6 failures, spanning BOTH
  (AH)'s inverted checks AND (AJ)'s new checks (not just AH). Restored the fix from a saved patch, confirmed
  byte-identical (`diff` of the before/after patches), rebuilt, confirmed green again (0 failures).
- Full `test/merge-quarantine*.mjs` corpus (50 files), run serially, both `env -u LOOM_DEV` and
  `LOOM_DEV=1`: 0 failures in either state.
- `pnpm --filter @loom/daemon guards`: all 30 guards passed.
- Full `pnpm build` clean.

## Round 2 (Code Review `46d6e471` on `59fe9621`): MERGEABLE, no under-block; two non-blocking items closed

**Item 1 — (AJ) alone under-labels its own evidentiary weight.** Measured: on a revert of only the source
fix, ONLY (AJ)'s two "X reads BLOCKED"/"carries X" checks go RED — the interleaved-reduce, Before/After-
survive, and `stillBlockedCoOccupants`-names-X checks all still PASS pre-fix too, since a single remove's
own drop never disturbs anything else sitting in the array. (AJ)'s own header comment now says so
explicitly: those are SAFETY checks (they would catch a DIFFERENT regression — a fix that broke the
reduce/survival contract while "fixing" the push), not this scenario's own regression witness.

**New scenario (AK)** exercises the interleaving the fix's own `indexOf`-at-removal-time design actually
exists for: TWO sequential "remove" twins (`q1AK`, `q2AK`, each armed at its own distinct synthetic key
holding a distinct fresh foreign occupant, `x1AK`/`x2AK`) plus an unrelated pending entry `uAK` injected
after both. Processing `q1AK` pushes `x1AK`'s mint onto the tail, then splices `q1AK` out at its (still
original) index. Processing `q2AK` next pushes `x2AK`'s mint onto the (now longer) tail, then must resolve
`q2AK`'s own CURRENT index — which has shifted down by one because `q1AK`'s own earlier splice shifted
everything after it. A stale/precomputed index here would splice the wrong slot or corrupt `uAK`; only a
fresh `indexOf` lookup at splice time gets it right. Also asserts the fix's own defensive "expected to
remove ... already absent" log never fires (captured via a temporary `console.error` wrapper) — every
`indexOf` lookup this call makes finds its own wrapper exactly where expected. **Negative control,
reproducing the reviewer's own measurement:** reverted only the committed source fix (`git checkout
59fe9621~1 -- packages/daemon/src/git/merge-quarantine.ts`), cleared `tsconfig.tsbuildinfo`, rebuilt — 9
failures total, and in (AK) specifically, exactly the three the reviewer predicted go RED ("X1 reads
BLOCKED", "X2 reads BLOCKED", "listActiveMergeQuarantines carries BOTH") while every other (AK) check
(removal, y unblocked, U untouched, the absent-log check, durability) stayed GREEN even pre-fix — confirming
(AK), not (AJ) alone, is this fix's real regression witness for the two-remove interleaving. Restored via
`git checkout 59fe9621 -- packages/daemon/src/git/merge-quarantine.ts`, confirmed byte-identical (`git diff
HEAD` empty), rebuilt, confirmed green again (0 failures).

**Item 2 — audited the file's other two array-reassignment sites named in this record's own "Root cause"
section for the SAME hazard, plus a second drop SHAPE in the old code.** The boot-time
`pendingUnresolvedQuarantines = pendingUnresolvedQuarantines.map((p) => {...})` reassignment
(`reenterMergeQuarantinesAtBootImpl`, ~line 6053) was checked and is safe: its own callback never
pushes or splices `pendingUnresolvedQuarantines` — it only durably writes a safety-tmp file and calls
`replaceEntryEverywhere` (mutates `.entry` in place, never touches array length) before returning either
`p` unchanged or a same-shape replacement wrapper for `.map()` to place at the SAME index. `.map()` always
produces a result of identical length with no element skipping possible, so this site has neither this
card's own reassign-drops-a-tail-push hazard nor the shape below.

Separately (code-read, not reproduced — no repro was built or needed, since the snapshot-loop fix already
closes it structurally): the OLD `.filter()`-based pending loop had a SECOND, independent drop shape beyond
the one this card fixes. `protectOccupantContentBeforeDelete`'s own union/re-point success branch can
`pendingUnresolvedQuarantines.splice(atFinalBasenameIdx, 1)` (merge-quarantine.ts, ~line 2409) for an
ENTIRELY DIFFERENT (foreign) entry, as a side effect of processing the CURRENT callback's own entry. If
`atFinalBasenameIdx` sits BEHIND the `.filter()` cursor's current read position, that splice shifts every
later element down by one — which can shift the NOT-YET-VISITED element at the cursor's own next position
out from under it, skipping it entirely on the next iteration (the classic "mutate while forward-iterating"
hazard, distinct from the reassignment-drops-a-push hazard this card's own root cause describes). The new
snapshot-based loop closes this too, structurally, not as a side effect: it iterates a FIXED snapshot array
by object reference (never a live, positionally-advancing cursor), and resolves a removal's own index via an
explicit `indexOf` lookup only once, at the single point it actually splices — immune to any splice an
unrelated entry's own protect call makes anywhere else in the live array.

## Do not

- Do not reintroduce `pendingUnresolvedQuarantines = pendingUnresolvedQuarantines.filter(cb)` in
  `clearMergeQuarantineByKey`'s own pending loop, or any future call site in this function that processes a
  protect call capable of pushing onto this array, mid-callback — a `.filter()` reassignment silently drops
  anything pushed past its own length snapshot. Splice in place instead, re-resolving the CURRENT index at
  removal time, mirroring `mergeTokenIntoPendingEntries`'s own shape.
- Do not resolve a "remove" entry's splice index BEFORE its own protect-call side effects run, or batch
  every removal's index up front — a precomputed index can go stale relative to an array that may still
  grow (via a push) or shift (via another entry's own earlier splice) between computation and use. Resolve
  it fresh, immediately before the one splice call that uses it.
- Do not read a `-1` from `pendingUnresolvedQuarantines.indexOf(p)` at removal time as a silent no-op to
  swallow — log it loudly. It is not expected to fire (see "The fix" above for why), so a future regression
  that DOES make it fire should be visible, not papered over.
- Do not treat the "relocation double record" / two-clears-needed behavior as a residual bug this card left
  open — it is `182c01cc` Round 3's own documented, verified, fail-closed design (`BlockedCoOccupant.alsoClear`).
  This card only restored the first clear's own in-memory visibility; it did not and should not change that
  ordering contract.
