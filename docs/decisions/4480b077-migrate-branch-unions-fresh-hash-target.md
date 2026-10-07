# 4480b077 — PASS 1's migrate branch writes each key's union exactly once, after every file is read, instead of writing per file inside the read loop

From the round-2 Code Review of `8a1bc2ef` (reviewer `2ae805f3`, 2026-10-06) — PRE-EXISTING, MAJOR
durable-loss defect, also the root cause of `8a1bc2ef`'s own nondeterministic restart asserts. See
`docs/decisions/8a1bc2ef-cross-tier-sibling-pending-absorb.md`'s round-2 "Follow-up" note for the original
hand-off.

## The bug

`reenterMergeQuarantinesAtBoot`'s PASS 1 migrates a latch filed under a stale key to its fresh-hash
filename (`merge-quarantine.ts`'s `if (freshHash !== hash) { if (resolvableNow) { ... } }` branch, at
`3c54a35c` ~line 1400, `writeMergeQuarantineLatch(entry)`). That write used the bare, un-unioned `entry`
object — the in-memory union via `armQuarantineKey` only happened several lines LATER, in the shared
fall-through all entries pass through after the `if`/`else`. So the DISK write landed before the union
ever corrected it.

Two separate repo paths that collapse onto the SAME canonical key (card `7673d096`) can each carry their
OWN stale-keyed `.json` file at the same boot. PASS 1's `for (const f of files)` loop processes both,
each one's migrate branch writing to the IDENTICAL fresh-hash filename — whichever file's own migrate
write ran LAST clobbered the other's content entirely, keeping only its own token/reason/branch. Which
file's migrate call runs last is decided by `fs.readdirSync`'s own return order for `MERGE_QUARANTINE_DIR`
— not guaranteed stable, and in the reviewer's repro, test-fixture repo paths under `os.tmpdir()` hash to
effectively random strings with no stable relationship to each other, so this order (and therefore which
sibling's data survives) varies run to run.

Reproduced (reviewer, 12/12): `R` has a current latch plus a legacy subdir latch at its old hash. After
boot 1, `R`'s genuine token/reason/branch is gone from disk in every trial; in-process `R` is lost at boot
1 whenever the legacy filename sorts first in `readdir`, and at boot 2 always (once only the surviving
single-entry file remains on disk, that's now the "fresh" file for every subsequent boot). The repo stays
quarantined either way (fail-closed, never open) — but the human sees the (now sole) stale entry's reason
instead of `R`'s real reason, and may clear believing they're addressing the wrong problem, or clear the
right key while reading the wrong justification for it.

## Round 1's fix attempt — NOT MERGED; superseded below

The first attempt unioned `entry` with whatever `byRepoKey.get(currentKey)` already held, immediately
before that one file's own write, gated on `isKeyVerifiedFor(priorAtKey.repoPath, currentKey)`. Code
Review round 1 rejected this as not mergeable — the gate only ever sees what has been READ into
`byRepoKey` so far in the SAME streaming pass, which is strictly less than "every file that will ever
resolve to this key":

1. **(MAJOR) A stale sibling sorting BEFORE a repo's own current file still destroyed it.** `R`'s own
   correctly-named current latch (at `sha(K).json`) had not been read yet when an earlier-sorting stale
   sibling's migrate-write landed — `priorAtKey` read as empty (nothing armed yet), the gate's `!priorAtKey`
   branch treated that as "safe", and the stale sibling's bare content overwrote `R`'s own file before
   PASS 1 ever got to read it. The round-1 test suite only ever constructed the "two stale files, neither
   one pre-existing at the correct name" shape, so it never caught this.
2. **(MAJOR, fail-OPEN) The same race could destroy a DEGRADED entry's own backing file.** `883e29bc`
   round 2 Finding 3 already established PASS 1 arms a permanently-unresolvable entry `X` at `X`'s own
   recorded `resolvedKey` unconditionally (trusted per `7673d096`), and that `resolvedKey` physically backs
   a file at exactly `sha(resolvedKey).json` (the only place a migrate-write ever persists a
   `resolvedKey`-carrying entry — see "Round 2" below). If `X`'s own degraded branch had not run yet when a
   genuinely resolvable `Y` migrated to the SAME (colliding) key, `priorAtKey` again read as empty and `Y`'s
   write overwrote `X`'s own file. After a restart, `X`'s own latch is simply gone — fail-OPEN, worse than
   the fail-closed bug this card exists to fix. The round-1 test for this put `X`'s manufactured file at
   `sha(X's own path)` instead of the real invariant location `sha(X.resolvedKey)`, so it never collided
   with anything and never caught this either.
3. **(minor)** The gate inspected only the single `repoPath` field of whatever object currently occupied
   the key — not every individual constituent a prior union might already have folded in.

## Round 2 (shipped) — collect during the read pass, write once per key after it

Restructured to mirror `92c645cc`'s own PASS 1b tmp-recovery pattern: read every file first (writing
nothing), then write each key's FINAL union exactly once, after every file (and every PASS 1b tmp) has
been read.

**Read pass.** Every resolvable entry still arms into `byRepoKey` via the existing unconditional
fall-through (`armQuarantineKey` at `currentKey`, dual-arm at `resolvedKey` if set and different) —
unchanged, and this is what builds each key's order-independent union by the end of the loop. When a
resolvable entry's `freshHash !== hash` (needs migration), its source filename `f` is pushed onto
`migratedSourcesByKey.get(currentKey)` instead of being written immediately. The existing degraded
(unresolvable + `resolvedKey`) branch is unchanged (arms only at `resolvedKey`, diverts to pending, never
touches disk) but additionally records `degradedOccupiedKeys.add(entry.resolvedKey)` — a direct,
per-constituent set built from every individual degraded entry actually read, in BOTH PASS 1's own loop
and PASS 1b's own tmp loop (the same root cause reaches PASS 1b's own write pass too — see below).

