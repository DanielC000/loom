# 9c3b023a — strip migrated siblings' own orphan refs on an unmarked PASS1 migrate

From `4e987303`'s CR3 (session `d3a1a5b9`), confirmed by a hermetic repro before any production code was
touched.

## The class

`reenterMergeQuarantinesAtBoot`'s PASS1-migrate read loop (`merge-quarantine.ts` ~:8458, `@decision
a6fa60e2`) strips a stale source `f`'s own SELF-reference from `entry.orphanLatchFiles` — it checks
`entry.orphanLatchFiles?.includes(f)` for the SAME `f` currently being read. It never strips a SIBLING
migrating source's filename that a DIFFERENT source's entry cross-lists in its own `orphanLatchFiles`
(e.g. folded in earlier by some other process). `unionQuarantineEntries` ORs `orphanLatchFiles` from both
sides unconditionally when the two sources collapse onto the same canonical key (`migratedSourcesByKey`),
so the cross-listed sibling's name survives into the in-memory union untouched.

`4e987303`'s own round-3 M1 fix added a `dropped: DroppedSets` backstop
(`bootWriteLatch(key, unionEntry, { ...NO_DROPS, orphanLatchFiles: new Set(sources) })`, PHASE 1a,
~:9367) intended to subtract every migrated `sources` member from `orphanLatchFiles` before persisting.
But `dropped` is consulted ONLY inside `writeMergeQuarantineLatch`'s MARKED reconcile branch
(`!reconciledAlready && keptUnreadableLatchFiles.has(targetBasename)`, ~:2062) — every single
`dropped.tokens`/`dropped.orphanLatchFiles`/`dropped.contributorRepoPaths` read in the whole file lives
inside `reconcileMarkedBasenameBeforeWrite`'s two branches (verified by grep: zero other consumers). So
the M1 backstop is a complete no-op whenever the target basename is NOT in `keptUnreadableLatchFiles` —
i.e. the common case of a brand-new fresh-hash target with no pre-existing read failure. On that path the
persisted final still lists the deleted sibling's basename in `orphanLatchFiles`, a dangling reference to
a file PHASE 3 is about to unlink.

## Confirmed by repro (investigate-first checkpoint)

Two subdirs of one physical repo (teamA/teamB, same canonical key K), each with a stale-keyed latch file.
teamA's own entry cross-lists teamB's own 24-hex basename in `orphanLatchFiles`. Both migrate to the same
fresh-hash target, which has no pre-existing final (necessarily UNMARKED). After boot:

- The persisted final's own `orphanLatchFiles` still listed teamB's (now-deleted) basename.
- The in-memory union entry carried the identical dangling reference.
- `clearMergeQuarantineLatchFile(<teamB's freed 24-hex id>)` returned `{ok:true, latchKept:true,
  referencingRepoPaths:["...teamA"]}` — falsely reporting the freed id as still "kept"/referenced by
  teamA, via the dangling cross-reference alone, even though nothing legitimately references it anymore.

## The fix

PHASE 1a (~:9359) now strips every member of `sources` from the LIVE union entry's own
`orphanLatchFiles` directly, caller-side, before calling `bootWriteLatch` — mirroring
`consumeMatchedPendingsIntoArmedEntry`'s own `be79f4d5` strip (which already strips ALL matched
`sourceFiles` from its entry before writing, not just self). `replaceEntryEverywhere` re-points
`byRepoKey` so memory and disk agree. The existing `{ ...NO_DROPS, orphanLatchFiles: new Set(sources) }`
passed to `bootWriteLatch` is left unchanged — it remains the correct backstop for the MARKED case, where
a reconcile-from-disk union could independently re-introduce one of `sources`.

## Ordering analysis — PHASE 1a writes BEFORE PHASE 3 deletes (Lead-requested, before closing this card)

PHASE 1a's strip is OPTIMISTIC: it removes a `sources` member from `orphanLatchFiles` before PHASE 3 has
actually attempted to delete that file. If PHASE 3's own `deleteSourceLatchIfSuperseded` call for one of
`sources` genuinely FAILS (the file stays on disk), does the now-unreferenced survivor become an
unprotected orphan, or get misattributed on a later boot?

**Mostly — by a PRE-EXISTING mechanism `c870618c` added for a different reason — but with one accepted,
fail-closed residual, named explicitly below rather than claimed away.** PHASE 3 (per `4e987303` round-3
m3) reads `byRepoKey.get(key)` LIVE, never a PHASE-1a-stored snapshot — so it sees the ALREADY-stripped
union this fix produces. On a genuine delete failure, PHASE 3's own `c870618c` fold-on-failed-unlink
logic (~:9538-9544) pushes the failed filename into `failedToDelete` and folds it BACK into
`orphanLatchFiles` before re-persisting:
```
const folded = { ...unionEntry, orphanLatchFiles: [...new Set([...(unionEntry.orphanLatchFiles ?? []), ...failedToDelete])] };
replaceEntryEverywhere(byRepoKey, unionEntry, folded);
bootWriteLatch(key, folded, NO_DROPS);
```
`replaceEntryEverywhere` runs UNCONDITIONALLY — memory always ends up holding `folded` (the reference
re-added), regardless of whether the following `bootWriteLatch(key, folded, NO_DROPS)` call itself
succeeds.

**The double-failure shape (named, not hidden):** if BOTH the unlink AND this re-persist fail (two
independent I/O failures in the same pass), the DISK final is left as PHASE 1a wrote it — missing the
reference — while MEMORY correctly carries it (via the unconditional `replaceEntryEverywhere` above).
This is a genuine, if narrow, disk/memory disagreement, not a claim that it cannot happen. It is still
fail-closed, for two reasons: (1) any `/clear` or clear-by-id issued in THIS running process reads the
LIVE, correct in-memory entry (`byRepoKey`/`activeQuarantines`), never the stale disk bytes, so it still
correctly finds and sweeps the file; (2) if the process restarts before any clear happens, the file is
still physically present on disk with its ORIGINAL content (the unlink never succeeded), so the next
boot's PASS 1 re-reads it from scratch exactly like any other stale latch — it either re-migrates (if its
own repoPath still resolves) or diverts to `pendingUnresolvedQuarantines` (if not). Either way it is
re-discovered, never silently lost. The only real cost of this double-failure shape is a transient window
where a tool reading the DISK FINAL directly (bypassing the daemon's own in-memory state entirely) would
not see the reference — an inherent property of this module's write-then-maybe-fail-to-repersist pattern
in general, not something this card's fix newly introduces.

**Independent of that fold, several paths keep a file on disk WITHOUT ever attempting the unlink at
all — these are what make the optimistic PHASE 1a strip defensible even before `c870618c`'s own
re-fold is considered.** `deleteSourceLatchIfSuperseded` (~:2249) checks, in order, before ever calling
`fs.unlinkSync`:
1. `sourceFile === writtenFile` — the "stale" source IS the just-written final's own name; nothing to
   delete by construction.
2. `keptUnreadableLatchFiles.has(sourceFile)` — a basename this process already failed to read once stays
   untouched.
3. `pendingUnresolvedQuarantines.some((p) => p.sourceFile === sourceFile)` — a DIFFERENT, still-pending
   entry independently owns this exact file.
4. `physicalOwnerRepoPaths(sourceFile)` (excluding the entry being written) — a DIFFERENT, currently-ACTIVE
   surviving entry now physically owns this filename (one of its own armed keys hashes to it, or it is
   that entry's own fresh write target).
Each of these returns `true` (a no-op "kept", not pushed into `failedToDelete`) WITHOUT depending on
THIS entry's own `orphanLatchFiles` at all — the file's real protection lives in its own record elsewhere
(a pending entry, or a different active entry's own armed keys), not in a cross-reference inside a
sibling's bookkeeping. `writeTargetsThisPass` (checked by PHASE 3 itself, ~:9531, before ever calling
`deleteSourceLatchIfSuperseded`) adds a fifth: never delete a source whose basename is ALSO some OTHER
key's own write target from this same pass. So stripping a `sources` member from THIS entry's
`orphanLatchFiles` never puts a still-needed file at risk — if it is still needed, one of these five
independent checks refuses the delete regardless of what this fix did to `orphanLatchFiles`; if none of
them applies and the unlink itself still fails, `c870618c`'s fold (and its one named double-failure
residual, above) is what covers it. **No second post-delete strip and no gating-on-success was
needed** — these five pre-existing protections, plus `c870618c`'s own re-fold, already cover the space.

A crash between PHASE 1a's write and PHASE 3's delete (so `sources`' own stale files are still present,
never referenced by the just-written final) is not a new hazard either: the next boot re-reads those
still-present stale files from scratch (same `freshHash !== hash` migrate path) and re-unions/re-writes
them idempotently, exactly like every other crash-mid-migrate case this function already tolerates (see
`4480b077`'s own "a later boot can retry the migration" precedent). `writeMergeQuarantineLatch` is fully
synchronous with no yield point (`4e987303`'s own "Ordering hazard — none" section), so there is no
concurrent-reader window within one boot pass between the strip and the delete attempt.

## Tests

`merge-quarantine-pass1-migrate-union.mjs` — two new scenarios:
- `unmarked-sibling-cross-ref-orphan`: the card's own repro (cross-listed 24-hex sibling, unmarked
  target) — asserts the on-disk final and the in-memory union entry both exclude the deleted sibling's
  basename, and `clearMergeQuarantineLatchFile` on the freed id returns `wasQuarantined:false` with no
  `latchKept`/`referencingRepoPaths`. ALSO cross-lists a THIRD, genuinely unrelated, never-`sources`
  basename (Z — an unresolvable repoPath with no `resolvedKey`, diverted straight to
  `pendingUnresolvedQuarantines`, never touching `migratedSourcesByKey` for this key at all) and asserts
  Z's own reference SURVIVES in both the on-disk final and the in-memory entry — the "never widen this
  strip beyond `sources`" rule below, proven by a scoped TEMPORARY over-widening (strip ALL of
  `orphanLatchFiles`, not just `sources`) that turned these two specific checks RED, restored afterward.
- `unmarked-sibling-cross-ref-failed-delete`: same cross-ref shape, PLUS an injected EBUSY on the
  cross-listed sibling's own unlink (same injection technique as `ebusy-fold-and-sweep`) — asserts the
  final still correctly references the sibling (via PHASE 3's own `c870618c` re-fold) after the failed
  delete, the file genuinely survives on disk, and a reboot-sim cleanly re-migrates/deletes it on a later
  boot with no duplicate/misattributed entry.

RED/GREEN proven via `scripts/negative-control.mjs --file packages/daemon/src/git/merge-quarantine.ts
--test packages/daemon/test/merge-quarantine-pass1-migrate-union.mjs --ref <pre-fix sha>`.

## Do not

- Do not rely on `bootWriteLatch`'s `dropped` param alone to strip a migrated source from
  `orphanLatchFiles` — it is consulted only inside `writeMergeQuarantineLatch`'s MARKED reconcile branch
  and is a no-op on an unmarked key. Strip caller-side, on the live union, before the write.
- Do not add a second, post-delete strip in PHASE 3, and do not gate the PHASE 1a strip on PHASE 3's
  delete succeeding — PHASE 3's own pre-existing `c870618c` fold-on-failed-unlink already closes the gap
  a purely optimistic PHASE 1a strip would otherwise open. Adding either would be redundant, not
  incorrect, but would duplicate logic that already exists for a different card.
- Do not widen this strip beyond `sources` for the CURRENT key's CURRENT pass — stripping anything else
  from `orphanLatchFiles` would drop a reference to a file that still legitimately exists.
