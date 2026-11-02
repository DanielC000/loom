# 59e758e5 — writePendingDivertFile never unlinks a stranded tmp itself; a caller may ONLY when it proved the content secured elsewhere (the 3 raise callers, after their own fallback succeeds)

Found by the 028837ad CR round 4 (reviewer 4c7fcd61, 2026-10-29): `writePendingDivertFile`'s catch path
(merge-quarantine.ts) never unlinked its own `pending-….json.tmp-<pid>-<hex>` after a failed rename (e.g.
EPERM). A later boot picked the leftover up as tmp residue and armed it as a SEPARATE, untracked, duplicate
active-quarantine entry for the same identity — "foreign residue that no real raise produced." FIRST LANDED
(commit `0a9fc7fc`): the catch path best-effort unlinked the exact tmp it minted, scoped to that one path,
never throwing past the original error. **SUPERSEDED by B1 below (round 1 CR) and again by round 3 (CR
round 2) — see "Status" at the end for the FINAL shape:** `writePendingDivertFile` itself no longer
unlinks anything; it returns `strandedTmp` and the decision belongs to the caller alone.

## The unlink-alone regression (found; see "Status" below for how it was eventually fixed)

The unlink alone converted a FAIL-CLOSED defect into a FAIL-OPEN one: `mergeTokenIntoPendingEntries`
(unlike its sibling `divertRaiseEntry`) has no safety-tmp fallback of its own on a `writePendingDivertFile`
failure — pre-unlink-fix, the newly-merged token only "survived" a reboot because the stranded tmp got
(accidentally) armed as that duplicate entry; post-unlink-fix, with the stranding gone, the token is just
cleanly lost. Proven via negative-control against the unlink-only sha (`0a9fc7fc`):
`merge-quarantine-2dd97aaa-item3-pending-divert-safety-tmp.mjs`'s "t2 survives the reboot" assertion flips
from PASS to FAIL with no other change. Filed as card 7845ae33, then folded into this card (manager ruling,
lesson 283: a change that converts a fail-closed defect into a fail-open one is a blocker, not a separate
follow-up).

## The attempted fix, and the SECOND, deeper regression it caused