**Write pass**, placed after BOTH PASS 1's and PASS 1b's own read loops (so `degradedOccupiedKeys`
reflects every degraded entry either one found) and before PASS 1b's own existing tmp-promotion write
loop: for each `[key, sources]` in `migratedSourcesByKey`:
- If `degradedOccupiedKeys.has(key)`: **skip entirely.** Never call `writeMergeQuarantineLatch`, never
  delete any source file. A loud, one-time warning names the key and source count. Both the degraded
  entry and every migrating sibling stay enforced in-memory only, for this process, via the union the read
  pass already built (unchanged, see "known-open residual" below) — never durably, until the collision
  resolves itself (the degraded entry is cleared, or remounts).
- Else: `unionEntry = byRepoKey.get(key)` is guaranteed to exist and be resolvable (every constituent
  that reaches this point came through the resolvable fall-through; the only way a degraded constituent
  could be involved was excluded above). Atomic write via the existing `writeMergeQuarantineLatch`
  (unchanged primitive — tmp + fsync + rename; only *when* it's called changed, once per key instead of
  once per file). On success, attempt `deleteSourceLatchIfSuperseded` on every source; fold any failures
  into `orphanLatchFiles` and re-persist once (see "Folded in: c870618c" below). On a write failure, fold
  every source into `orphanLatchFiles` (no deletes attempted) and log — same `a6fa60e2` failure-branch
  shape as before, now covering N sources instead of one.

