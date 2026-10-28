# da716192 — strip a migrating source's basename from every OTHER key's own orphan refs, not just the migrating key's

From `9c3b023a`'s own Code Review (reviewer `62eeb9f8`, 2026-10-28), confirmed by a hermetic, real-code-path
repro (no hand-authored impossible entry) before any production code was touched.

## The class

`9c3b023a` strips a migrating source's own basename from the ONE entry it is migrating INTO — the key
currently being iterated in PHASE 1a's `for (const [key, sources] of migratedSourcesByKey)` loop. It never
visits a key that is NOT itself a migrate target this boot. So an unrelated, genuinely live entry K whose
own `orphanLatchFiles` cross-lists a file O — via some earlier, unrelated process (e.g. PASS 2's own
orphan-broadcast into every registered repo's entry, a prior boot) — keeps a dangling reference to O for
good once O later turns out to be a migrate SOURCE for some OTHER key L and PHASE 3 deletes it: K is never
a member of `migratedSourcesByKey`, so PHASE 1a's own strip never even looks at K's entry.

## Confirmed by repro

Two real, unrelated repos, two real boots, no hand-authored entry:

- **Boot 1** — K is a real, standalone, already-quarantined repo. A genuinely CORRUPT/unparsable latch O
  matches no repo registered this boot (L is not yet registered) ⇒ PASS 2 broadcasts O into K's own REAL
  entry's `orphanLatchFiles` (the ordinary "every registered repo references an orphan so a human clear
  can eventually free it" mechanism — `merge-quarantine.ts` PASS 2).
- **Boot 2** — L (a nested subdir, so its LEGACY direct-path hash differs from its CURRENT canonical-key
  hash) is now also registered. O's filename is exactly L's legacy hash, so the deferred corrupt-latch
  loop (`deferredCorruptJsons`, the "Site A" legacy/unverified `hashToRepo` match) matches O to L and
  migrates it into L's key as one of L's own `sources`. PHASE 3 deletes O outright — none of
  `deleteSourceLatchIfSuperseded`'s five pre-existing protections fire for it (K's mere `orphanLatchFiles`
  reference is not "physical ownership"; `physicalOwnerRepoPaths` never consults another entry's
  `orphanLatchFiles`). K's entry (in-memory AND the persisted final) is never touched this boot, so it
  still lists O's now-deleted basename.
- `clearMergeQuarantineLatchFile(<O's freed id>)` then returned `{ok:true, wasQuarantined:false,
  latchKept:true, referencingRepoPaths:[K's repoPath]}` — the same misattribution class `9c3b023a` fixed
  within one key, now reproduced across two.

## The fix

A CROSS-KEY strip runs right before PHASE 1a/3 ever write or delete a byte: it flattens
`migratedSourcesByKey`'s values into one `allMigratingSources` set (every source migrating ANYWHERE this
boot, not just one key's own `sources`), then strips that full set from every OTHER live `byRepoKey`
entry's own `orphanLatchFiles` too. A key is skipped ONLY when it is an ORDINARY (non-degraded) migrate
target — `migratedSourcesByKey.has(key) && !degradedOccupiedKeys.has(key)` — since PHASE 1a's own
9c3b023a strip already handles that exact key. A DEGRADED-OCCUPIED migrate target is deliberately NOT
skipped here: PHASE 1b only ever ADDS sources to the occupant's `orphanLatchFiles` (never strips), so a
degraded-occupied bystander that ALSO happens to be some other entry's own migrate target still needs
this pass (Code Review round 2, item #2 — a bystander whose own key coincidentally collides with an
unrelated migrate target was reproduced going through un-stripped, see "Reachability" below).