Mirroring `divertRaiseEntry`'s own existing `attemptDivertSafetyTmpFallback` double-fault fallback into
`mergeTokenIntoPendingEntries`'s write-failure branch (re-point via `replaceEntryEverywhere`, push the
pending record at the safety-tmp's basename, sweep `base.sourceFile` via
`sweepOwnLatchFileUnlessOwnedElsewhere`) DOES close the first regression — verified via negative-control,
both the new dedicated test and the existing `2dd97aaa-item3`/`028837ad` scenarios went GREEN with no
duplicate entry and no lost token for THAT specific shape (a second raise's own token).

It initially appeared to open a THIRD, worse shape: `merge-quarantine-raise-protect-failure.mjs`'s
`6451a749-inmemory` (and presumably its `-collision` sibling) scenario — unrelated to 59e758e5/7845ae33,
from a SEPARATE card (6451a749) that fixed a different fail-open in `protectOccupantContentBeforeDelete` —
appeared to show a PRE-EXISTING token (`"current-token"`, discovered via a degraded-occupant record at a
THIRD repo's own final path) getting SILENTLY DROPPED once the fallback relocates D's own pending record to
an unpredictable `<hash>.json.tmp-safety-<pid>-<hex>` filename.

**⛔ RETRACTED (card 4be98ac8, worker 231dbd33's repro on main `f0ecac58`, gen 457, 2026-11-02): that "silent
drop" claim was wrong.** It was derived from reading only the single `activeMergeQuarantineFor()` view. The
real mechanism, confirmed via a dedicated hermetic repro using `divertRaiseEntry`'s own already-shipped
fallback (no code change needed to reproduce it — this is a LIVE, PRE-EXISTING shape today): when
`protectOccupantContentBeforeDelete`'s strict `sourceFile === filename` match misses the relocated record,
it does NOT drop the degraded occupant's token — it MINTS A SECOND, independent pending record for the same
identity at the deterministic `pending-<hash>.json` name, holding that token. That is a SPLIT, not a loss,
and it is FAIL-CLOSED: after clearing every token on the (now-split-off) FIRST record, the identity is still
blocked by the SECOND one. Reading only `activeMergeQuarantineFor()` — which surfaces a single record — is
what made the split look like a drop.

**Root cause (still accurate as a mechanism description, only the CONSEQUENCE above was wrong):**
`protectOccupantContentBeforeDelete`'s own `atFilenameIdx`/`atFinalBasenameIdx` matching (the mechanism
that unions a degraded occupant's on-disk tokens INTO whatever record already represents that identity) is
a STRICT `p.sourceFile === filename` check — it does not consult `orphanLatchFiles`, so it cannot find a
pending record that has been relocated to a safety-tmp, even though that record's own `orphanLatchFiles`
correctly lists the ORIGINAL (now-swept) filename as a cross-reference. When the lookup misses, the
degraded occupant's own tokens are unioned into a freshly-minted sibling record instead of the one that
already represents the identity — a split, tracked separately as card 4be98ac8 (downgraded to p3: hygiene,
not a safety defect, since the identity stays correctly blocked either way).

**This gap is PRE-EXISTING in `divertRaiseEntry`'s own already-shipped fallback too**, confirmed by the same
repro — it relocates to the exact same kind of unpredictable safety-tmp name, and nothing in
`protectOccupantContentBeforeDelete` treats that caller any differently. `mergeTokenIntoPendingEntries`
gaining the same fallback (this card) only widens the trigger shape's entry point (ordinary repeated raises
on an unresolvable identity, instead of only the rarer existing-raise-diverts path); it does not introduce a
new class of defect.

## B1 (Code Review round 1, CRITICAL): a THIRD fault reopened the exact fail-open this card exists to close

`mergeTokenIntoPendingEntries`'s own safety-tmp fallback (above) closes the DOUBLE fault (rename fails,
fallback succeeds). A reviewer's own probe found a genuine, measured TRIPLE fault — the rename AND the
fallback's own `.tmp-safety-...` write ALSO failing (e.g. ENOSPC) — still lost data at commits
`9eb54fef`/`32f32040`: `writePendingDivertFile`'s own catch path (0a9fc7fc's unconditional unlink)
deleted the stranded tmp — the ONLY durable copy of the token(s) left anywhere — before ANY caller's own
fallback could even be attempted. Measured: (A) a second raise's own newly-added token was lost on
reboot; (B) a first raise's own entire identity went fully UNBLOCKED on reboot (the worse of the two). A
pre-0a9fc7fc control (never unlinking at all) kept both armed as a fail-closed duplicate — proving the
unlink itself, not the fallback, was the defect.

**THE FIX (B1, round 1):** `writePendingDivertFile` no longer unlinks its own stranded tmp at all — it
returns `strandedTmp` on failure and lets the CALLER decide. The rule AS FIRST STATED here: **a RAISE
caller (mintPendingDivert, divertRaiseEntry, mergeTokenIntoPendingEntries) unlinks the stranded tmp ONLY
after its OWN safety-tmp fallback succeeds** (the tmp is then pure redundant duplicate content, safe to
remove); **on a genuine triple fault (the fallback ALSO fails), it KEEPS the tmp** — the same fail-closed
duplicate shape this call had before 0a9fc7fc, recovered by boot's own pre-existing tmp-recovery pass.
Round 1 ALSO claimed every non-raise (narrowing/clear) call site's own immediate unlink was safe because
its content was a strict SUBSET of what's already durable elsewhere, "verified per call site."