**PASS 1b gets the same gate.** PASS 1b's own existing tmp-promotion write loop (`for (const [key, tmps]
of tmpsToUnlinkByKey)`) had the identical defect shape — its own `isRepoPathCurrentlyResolvable` check was
the only gate before writing, with no degraded-collision check, so a tmp migrating to a key that collides
with a PASS-1-sourced degraded entry's `resolvedKey` could clobber that entry's backing file the same way.
Since `degradedOccupiedKeys` is shared and fully populated before this loop runs, it gets the identical
`if (degradedOccupiedKeys.has(key)) { ...skip...; continue; }` guard at its own top.

**Finding 3, decided for the two write passes this branch gates.** The old
`isKeyVerifiedFor(priorAtKey.repoPath, currentKey)` gate inspected one identity field of whatever single
object happened to occupy a key *at that point in the streaming loop* — exactly the bug Code Review
named. It's replaced by `degradedOccupiedKeys`, built from every individual degraded source entry during
the read pass, independent of any later union — a key PASS 1's own migrate-write pass or PASS 1b's own
tmp-promotion write pass is about to touch is protected if *any* degraded constituent ever named it as
`resolvedKey`, full stop, with no merged object to inspect for either of those two passes. **This covers
only those two call sites** — see "Known-open residual #2" below for the two write sites this set does
NOT reach.

**Crash-mid-write safety.** Unchanged primitive: `writeMergeQuarantineLatch` is still the same atomic
tmp+fsync+rename. A crash between a successful rename and its own source deletes leaves a stale source
file behind — the same accepted residual `92c645cc` already carries for tmp recovery (a later boot or a
legitimate clear's own orphan-sweep sweeps it) — not a new crash window. Round 3 (below) changes exactly
WHEN the deletes run relative to OTHER keys' writes, not this per-write atomicity.

## Round 3 (shipped) — write ALL keys before deleting ANY source; fold the degraded-skip's sources too

Code Review round 2 found round 2's own write pass still not mergeable — two more findings, both
reproducible, neither caught by round 2's own test suite.

1. **(CRITICAL) A migration SOURCE for one key can physically BE a DIFFERENT key's own WRITE TARGET.**
   Round 2 still wrote and deleted PER KEY, in one interleaved loop. Repro: `sub` (a nested repo, own
   `.git`, real key `Ksub`) has its own latch filed at `sha(Kp).json` — stale for `sub`, but it IS
   `teamA`'s (a plain subdir of `P`, real key `Kp`) own correct, eventual write target. `teamA`'s own
   stale-named latch sorts BEFORE `sha(Kp).json` in this boot's `readdir`. Round 2's loop: `Kp`'s own
   write lands correctly at `sha(Kp).json` (teamA's union) and its own source deletes cleanly; THEN
   `Ksub`'s own write lands at `sha(Ksub).json` (sub's union), and `Ksub`'s own delete step removes ITS
   source — which is literally `sha(Kp).json`, now holding `teamA`'s freshly-written data —
   **destroying it**, durably, fail-OPEN. `deleteSourceLatchIfSuperseded` only ever protects the file THIS
   key wrote (`quarantinePathFor(unionEntry.repoPath)`); it has no way to know a DIFFERENT key, processed
   either earlier or later in the SAME pass, also just wrote to that exact path. (On round 1/round 2's own
   baseline, the identical fixture loses `sub` instead of `teamA` — round 2 moved WHICH side loses, it
   never closed the hazard; round 2's own "makes the final written state order-independent" claim above
   is false for this shape specifically.)
2. **(MAJOR) The degraded-collision skip branch never folded its skipped sources into `orphanLatchFiles`.**
   Round 2's skip left every migrating source (e.g. `stale-y.json`) completely untracked — not referenced
   by anything, so a later legitimate `clearMergeQuarantine(y)` (which still deletes the degraded entry's
   own `sha(Ky).json`, per the known-open residual below) left `stale-y.json` behind. The NEXT boot then
   found `degradedOccupiedKeys` no longer named `Ky` (the degraded entry's own file was itself just
   deleted by that clear) and `stale-y.json` migrated SUCCESSFULLY — resurrecting the exact quarantine the
   human had just cleared. The `c870618c` resurrection class, reached through this branch instead of a
   failed unlink, and independent of `d4b25feb`.

**Fix for finding 1:** split into two loops over `migratedSourcesByKey` — WRITE every non-degraded-occupied
key's union first, recording `writeTargetsThisPass` (every `path.basename(quarantinePathFor(
unionEntry.repoPath))` that write actually landed at — derived from what `writeMergeQuarantineLatch`
itself writes, never recomputed from `key`, since the two can diverge the same way a receiver's own
identity can). Only THEN, in a second loop, delete each successfully-written key's own sources — skipping
(never deleting, never folding — see "Do not") any source whose basename is ALSO in
`writeTargetsThisPass`, logging why. A source skipped this way is simply left as-is: it now physically
holds a DIFFERENT, unrelated key's correct, current data, so on the next boot `freshHash === hash` for
whichever repo actually owns that key now, and no further migration is attempted for it.

**Fix for finding 2:** the degraded-occupied skip branch now folds every migrating `source` into the
SAME in-memory union object `byRepoKey.get(key)` already holds (the pre-existing, unconditional X+Y
union — no disk write, the degraded entry's own backing file is still never touched) before logging and
`continue`-ing. Because `clearMergeQuarantineByKey` already sweeps a cleared entry's own
`orphanLatchFiles` via `sweepOrphanLatchFileIfUnreferenced` (unchanged, pre-existing), the SAME ordinary
clear that lifts the shared union now also sweeps the folded source(s) — closing the resurrection without
needing a new sweep path. The skip's own log text no longer suggests "clear the degraded entry" as a
remedy (it doesn't work as separate advice — clearing the shared union is the only clear that exists here
at all); it now states plainly that sources are folded and swept by the SAME ordinary clear.

## Known-open residual — the in-memory twin (tracked on card `d4b25feb`, NOT fixed here)

This card deliberately leaves `armQuarantineKey`'s own in-memory union unconditional — a degraded entry
`X` and a genuinely resolvable, colliding `Y` are still unioned into ONE in-memory object sharing
`armedKeys: [Ky]`, exactly as before. The manager-requested check (scenario
`in-memory-twin-clear-destroys-degraded-file`) confirms this has a durable, destructive consequence this
card does **not** close: `clearMergeQuarantine(y)` (the ordinary, legitimate human clear for the
resolvable repo) resolves the SAME unioned entry, lifts every key in its `armedKeys` (`[Ky]`), and
`deleteMergeQuarantineLatchByKey(Ky)` deletes `sha(Ky).json` — which, by the very invariant this card's own
fix relies on, is `X`'s own, unrelated, physically separate backing file. **Measured: it reproduces.**
Clearing `Y` destroys `X`'s only durable copy as a side effect, even though this card's own write-pass
guard never touches that file during boot. This is the in-memory counterpart of the on-disk defect this
card fixes, reached through the CLEAR path instead of the WRITE path, not fixed by this card. Tracked on
card `d4b25feb`. (Round 3's own fix above closes the SIBLING resurrection — `Y`'s own migrating source
surviving that same clear — but not this one; the two are independent consequences of the same
unconditional in-memory union, and only the first is in this card's scope.)

## Known-open residual #2 — two write sites `degradedOccupiedKeys` does not gate (NOT fixed here)

`degradedOccupiedKeys` only gates the two write passes named above (PASS 1's own migrate-write pass, PASS
1b's own tmp-promotion write pass). Two OTHER sites in this same function write a `.json` final without
consulting it at all, and could in principle overwrite a degraded entry's own backing file the same way,
if their own key ever collided with one:
- **PASS 1's matched-corrupt self-heal** (the `catch` branch's `armQuarantineKey(byRepoKey,
  canonicalRepoLockKey(matchedRepo), entry); writeMergeQuarantineLatch(entry)` for a corrupt-but-hash-matched
  latch) — carded `ed74603b`.
- **PASS 2's orphan-reference re-persist** (merging an orphan filename into an already-valid entry's own
  `orphanLatchFiles` and re-persisting) — carded `d163aef5`.

Neither is fixed by this card — named here so a future reader doesn't assume `degradedOccupiedKeys`
reaches every write site in this function just because its own doc comment says "neither write pass may
ever write there."

## Folded in: c870618c — a failed migrate-branch unlink is folded into orphanLatchFiles

Same deferred write pass's success branch: `deleteSourceLatchIfSuperseded(f, entry)`'s boolean return
(card `8a1bc2ef` item 2 — `false` only for a genuinely attempted-and-failed unlink, e.g. EBUSY;
ENOENT/already-gone/self-target-skip all return `true`) was previously ignored outright. An EBUSY there
left the stale source file `f` on disk, untracked by anything: not folded into the armed entry's own
`orphanLatchFiles`, so a later legitimate clear of the real (fresh-hash) entry never swept it — and the
next boot found this still-cleanly-parsing leftover and re-armed the quarantine the human had just
legitimately cleared (fail-closed, same class `be79f4d5`/`9cabd143` exist to close, reached through a
fifth call site).

Fixed by mirroring `consumeMatchedPendingsIntoArmedEntry`'s own SUCCESS-branch fold exactly, now for
N sources per key: on any per-source `false` return, fold every failing source into `orphanLatchFiles`
(deduped) and re-persist via `writeMergeQuarantineLatch` once. If that re-persist itself fails, a loud log
names it explicitly and the surviving source(s) stay able to re-arm the quarantine at the next boot — safe
(fail-closed, never open) for THIS branch specifically, because the write to the entry's own NEW key has
already durably succeeded by the time this unlink-fold runs; nothing here risks the entry's own data.

**CORRECTION (card `97cff6db`) — this did NOT generalize to "any failed durable write," and the original
text above claimed it did.** A *migrate write itself* failing (not this branch's unlink-after-a-successful-
write) was fail-OPEN whenever a sibling key's own successful write, earlier or later in the SAME pass,
physically superseded the exact file this entry's "left in place" fallback assumed was still intact — see
`docs/decisions/97cff6db-migrate-source-owner-durable-before-write.md` for the repro and the fix (a
safety-tmp residue, written before any such write can run).

## Verification

`test/merge-quarantine-pass1-migrate-union.mjs` — ten scenarios, each its own process + fresh
`LOOM_HOME`, each with a reboot-sim (a fresh, cache-busted module re-import in the SAME process — module
state starts genuinely empty, the same as a real process start would see, but it is NOT an actual OS
process restart):
- `sibling-collapse-orderA`/`orderB` — two stale siblings colliding, both readdir orders (role-assignment
  swapped between the two scenarios, never a hardcoded filename).
- `current-plus-stale-sibling-first` — round 1's own finding 1 repro: a pre-existing, correctly-named
  current latch plus a stale sibling forced (empirically verified, not assumed) to sort first.
- `ebusy-fold-and-sweep` / `ebusy-no-injection-control` — the single-source EBUSY fold and its negative
  control.
- `stale-id-clear-keeps-folded-file` — the N-source EBUSY fold: two migrating siblings, one's unlink
  fails; a clear-by-id on the failing source's own (real, 24-hex) stale hash keeps it; the real clear
  sweeps it; a reboot-sim confirms no resurrection.
- `migrate-source-collides-with-sibling-target` — round 3's own finding 1 repro (above): a nested repo's
  own latch sits at a plain sibling subdir's own correct write target; both survive, on disk and after a
  reboot-sim.
- `degraded-receiver-guard` — round 1's own finding 2 repro, corrected: `X`'s manufactured backing file
  sits at the REAL invariant location `sha(X.resolvedKey)`, not `sha(X's own path)` (round 1's test
  error). Asserts `X`'s file is byte-identical before/after, `Y`'s own stale file is left untouched, and
  both survive a reboot-sim unresolved rather than losing either side.
