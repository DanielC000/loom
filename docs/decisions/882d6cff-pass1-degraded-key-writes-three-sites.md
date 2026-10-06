# 882d6cff — gate three boot-reentry write/fold sites on resolvability, never a degraded walked-up key (folds in ed74603b)

From the 5b40376c Code Review (reviewer `95807a3b`, 2026-10-06), items 1-3. PRE-EXISTING, all reproduced
by the reviewer first (scratch harness, own process+`LOOM_HOME` per scenario) and independently
re-reproduced by this card's own worker before any fix was written. Same root class as
`883e29bc`/`5b40376c`: `reenterMergeQuarantinesAtBoot` (`packages/daemon/src/git/merge-quarantine.ts`)
has THREE further sites that trusted `canonicalRepoLockKey(X)` for an UNRESOLVABLE `X` — which degrades
(walks up) to an ancestor key `Kr` a genuinely resolvable sibling `T` also occupies — and wrote or folded
at that degraded key instead of `X`'s own identity.

Setup throughout: `R` repo, `T = R/teamA` plain subdir (no own `.git`, key `Kr`), `X = R/nested` (own
`.git`, true key `Kx`), unmounted at boot.

## The bugs

### Site A — PASS 1's matched-corrupt `.json` self-heal (also card `ed74603b` — the SAME site)

PASS 1's catch branch for an unparsable `.json` final, once it matches a registered repo via
`hashToRepo`, used to build a GENERIC placeholder entry and write it SYNCHRONOUSLY, inline, inside the
read loop:

```js
armQuarantineKey(byRepoKey, canonicalRepoLockKey(matchedRepo), entry);
if (!writeMergeQuarantineLatch(entry)) { ... }
```

Two independent defects in this one shape:

1. (`882d6cff` item 1) When `matchedRepo` (`X`) is unresolvable, `canonicalRepoLockKey(matchedRepo)`
   degrades to `Kr`. `writeMergeQuarantineLatch(entry)` targets `quarantinePathFor(entry.repoPath)` —
   also `Kr`'s path — unconditionally, OVERWRITING `T`'s genuine final the instant `X`'s corrupt latch
   happens to match via its own legacy hash. After this boot, `sha(Kr).json` holds `{repoPath: X,
   placeholder: true}` — `T`'s token is gone. Once `X` remounts, a later boot's MIGRATE branch
   (`freshHash !== hash`, since `X` is now resolvable and its true key is `Kx`) relocates this content to
   `sha(Kx).json` and deletes the old `sha(Kr).json` source — `T`'s own entry is now durably,
   unrecoverably gone. `activeMergeQuarantineFor(T)` reads `undefined`.
2. (card `ed74603b`) Even setting aside the degraded-key hazard, this write is the BARE placeholder
   `entry`, never `armQuarantineKey`'s own return value (the UNIONED object) — contradicting `4480b077`'s
   own "never write per file inside PASS 1's read loop" rule. A sibling `.json.tmp-<pid>` residue for the
   SAME key, read moments later in PASS 1b, gets unioned with this placeholder IN MEMORY, but the ALREADY-
   WRITTEN disk copy never reflects it.

Both reproduced hermetically: `T`'s real final written directly at `sha(Kr).json`; `X`'s corrupt final
("{") written at `oldHashFor(nested)` (`X`'s own legacy hash, matching via `hashToRepo`'s legacy
mapping); `X` parked. `reenterMergeQuarantinesAtBoot([repo, nested, subdir])` overwrites `T`'s own final
with the bare placeholder; after a restart-sim with `X` remounted, `T`'s quarantine is durably lost.

### Site B — `hashToRepo` construction (item 2)

```js
for (const p of registeredRepoPaths) {
  hashToRepo.set(quarantineHashFor(p), p);
  hashToRepo.set(legacyQuarantineHashFor(p), p);
}
```

`quarantineHashFor(p)` degrades identically to `canonicalRepoLockKey` when `p` is unresolvable — so an
unresolvable `X`'s own "fresh" hash entry can equal a genuinely resolvable sibling's (`T`'s, or `R`'s own)
fresh hash entry, with LAST-WRITER-WINS in the `Map`. If `T`'s own final is corrupt (named at `sha(Kr)`,
`T`'s own true hash), attribution of that corrupt latch flips between `T` and `X` purely based on
`registeredRepoPaths`' iteration order — reproduced: order `[R, T, X]` attributes to `X` (wrong, `X`
registered last); order `[R, X, T]` attributes to `T` (right, `T` registered last).

### Site B, round 2 — a bare drop of the unresolvable fresh hash is ALSO wrong (Code Review `7eff21dd`, MAJOR)