**⛔ THAT "verified per call site" claim was FALSE — see round 3 below (CR round 2, reviewer 6aee1d61).**
The surviving rule, replacing it: **a stranded tmp may be unlinked ONLY where the caller has actually
PROVEN its own content is secured elsewhere — never from the shape of the call site alone.** Today that is
true for exactly the 3 raise callers, exactly at the point their own safety-tmp fallback has JUST
succeeded (round 1's B1 rule above, which stands). At every OTHER site — six of them, enumerated in round
3 — the tmp is now kept unconditionally, exactly as main did before `0a9fc7fc`, and recovered the same way
every triple-fault duplicate is: by boot's own tmp-recovery pass.

## Round 3 (CR round 2, reviewer 6aee1d61, 2026-11-02): the "strict subset" claim was false at two shapes

The reviewer's own probes (probe6, probe8) found the round-1 "strict SUBSET of durable state elsewhere"
reasoning was FALSE BY CONTENT at two of the six non-raise sites, each turning main's fail-closed
duplicate into a fail-open loss:

1. **`protectOccupantContentBeforeDelete`'s own double-fault unlink.** `toWrite` unions the in-memory
   record at `atFilenameIdx`, which can hold a MEMORY-ONLY token (an earlier raise whose own primary write
   AND safety-tmp fallback both failed — see the "6451a749-inmemory" shape above). `final`'s own on-disk
   bytes never received that token, so "already fully duplicated at final" was false for it. Measured: a
   second raise's own memory-only token was durably lost on reboot with the unlink; kept (and re-armed as
   a fail-closed duplicate) without it.
2. **The narrowing sites reached through a REDIRECTED write.** `writePendingDivertFile`'s own
   `keptUnreadable` branch can redirect a write to an unpredictable `-collision-<hex>` filename instead of
   the caller's own `filename`/`sourceFile` — when it does, the UNTOUCHED original file does NOT hold the
   narrowed-down content at all (it holds a DIFFERENT identity's content, which is WHY it was marked
   unreadable in the first place). Unlinking the stranded tmp from that redirected write loses the
   narrowed tokens outright. Measured via probe6: a repo wrongly fully unblocked on reboot with the unlink;
   correctly stayed blocked (one outstanding token, fail-closed) without it.

**THE FIX (round 3):** delete the immediate unlink at ALL SIX non-raise sites — never reason per-site
about whether a particular call's own content happens to be a safe subset; the round-1 "verified per call
site" exercise missed exactly these two. The six sites: `consumeMatchedPendingsIntoArmedEntry`'s own
foreign-group union; `protectOccupantContentBeforeDelete`'s own double-fault branch;
`rewriteOrphanLatchFilesAfterPartialClear`; `clearTokenFromPendingIndices`; `clearActiveEntryTokenAtKey`;
and the `clearMergeQuarantineByKey` tied-twin write. Each now keeps its stranded tmp exactly as main did
before `0a9fc7fc` — boot's own tmp-recovery pass re-arms it as a fail-closed duplicate, never a loss.