- `union-with-degraded-in-memory` — the in-process fail-closed half of the same fixture: both `X` and `Y`
  still read quarantined via `activeMergeQuarantineFor` even though no file was ever written for either.
- `in-memory-twin-clear-destroys-degraded-file` — round 3's own finding 2 repro ("Repro B"), and the
  still-open in-memory twin, in one fixture: asserts (pass/fail) that `Y`'s own folded stale source is
  swept by the same clear and that `Y` does not resurrect on a later reboot-sim (the part round 3 fixes),
  and separately REPORTS (never asserts) whether `X`'s own backing file survives that same clear (the
  still-open `d4b25feb` twin).

Nine of ten proven RED against the pre-`4480b077` code and GREEN after, via `scripts/negative-control.mjs`;
`ebusy-no-injection-control` passes on both sides by design (a negative control). Two scenarios
(`migrate-source-collides-with-sibling-target`, `in-memory-twin-clear-destroys-degraded-file`) were
additionally proven RED against round 2 (`20d0756f`) specifically and GREEN after round 3, confirming
round 3 closes what round 2 missed without reopening anything round 1/2 already closed.

## Do not

- Do not write to `MERGE_QUARANTINE_DIR` per file inside PASS 1's (or PASS 1b's) own read loop — collect
  every migrating source under its target key during the read pass, and write each key's FINAL union
  exactly once, after every file (PASS 1 AND PASS 1b) has been read. A per-file write can land before a
  not-yet-read sibling — including that key's own pre-existing correct file — has had a chance to be read
  (round 1's own MAJOR finding 1).
- Do not gate a pre-write union (or skip) on the single identity field of whatever currently occupies a
  key — build and consult `degradedOccupiedKeys` (every degraded entry's own `resolvedKey`, collected
  during the read pass) instead. A key in that set is NEVER written to by PASS 1's own migrate-write pass
  or PASS 1b's own tmp-promotion write pass, full stop — the two write passes this set actually gates (see
  "Known-open residual #2": PASS 1's matched-corrupt self-heal and PASS 2's orphan-reference re-persist
  are NOT among them, carded `ed74603b`/`d163aef5` separately — do not assume this set reaches every write
  site in this function). Nothing about the TIMING of when a degraded entry happens to be read should
  change that answer, for either of the two it does cover (round 1's own MAJOR finding 2 and minor
  finding 3).