Round 1's fix (below) dropped an unresolvable path's fresh hash UNCONDITIONALLY, reasoning that it is
always a degraded stand-in for some resolvable sibling's own key. False: for a path bound to a SUBDIR
that is itself absent, the walk lands on its OWN TRUE toplevel key, with no resolvable registrant
involved at all. Repro: `X = Y/sub` (absent at boot — `sub` never created), `Y` a real repo but
deliberately NOT itself registered, `Z` an unrelated, registered, resolvable repo. `X`'s corrupt latch,
named at `sha(Ky)` (exactly what `X`'s degraded walk produces, `Y` being the nearest existing ancestor
with a `.git`), matched NOTHING in round 1's `hashToRepo` (its fresh hash was dropped outright, and its
legacy hash is a different, direct-identity value) — it fell through to the PASS 2 orphan sweep, which
fail-closes EVERY registered repo. Parent (pre-882d6cff) behavior: only `X` quarantined. Round-1 HEAD:
`X` AND `Z` (wholly unrelated) both quarantined — violates `@decision 7673d096`'s own intent (index both
hashes so a latch "falls through to its own one repo", never the broad sweep).

### Site B, round 3 — precedence still picks ONE winner among MULTIPLE unresolvable claimants (Code Review `688a31c0`, MAJOR)

Round 2's precedence fix still used a single-winner `Map` for the unresolvable tier
(`if (!hashToRepo.has(h)) hashToRepo.set(h, p)`) — correct when at most ONE unresolvable path ever
degrades to a given hash, but TWO genuinely different unresolvable paths can share one degraded hash at
once: `W1 = Y/a` and `W2 = Y/b`, BOTH registered and BOTH absent, `Y` a real repo but not itself
registered, `Z` unrelated and registered. A corrupt latch at `sha(Ky)` (what EITHER `W1`'s or `W2`'s
degraded walk produces) matched whichever of `W1`/`W2` happened to claim the slot first — the OTHER was
simply never entered into `hashToRepo` at all, fail-OPEN, with no diverted pending record and no orphan-
sweep fallback either (the slot WAS claimed, by the winner, so the corrupt latch was never "unmatched").
Round 2 HEAD: the first-registered of `W1`/`W2` quarantined, the other NOT — and WHO wins flips with
registration order (in production, `db.listProjects()`'s own `ORDER BY name`, so renaming a project can
flip which one is protected). Even remounting the loser in-process (`mkdir Y/b`) didn't help until the
NEXT boot — `W2`'s own identity was never recorded anywhere to graduate FROM.

**Round-4 correction (Code Review `5339b48f`, m1) — the PARENT's own behavior is NOT "exactly one of the
two, never both," as an earlier draft of this record claimed.** Measured precisely, by checking
ENFORCEMENT (`activeMergeQuarantineFor`) separately from IDENTITY (`listActiveMergeQuarantines`), which
this record's own round-3 draft conflated: the parent's one unconditional `hashToRepo.set(...)` loop
(last write always winning, independent of resolvability) attributes the corrupt latch's own `repoPath`
field to exactly ONE of `W1`/`W2` (the last-registered one) — but the OTHER is NOT left unprotected
in-process. Both `W1` and `W2` degrade to the IDENTICAL key `Ky`, so `activeMergeQuarantineFor` for
EITHER one resolves to the SAME `activeQuarantines.get(Ky)` entry and BLOCKS — just under the winner's
own (wrong, for the loser) identity. The parent BLOCKS BOTH, in-process, coincidentally, via the shared
degraded key; it only MISATTRIBUTES one of them. The loser's fail-open is not immediate — it manifests
the moment the loser (not the winner) REMOUNTS: its own key is then its TRUE one, no longer coincident
with `Ky`, and nothing was ever recorded under its own identity to carry the protection forward. **Round
2's fix (proper `pendingUnresolvedQuarantines` diversion, replacing the parent's accidental active-entry
coincidence) is what turns this into a fail-open FROM BOOT instead of fail-open-only-on-remount** — the
winner now diverts correctly to PENDING (never armed into `activeQuarantines` at all), so the coincidental
"both read as blocked via the same map slot" side effect the parent had is gone, and the loser (never
diverted anywhere) is unprotected immediately. See Verification below for the exact per-scenario
breakdown, measured by running BOTH an identity check and an enforcement check against each baseline.

### Site C — the deferred-corrupt-tmp loop (5b40376c's twin, item 3)

```js
for (const { f, matchedRepo } of deferredCorruptTmps) {
  const key = canonicalRepoLockKey(matchedRepo);
  const existing = byRepoKey.get(key);
  if (existing && !isPlaceholderEntryShape(existing)) {
    // folds `f` into tmpsToUnlinkByKey[key] — deleted once that key's union write succeeds
    ...
  }
  ...
}
```