For every key this pass strips, it computes `liveKeys = liveArmedKeysOf(entry, byRepoKey)` — LIVE
occupancy, captured BEFORE `replaceEntryEverywhere`, never `entry.armedKeys`/`stripped.armedKeys` alone
(8db913e2/6be6c9ff/c52b290e's own established rule: a re-pointed multi-key twin can carry no `armedKeys`
of its own). It then threads the ADOPTED return value through every one of those keys — `let cur =
stripped; for (const writeKey of liveKeys) { const r = bootWriteLatch(writeKey, cur, NO_DROPS); if (r !==
false) cur = r; }` — never writing the SAME pre-loop `stripped` to every key and discarding
`bootWriteLatch`'s own return (Code Review round 2, item #1 — exactly `4e987303`'s own first "Do not";
with a dual-armed entry whose files are kept-unreadable, the second key's own merged tokens would never
reach memory, and a caller re-pointing with the stale object would silently miss it). A key in `liveKeys`
that is itself a migrate target or degraded-occupied is skipped by the WRITE loop specifically (never the
strip above it) — a degraded-occupied key is unconditionally refused by `bootWriteLatch` itself anyway, so
the in-memory strip is the only effect there, matching what `bootWriteLatch` would have done regardless.

The strip is persisted IMMEDIATELY (for every writable key), via the same `bootWriteLatch` chokepoint
every other write in this function uses, never left stale for a future boot to re-discover and
re-misattribute. Because `bootWriteLatch` refuses any basename not already registered in
`allBootWriteTargets` ("UNANTICIPATED boot write"), the SAME `allBootWriteTargets` build (before Phase 0's
own safety-tmp protection pass) now also registers every such OTHER key's own basename — gated on
`isRepoPathCurrentlyResolvable(e.repoPath)` too, matching the sibling registration sites immediately
above it (Code Review round 2, item #4 — an unresolvable bystander's basename must never be registered;
registering one it would trigger Phase 0's own pending re-point/safety-tmp machinery on every boot, the
`ef651188` growth pattern, for a key `bootWriteLatch` was always going to refuse anyway).

`clearMergeQuarantineLatchFile`/`sweepOrphanLatchFileIfUnreferenced` read `activeQuarantines` (populated
from `byRepoKey` at the very end of the boot function) — purely in-memory, never disk — for this
referencing check. So the in-memory `replaceEntryEverywhere` call alone already makes clear-by-id correct
for the remainder of this process even if the persist write itself fails; a failed write only risks the
SAME stale on-disk reference resurfacing on a LATER boot (logged, never silently swallowed).

## Fail direction — a failed unlink or a failed WRITE

The strip subtracts O from K UNCONDITIONALLY, before PHASE 3 ever attempts O's delete. Two independent
failure shapes were tested:
- The delete itself fails (EBUSY, `succeeded:true` for L's own write) — `c870618c`'s own pre-existing
  fold-on-failed-unlink re-adds O into the MIGRATING key's (L's) own `orphanLatchFiles` — never K's.
- L's own WHOLE WRITE fails (`succeeded:false`, injected via an `fs.openSync` failure on L's own tmp
  target) — PHASE 3 never even attempts a delete at all; its own `else` branch folds every one of L's
  sources into L's `orphanLatchFiles` instead.

Either way, the still-present file ends up referenced by exactly one entry — the one with a live claim
via its own superseded migrate attempt — never an unrelated bystander.

## Scope — `byRepoKey` AND `pendingUnresolvedQuarantines`, both covered (Code Review round 2, item #2, Lead ruling)

The original cut of this fix touched only `byRepoKey` (active, armed entries), treating a PENDING entry
(`pendingUnresolvedQuarantines`) or a DEGRADED-OCCUPIED bystander as out of scope. Code Review round 2
found both REACHABLE, not merely theoretical: `sweepOrphanLatchFileIfUnreferenced` checks pending entries
too, and a bystander that is itself degraded-occupied (its own key coincidentally collides with an
UNRELATED entry's own migrate target this same boot) was reproduced going through this fix's own outer
`byRepoKey` loop un-stripped, because that loop originally excluded EVERY `degradedOccupiedKeys` member
unconditionally. Both are now covered, in-memory only, with NO disk write attempted for either (a
degraded-occupied key is unconditionally refused by `bootWriteLatch` itself; a pending entry has no key of
its own to write through):
- The `byRepoKey` strip's own outer guard now admits a degraded-occupied migrate target (see "The fix"
  above) — it is excluded from the WRITE loop specifically, never from the strip.
- A dedicated loop over `pendingUnresolvedQuarantines` strips `allMigratingSources` from every pending
  entry's own `orphanLatchFiles`, excluding that SAME entry's own `sourceFile` (its self-reference must
  never be stripped, even if it happens to coincide with a migrating source elsewhere).