- Do not write and delete per key in one interleaved loop — write EVERY key's union first, THEN delete
  every source, and never delete a source whose basename is ALSO a write target this SAME pass wrote to
  for a DIFFERENT key (derived from what `writeMergeQuarantineLatch` actually wrote —
  `quarantinePathFor(unionEntry.repoPath)` — never recomputed from `key`). A per-key interleaved loop can
  destroy an EARLIER key's freshly-written latch via a LATER key's own delete step (round 3, finding 1,
  CRITICAL) — reproduced whichever way the two keys happen to be ordered; round 2 only moved which side
  lost, it never closed the hazard.
- Do not let the degraded-occupied skip leave its migrating sources untracked — fold them into the shared
  in-memory union's own `orphanLatchFiles` (no disk write) before `continue`-ing, so the SAME ordinary
  clear that eventually lifts that union also sweeps them via `clearMergeQuarantineByKey`'s existing
  orphan-sweep. An untracked skip survives a clear and resurrects on the next boot once the degraded
  entry's own file is separately gone (round 3, finding 2, MAJOR — the `c870618c` resurrection class,
  reached through this branch).
- Do not advise "clear the degraded entry" in that skip's own log text — there is no separate entry to
  clear; the degraded entry and its colliding sibling share ONE in-memory union, so clearing either clears
  both. State what actually happens (sources are folded and swept by the ordinary clear) instead.
