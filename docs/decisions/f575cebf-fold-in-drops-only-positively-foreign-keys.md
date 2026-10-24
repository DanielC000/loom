# f575cebf — reconcileMarkedBasenameBeforeWrite's fold-in drops only a POSITIVELY FOREIGN newly-folded key, never a merely unprovable one

From `d69a6744`'s own deliberately-left-open residual: `writeMergeQuarantineLatch`'s retention union
(`unionResolvedKeysRetaining(entry.resolvedKeys, freshSecondaryKeys, ...)`) retains `entry.resolvedKeys`
FOREVER, by design (the union-never-drop rule of `8db913e2`/`43cf3b26`). `d69a6744` correctly filtered
the SECOND argument (`freshSecondaryKeys`) through live-occupancy ownership, but `entry.resolvedKeys`
itself (the FIRST, unfiltered argument) can already be contaminated with a FOREIGN key if an EARLIER
write persisted one AND `reconcileMarkedBasenameBeforeWrite`'s own fold-in (card `150aed7b`) later folds
that bad on-disk value back into memory — completely bypassing `d69a6744`'s filter, which never gets a
say over content that entered via the FIRST argument.

## Investigation (worker_report blocked, Lead ruling obtained)

Constructed hermetically end to end: a pre-existing contaminated on-disk latch for repo Y
(`resolvedKeys:[kY, kF]`, `kF` belonging to a separate, real, currently-ARMED repo F) → a transient
EACCES during a clear evicts Y's in-memory entry while keeping the file on disk, marking its basename
`keptUnreadableLatchFiles` (same technique as `150aed7b`'s own test) → a fresh raise on Y reaches
`writeMergeQuarantineLatch`'s chokepoint, triggering `reconcileMarkedBasenameBeforeWrite`, which folded
`kF` into `entry.resolvedKeys` UNCONDITIONALLY — persisting it to disk despite `d69a6744`'s
`freshSecondaryKeys` (computed from this fresh raise's empty live `armedKeys`) being empty. On the next
reboot, PASS 1's own boot-time union (`armKeyUnlessDegradedCollision`'s "legitimate same-toplevel union"
fallthrough, which has NO identity check when both colliding sides are resolvable) merged Y's and F's
quarantines into ONE entry object occupying both keys: Y's own identity/branch/reason was replaced by
F's (F being older by `enteredAt`), F's tokens were contaminated with Y's, and — the real operational
consequence — F's own human clearing F's own, only-ever-legitimate token left F WRONGLY STILL BLOCKED,
stranded by Y's foreign tokens it never owned.

This ALSO confirmed the card's second question (the "upgrade case"): the boot-time union above has no
dependency on the fold-in at all — a latch already contaminated on disk before this session (a real
pre-`d69a6744` write, or any other historical corruption) reaches the identical fail-open on its very
next reboot with zero other action. Write-time filtering (below) prevents NEW contamination from
entering `resolvedKeys`, but cannot retroactively protect an already-contaminated disk file — PASS 1
would still union it the same way. **That upgrade case is filed as a SEPARATE card by the Lead — `e7652e06`, "fix(git): stop boot re-arm
merging two distinct repos through a contaminated latch resolvedKey" — not this card's scope, and
stays open.**

## The fix (Lead ruling)

`reconcileMarkedBasenameBeforeWrite` now filters every newly-folded on-disk key — both the whole-record
reingest branch and the generic resurrect branch — through `positivelyForeignKey(key, entry,
ownershipMap)` BEFORE it is ever unioned into `entry.resolvedKeys`. A key is dropped ONLY when the live
map holds an occupant at that key whose `directPathIdentity` differs from this entry's own — i.e. a key
PROVEN to belong to another repo right now. An EMPTY slot, or a same-identity occupant, both survive the
filter unchanged.

**Why this is NOT a plain `entryStillOwnsKey` filter (the Lead's explicit correction):** `entryStillOwnsKey`
treats an empty slot as "not provably owned" (`false`) — the WRONG polarity here. An entry freshly evicted
by the `150aed7b` EACCES-during-clear path has nothing armed yet, so a LEGITIMATE secondary's own slot
reads empty too at fold time; filtering on `entryStillOwnsKey` would drop that legitimate secondary,
which is a fail-open in the OTHER direction (the entry never re-arms there after reboot).
`positivelyForeignKey` only ever drops a key POSITIVELY proven foreign — never one merely unprovable —
so it keeps the union-never-drop rule intact: it drops only a key proven to belong to another repo right
now, never a key merely because its ownership can't currently be proven.

`ownershipMap` is a new REQUIRED parameter on `reconcileMarkedBasenameBeforeWrite` and
`foldInOnDiskTokensIfMarked` (same precedent as `58957b1e`'s `droppedTokens` and `d69a6744`'s own
`writeMergeQuarantineLatch` parameter of the same name) — every one of its 5 call sites now passes it
explicitly: 3 runtime callers (`consumeMatchedPendingsIntoArmedEntry`, and both branches of
`enterMergeQuarantine`) pass `activeQuarantines` directly; the ONE call INSIDE `writeMergeQuarantineLatch`
itself (~:1409) forwards whatever `ownershipMap` ITS OWN caller already threaded in (so it reads
`activeQuarantines` for every runtime write and `byRepoKey` for the boot-time one below, never a literal
of its own); the ONE boot-time caller (`bootWriteLatch`, inside `reenterMergeQuarantinesAtBootImpl`) passes
its own closure-captured `byRepoKey`, never the stale module-global default, for the exact reason
`d69a6744`'s own "Do not" section states for `writeMergeQuarantineLatch`'s `ownershipMap`.

## Accepted residual (documented, not closed here)

`positivelyForeignKey` only ever reads the live `activeQuarantines`-shaped map it's given — it proves
nothing about a key whose true occupant lives OUTSIDE that map, or whose occupant's OWN identity is
itself already wrong. Three shapes slip through, named here rather than widened against:

1. **An EMPTY slot** (the foreign repo never raised, or was already cleared) — the committed test's own
   `accepted-residual-foreign-key-with-empty-slot` scenario reproduces this one directly.
2. **F is live but PENDING** (degraded-diverted, unreadable-diverted, or not yet graduated into
   `activeQuarantines`) — `positivelyForeignKey` never consults `pendingUnresolvedQuarantines` at all, so
   a pending-tier F is just as invisible to it as an empty slot; the key survives the filter.
   **Closed — but AT BOOT, not here (`e7652e06`, see "Do not" below): `e7652e06`'s own boot-time
   mechanism — freshness (`isKeyVerifiedFor(prior.repoPath, key)`, checked against `prior`'s repoPath
   directly, never against whether `prior` has a live `byRepoKey` entry at fold time) for the plain
   same-boot case, or `provenanceUnknown` marking (Round 3) when a third, ghost party reaches the
   collision first — makes the NEXT boot converge correctly regardless of whether F's own real latch or
   Y's contaminated secondary is read first. F "merely pending" when Y's contamination was folded in no
   longer matters once any boot runs, either way.**
3. **The slot already holds a PASS1-merged union whose winning identity is Y itself** (an earlier
   boot-time union already re-pointed the occupant's own `repoPath` to Y, not F) — `positivelyForeignKey`
   correctly reads this as "same identity", because BY THE TIME it looks, the contamination has already
   rewritten what "same identity" means at that key. **Not closed — this is exactly the PASS1 "upgrade
   case" `e7652e06` fixes going FORWARD (a NEW such union can no longer form), but it does not retroactively
   repair one that already formed before `e7652e06` landed.**

This is not "no live signal exists" for shape 1 — it is **no signal this card adopts** there. Shape 2 is
closed structurally, at a different chokepoint, by `e7652e06` (see above) — **`positivelyForeignKey`
itself was deliberately NOT widened to cover it**, by Lead ruling: fold time has no tautological-primary
concept at all (it only ever deals with secondary candidates being retained), which is exactly the input
`e7652e06`'s own discriminator needs and this chokepoint never has — see that record's own "Shared
predicate with fold time" section for why unifying the two would either add a boot-only input here for no
fold-time benefit, or weaken boot's own discriminator and reopen a real regression. Shape 1 (empty slot)
and shape 3 (an already-wrong winning identity) remain genuinely open, named rather than silently assumed
closed — `e7652e06`'s own record states the same boundary from its own side.

## Do not

- Do not filter the newly-folded on-disk keys through `entryStillOwnsKey` — it treats an empty slot as
  unowned, which drops a legitimate secondary whose entry was just evicted (nothing armed yet) and is a
  fail-open in the OTHER direction. Use `positivelyForeignKey` (drop ONLY a key with a live,
  different-identity occupant) instead.
- Do not widen `positivelyForeignKey` to try to catch any of the three accepted-residual shapes above —
  `e7652e06` considered exactly this TWICE (the triage note that opened it, then again when its own
  Round-3 fix was being chosen) and REJECTED it by Lead ruling both times: it regresses the
  `883e29bc`/`9a55fb90` same-toplevel-union precedent at boot time. Shape 2 is closed at a DIFFERENT
  chokepoint instead (`e7652e06`'s own boot-time mechanism — freshness for the plain case,
  `provenanceUnknown` marking for a ghost-interfered one); shapes 1 and 3 stay open, by design, on both
  records.
- Do not pass `activeQuarantines` as `foldInOnDiskTokensIfMarked`'s/`reconcileMarkedBasenameBeforeWrite`'s
  `ownershipMap` from inside `reenterMergeQuarantinesAtBootImpl`'s `bootWriteLatch` closure — it is
  structurally stale there (not synced into `activeQuarantines` until the whole boot function's
  end-of-function loop runs); pass `byRepoKey` instead.
- This card alone does NOT close the PASS1 "upgrade case" — a latch already contaminated on disk before
  any fold-in ever runs was unioned by `armKeyUnlessDegradedCollision`'s own "legitimate same-toplevel
  union" fallthrough, independent of how the contamination got there. **That case IS now closed, but by
  `e7652e06`'s freshness discriminator landing in `armKeyUnlessDegradedCollision` itself — not by anything
  in this card.** See `docs/decisions/e7652e06-boot-freshness-not-resolvability-parity.md`.

## Verification

- `packages/daemon/test/merge-quarantine-f575cebf-resolvedkeys-fold-filter.mjs` — four scenarios. Only
  `fold-filter-closes-foreign-key` discriminates the negative-control below (RED at this card's true
  parent, GREEN after) — it is the one scenario asserting the NEW, fixed behavior (the parent's
  pre-filter code unconditionally retains the foreign key, so asserting it's gone is what actually fails
  there). The other three are GREEN on BOTH sides of that same revert, by design: they either pin
  behaviour the union-never-drop retention already provided before this card (no foreign-key filtering at
  all existed yet, so nothing was ever dropped), or document a residual that is equally present (if
  anything, more so) on the unfiltered parent code.
  - `fold-filter-closes-foreign-key`: the full propagation path above, now asserting the fixed polarity —
    Y's written record no longer carries `kF`; Y and F stay two distinct entries after reboot; F carries
    none of Y's tokens; F unblocks cleanly by clearing its own token; Y stays blocked throughout.
  - `fold-filter-keeps-empty-slot-secondary`: a legitimate secondary `kS` whose slot is empty at fold time
    survives the filter, and Y re-arms at `kS` after reboot.
  - `fold-filter-keeps-same-identity-different-object-secondary` (Code Review SF1): a legitimate secondary
    `kS` occupied by a DIFFERENT object sharing Y's own identity (not Y's own object) survives the filter.
    Proven to actually discriminate a real mutant (`occupant !== entry`, object identity, in place of
    `directPathIdentity`) — applied by hand, rebuilt, re-run: exactly this scenario's 2 checks go RED
    while every other scenario in the file stays unchanged; reverted and rebuilt clean afterward. Neither
    of the two scenarios above this one can discriminate that same mutant — their own kept secondary is
    EITHER on an empty slot (`occupant` is `undefined`, so the comparison never runs) or already present
    in `entry.resolvedKeys` BEFORE the fold ever runs (the existing-raise branch inherits it from
    `existing` via the object spread, so the union-never-drop retention masks whatever the filter
    computes) — this scenario is the one case where the filter's own decision is the ONLY source of the
    key, which is what makes it discriminating.
  - `accepted-residual-foreign-key-with-empty-slot`: documents, rather than closes, residual shape 1 from
    the "Accepted residual" section above.
- RED/GREEN via `pnpm --filter @loom/daemon negative-control --file packages/daemon/src/git/merge-quarantine.ts
  --test packages/daemon/test/merge-quarantine-f575cebf-resolvedkeys-fold-filter.mjs` (default `--ref HEAD`,
  this card's true parent) — confirmed RED on the pre-fix code, GREEN after, byte-identical tree restore.
- Full `merge-quarantine*.mjs` corpus (70 files), individually, fresh `LOOM_HOME` per file, both env states
  (`env -u LOOM_DEV -u LOOM_SUPERVISED` / `LOOM_DEV=1 LOOM_SUPERVISED=1`), one lane: 70/70 pass in both.
- `pnpm --filter @loom/daemon guards`, committed first.