This is reachable, demonstrated by a hermetic repro (`cross-key-strip-degraded-and-pending-bystanders`,
mirroring this file's own `degraded-receiver-guard`/`union-with-degraded-in-memory` construction for the
degraded half, and `reenterMergeQuarantinesAtBootTestOnly`'s own `testOnlyInjectUnprotectedPending` seam
for the pending half) — not "not-yet-demonstrated."

## Tests

`merge-quarantine-pass1-migrate-union.mjs`:
- `cross-key-dangling-orphan-after-sibling-migrate` — the card's own repro, flipped to assert the fix
  (K no longer references O, on disk and in-memory; clear-by-id on O's freed id is no longer
  misattributed; K's own real token/quarantine survives untouched).
- `cross-key-strip-failed-unlink-stays-referenced-by-migrating-key` — the fail-direction twin: O's own
  unlink is injected to fail: K no longer references it (stripped unconditionally, before the delete was
  even attempted), L (the migrating key) does (via `c870618c`'s existing fold), and a later clean boot
  finally deletes the survivor with nothing left misattributed anywhere.
- `cross-key-strip-dual-armed-both-keys-written` (Code Review items #1/#3; REBUILT in round 3 — see
  "Round 3" below for why the original 2-key version could not discriminate threaded from unthreaded
  code) — K armed at its own key plus TWO secondary keys reached via its own `resolvedKeys` field (the
  only dual-arm shape reachable through `reenterMergeQuarantinesAtBoot`'s own disk-driven semantics
  without a real on-disk file being swept into the UNRELATED, pre-existing stale-migrate-union mechanism
  instead — verified empirically with a throwaway probe before writing this scenario), BOTH secondary
  keys genuinely MARKED (a real, injected EACCES on the first read of each, routed through the REAL
  `divertUnreadableBootLatch` mechanism) with a DIFFERENT extra token discoverable only via reconcile.
  Asserts memory ends up holding BOTH extra tokens, never just whichever reconciled last.
- `cross-key-strip-survives-migrating-keys-own-write-failure` (Code Review item #5(b)) — the
  WHOLE-WRITE-fails twin of the existing failed-unlink scenario (`fs.openSync` injected to fail on L's own
  migrate-write tmp target, so `writeOutcomesByKey` records `succeeded:false` and PHASE 3 never even
  attempts a delete): K no longer references O; L does (PHASE 3's own `else`-branch fold); a later clean
  boot finally succeeds and deletes the survivor.
- `cross-key-strip-degraded-and-pending-bystanders` (Code Review item #2/#5(c); extended in round 3 with
  a snapshot-based byte-compare, a relabeled self-reference check, and a "boot 3" continuation — see
  "Round 3" below) — a degraded-occupied bystander X (mirrors `degraded-receiver-guard`'s own
  construction) and a pending bystander (injected via `reenterMergeQuarantinesAtBootTestOnly`), both
  cross-listing O: both are stripped in-memory, neither is ever written to disk, and clear-by-id is not
  misattributed to either. Boot 3 then makes X resolvable for real and documents the named continuation
  residual (see "Round 3", item 8).

RED/GREEN/clean-restore proven three times, once per round — see "Round 3"'s own citations section below
for the exact ref/scoped-revert used for each claim; never cite a bare "HEAD".

## Round 3 (Code Review) — a test that can fail, a drop-set asymmetry, a stale `cur` on failure, and two more bystander findings

Round 2's own CR found the core fix correct and the degraded/pending coverage genuinely fail-closed, but
NOT merge-ready: round 1's own threading (#1) and `liveArmedKeysOf` (#3) claims had NO test that could
actually fail on them. Confirmed: `cross-key-strip-dual-armed-both-keys-written` (round 2's 2-key, one
secondary MARKED version) stayed GREEN with EITHER the threading alone reverted OR `liveKeys` alone
reverted to `stripped.armedKeys` — because `bootWriteLatch`'s own internal MARKED-reconcile branch calls
`replaceEntryEverywhere(byRepoKey, entry, reconciled)` as a SIDE EFFECT, which already fixes EVERY
`byRepoKey` slot pointing to the stale pre-loop value the FIRST time ANY key reconciles — a 2-key
construction can never observe threading mattering in MEMORY, since there is only one reconcile to begin
with. Fixed by rebuilding the scenario around THREE keys, with the LAST TWO both marked, each with a
DIFFERENT extra token discovered only at write time — see the scenario's own header comment for the full
trace of why 2 keys can't discriminate and 3 does. RED/GREEN citations below are now exact.

1. **Threading (#1) — genuinely exercised, RED confirmed by a scoped revert.** With `cur = result;`
   (merge-quarantine.ts, the write loop's success branch) replaced with a no-op, `cross-key-strip-dual-
   armed-both-keys-written` goes RED: memory ends up holding `"token-V-EXTRA"` (keyV's own reconcile,
   whose own `replaceEntryEverywhere` ran while every slot still pointed at `stripped`) but NOT
   `"token-W-EXTRA"` (keyW's own reconcile unions it onto the STALE `stripped`, and its own
   `replaceEntryEverywhere(byRepoKey, stripped, ...)` finds nothing left to replace — nothing points to
   `stripped` anymore, so that result is applied NOWHERE). Restored and reconfirmed GREEN immediately
   after. The full corpus was not run against this scoped revert (checked the one scenario only, per the
   card's own "scoped revert" allowance) — the sha-based proof below (`--ref 6556b016`) covers the full
   corpus for the complete round-3 diff instead.

2. **`liveArmedKeysOf` (#3) — verified UNREACHABLE at boot, by reasoning, not by a failing test.**
   `armQuarantineKey` (the ONE arming chokepoint PASS1/PASS1b route through) unconditionally computes
   `armed.armedKeys = [...new Set([...(merged.armedKeys ?? []), key])]` and then
   `for (const k of armed.armedKeys ?? [key]) byRepoKey.set(k, armed);` — every key it ever arms gets
   folded into `armedKeys`, and every key in `armedKeys` gets `byRepoKey` pointed at the SAME object, by
   construction. `evictPriorFromKey` (the only OTHER boot-time `replaceEntryEverywhere` call touching
   `armedKeys`) narrows it correctly on eviction, never widens occupancy past it. The specific gap
   `6be6c9ff`/`8db913e2` describe — a re-point that stamps NO `armedKeys` at all — lives exclusively in
   `protectOccupantContentBeforeDelete`, a RUNTIME clear-path function never called from
   `reenterMergeQuarantinesAtBootImpl`. Confirmed empirically too: with `liveKeys` scope-reverted to
   `stripped.armedKeys ?? []`, the FULL `merge-quarantine*.mjs` corpus (90 files) stayed GREEN — 0
   failures — consistent with the reasoning above. `#3` is marked **verified by reasoning only** for the
   boot-time scope this card covers; `liveArmedKeysOf` is kept anyway, both because it is the established
   precedent (8db913e2/6be6c9ff/c52b290e) for every OTHER consumer in this file and because it costs
   nothing when `armedKeys` is already complete.

3. **Two-path asymmetry with PHASE 1a (#2, blocking) — fixed.** The write loop now passes
   `{ ...NO_DROPS, orphanLatchFiles: allMigratingSources }` to `bootWriteLatch`, never bare `NO_DROPS`.
   Without it, a MARKED bystander's own reconcile (`reconcileMarkedBasenameBeforeWrite`, the SAME
   `4e987303` M1 mechanism PHASE 1a's own sibling call already guards against) unions `orphanLatchFiles`
   back in from whatever is STILL on disk — the stale bytes THIS write is about to supersede — and round
   2's own threading would then pull that resurrected reference into every later key too. Exercised by
   `cross-key-strip-degraded-and-pending-bystanders`'s own first check (a marked bystander, X, whose disk
   final lists O): after the strip, neither memory nor X's own disk file lists O.

4. **Stale `cur` on a failed write (#3, blocking) — fixed.** On `bootWriteLatch` returning `false`, `cur`
   now re-syncs from the live slot (`cur = byRepoKey.get(writeKey) ?? cur`) before logging and moving to
   the next key. `bootWriteLatch`'s own MARKED reconcile branch re-points `byRepoKey` to the reconciled
   entry BEFORE the write itself is even attempted (and thus before it can fail) — so a failed write can
   leave `cur` pinned to a value `byRepoKey` has already moved past, silently discarding that reconcile
   for every later key in the SAME loop. No dedicated test was added (the construction — a marked key
   whose reconcile succeeds but whose OWN subsequent write then fails — was judged not cheap relative to
   the fix's own small, clearly-correct diff); named here per the card's own fallback.

5. **Degraded-occupied keys were wrongly excluded from the STRIP, not just the write (#2, Lead ruling,
   found independently while building the round-3 tests) — fixed in round 2, re-verified here.** The
   outer loop's guard changed from `migratedSourcesByKey.has(key)` to
   `migratedSourcesByKey.has(key) && !degradedOccupiedKeys.has(key)` — confirmed with a REAL repro (a
   degraded bystander X whose own key coincidentally collides with an unrelated entry's migrate target
   was going through un-stripped under the old blanket exclusion).

6. **A residual check fixed en route — `warnDanglingOrphanRefsNotMigratingThisBoot` must run for EVERY
   entry, including an ordinary (non-degraded) migrate target.** It was originally gated behind the same
   outer skip as the strip itself, so it never fired for a migrate target's own UNRELATED dangling
   reference — found via the card's own boot-3 continuation test (below) going RED for the wrong reason
   (the state assertion passed, the log-line assertion failed) until the warning call was moved above the
   skip.

7. **Test construction fixes (#4):**
   - `Buffer.compare(fs.readFileSync(xFile), fs.readFileSync(xFile))` compared the file with itself and
     could never fail. Fixed: the bytes are snapshotted BEFORE boot 2 and compared against a FRESH read
     after.
   - The `f === p.sourceFile` self-reference exclusion is genuinely unobservable end-to-end in THIS
     module: making `p.sourceFile` ALSO a real migrate source (so the exclusion has something to protect)
     makes `clearMergeQuarantineLatchFile` resolve that id via `pendingLatchIdFor(p.sourceFile)` directly
     (the matchedPending branch) — a path that never reads `p.entry.orphanLatchFiles`' own CONTENT at all,
     so the exclusion's effect is invisible to it either way. No caller in this module reads
     `orphanLatchFiles` content for a basename that also equals that SAME entry's own `sourceFile` via any
     OTHER route either. The assertion is relabeled to state only what it verifies (the pending wrapper
     survives the pass intact), with the reasoning recorded inline at the construction.

8. **The continuation residual (#7) — named, not fixed; follow-up card `6a098eb1`.** A degraded or pending
   bystander's own DISK file can still list a reference (like O) that is neither migrating this boot nor
   exists on disk — logged via `warnDanglingOrphanRefsNotMigratingThisBoot` (citing `6a098eb1` in the log
   text), never stripped. `6a098eb1` is the boot-time reconcile that would actually drop such a reference;
   this card deliberately does not implement it. Demonstrated as "boot 3" of
   `cross-key-strip-degraded-and-pending-bystanders`: X's own directory is created for real (git init)
   between boot 2 and boot 3, making it resolvable; X's own file (still at its original, now-stale `ky`
   hash) migrates to X's OWN new real key via the EXISTING 9c3b023a mechanism (which strips only X's own
   migrate source, never O) — O re-enters memory, unstripped, exactly as this section predicts, and the
   residual's own warning log line fires, naming the card.

### RED/GREEN citations (CR round 3's own nitpick: name the exact ref, never "HEAD")

- The original fix (round 1): `--ref 3a706680` (the repro-only commit, before any fix existed).
- Round 2's own additions: `--ref 0b02586e` (round 1's own tip, before round 2's threading/scope fixes).
- Round 3's own additions (items 1-8 above, as a whole-corpus proof): `--ref 6556b016` (round 2's own
  tip, before round 3's drop-set/re-sync/degraded-strip-ordering/test fixes) — RED, then GREEN, tree
  byte-identical afterward.
- Item #1's own threading claim specifically: a SCOPED revert (`cur = result;` → no-op in the write
  loop's success branch), never a whole-file `--ref` — see "Round 3" item 1 above for the exact RED
  signature this produced.
- Item #3's own `liveArmedKeysOf` claim specifically: a SCOPED revert (`liveKeys = liveArmedKeysOf(entry,
  byRepoKey)` → `liveKeys = stripped.armedKeys ?? []`) — the FULL corpus stayed GREEN under this revert,
  which is itself the evidence for "verified by reasoning only," not a RED repro.

## Do not

- Do not rely on natural `byRepoKey` Map iteration to reach every key a dual-armed entry is written under
  — a second visit (via a different key) to an already-stripped entry sees it already clean and silently
  skips its own write. Use `liveArmedKeysOf(entry, byRepoKey)` — LIVE occupancy, captured BEFORE
  `replaceEntryEverywhere` — to enumerate every physical file that needs the update, never
  `entry.armedKeys`/`stripped.armedKeys` alone (8db913e2/6be6c9ff/c52b290e's own established rule: a
  re-pointed multi-key twin can carry no `armedKeys` of its own).
- Do not write the SAME pre-loop `stripped` value to every key in that write loop, discarding
  `bootWriteLatch`'s own return — thread the ADOPTED value forward (`4e987303`'s own first "Do not"): a
  marked (`keptUnreadableLatchFiles`) key's own reconcile can produce a genuinely different object, and
  the NEXT key's write (and the final in-memory re-point) must build on THAT, never the stale original.
- Do not call `bootWriteLatch` for a key whose basename was never registered in `allBootWriteTargets` —
  register it in the SAME upfront pass every other boot-write site uses, gated on
  `isRepoPathCurrentlyResolvable(e.repoPath)` like its sibling registration sites, with the identical
  `migratedSourcesByKey`/`degradedOccupiedKeys` exclusion the WRITE loop (never the strip) uses, or the
  write is refused as "UNANTICIPATED" and the fix silently never persists to disk.
- Do not exclude a degraded-occupied key from the STRIP's own outer loop — only from its WRITE loop. A
  bystander whose own key happens to ALSO be an unrelated entry's migrate target is still a genuine
  bystander; PHASE 1b's fold never strips anything, so skipping the strip there reopens this exact card's
  bug for that one shape. See "Scope" above.
- Do not treat `pendingUnresolvedQuarantines` as out of scope — see "Scope" above; it is covered by a
  dedicated loop, excluding each entry's own self-referencing `sourceFile`.
- Do not run the cross-key strip AFTER PHASE 3's deletes — it must run before any delete is even
  attempted, so `c870618c`'s own fold-on-failed-unlink (which re-adds a still-present source into the
  MIGRATING key, not the bystander) is the only mechanism that ever re-introduces a reference, never a
  race between this strip and that fold.
- Do not write this scenario's own test with only TWO keys (one unmarked primary, one marked secondary)
  to prove threading matters — `bootWriteLatch`'s own internal reconcile-repoint already fixes EVERY
  `byRepoKey` slot pointing to the stale value as a side effect of the FIRST reconcile, so a 2-key
  construction stays GREEN whether or not the write loop threads `cur`. Use at least two MARKED keys
  (round 3's own fix) so the SECOND reconcile has something to lose if threading is reverted.
- Do not pass bare `NO_DROPS` to `bootWriteLatch` in the write loop — pass
  `{ ...NO_DROPS, orphanLatchFiles: allMigratingSources }`, or a marked bystander's own reconcile unions
  a just-stripped reference right back in from the stale bytes that write is about to supersede.
- Do not leave `cur` pointing at its pre-call value after `bootWriteLatch` returns `false` — re-sync it
  from `byRepoKey.get(writeKey) ?? cur` first. The MARKED reconcile branch re-points `byRepoKey` BEFORE
  attempting the write, so a failure there still leaves a genuinely different value live in memory.
- Do not gate `warnDanglingOrphanRefsNotMigratingThisBoot` behind the same exclusion as the strip itself
  — it must run for EVERY entry, including an ordinary migrate target, or it misses that same target's
  own unrelated dangling reference (found via the card's own boot-3 continuation test going red for the
  wrong reason until this was fixed).
- Do not construct a "self-reference exclusion" test by making a pending entry's own `sourceFile` ALSO a
  genuine migrate source and then verifying via `clearMergeQuarantineLatchFile` — that call resolves such
  an id through `pendingLatchIdFor(p.sourceFile)` directly (the matchedPending branch), which never reads
  `p.entry.orphanLatchFiles`'s own content, so the exclusion's effect is unobservable through it either
  way. See "Round 3", item 7, for what was tried and why it was abandoned in favor of an honest relabel.