- Do not assume gating PASS 1's own write pass is sufficient once PASS 1b also writes migrated/promoted
  latches — share `degradedOccupiedKeys` across both, populated by both passes' own degraded branches,
  and apply the same gate to PASS 1b's own write loop too.
- Do not ignore `deleteSourceLatchIfSuperseded`'s boolean return at this (or any) call site — fold a
  `false` into `orphanLatchFiles` and re-persist, exactly like `consumeMatchedPendingsIntoArmedEntry`'s own
  success branch, for every failing source in the N-source case. An ignored failure here untracks the
  stale file and lets it resurrect a cleared quarantine at the next boot.
- Do not trust a single `negative-control` run's per-order pass/fail pattern as a stable fact (see
  `8a1bc2ef`'s own round-2 "Do not" on this) — construct both orders explicitly (by role-assignment, never
  a hardcoded filename) rather than relying on one run to discriminate.
- Do not assume `fs.readdirSync` returns creation order on every filesystem — measured alphabetical on
  this host; a scenario that needs a specific order verifies it with a real readdir check rather than
  assuming either semantics.
- Do not read this card as having closed the in-memory union itself — `armQuarantineKey`'s own
  unconditional union is UNCHANGED and deliberately so; the known-open consequence named above (a
  legitimate clear of a resolvable repo can destroy a degraded, colliding sibling's own backing file) is
  tracked separately on card `d4b25feb`, not fixed here — this is DIFFERENT from, and not fixed by, round
  3's own fold-the-skip's-sources fix, which closes the SIBLING's own resurrection, not this one.

Tests: `test/merge-quarantine-pass1-migrate-union.mjs`.