Test coverage: `merge-quarantine-59e758e5-protect-double-fault-tmp-loss.mjs` (finding 1, probe8's shape)
and `merge-quarantine-59e758e5-narrowing-redirect-tmp-loss.mjs` (finding 2, probe6's shape), both
negative-controlled against `699d1f61` (RED there, GREEN after this round). A third scenario,
`merge-quarantine-59e758e5-triple-fault-no-loss.mjs`'s "tf-c", closes a SEPARATE coverage gap the reviewer
found via mutation testing (probe10): none of the 13 pre-existing test files caught a reintroduced unlink
in `divertRaiseEntry`'s own matched-indices triple-fault branch (the ONE non-raise-caller-shaped site that
is actually one of the 3 raise callers, just reached via its matched-record path rather than its
mint-fresh path). Proven RED→GREEN by directly reintroducing that exact mutant.

**Residual, narrowed (was "never fails open" at round 1 — that overstated it, and was narrowed WRONG at
round 3 too — see below):** an OPEN-failure triple fault — every `.tmp-` open for the raise's own
primary write ALSO failing (not just a rename or the safety-tmp fallback's own open; no tmp is ever
created at all) — still loses that raise's token outright, on a repoPath's first-ever raise OR a later
one on top of an already-clean record: either way nothing durable was ever written anywhere for boot's
own tmp-recovery pass to find. Measured by the reviewer on `c56f8d9b`: raise `d` (t1, clean), then raise
t2 with every `.tmp-` open failing; after a reboot t1 is armed and t2 is not, so clearing t1 leaves `d`
unblocked while t2's merge is still outstanding — a lost token on a SECOND raise, not a first-ever one.
This is PRE-EXISTING and INHERENT to a write that creates no tmp at all, not a regression this card
introduced or could close. `merge-quarantine-59e758e5-triple-fault-no-loss.mjs` does NOT reproduce this
shape — its scenarios all fault the RENAME step, after a real tmp has already been written, and its own
scenario B in fact asserts the opposite: that a first-ever raise's token SURVIVES that (rename-fault)
triple fault.

## Status: LANDED (rounds 1-3)

Never fails open on a RENAME-fault double or triple fault, first-ever raise or later. The OPEN-failure
residual named just above — any triple fault where no tmp is ever created, on ANY raise — is accepted
and documented, not closed.

`mergeTokenIntoPendingEntries`'s write-failure branch mirrors `divertRaiseEntry`'s own
`attemptDivertSafetyTmpFallback` double-fault fallback exactly (re-point via `replaceEntryEverywhere`, push
the pending record at the safety-tmp's basename, sweep `base.sourceFile` via
`sweepOwnLatchFileUnlessOwnedElsewhere`), AND (B1, round 1) `writePendingDivertFile` itself never unlinks a
stranded tmp before something durable supersedes it, AND (round 3) every non-raise site stopped unlinking
unconditionally too. Manager decision (gen 458, 2026-11-02): land 59e758e5's unlink and 7845ae33's fallback
TOGETHER, in one branch/merge — the combined change goes from a duplicate (fail-closed, the unlink-alone
shape) to a possible split (fail-closed, card 4be98ac8's tracked residual) and never fails open on a
second-or-later raise/clear — true of the double fault from the start, and now true of the triple fault
too, since B1 and round 3 closed it. Card 4be98ac8 stays open as a separate, later p3 hygiene follow-up; it
is not a blocker for this change.

## Test-coverage ripple (landed alongside the fallback, commit `9eb54fef`)

Besides restoring `2dd97aaa-item3`'s own "t2 survives the reboot" assertion (now via a tracked,
self-referenced safety-tmp, with an added content-level cross-check reading every file in
`MERGE_QUARANTINE_DIR` directly rather than only the in-memory view) and adding a dedicated polarity test
(`merge-quarantine-7845ae33-relocated-record-polarity.mjs`, covering exactly the split shape this record's
own "4be98ac8" section above documents, in-process and across a reboot), three MORE pre-existing test
files broke on this change and needed updating, none named in the original card bodies:

- `merge-quarantine-59e758e5-pending-divert-tmp-unlink.mjs` (the unlink test itself) — its own "the
  original on-disk record is untouched" assertion no longer holds; it's now relocated, not left stale.
- `merge-quarantine-028837ad-pending-arm-mid-clearbytoken.mjs`'s `eperm-union`/`multi-eperm` scenarios —
  both forced the SAME write failure this card's fallback now intercepts; their own "disk still names
  ONLY the original token" preconditions had to be re-pointed at the relocated sourceFile instead.
- `merge-quarantine-raise-protect-failure.mjs`'s `6451a749-inmemory`/`-inmemory-collision` scenarios (the
  REAL scenarios this record's own "4be98ac8" section above refers to) and
  `f00e9de8-dropped-tokens-finalbasename-only`.

**The `f00e9de8-dropped-tokens-finalbasename-only` scenario is worth flagging specifically — it is NOT
just a re-pointed assertion, it is a genuine BEHAVIOR IMPROVEMENT for that one trigger shape.** That
scenario exercises card f00e9de8's own documented, accepted residual: `protectOccupantContentBeforeDelete`'s
`atFinalBasenameIdx`-only branch silently drops an in-memory-only token (with a warning) when the twin's
own physical backing file is genuinely stale. In this scenario, that twin's own physical backing file
HAPPENS to be the exact file `mergeTokenIntoPendingEntries`'s own write targets (`base.sourceFile ===
<Krhash>.json`) — so this card's own fallback now secures the twin's full token set (via a relocated
safety-tmp) and SWEEPS that file BEFORE the later raise that used to discover it stale ever runs. That
later raise now finds `final` simply MISSING (ENOENT, "nothing to protect") and never reaches the
`atFinalBasenameIdx`-only branch at all — confirmed empirically: no warning fires, and NEITHER token is
lost. **The underlying `atFinalBasenameIdx`-only branch itself is UNCHANGED** and remains the documented
accepted residual (see `docs/decisions/f00e9de8-*.md`) for any OTHER trigger that leaves a genuinely stale
`final` without going through this card's own fallback (e.g. a pre-existing stale file never produced by
a live raise in this same process) — this one specific trigger shape just can no longer construct that
precondition any more.

## Test-coverage ripple, round 2 (B1-B5, same Code Review round 1)

Fixing B1 forced a full double-vs-triple-fault audit of every test built atop the round-1 (double-fault)
fallback shape. Several scenarios in `merge-quarantine-raise-protect-failure.mjs` and
`merge-quarantine-028837ad-pending-arm-mid-clearbytoken.mjs` had used a mere DOUBLE fault (rename fails,
fallback succeeds) to construct a "memory outran disk" precondition — once the fallback reliably secures
content elsewhere (round 1's own fix), that precondition no longer arises via a double fault at all, so
these scenarios went vacuous. Converted each to a genuine TRIPLE fault (rename AND the fallback's own
`.tmp-safety-...` write both failing) to restore the ORIGINAL precondition each was built to prove:
`6451a749-inmemory`/`-inmemory-collision`, the `eperm-union`/`multi-eperm` scenarios, and (adding a
dedicated new scenario, since the existing one now correctly shows the IMPROVED no-loss behavior for a
double fault specifically) `f00e9de8-dropped-tokens-finalbasename-only-triple-fault`. The `multi-eperm`
scenario's own final reboot check also needed correcting to its own true, accepted outcome: B1's "keep
the tmp on a triple fault" rule means a stale, pre-clear snapshot CAN re-arm a legitimately-already-lifted
identity as a fail-closed duplicate on a later boot — over-blocking, never a loss, and itself recoverable
by clearing that duplicate's own tokens too.

Separately, the new `merge-quarantine-7845ae33-relocated-record-polarity.mjs` test's own "d STILL
blocked" polarity checks were vacuous for an unrelated reason (B5): `r`'s own active quarantine shares
`d`'s own walked-up degraded key, so leaving `r`'s token outstanding keeps `d` reading blocked regardless
of what happens to `d`'s own two split records — clear `r`'s own token FIRST, before the partial clear,
so the check actually exercises `d`'s own split-off record.

New dedicated triple-fault test: `merge-quarantine-59e758e5-triple-fault-no-loss.mjs` — reproduces both
measured shapes (A: a second raise; B: a first-ever raise) under a genuine triple fault, plus the
reviewer's own pre-unlink control (unlinking suppressed entirely, standing in for pre-0a9fc7fc code) to
confirm the no-loss outcome is genuinely reachable by "never unlink first," not an artifact of the
control's own construction.

## Do not

- Do not treat a predecessor's "silent drop" finding (or any claim read off a single
  `activeMergeQuarantineFor()` call) as proof of a fail-open without ALSO reading every pending record by
  content — a split (a second record holding the same token) looks identical to a drop through that one
  narrow view.
- Do not treat `divertRaiseEntry`'s own existing fallback as risk-free just because it shipped first — it
  has the SAME `atFilenameIdx`/`atFinalBasenameIdx` matching gap as the fallback added here; it is simply
  tracked (card 4be98ac8) as a fail-closed split, not a reason to withhold either fallback.
- Do not fix card 4be98ac8 by matching via a bare `orphanLatchFiles` cross-reference — forbidden by
  decision 9cabd143 (see that card's own triage note for the fix candidates actually under consideration).
- Do not unlink a stranded tmp (or relocate a record to an unpredictable filename for any reason) without
  checking EVERY caller of the function being fixed, AND every OTHER subsystem that looks up a pending
  record by its deterministic filename rather than by identity — removing one fail-open can open another
  one, even a fail-closed one worth tracking, in a totally different, seemingly unrelated subsystem.
- Do not treat "the existing test now fails" as proof the test is stale — negative-control it against the
  exact pre-fix sha first (not just HEAD) to prove the behavior genuinely changed, then decide whether the
  new behavior is correct or a regression.
- **(B1)** Do not let `writePendingDivertFile` unlink its own stranded tmp internally, ever again — the
  caller alone knows whether its own fallback secured the content elsewhere. A DOUBLE fault (fallback
  succeeds) unlinks only AFTER that success; a TRIPLE fault (fallback also fails) KEEPS the tmp — never
  unlink it "to be tidy," or the ONLY durable copy left anywhere is gone before anything could recover it.
- **(B1, SUPERSEDED by round 3)** Do not assume a NEW caller of `writePendingDivertFile` may unlink its
  own `strandedTmp` immediately just because "most callers do," OR because you have personally reasoned
  that this one site's content happens to be a safe subset — round 1's own "verified per call site" claim
  was wrong at TWO of the six non-raise sites (round 3 below). Unlink ONLY at one of the 3 raise callers,
  only after that caller's own safety-tmp fallback has just succeeded. Every other site keeps the tmp,
  unconditionally, no per-site exception.
- **(B3/B4)** Do not construct a "memory outran disk" test precondition via a mere double fault once a
  write path has its own safety-tmp fallback — the fallback closes that gap. Use a genuine triple fault
  (also fail the `.tmp-safety-...` open) to restore the staleness a scenario actually needs.
- **(B5)** Do not check "identity X is still blocked" as a polarity claim without first clearing every
  OTHER identity's own token that could independently keep X's canonical key blocked (e.g. a resolvable
  container repo sharing X's own walked-up degraded key) — such a check can pass vacuously forever.
- **(Round 3)** Do not reason per-site about whether a non-raise caller's own stranded tmp is a "safe
  subset" of durable state elsewhere, however plausible that reasoning looks — `protectOccupantContentBeforeDelete`'s
  own double-fault branch and every narrowing site reached through a REDIRECTED (`keptUnreadable`/
  `-collision-`) write both looked safe under that reasoning and were FALSE BY CONTENT. Keep the tmp at
  every non-raise site, full stop; let boot's own tmp-recovery pass re-arm it as a fail-closed duplicate.
- **(Round 3)** Do not call `activeMergeQuarantineFor`, `assertRepoNotQuarantined`, or any other
  resolve-aware query reaching the same `resolveQuarantineFor` "lazy re-resolve on first query"
  chokepoint, between an injected write failure or a clear and a later durable assertion in a test — on
  a VERIFIED repoPath, that query durably self-heals the pending record as a side effect of being asked,
  masking the exact loss (or exact split/duplicate) the test exists to prove. This applies to ANY action
  under test, not just a raise — a CLEAR followed by a durable assertion is reached the same way. Use a
  content-level disk read (`readdirSync` + `JSON.parse` by `repoPath`) for an in-process precondition,
  or the non-healing `stillBlockedEntryFor` (a pure peek) instead.

Full regression finding, reproductions, and verification detail: see board cards 59e758e5 (absorbing
7845ae33) and 4be98ac8, and the worker reports on them.