`X`'s only evidence is a corrupt tmp — it PASSES `5b40376c`'s own resolvability gate precisely because
`X` is unresolvable (that gate only short-circuits a RESOLVABLE `matchedRepo`), falls through to parse,
throws, and is deferred here. `canonicalRepoLockKey(matchedRepo)` degrades to `Kr` again; `T`'s own real,
non-placeholder data already occupies `Kr` (read earlier in PASS 1) — so `X`'s tmp is folded into `T`'s
own "safe to delete, it's just stale residue" list and unlinked the instant `T`'s own union write
succeeds. `X`'s only durable evidence is gone; after a restart-sim with `X` remounted,
`activeMergeQuarantineFor(X)` reads `undefined` — fail-open.

## The fixes

All three share ONE gate: `isRepoPathCurrentlyResolvable(matchedRepo)` (Site A, Site C) or
`isRepoPathCurrentlyResolvable(p)` (Site B) — checked BEFORE any key recompute, mirroring every other
degraded-key guard already in this function.

**Site B (round 3 — supersedes round 2's single-winner unresolvable tier)** — `hashToRepo` resolves to
exactly ONE repo (legacy match, always unique; or resolvable-fresh match, the intentional sibling-
collapse case) — built in two passes, legacy strictly first so a toplevel repo's own legacy-equals-fresh
coincidence can never outlive a later sibling's resolvable-fresh claim (the ordering trap below):

```js
const hashToRepo = new Map<string, string>();
for (const p of registeredRepoPaths) {
  hashToRepo.set(legacyQuarantineHashFor(p), p);
}
for (const p of registeredRepoPaths) {
  if (isRepoPathCurrentlyResolvable(p)) hashToRepo.set(quarantineHashFor(p), p);
}
```

An unresolvable path's own (possibly degraded) fresh hash is NEVER folded into this single-winner map —
instead, a SEPARATE `unresolvedClaimantsByHash: Map<string, string[]>` keeps the FULL SET of every
unresolvable path sharing a given hash, with any hash `hashToRepo` already resolves (a verified match)
stripped out of it (verified always wins):

```js
const unresolvedClaimantsByHash = new Map<string, string[]>();
for (const p of registeredRepoPaths) {
  if (!isRepoPathCurrentlyResolvable(p)) {
    const h = quarantineHashFor(p);
    const claimants = unresolvedClaimantsByHash.get(h) ?? [];
    claimants.push(p);
    unresolvedClaimantsByHash.set(h, claimants);
  }
}
for (const [h] of unresolvedClaimantsByHash) {
  if (hashToRepo.has(h)) unresolvedClaimantsByHash.delete(h);
}
```

Both lookup sites (PASS 1's matched-corrupt `.json` catch, and the deferred-corrupt-tmp catch) now check
`hashToRepo` first (a verified, unambiguous match — unchanged), and ONLY when that returns nothing, fall
back to `unresolvedClaimantsByHash.get(hash)` — iterating EVERY claimant and pushing one deferred entry
per claimant (`deferredCorruptJsons`/`deferredCorruptTmps`), instead of taking a single "winner". Since
every claimant is unresolvable by construction, each independently takes the EXISTING unresolvable-divert
branch (below) — no changes needed there; the fix is entirely in WHO gets offered a divert, not in how a
divert itself behaves once offered.

**THE SHARED-SOURCE-FILE HAZARD (found while building this, not merely while reviewing it):** multiple
claimants diverting from the SAME physical corrupt file now means multiple `pendingUnresolvedQuarantines`
entries can share one `sourceFile`. `deleteSourceLatchIfSuperseded` (used by graduation and the migrate
pass to clean up a "superseded" source) previously assumed SOLE ownership and unlinked unconditionally —
if `W1` graduates (a real remount + query) while `W2` is still pending on the SAME shared file, the old
code deleted it out from under `W2`: `W2` still read as quarantined for the rest of THIS process (its own
in-memory pending object was untouched), but the file was gone, so `W2`'s quarantine was NEVER reloaded
on a RESTART — fail-open, introduced by this card's own fix, not a pre-existing defect. Fixed by adding
one more no-op condition to `deleteSourceLatchIfSuperseded`: kept (reported `true`, not deleted) whenever
ANY remaining pending entry still names that exact `sourceFile` as its own. Proved RED by temporarily
disabling just this one line (`if (false) return true`) and confirming the exact predicted failure mode
(`site-b-remount-one-claimant-no-collateral-damage`'s own in-process check still passed; its DURABILITY
check, across a restart-sim, failed) before restoring it.

A resolvable path's own fresh hash always wins. An unresolvable path's fresh hash claims a slot in
`unresolvedClaimantsByHash` only where nothing resolvable has claimed it — covering the item-2 sibling-
collision repro (a resolvable sibling's claim wins), the round-2 repro (no resolvable claimant at all,
one true-toplevel unresolvable key still wins), and the round-3 repro (MULTIPLE unresolvable claimants
sharing one hash, ALL of them, never just one).

**THE ORDERING TRAP (worth recording — this is exactly how round 2's first attempt at this fix
regressed item 2 while fixing the round-2 repro):** a three-separate-loop split is NOT equivalent to
doing fresh-then-legacy per path in ONE loop (round 1's original shape). A repo bound at its OWN git
toplevel has a legacy hash IDENTICAL to its own fresh hash (`54054c01`). If the legacy loop runs AFTER
the resolvable-fresh loop (or interleaved per-path, as round 1 had it), a toplevel repo `R`'s own legacy
registration can re-claim a hash a LATER-registered sibling `T`'s own fresh hash had already (correctly)
overridden — resurrecting the exact order-dependence item 2 exists to kill, just via a different
mechanism. The legacy loop MUST run strictly FIRST, with both fresh loops (unresolvable-if-unclaimed,
then resolvable-unconditional) running strictly AFTER it, so resolvable-fresh always has the final say
regardless of how many paths share a toplevel-coincidental legacy value.

**Site A** — DEFER (never arm/write inline inside the read loop): the catch branch now only collects
`{f, matchedRepo}` into a new `deferredCorruptJsons` array. A short loop, placed right after PASS 1's own
`flushDegradedDiverts()` (before PASS 1b starts, so PASS 1b's own `cleanlyParsedKeys` gate sees a
consistent `byRepoKey`), resolves each:

- RESOLVABLE: build the placeholder, `armQuarantineKey(byRepoKey, key, entry)` (unions in-memory,
  unchanged), then push `f` onto the EXISTING `migratedSourcesByKey.get(key)` list — reusing `4480b077`'s
  WRITE-ALL-THEN-DELETE-ALL pass VERBATIM, no changes to that pass at all. That pass already writes
  `byRepoKey.get(key)` (the TRUE UNION, never the bare placeholder — this is what closes `ed74603b` too)
  and already honours `degradedOccupiedKeys` (folds as orphan instead of writing, when a different
  degraded entry's own trusted `resolvedKey` occupies `key`). When the corrupt file's own basename IS the
  key's write target (`freshHash === hash`, no legacy/fresh mismatch), the existing "also a write target
  this pass wrote to" protection in the delete loop correctly treats it as a no-op — the file is
  overwritten in place (the self-heal), never deleted. Verified directly (condition 2, Lead review).
- UNRESOLVABLE: per Lead directive, NEVER write an overwrite-in-place helper for a path that cannot be
  verified. Build the placeholder (no `resolvedKey` — only the file's HASH is known, not its one-way
  pre-image key string, so one cannot be derived) and push `{entry, sourceFile: f}` straight to
  `pendingUnresolvedQuarantines`, mirroring the established "no resolvedKey + unresolvable" idiom used
  elsewhere in this function (e.g. a parseable latch with no `resolvedKey`). The corrupt file is left AS
  WRITTEN — the same "never touch a file we can't verify" posture as every other unresolvable-path branch
  here.

**Site A, round 2 MINOR (write-failure fold)** — the 4480b077 migrate-write pass's own FAILED-write fold
branch (`else { ... orphanLatchFiles: [...sources] ... }`) used to fold EVERY source unconditionally.
Site A's resolvable branch can now feed a source whose basename IS the key's own write target (the
basename-matches-target self-heal case) — folding that into the entry's own `orphanLatchFiles` would
self-reference. Fixed by excluding the key's own write target from the fold, mirroring
`consumeMatchedPendingsIntoArmedEntry`'s existing `f !== freshWriteTarget` filter:
`sources.filter((f) => f !== path.basename(quarantinePathFor(unionEntry.repoPath)))`.

**Site C** — the same resolvability gate, placed before `key`/`existing` are computed: when
`matchedRepo` is unresolvable, keep the tmp untouched (never add to `tmpsToUnlinkByKey`) and divert
in-memory to `pendingUnresolvedQuarantines` instead, no new write — identical posture to Site A's
unresolvable branch. The pre-existing resolvable-path logic (fold into `tmpsToUnlinkByKey` when real data
covers the key, else build+arm+write a fresh placeholder) is UNCHANGED.

## Clearability, convergence, stability (Lead review conditions)

A diverted pending entry (no `resolvedKey`) is reachable via `listActiveMergeQuarantines()` (never via a
key-tier query for an ancestor — by design, matching `883e29bc`'s own tier-4 restriction) and:

- **Clearable while parked — scoped to a SINGLE claimant (Code Review `5339b48f`, round 4, corrects an
  earlier unscoped claim here)**: when exactly ONE claimant shares a given latch (the item-1/item-3
  shapes), both `clearMergeQuarantine(X)` (by repo path) and `clearMergeQuarantineLatchFile(id)` (by the
  corrupt file's own 24-hex id) lift the diverted entry, sweep its source file, and verified: no
  resurrection on a later reboot-sim, for either clear route. **This does NOT generalize to MULTIPLE
  claimants sharing one latch** — see "Round 4: clearing a shared latch" below for the scoped, corrected
  behavior and the durable escape.
- **Converges on remount**: once `X` resolves again, its NEXT boot's matched-corrupt processing takes the
  RESOLVABLE branch — for a corrupt FINAL (Site A), since `X` is its own git toplevel, its legacy hash
  equals its own fresh hash, so the "source" IS the write target: the file is self-healed IN PLACE (no new
  file, no accumulation), now a valid placeholder JSON correctly keyed at `Kx`. `T`'s own final stays
  byte-identical throughout.
- **Stays stable while parked, across several reboot-sims**: verified for both the corrupt-FINAL and
  corrupt-TMP shapes — the file set under `MERGE_QUARANTINE_DIR` is IDENTICAL across repeated reboot-sims
  with `X` never remounted or cleared (no accumulation), and `T`'s own final stays byte-identical
  throughout. (The corrupt-TMP shape's own "no real sibling data" fallback — PRE-EXISTING code, untouched
  by this card — re-arms a fresh placeholder FINAL at `X`'s own key on every boot while leaving the
  original corrupt tmp residue in place; this is stable, not accumulating, but does not itself "clean up"
  the tmp the way Site A's basename-match case does. Not this card's scope — Site C's own fix only changes
  whether `X`'s tmp survives at all while `X` is unresolvable, not what happens to it once `X` resolves.)

## Known-open: input-population widening of `97cff6db`'s own mechanism

Site A's RESOLVABLE branch feeds `f` into the EXISTING `migratedSourcesByKey` collection — the exact
mechanism card `97cff6db` (open, unrelated to this card) already flags as having a pre-existing,
EMFILE-shaped durable-loss edge case ("a boot-time write for key `Kb` lands on `sha(Kb).json` which is
ANOTHER key `Ka`'s migrate SOURCE, before `Ka`'s own data is durable elsewhere"). This card does not touch
that pass's own logic — it only widens WHO can land in it: a matched-corrupt `.json` final is now also a
legitimate "source" subject to the same fault class a stale-key MIGRATE source already was. Not fixed,
not worsened by this card; `97cff6db`'s own eventual fix (ordering migrate-source owners durably before
any dependent write) will cover this new source type for free, since it operates on `migratedSourcesByKey`
generically. No touch to `d163aef5` (PASS 2's own orphan re-persist) or `d4b25feb` (`enterMergeQuarantine`,
an in-process raise path) — both are structurally unrelated code paths to the three sites this card fixes.

## Round 4: clearing a shared latch (Code Review `5339b48f`, M1, fail-CLOSED direction)

LEAD RULING: direction (a) — report the limitation and verify the durable escape — NOW; direction (b) — a
durable per-claimant "tombstone" so clearing ONE claimant of a shared latch survives a restart on its own
— is a SEPARATE, deferred card. This section documents (a) plus one genuine bug found and fixed while
verifying it.

**The documented (not fixed — by design, per the Lead ruling) behavior**: clearing ONE claimant of a
latch shared by `N > 1` claimants (`clearMergeQuarantine`/`clearMergeQuarantineByRecordedPath`, by
repoPath) lifts that claimant's OWN pending record and durably sweeps the shared file ONLY once nothing
else references it — while `N - 1` other claimants still do, the file survives (correctly — they still
need it) and, on the NEXT restart, EVERY remaining registered+unresolvable claimant sharing that hash —
INCLUDING the one just cleared — re-diverts from it, since nothing records that this one was already
explicitly cleared. This is now surfaced, not silent: `clearMergeQuarantine`/
`clearMergeQuarantineByRecordedPath`/`clearMergeQuarantineReporting` all now return `latchKept: true` +
`referencingRepoPaths` (mirroring `clearMergeQuarantineLatchFile`'s own existing shape) with a `reason`
naming the durable escape, whenever the pending-clear branch's own file sweep is kept rather than
deleted. **The durable escape — clearing the SHARED LATCH BY ITS OWN 24-HEX ID
(`clearMergeQuarantineLatchFile`, `POST /internal/merge-quarantine/clear-by-path` with `{id}`) — lifts
EVERY claimant sharing it in one call**, durably, deleting the file so nothing can re-divert from it on a
later boot; its own success response now also names every `liftedRepoPaths` entry (m3).

**The genuine bug found while VERIFYING that durable escape actually holds in both of the Lead's named
shapes**: it did, for the simple "clear each claimant one at a time, in sequence" shape — but NOT for the
"a claimant graduates (remounts + a query), then UNMOUNTS AGAIN" shape. `physicalOwnerRepoPaths` (used by
both the latch-id clear AND the pending-clear's own sweep) recomputes `path.basename(quarantinePathFor(
e.repoPath))` FRESH for every ACTIVE entry, unconditionally, to catch legitimate key drift
(`abccee85`) — but a graduated entry whose path later goes UNRESOLVABLE again (never removed from
`activeQuarantines`) degrades right back to the SAME shared ancestor key its own graduation left behind —
falsely "protecting" the shared file forever, via pure coincidence, even though that entry's REAL backing
file lives at a completely different, already-resolved key. The shared file was never cleanable by
EITHER clear route after this — confirmed with an uncaught-ENOENT-free repro (RED proven by temporarily
disabling just the new gate and confirming the exact predicted failure before restoring it). Fixed by
gating that recompute on `isRepoPathCurrentlyResolvable(e.repoPath)` — `writeMergeQuarantineLatch` only
ever targets that recomputed value for a resolvable entry, so trusting it for an unresolvable one was
never correct in the first place, key-drift or not.

Tests: `test/merge-quarantine-pass1-degraded-key-writes.mjs`,
`clear-one-claimant-reports-kept-and-reasserts-on-restart` (the documented, scoped behavior: `latchKept`
reported, file survives, BOTH claimants re-divert on restart, THEN the latch-id clear is a confirmed
durable escape — stable across a further restart) and
`clear-remount-unmount-both-claimants-durable-via-latch-id` (the bug: the latch-id clear durably lifts
both even when one claimant's own stale, reverted-to-unresolvable active entry would otherwise falsely
block the sweep).

## Verification

`test/merge-quarantine-pass1-degraded-key-writes.mjs`, SIXTEEN scenarios (each its own child process,
own fresh `LOOM_HOME`): the original ten (`item1-final-self-heal-writes-union`,
`item2-hashToRepo-order-RTX` / `item2-hashToRepo-order-RXT`, `item3-deferred-tmp-kept-when-unresolvable`,
`clear-while-parked-no-resurrect`, `remount-converges-and-stays-stable`,
`stays-parked-stable-across-reboots`, `site-a-basename-matches-target-self-heals-in-place`,
`site-b-unresolvable-true-toplevel-key-still-attributes`, `site-a-resolvable-degraded-occupied-fold-only`),
round 3's four (`site-b-multiple-unresolvable-claimants-order-a` / `-order-b`,
`site-c-multiple-unresolvable-claimants-tmp-shape`, `site-b-remount-one-claimant-no-collateral-damage`),
and round 4's two (`clear-one-claimant-reports-kept-and-reasserts-on-restart`,
`clear-remount-unmount-both-claimants-durable-via-latch-id`). Every assertion includes a reboot-sim
(fresh, cache-busted module re-import) and a byte-identical check on `T`'s own final file where
applicable; the three multi-claimant scenarios round 4 added enforcement checks to (m2) assert
`activeMergeQuarantineFor` for EACH claimant directly, never only `listActiveMergeQuarantines` identity.

**RED/GREEN accounting, stated at true strength — measured per-scenario, not asserted (and corrected
TWICE now for exactly this failure mode: round 3's draft said "8 of 10 RED on parent", corrected to 7 in
round 4; this same round 4 then ALSO caught and fixed a SECOND hand-derived error — an early round-4 draft
claimed the parent leaves the unattributed multi-claimant loser completely unprotected, "never both" —
re-checked by splitting the IDENTITY assertion from a NEW ENFORCEMENT assertion (m2), which showed the
parent actually BLOCKS both, just misattributing one; see the Site B round-3 section's own round-4
correction above for the full, now-measured characterization):**

| scenario | RED on parent (`4173b48b`) | RED on round 2 (`58f82c90`) | RED on round 3 (`a1facd04`) |
|---|---|---|---|
| item1-final-self-heal-writes-union | RED | — | — |
| item2-hashToRepo-order-RTX | RED | — | — |
| item2-hashToRepo-order-RXT | *(control)* | — | — |
| item3-deferred-tmp-kept-when-unresolvable | RED | — | — |
| clear-while-parked-no-resurrect | RED | — | — |
| remount-converges-and-stays-stable | RED | — | — |
| stays-parked-stable-across-reboots | RED | — | — |
| site-a-basename-matches-target-self-heals-in-place | *(control)* | — | — |
| site-b-unresolvable-true-toplevel-key-still-attributes | *(control — passes on parent)* | RED *(round-1-only)* | — |
| site-a-resolvable-degraded-occupied-fold-only | RED | — | — |
| site-b-multiple-unresolvable-claimants-order-a | RED *(identity only — enforcement passes on parent)* | RED | — |
| site-b-multiple-unresolvable-claimants-order-b | RED *(identity only — enforcement passes on parent)* | RED | — |
| site-c-multiple-unresolvable-claimants-tmp-shape | RED | RED | — |
| site-b-remount-one-claimant-no-collateral-damage | RED | RED | — |
| clear-one-claimant-reports-kept-and-reasserts-on-restart | RED | RED | RED |
| clear-remount-unmount-both-claimants-durable-via-latch-id | RED | RED | RED |

**7 of the original ten are genuine RED-on-parent repros** (not 8). **2 of the original ten are
controls** that pass on parent BY DESIGN — `item2-hashToRepo-order-RXT` (the order that happened to
attribute correctly even pre-fix) and `site-a-basename-matches-target-self-heals-in-place` (a case the
pre-fix inline code already handled correctly). **1 of the original ten is RED ONLY against round 1's
own commit**, never the parent — `site-b-unresolvable-true-toplevel-key-still-attributes` (round 1's bare
drop regressed a case the UNFIXED parent's own, unrelated bug shape happened not to break). 7 + 2 + 1 =
10. **Round 3's four new scenarios are RED on BOTH the parent and round 2** — the multi-claimant fail-open
is pre-existing (present in the parent too, via the SAME mechanism measured and corrected above: it
blocks both in-process via the shared key but misattributes identity, failing open only once the
unattributed loser remounts) and neither round 1 nor round 2 addressed it; the two order-a/order-b rows
are RED on the parent for the IDENTITY assertion specifically, not the (newly added, round 4) enforcement
one — recorded as its own column rather than collapsed into a bare RED, since collapsing it is exactly
the error this section corrects. **Round 4's two new scenarios are RED on the parent, round 2, AND round
3** — the clear-path bug they pin (`physicalOwnerRepoPaths`'s unconditional fresh-recompute) existed
since before any of this card's work; round 3 didn't touch clearing at all.

Measured via negative-control runs covering BOTH changed source files (`merge-quarantine.ts` AND
`gateway/server.ts` — the REST-surfacing fields round 4 added make the latter fail to even BUILD against
an older `merge-quarantine.ts` whose functions don't yet carry them, which is itself a correct, expected
signal, not a tool defect): `pnpm --filter @loom/daemon negative-control --file
packages/daemon/src/git/merge-quarantine.ts --file packages/daemon/src/gateway/server.ts --test
packages/daemon/test/merge-quarantine-pass1-degraded-key-writes.mjs`, run against `--ref 4173b48b` and
`--ref HEAD~1` (`a1facd04`, round 3's own commit) — reading each run's own per-scenario PASS/FAIL lines
directly, never re-derived by reasoning about the code. Both runs' GREEN phase passed all 16 and the tree
restored byte-identical.

`remount-converges-and-stays-stable` originally went RED on the parent through an UNCAUGHT `ENOENT`
(a bare `fs.readFileSync` on `T`'s own final, which the parent's bug can delete via its own migrate-
delete pass once `X` remounts) rather than a clean assertion failure — the scenario would abort before
its later checks ever ran. Fixed by routing every read in that scenario through a `tryReadFile` helper
(returns `null` on a missing file instead of throwing), so a regression surfaces as an ordinary `FAIL`
line, never a crash that silently skips coverage.

`test/merge-quarantine-pass1b-clean-parse-gate.mjs`'s own R1 scenario (card `cac93b4c`, item 3) asserted a
STALE pin — "the final's own on-disk content after a failed union-promote write still carries
`placeholder: true`" — that this card's Site A fix changes for the better: deferring the self-heal into
the SAME write pass PASS 1b's own real-tmp-read already feeds means the self-heal write now ALREADY
carries the real union by the time it fires, so the final's own content is the RECOVERED identity even
when the (separate, later) tmp-promote write fails. Updated the scenario's own comment and the two
affected assertions to pin the NEW, strictly-better invariant instead of silently deleting coverage.
Round 2 also corrected the scenario's own stale boot-2 comment/labels ("lifting the placeholder") —
boot 2 no longer lifts anything; the real identity was already on disk from boot 1, and boot 2's only
remaining job is sweeping the real tmp once its own (separate) tmp-promote write is no longer faulted.

Every other `merge-quarantine*.mjs` file (18 total) and `pnpm --filter @loom/daemon guards` (27/27)
re-run clean — no regressions.

## Do not

- Do not write or fold at a RECOMPUTED `canonicalRepoLockKey`/`quarantineHashFor` value for a path that is
  not currently resolvable, anywhere in this function — that value is a DEGRADED, walked-up stand-in for
  an ancestor, never a verified identity for the unresolvable path itself. Gate on
  `isRepoPathCurrentlyResolvable` BEFORE the recompute, not after.
- Do not add an overwrite-in-place write helper for an unverifiable path (Lead directive, explicit) — a
  corrupt file belonging to a path that cannot currently be verified is left AS WRITTEN; the fail-closed
  signal lives in the in-memory `pendingUnresolvedQuarantines` divert, not in rewritten bytes on disk.
- Do not write per-file, inline, inside PASS 1's (or PASS 1b's) own read loop — collect into a deferred
  collection and write each key's union exactly once, after every file has been read (the `4480b077` rule,
  now also covering Site A's matched-corrupt `.json` case).
- Do not assume a diverted (no-`resolvedKey`) pending entry should block an ancestor query — it
  deliberately does not (the existing tier-4 restriction in `activeMergeQuarantineFor`); it is reachable
  via `listActiveMergeQuarantines()` and via its own direct-identity query once resolvable, never via a
  sibling's or ancestor's key.
- Do not read Site C's "stays stable" property as "the tmp gets cleaned up once `X` resolves" — that is
  Site A's own property (basename-matches-target self-heal), not Site C's; Site C's own "no real sibling
  data" fallback (pre-existing, untouched) re-arms a fresh placeholder on every boot while leaving the
  original tmp in place, indefinitely, without growing it.
- Do not DROP an unresolvable path's fresh-hash registration outright (round 1's own mistake) — a bare
  drop assumes every unresolvable path's degraded key is always a stand-in for some OTHER, resolvable
  registrant, false for a subdir-bound path whose subdir is absent, whose walk lands on its own TRUE
  toplevel key with no resolvable registrant involved at all.
- Do not pick a SINGLE WINNER for the unresolvable tier either, even "only where unclaimed" (round 2's
  own mistake, Code Review `688a31c0`) — TWO genuinely different unresolvable paths can share one
  degraded hash at once; keep the FULL SET of claimants (`unresolvedClaimantsByHash`) and divert every
  one, never just the first (or only) one that happens to claim a `Map` slot.
- Do not split Site B's single per-path loop into separate hash-kind loops without checking ORDER: the
  legacy loop must run strictly BEFORE the resolvable-fresh loop. A repo at its own git toplevel has a
  legacy hash identical to its own fresh hash — running legacy AFTER (or interleaved with) the
  resolvable-fresh loop lets it silently re-claim a hash a later-registered sibling's fresh hash had
  already, correctly, overridden, reopening item 2's own order-dependence through a different door.
- Do not fold a migrate/matched-corrupt source into `orphanLatchFiles` on a write FAILURE without
  excluding the key's own write target first — Site A can feed a source that already equals it (the
  basename-matches-target case), and the existing `consumeMatchedPendingsIntoArmedEntry` filter
  (`f !== freshWriteTarget`) is the established precedent for exactly this exclusion.
- Do not assume a pending entry's own `sourceFile` is exclusively its own once MULTIPLE unresolvable
  claimants can divert from the SAME physical corrupt file — `deleteSourceLatchIfSuperseded` must check
  whether any OTHER still-pending entry still names that exact file before unlinking it, or one
  claimant's own graduation/clear collaterally destroys a surviving sibling's only durable evidence (an
  in-process-only symptom that becomes a real, restart-durable fail-open the moment the file is gone).
- Do not trust a hand-derived RED/GREEN count for a multi-scenario test file — read it off the
  negative-control tool's own per-scenario PASS/FAIL output instead. This record's own "8 of 10" claim
  (round 2) was wrong — the true count was 7 — precisely because it was reasoned about rather than measured.
- Do not describe a multi-claimant baseline's behavior from an IDENTITY check (`listActiveMergeQuarantines`)
  alone — a real caller blocks via `activeMergeQuarantineFor` (enforcement), and the two can disagree: the
  parent's own single-winner `hashToRepo` MISATTRIBUTES identity for the loser while still BLOCKING it,
  via the same shared degraded key. An identity-only reading of this record itself produced a wrong
  "never both" claim (round 4's own first draft, corrected before shipping) — always assert and report
  both, never collapse one into a description of the other.
- Do not trust a FRESH recompute (`path.basename(quarantinePathFor(e.repoPath))`) as proof an ACTIVE
  entry currently owns a given filename without first gating on `isRepoPathCurrentlyResolvable(e.repoPath)`
  — an entry that graduated then went unresolvable again stays in `activeQuarantines`, and recomputing its
  key now degrades back to whatever ancestor key it ORIGINALLY shared, falsely "protecting" an unrelated
  file that key coincidentally still hashes to. The real write target for an unresolvable entry is never
  that recompute — nothing in this module ever writes there for one.
- Do not report a clear as a bare, unqualified success when the thing it cleared is one of SEVERAL
  claimants sharing a latch — surface `latchKept`/`referencingRepoPaths` (mirroring the existing
  `clearMergeQuarantineLatchFile` shape) so the caller can see that a restart will re-arm this (and every
  sibling) claimant, and is told the durable escape (clear by the shared latch's own id) explicitly.
- Do not run `negative-control` with only the PRIMARY source file listed in `--file` once a fix also
  touches a SECOND file (e.g. a REST route surfacing a new return field) — the build will correctly FAIL
  reverting only the first, since the second file's current code references a shape the reverted first
  file doesn't yet have. Pass every touched source file its own `--file` flag.

Tests: `test/merge-quarantine-pass1-degraded-key-writes.mjs` (all sixteen scenarios),
`test/merge-quarantine-pass1b-clean-parse-gate.mjs` (R1 scenario, revised, round 2 labels corrected).
