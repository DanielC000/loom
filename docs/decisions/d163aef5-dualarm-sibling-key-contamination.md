# d163aef5 — a degraded entry's `armedKeys` propagation could contaminate an unrelated verified sibling, in-memory and on disk, bypassing every existing write-side guard

From round-2 Code Review of `4480b077` (reviewer `ed20395f`), finding 3's own flagged-but-unverified
sibling: "the migrate write pass can carry a degraded constituent into a key NOT in
`degradedOccupiedKeys` via `armQuarantineKey`'s `armedKeys` propagation from a dual-armed entry — which
would falsify `4480b077`'s 'unionEntry guaranteed resolvable' claim." Confirmed true, with a hermetic
repro, by this card's own worker — then found to reach three MORE established, tested precedents
(`e1cb7d33`, `9a55fb90`, `82032b5c`) before a non-regressing fix was reached.

## The bug

`armQuarantineKey` unions unconditionally with whatever already occupies a key — correct for the case it
was built for (two different repoPaths genuinely collapsing onto the SAME real toplevel). It has no way
to tell that case apart from a purely coincidental collision: a verified, resolvable entry `Z` dual-armed
under a STALE second key (`armedKeys = [K1, K2]`, `K2` persisted but no longer `Z`'s own fresh
`canonicalRepoLockKey`), and a degraded, permanently-unresolvable entry `D` whose own trusted
`resolvedKey` happens to equal that SAME `K2` — purely by coincidence, with no real toplevel backing it.

When `D` arrives (at `K2`, trusting `resolvedKey` per `7673d096`) and finds `Z` already there, the union
spreads to EVERY key in the result's own `armedKeys`, including `K1` — `Z`'s OWN verified, primary
identity, which has nothing to do with `D` at all. `K1` was never added to `degradedOccupiedKeys` (only
`K2`, `D`'s own `resolvedKey`, was) — so `Z`'s in-memory entry at `K1` is silently overwritten with a
union carrying `D`'s token. A later query for `Z` (`activeMergeQuarantineFor`) then absorbs the pending
copy `flushDegradedDiverts` pushed (itself ALREADY the contaminated union) via the cross-tier-sibling
path and durably WRITES it — baking `D`'s degraded token into `Z`'s own, genuinely-verified latch file on
disk. This reaches disk through `consumeMatchedPendingsIntoArmedEntry`'s own write call, not through any
boot-time write pass — so it bypasses `bootWriteLatch`/`degradedOccupiedKeys` entirely, the exact
protection `4480b077`/`97cff6db` built for the boot-time write side.

Reproduced hermetically (`test/merge-quarantine-pass1-degraded-union-guard.mjs`, scenarios
`dualarm-sibling-key-contamination`/`-d-first`): Z is a real, resolvable repo correctly named at
hash(K1), with a persisted `resolvedKey` field = a synthetic K2 (modeling the stale-second-key shape); D
never exists, with its own `resolvedKey` manufactured to collide with that same K2. Both orders (D
processed before or after Z in `fs.readdirSync`) reproduce it — the union mechanism cares which side
*arrived* at a key, not which was read first.

## Why the obvious fix ("never union a degraded entry into a verified slot") is NOT what this ships

Three established, tested precedents rely on EXACTLY this shape unioning:

- **`e1cb7d33`** (`test/merge-quarantine-degraded-occupant-guard.mjs`, `runtime-sibling-absorb-refuses-direct-path`):
  a ghost `X` armed directly at its own trusted `resolvedKey`, which also happens to be a currently-resolvable
  sibling `teamA`'s own GENUINE, fresh key — two different repoPaths collapsing onto the SAME real
  toplevel, `armQuarantineKey`'s own intended case.
- **`9a55fb90`** (`test/merge-quarantine-pass1-migrate-union.mjs`, `dual-armed-sibling-at-non-first-key-text-and-id-agree`):
  a verified `x` occupies a key only via ITS OWN stale secondary key; a degraded `z` unions with `x`
  there; a THIRD, not-yet-processed registered repo `sub` is what actually, freshly owns that key.
  Checking only `x`/`z`'s own identities wrongly flags this as illegitimate — the real owner is neither
  of the two parties actually colliding.
- **`82032b5c`** (`test/merge-quarantine-runtime-union-provenance.mjs`, `secondary-armed-key-never-overwrites-different-occupant[-e-first]`):
  `E` dual-armed `[k1,k2]` via its own stale `k2`; `W` is a permanently-unresolvable ghost whose OWN
  fresh/degenerate key happens to equal `k2` too (a pure `os.tmpdir()`-ancestor-walk coincidence — no real
  toplevel backs it either side). This is the hardest case: unlike `e1cb7d33`/`9a55fb90`, `k2` is backed
  by NEITHER party's own fresh, CURRENTLY-RESOLVABLE identity (`W` never resolves, ever) — yet the
  pre-existing (buggy) code still let `W` reach `E`'s OWN key `k1` via `W`'s own, UNWRAPPED primary arm,
  not just via `E`'s secondary arm. Verified empirically: reverting to pre-fix `main` and calling
  `activeMergeQuarantineFor(e)` directly (E's own primary-key query) returns `['e-token','w-token']` —
  W's degraded token leaking into E's own identity query, 15/15 runs. `82032b5c`'s own test had never
  checked this (it only ever queried `w`, which happened to hit the same contaminated union either way)
  — its own "either outcome" acceptance wording was itself an instance of this card's bug, retired below.

## The fix

### 1. `armKeyUnlessDegradedCollision` (merge-quarantine.ts) — every `armQuarantineKey` call in
`reenterMergeQuarantinesAtBootImpl`'s read loops (PASS 1, PASS 1b, safety-tmp recovery, and the
corrupt-latch placeholder arms) now routes through this instead of a bare call. A cross-identity,
cross-resolvability collision is declined UNLESS `key` is genuinely backed — by SOME
`registeredRepoPaths` entry's own fresh, CURRENT identity, checked via `isKeyVerifiedFor` (the same
predicate `activeMergeQuarantineFor`'s own `direct` fast-path guard already uses). Checking every
registered repo, not just the two colliding sides, is what `9a55fb90` requires (the real owner can be a
third, not-yet-processed party).

Two call shapes, both routed through the one helper:
- **A PRIMARY arm** (`key` is `entry`'s own just-computed `currentKey`) — `entry`'s claim is tautological
  (the caller computed `key` FROM `entry.repoPath` in this exact call; no persisted field could
  misrepresent it), so it always wins an illegitimate collision, evicting `prior`.
- **A SECONDARY arm** (`key` is a persisted, trusted-but-unverified `resolvedKey` — either side's) — no
  such guarantee on either side; whichever is NOT currently resolvable loses.

Evicting `prior` removes it from ONLY the contested key, never blindly every key in its own `armedKeys` —
a `prior` that legitimately holds OTHER keys too (e.g. `E` in the `82032b5c` shape, evicted from `k2`
while keeping its real `k1`) keeps them untouched. Only when the contested key was `prior`'s LAST key is
it diverted to `pendingUnresolvedQuarantines` as its own standalone entry — recovering its `sourceFile`
via `degradedDivertsToFlush` if it was degraded-diverted, else deterministically via
`quarantinePathForKey` (a degraded prior with no other key can only have reached this key one of those
two ways).

### 2. `activeMergeQuarantineFor`'s own `direct`-exists-but-unverified branch (the `8a1bc2ef` guard) now
also checks the pending tiers (the SAME `findPendingIndicesFor` chain the no-`direct` branch already
uses — direct identity, ancestor-alias, resolvable-and-fresh-keyed, degraded-with-own-resolvedKey) for an
entry whose identity matches the QUERIED `repoPath` — but ONLY when `repoPath` ITSELF is not currently
resolvable. A resolvable `repoPath` whose own fresh key genuinely IS `key` (e.g. a subdir of a real
enclosing repo that `direct` coincidentally also shares the key with — the EXACT shape
`direct-verified-guard`'s own test requires `direct` to keep answering for, unsubstituted) says nothing
about whether `direct`'s presence is legitimate, and must not trigger a substitution — restricting to an
unresolvable `repoPath` is what keeps this safe. The hard invariant: this changes WHICH entry is
returned, never WHETHER one is — no match (or a resolvable `repoPath`) still returns `direct` exactly as
before, and the verified-`direct` branch is completely untouched.

### Monotonicity

`activeMergeQuarantineFor` has exactly one production call path: `resolveQuarantineFor` →
`assertRepoNotQuarantined`/`clearMergeQuarantineReporting`, consumed by `batch-merge.ts`, `bounded.ts`,
`repo-lock.ts`, `worktrees.ts`, `orchestration/restart.ts`, `sessions/service.ts`, `vault/versioner.ts` —
the real merge/git-safety gate. The new branch can ONLY ever substitute one non-null entry for another
non-null entry (it is reached only from inside `if (direct)`, and always ends by returning either
`direct` or a real pending entry — never `undefined`) — so a repo that was already going to be reported
quarantined still is, with at most a different (more accurate) blocker named; a repo with no entry at all
is never affected, since the branch never fires without a `direct` already present. It also only ever
activates for an UNRESOLVABLE queried `repoPath` — the production call sites above are all driven by a
real git repo being operated on, which is resolvable in the overwhelming majority of calls; this is a
structural argument, not merely an empirical one, and holds regardless of registered-path population.

## Tests

`test/merge-quarantine-pass1-degraded-union-guard.mjs` — new scenarios `dualarm-sibling-key-contamination`
and `-d-first` (both boot orders), proven RED on `main`/GREEN after via `scripts/negative-control.mjs`;
all 16 pre-existing scenarios in that file, including `direct-verified-guard` (the `8a1bc2ef` precedent
this fix must not regress), still pass.

`test/merge-quarantine-runtime-union-provenance.mjs`'s `secondary-armed-key-never-overwrites-different-occupant`
scenario rewritten: `buildDualArmFixture` gained an `orderHint` param (retrying `w`'s own path, free,
since it never touches disk, until its hash sorts on the desired side of `e`'s fixed hash — NOT a ~50/50
coin flip, since lexicographic hex-digest comparison depends on where `e`'s hash happens to sit, so the
retry cap is generous) plus a sibling `-e-first` scenario, covering BOTH boot orders explicitly rather
than leaving it to filename-hash luck. The old "either outcome" wording (`direct` found via its own
identity OR via a boot-time union with `e`) is RETIRED — the union-with-`e` half was itself this card's
bug. The single correct outcome, asserted for both orders, both tested at a second reboot too: `E`'s own
query carries ONLY its own tokens (never `w-token`); `W`'s own query returns its OWN standalone entry
(never `E`'s identity or tokens); both are durable across two consecutive reboots.

All 29 `merge-quarantine*.mjs` files pass individually (one at a time, never the full gate); all 30 static
guards pass.

**SHOULD-FIX 3 (scope note):** the new tests also assert through the PRODUCTION path
(`assertRepoNotQuarantined` → `resolveQuarantineFor` → `activeMergeQuarantineFor`), not only the internal
function. For a currently-RESOLVABLE queried `repoPath` (e.g. `z`/`e` in the scenarios above),
`resolveQuarantineFor`'s own `ownIdentityEntryFor` short-circuit is gated on the query being
UNRESOLVABLE and so never fires — meaning this fix's change #2 is production-INERT for that query shape,
and the assertion exercises the exact same `activeMergeQuarantineFor` code path already asserted
directly, just through its real caller. For an UNRESOLVABLE queried `repoPath` (`d`/`w`), it DOES route
through `ownIdentityEntryFor` first — still a live exercise of the SAME in-memory state this fix
protects, just via a different early branch. Change #2's own LIVE effect in production is via
`findPendingIndicesFor`'s tiers 2-4 (ancestor-alias / resolvable-and-fresh-keyed / degraded-with-own-
resolvedKey), reachable from callers other than `resolveQuarantineFor`'s own tier-1 short-circuit.

## Round 2 (Code Review of `7545166b`) — the fix's own eviction bookkeeping had two further bugs

### BLOCKING 1 (CRITICAL, reviewer-reproduced) — durable loss of a degraded quarantine across the TRIM branch

`armKeyUnlessDegradedCollision`'s TRIM branch (when `prior` keeps OTHER keys after losing the contested
one) correctly re-pointed `byRepoKey`/pending references to the trimmed survivor via
`replaceEntryEverywhere` — but left any STILL-PENDING `degradedDivertsToFlush` record keyed by the
EVICTED key untouched. `flushDegradedDiverts` (called once, after the ENTIRE PASS 1 read loop) re-reads
`byRepoKey.get(resolvedKey)` AT FLUSH TIME, by which point that key now holds the EVICTION'S WINNER —
nothing to do with the original degraded entry. The pre-fix code pushed `{entry: <winner>, sourceFile:
<the degraded entry's own file>}` into `pendingUnresolvedQuarantines` — a later verified query for the
winner then absorbed this as a genuine "sibling" and durably unlinked the degraded entry's OWN latch
file as a superseded duplicate, even though its real data (merged into the trimmed survivor) was never
written to disk anywhere. After a reboot, that data is gone for good.

Reviewer's repro (`test/merge-quarantine-pass1-degraded-union-guard.mjs`, scenario
`degraded-divert-rebind-survives-trim-eviction`): `X` (nonexistent, self-consistently named at
hash(canonical(X))=K3, dual-arming K3+K2) and `D` (nonexistent, mismatched-name divert, resolvedKey=K2)
are BOTH degraded — SAME resolvability, so they legitimately union at K2 (`883e29bc`'s own accepted
same-tier case, unaffected by this card). `Z` (real, resolvable) then arms its own second key at K2 too,
finds the X+D union there, and evicts it — trimming down to K3 via the TRIM branch. RED on `7545166b`
(the X+D union's own data survives the FIRST query but is gone after a reboot — matching the reviewer's
own report exactly); GREEN after.

**Fix:** the TRIM branch now re-binds every `degradedDivertsToFlush` record still targeting the evicted
key onto one of the union's OWN surviving keys — so the deferred flush correctly finds the TRIMMED union
(still carrying the degraded entry's own token, merged with the survivor's) there instead of the winner.

### BLOCKING 2 (MAJOR, reviewer-measured) — duplicate pending entries across the TWO `flushDegradedDiverts` calls

`degradedDivertsToFlush` is flushed TWICE in one boot — once after PASS 1's own read loop, once after
safety-tmp recovery — so a `prior` diverted and flushed during PASS 1 can still be sitting in `byRepoKey`
when PASS 1b (or safety-tmp recovery) LATER evicts it via the SAME key, with `degradedDivertsToFlush` now
EMPTY (already drained by the first flush). The zero-remaining-keys (full-divert) branch's fallback —
inferring the sourceFile from `quarantinePathForKey(key)` — is WRONG for this shape (the degraded entry's
real file is its own original, mismatched-name latch, never physically at that inferred path) AND
produces a DUPLICATE pending entry for the same logical identity under a second, different sourceFile.

Reviewer's repro (scenario `degraded-divert-no-duplicate-across-flushes`): `D` degraded, resolvedKey=K(R)
— `R` a REAL, resolvable repo deliberately NOT in `registeredRepoPaths` (so nothing legitimizes the
collision). D's own divert is pushed and flushed during PASS 1. R's own `.json.tmp-<pid>` torn-write
residue is then recovered in PASS 1b, colliding with D (still armed at K(R) from PASS 1) via R's own
PRIMARY (tautological) arm — R wins, D is evicted a SECOND time, now past the first flush. RED on
`7545166b` (the FIRST boot's own `listActiveMergeQuarantines()` already dedupes the duplicate by object
reference, by sheer coincidence of the SAME in-process object surviving in two pending wrappers — but a
REBOOT re-parses from disk, where the two wrappers are no longer the same reference, and the duplicate
becomes visible: 2 listings, not 1, across both reboots the test checks); GREEN after.

**Fix:** before pushing `prior` to `pendingUnresolvedQuarantines` in the full-divert branch, check
whether it is ALREADY there (by object identity) — if so, skip the push entirely; it is already
correctly represented with its own real sourceFile from whenever it was first flushed.

**Round-2's own "traced-but-not-reproduced residual" proof below is FALSE — disproved in Round 3; read
that section before trusting the claim this paragraph used to make.** It argued a RESOLVABLE `prior`
could never reach the zero-remaining-keys branch, because a resolvable entry's own `armedKeys` always
includes its own primary `currentKey`. The gap: a `prior` can reach a key via a PRIMARY arm that is
ITSELF a degraded, tautological walk-up (its own `repoPath` is unresolvable, so the "primary key" it
computed is a degenerate ancestor-walk value, not a verified identity) — `armedKeys` then has exactly
ONE member, and a LATER, genuinely resolvable entry's own primary arm can still evict it to zero. See
Round 3's finding B2 for the hermetic repro.

### NITS (fixed)

- The `4480b077` record's own correction (above) overstated "never unions ... in either direction" —
  reworded to state the exception: a union IS still allowed when a registered repo backs the key.
- Two comments (PASS 1's and PASS 1b's own second-arm sites) claimed `entry` is "verified/resolvable
  here" — false for a degraded entry that is self-consistently NAMED (so the degraded-divert branch never
  ran) but still carries a STALE `resolvedKey` field diverging from its own currentKey (exactly `X` in
  the BLOCKING 1 repro above) — reworded; the helper's own logic was already correct here regardless, as
  it never assumed either side's resolvability.
- A test comment named the pre-rename `armSecondaryKeyUnlessDegradedCollision` — corrected to
  `armKeyUnlessDegradedCollision`.
- `dualarm-sibling-key-contamination`'s base scenario left D's own filename at its real (effectively
  random) hash, so the degraded-divert call site's OWN decline branch was exercised only by filename-hash
  luck relative to Z's. Forced deterministically (D's filename pinned to sort strictly AFTER Z's real
  hash, mirroring the `-d-first` variant's own technique in the opposite direction) — see the "Do not"
  entry on filename-hash luck above, which this card's OWN test had briefly violated too.

Tests added: `degraded-divert-rebind-survives-trim-eviction`, `degraded-divert-no-duplicate-across-flushes`
(`test/merge-quarantine-pass1-degraded-union-guard.mjs`); both proven RED on `7545166b`/GREEN after via
`scripts/negative-control.mjs`. All 20 scenarios in that file, all scenarios in
`test/merge-quarantine-runtime-union-provenance.mjs`, all other 27 `merge-quarantine*.mjs` files, and all
30 static guards re-verified green.

## Round 3 (LEAD gen 413, CR round 2 of `0ea04efb`) — Round 2's OWN eviction bookkeeping had two further
CRITICAL holes, and the Round 2 proof above was itself false

Three rounds in a row each added a branch to `armKeyUnlessDegradedCollision`'s own eviction bookkeeping
(the TRIM re-bind, the zero-keys dedup) and each one opened a new durable-loss hole. The RULING: stop
patching that bookkeeping piecemeal — remove the class.

### B1 (CRITICAL) — the zero-remaining-keys branch spliced only ONE `degradedDivertsToFlush` record

When TWO degraded diverts legitimately union at one key (`883e29bc`'s own same-tier shape) and are later
evicted together, the old zero-keys branch's `degradedDivertsToFlush.findIndex(d => d.resolvedKey ===
key)` found and consumed only the FIRST matching record — the SECOND stayed pointing at the evicted key,
and `flushDegradedDiverts`'s own re-read of `byRepoKey.get(key)` at flush time found the eviction's
WINNER instead, durably misattributing the second divert's own latch file to it.

Repro (`round3-two-diverts-at-one-key-eviction`): `D1`/`D2` both nonexistent, both `resolvedKey=K2`
(union legitimately); `Z` a real repo, self-consistently named at its own `K1`, with a stale secondary
`resolvedKey=K2` — evicts the D1+D2 union from K2 to zero remaining keys. RED on `0ea04efb`; GREEN after.

### B2 (CRITICAL) — "a resolvable prior can never reach the zero-keys branch" is FALSE

Round 2's own proof (above, now corrected) missed that a degraded entry's PRIMARY arm is tautological
regardless of whether the key it computed is itself verified — `D`'s own `repoPath` (`R/gone-subdir`,
nonexistent) walks up to `R`'s real key `K(R)` when unresolvable, and `D`'s persisted `resolvedKey` field
is ALSO `K(R)` (self-consistent, so the degraded-divert branch never fires) — `D` reaches `K(R)` via an
ordinary, "tautological", PRIMARY arm, with `armedKeys=[K(R)]` only. When `R` itself is later read
(PASS 1b, via a torn-write tmp) and arms its OWN primary key `K(R)` too, `D` is evicted to ZERO remaining
keys — the old code's refuse-to-push fallback (`console.error` + no push) DROPPED `R` entirely: `R`'s own
quarantine, never written to this physical file by `D` at all, was lost from `pendingUnresolvedQuarantines`
the moment `D` won the key, and a LATER clear of `D` by token then unconditionally unlinked `R`'s OWN
real backing file as collateral (`deleteMergeQuarantineLatchByKey`'s unconditional unlink, with no
protection check covering this shape — see "Extended fix, item 3" below).

Repro (`round3-degraded-walkup-to-resolvable-key`): `R` a real, resolvable, UNREGISTERED repo with its
own clean final; `D`'s PASS 1b tmp residue names `R/gone-subdir`, `resolvedKey=K(R)`. RED on `0ea04efb`
(R's token is lost from boot onward); GREEN after.

### The fix — retire the re-bind-on-key bookkeeping entirely

1. **`degradedDivertsToFlush` records now carry the ENTRY OBJECT itself, captured AT DIVERT TIME** — never
   a `resolvedKey` string to re-look-up against `byRepoKey` at flush time (883e29bc's original design,
   retired). `flushDegradedDiverts` unconditionally pushes `{record.entry, record.sourceFile}` for every
   remaining record — no re-read, no lookup, nothing that can go stale relative to `byRepoKey`.
2. **Eviction (`armKeyUnlessDegradedCollision`'s TRIM and zero-keys branches) never reads or mutates
   `degradedDivertsToFlush` at all** — no re-bind-on-trim, no splice-and-consume-on-zero-keys. The
   zero-keys branch NEVER discards `prior` — degraded or genuinely resolvable alike: it recovers
   `prior`'s own real sourceFile from an ALREADY-FLUSHED `pendingUnresolvedQuarantines` reference (by
   object identity) when one exists, else infers it deterministically via `quarantinePathForKey` and logs
   loudly; a push is skipped only when the EXACT `(entry, sourceFile)` pair is already present — never on
   entry identity alone. **A duplicate pending reference is an accepted, harmless outcome; a lost one is
   not.**
3. **A SEPARATE, GENERAL fix closes the staleness this reopens for an ORDINARY union** (not just
   eviction): whenever `armKeyUnlessDegradedCollision` returns through a genuine union (never an eviction
   — `prior` is still occupying `key` right before the shared `armQuarantineKey` call, not yet deleted),
   it rebinds any `degradedDivertsToFlush` record still referencing the PRE-union object onto the fresh
   merged result. Without this, a CR round-2-era test (`round4-minor1-safety-recovery-double-report` in
   `merge-quarantine-migrate-source-owner-durable.mjs`) and this card's own `deferred-flush-no-stale-
   snapshot` scenario both regressed to a spurious duplicate listing — caught by running every
   `merge-quarantine*.mjs` file individually, not just this card's own new scenarios, before reporting
   done.
4. **A THIRD, narrower fix closes B2's own physical-file hazard** (never discarding `R` in memory isn't
   enough if a later clear still destroys its real file as collateral): `clearMergeQuarantineByKey` ran a
   protect-before-delete pass keyed on **TOKEN OVERLAP, never repoPath identity**
   (`unincorporatedOccupantRepoPathAt`) — a degraded entry's own tautological claim to a key shares ZERO
   tokens with whatever physical content is actually sitting there, while a GENUINE union's own result
   always carries every token it absorbed. Token overlap was required, not repoPath identity, because the
   SAME widened protect pass initially false-positived on the pre-existing UNION-KEYS shape (two toplevel
   repos legitimately merged, where the union keeps only ONE side's repoPath label while absorbing both
   tokens) — caught by `merge-quarantine-unresolvable-path.mjs`'s own `UNION-KEYS` scenario regressing,
   again only visible by running every file individually. **This item's own GATE — running only when the
   entry being cleared is itself unresolvable — is ITSELF WRONG; see Round 4 below, which replaces it.**

### Tests

`merge-quarantine-pass1-degraded-union-guard.mjs`: `round3-two-diverts-at-one-key-eviction` (B1),
`round3-degraded-walkup-to-resolvable-key` (B2, includes the clear-by-token + reboot acceptance bar),
`round3-chained-eviction-three-parties` (a degraded union evicted TWICE in one boot — once trimmed, once
to zero — with 3+ parties and no token or file lost across a reboot); all three RED on `0ea04efb`/GREEN
after via `scripts/negative-control.mjs`. `deferred-flush-no-stale-snapshot` keeps its ORIGINAL, stricter
assertion (exactly one listing) — the general union-rebind fix (item 3) makes it hold under the new
design too, no weakening needed. All 29 `merge-quarantine*.mjs` files pass individually, 3 full sweeps
with zero flakes; all 30 static guards pass.

## Round 4 (CR round 3, `5bb32bae`, on `cde2bdb3`) — Round 3's own clear-side protect was gated on the
WRONG condition

Round 3's item 4 (above) ran its clear-side protect only when the entry BEING CLEARED is itself
unresolvable — the wrong axis entirely. The physical-file hazard has nothing to do with whether the
*clearing* entry resolves; it depends on whether some OTHER, surviving record still legitimately owns
the file about to be unlinked.

### P1 (CRITICAL) — a RESOLVABLE eviction winner's own clear destroys the loser's file at one of its
OTHER armed keys

`Z` is dual-armed `[K1,K2]` (its own real `K1`, plus a stale secondary `K2` coinciding with degraded
`D`'s own real key). `D`'s own tautological primary arm reaches `K2` first; `Z`'s own secondary arm then
evicts `D` to pending there (Round 3's own "never discard" fix correctly keeps `D`'s token alive in
memory). `clearMergeQuarantineByToken(z, "z-token")` fully clears `Z` — lifting BOTH `K1` and `K2`. `Z`
itself IS resolvable, so Round 3's gate never even attempted a protect for `K2` — `D`'s only physical
file was unconditionally unlinked as pure collateral, even though `D` was never part of this clear.

### P2 (CRITICAL) — the degraded walk-up entry REMOUNTING before its own clear skips the protect entirely

The Round 3 `degraded-walkup-to-resolvable-key` fixture (`D`'s own repoPath is a nonexistent subdirectory
of `R`, a real resolvable repo; `D`'s tautological primary arm evicts `R` to pending), but `D`'s own
`gone-subdir` is created (so `D` now resolves) BEFORE it is cleared, with no intervening query of `R`.
Round 3's gate checked `D`'s OWN resolvability at clear time — now true — so the protect was skipped
entirely, and `clearMergeQuarantineByToken(d, "d-token")` unconditionally unlinked `R`'s own real file.
(The negative control — clearing `D` WITHOUT the remount first — stays fail-closed, since Round 3's gate
happens to fire correctly for THAT one case; the gate's own axis was simply never robust to either side's
resolvability changing out from under it.)

### The fix — key on FILE OWNERSHIP, never on the cleared entry's own resolvability

1. **PRIMARY**: `deleteMergeQuarantineLatchByKey` now takes a `clearIdentity` — before the unconditional
   unlink, it scans `pendingUnresolvedQuarantines` for any SURVIVING entry whose own recorded
   `sourceFile` is this exact physical file, with an identity DIFFERENT from `clearIdentity` (i.e., not
   part of this same clear). The eviction logic already records exactly this for both `D`s above — this
   is a direct ownership check, reading the IN-MEMORY tracking state, never an inference from the file's
   own on-disk content.
2. **BACKSTOP**: the token-overlap protect (`unincorporatedOccupantRepoPathAt`, Round 3 item 4) now runs
   for EVERY clear, unconditionally — the resolvability gate is REMOVED entirely. Over-protecting a
   stale leftover costs one extra re-block on the next query (fail-closed, recoverable); under-protecting
   is a durable loss (not recoverable).
3. Both checks were threaded through all FOUR call sites of `deleteMergeQuarantineLatchByKey` (not just
   `clearMergeQuarantineByKey`'s own primary path) — `clearPendingEntryByToken` and both pending-sweep
   sites in `clearMergeQuarantineByKey`/`clearMergeQuarantineByRecordedPath` — since each one can reach
   the SAME "a key's physical file outlives the in-memory record that physically backs it" shape.

### Tests

`merge-quarantine-pass1-degraded-union-guard.mjs`: `round4-p1-resolvable-winner-clear-destroys-loser-file`
(P1 — `D` forced to process before `Z` via a free retry loop on `D`'s own never-created path, since
`D` must be read, and so armed and later evicted, BEFORE `Z`'s own secondary arm reaches an
already-occupied key, or the collision never reproduces at all),
`round4-p2-remounted-walkup-clear-destroys-winner-file` (P2 — the remount-before-clear step added to the
Round 3 fixture); both assert the LOSER's token and `assertRepoNotQuarantined` block survive the clear
AND a reboot. Both proven RED on `cde2bdb3`/GREEN after via `scripts/negative-control.mjs`. All 24
scenarios in this file, all other 28 `merge-quarantine*.mjs` files, and all 30 static guards re-verified
green.

**Minor residual (CR round 3, optional, accepted as-is):** `unincorporatedOccupantRepoPathAt` treats a
legacy, genuinely-token-less final (no `tokens` array AND no legacy singular `token` field) as having
ZERO overlap with anything, by construction — it can never match `clearedEntry.tokens`, so a
genuinely-incorporated-but-token-less file gets a spurious protective copy on clear. Accepted: the cost
is one extra, harmless re-block the next time that identity is queried (fail-closed), never a loss — not
fixed, since the fix would need a THIRD discriminator beyond identity/tokens for a vanishingly rare
legacy shape.

## Round 5 (CR round 4, `891bb19a`, on `f5e353bf`) — the inference the Round 3 zero-keys branch falls
back to can claim the EVICTOR's own file, and Round 4's primary check trusted that claim unconditionally

Round 3's zero-keys branch (above) recovers an evicted `prior`'s real `sourceFile` three ways, in order:
an already-flushed `pendingUnresolvedQuarantines` reference (by object identity); otherwise, an inference
via `quarantinePathForKey(key)`'s own basename, trusted unconditionally. That inference is correct only
when `prior` reached `key` via its own self-consistent primary arm — but a `prior` that is STILL queued
in `degradedDivertsToFlush` (its own secondary-arm divert, not yet flushed into
`pendingUnresolvedQuarantines`) has NEITHER a tracked reference NOR a self-consistent claim to that file:
the file at `quarantinePathForKey(key)` physically belongs to whichever entry is doing the evicting.

### The bug (MAJOR, fail-STUCK) — `W`'s own raise becomes permanently circular

`W` is a real, UNREGISTERED repo with an active latch at its own natural file `sha(K).json`, `K =
canonicalRepoLockKey(W)`. `D` is a nonexistent path (never under `W`) carrying `resolvedKey: K` — the
SAME key as `W`'s own, purely manufactured — but `D`'s OWN walked-up `currentKey` differs from `K`, so
`D` is a genuine degraded divert (the secondary, non-tautological arm), armed at `K` FIRST (`D`'s forced
filename sorts before `W`'s own real hash filename). `D`'s own divert record is pushed into
`degradedDivertsToFlush`, not yet flushed. `W` is then read; its own TAUTOLOGICAL primary arm evicts `D`
from `K` to zero remaining keys. No tracked reference exists yet (the flush hasn't run), so the old
inference blindly trusted `quarantinePathForKey(K)`'s own basename as `D`'s "real source file" — but that
file is physically `W`'s OWN final (`sha(K).json`), not `D`'s. `D` is pushed to
`pendingUnresolvedQuarantines` falsely CLAIMING `W`'s own file as its `sourceFile`.

Clearing `W` (by path OR by token) then reaches Round 4's PRIMARY ownership check, which finds this
"foreign" pending claim naming `W`'s own final and — trusting the claim unconditionally — copies `W`'s
own content aside under `D`'s own pending-divert name (a circular resurrection: the copy's own `repoPath`
field is still `W`'s, since the copy is byte-for-byte `W`'s content under a new name) before unlinking
the original. The next query or boot graduates that copy back under `W`'s own identity — `w-token`
survives every clear and every reboot.

### The fix

1. **PRIMARY**: the clear-side primary check (`deleteMergeQuarantineLatchByKey`) now skips the protect
   when `final`'s own ON-DISK content (`quarantineFileRepoPathIdentity`, a new shared helper) already
   names `clearIdentity` as its `repoPath` — a file that is already genuinely the clearer's own has no
   foreign data to lose, and copying it could only ever resurrect the clearer.
2. **BELT**: the eviction's own inference (`armKeyUnlessDegradedCollision`'s zero-keys branch) now (a)
   checks `degradedDivertsToFlush` for `prior` by object identity FIRST, before ever inferring — a
   read-only check (never a push there; `flushDegradedDiverts` owns pushing it, on its own schedule) —
   and (b), only when neither a tracked pending reference nor a queued flush record exists, verifies the
   inferred file's own on-disk content actually names `prior` before trusting it. On a mismatch, it never
   claims that file: `prior` is tracked instead under its own disjoint `pendingDivertFilenameFor` name
   (the same minting helper `enterMergeQuarantine`'s own brand-new-entry divert branch already uses),
   with a loud log explaining why the inferred file was rejected.

### Tests

`merge-quarantine-pass1-degraded-union-guard.mjs`: `round5-own-raise-lifts-past-inferred-evictee` —
exercises BOTH clear routes the CR named (`clearMergeQuarantineReporting`/clear-by-path and
`clearMergeQuarantineByToken`/clear-by-token), each with its own fresh fixture AND module instance (two
independent boot-time repro instances inside one scenario must never share module-level
`activeQuarantines`/`pendingUnresolvedQuarantines` state). Both routes assert `w-token` does NOT survive
a clear + reboot, `D`'s own token and physical file DO survive untouched, and `assertRepoNotQuarantined(d)`
still blocks. Proven RED on `f5e353bf` (both routes fail with `w-token` wrongly surviving) and GREEN after
via `scripts/negative-control.mjs`-equivalent manual revert/rebuild/retest/restore. All 25 scenarios in
this file (24 prior + 1 new), all other 28 `merge-quarantine*.mjs` files individually, and all 30 static
guards re-verified green.

## Round 6 (CR round 5, `df708ec4`, on `2ba1f25e`) — Round 5's own eviction-side "belt" was itself the
bug; the clear-side fix alone was always sufficient

Round 5's clear-side primary-check fix (`quarantineFileRepoPathIdentity`, item 1 above) is SOUND and
KEPT — it is what actually fixes Round 4's own blocker. Round 5's OTHER change — the eviction-side
"belt" (item 2 above: `queuedForFlush` early-skip + verified-mismatch fallback) — was NOT load-bearing
for that fix, and opened two NEW CRITICAL fail-open reboot losses, both reproduced (pass on `f5e353bf`,
fail on `2ba1f25e`):

### (a) the `queuedForFlush` early-skip drops a union constituent no OTHER record covers

When `prior` (being evicted to zero remaining keys) is a same-tier UNION, the general union-rebind
(Round 3, Part A) points its OWN `degradedDivertsToFlush` record at the union — but that record still
carries only the ORIGINAL divert's own `sourceFile`. A constituent absorbed into the union LATER, whose
OWN physical file differs from that original `sourceFile` (e.g. a tautological entry physically AT
`sha(key).json`, unioned in via `armQuarantineKey`), is never separately tracked. Round 5's
`queuedForFlush` check saw the union already queued and skipped pushing `{union, sha(key).json}`
entirely, trusting the later flush to cover it — but the flush only ever pushes the ORIGINAL divert's own
`sourceFile`, never the later constituent's. Phase 0 never sees `sha(key).json` as at-risk, so a
SUBSEQUENT successful migrate write for that key overwrites it with ZERO protection. The constituent's
own token is gone after a plain reboot — no clear needed.

### (b) the verified-mismatch fallback's name is never written, so Phase 0 never protects it

An entity evicted via the zero-keys branch with NEITHER a tracked pending reference NOR a queued flush
record (e.g. a MIGRATING real repo, or a TAUTOLOGICAL tmp-residue entry — neither ever touches
`degradedDivertsToFlush`) falls to inference. When that entity's OWN real backing file differs from
`quarantinePathForKey(key)` (a genuine mismatch — e.g. the migrating entity's real file is its own stale
source, not the key's bare final, which may not even exist yet), Round 5's fallback tracked it under
`pendingDivertFilenameFor(prior.repoPath)` — a name NEVER written to disk and never a member of
`allBootWriteTargets`. Phase 0's at-risk computation can never see it as colliding with anything, so it
is never safety-tmp'd. If a LATER entity (also cross-tier, also tautological, but genuinely resolvable)
evicts the CURRENT occupant in turn and becomes the key's final, RESOLVABLE occupant, its own migrate
write SUCCEEDS — and every entity tracked via this in-memory-only name this boot is destroyed outright,
with no safety-tmp and no surviving original file (the migrate's own stale source is deleted once the
write that supersedes it succeeds). Two entities can be lost this way in one boot, with no clear needed.

### The fix (round 6, minimal) — revert the belt; it was never necessary

`armKeyUnlessDegradedCollision`'s zero-keys branch is reverted BYTE-FOR-BYTE to `f5e353bf`'s own
behaviour: no `queuedForFlush` check, no verified-mismatch fallback — the unconditional
`priorSourceFile = path.basename(quarantinePathForKey(key))` inference, exactly as Round 3 shipped it.
Round 4's own eviction-side behaviour was independently CR-verified fail-open CLEAN; the belt added
nothing load-bearing and cost two new CRITICAL holes. `quarantineFileRepoPathIdentity` (the shared
helper) and its one call site in the clear-side primary check are KEPT — that is the entire fix for
Round 4's real blocker, unchanged by this revert.

### Tests

`merge-quarantine-pass1-degraded-union-guard.mjs`:
- `round6-union-constituent-survives-eviction` (finding a) — `D` (a degraded divert, forced to sort
  first) unions with `X` (`W/gone-subdir`, tautological, physically AT `sha(K).json`) into `U`, rebound
  into `D`'s own `degradedDivertsToFlush` record; `W` (a real, UNREGISTERED repo migrating from a stale
  key) then evicts `U` to zero remaining keys. Asserts `x-token` survives the eviction AND a plain
  reboot (no clear), plus `assertRepoNotQuarantined(x)` still blocks.
- `round6-mismatch-evictee-survives-clear` (finding b) — `W` (migrating) arms at `K` first; `Y`
  (`W/gone-two`, a tautological TMP-RESIDUE entry — PASS 1b, so read strictly after every plain `.json`)
  evicts `W` (a genuine mismatch: `W`'s own real file differs from `sha(K).json`, which does not even
  exist yet); `teamA` (`W/teamA`, a REAL, EXISTING plain subdir of `W` — ALSO resolvable, ALSO a
  tautological tmp-residue entry, processed after `Y`'s own tmp) evicts `Y` in turn (a SECOND genuine
  mismatch) and, being resolvable, becomes the final occupant — its own migrate write for `K` SUCCEEDS.
  Asserts both `w-token` and `y-token` survive that successful write AND a plain reboot (no clear), plus
  (the DoD's own "and clear" bar) that clearing the unrelated `w`/`teamA` merged entry afterward leaves
  `y-token` — a wholly separate identity — unaffected.

Both scenarios proven RED on `2ba1f25e` (both findings reproduce exactly as the CR described) and GREEN
on the revert, via `pnpm --filter @loom/daemon negative-control --file packages/daemon/src/git/merge-quarantine.ts --test packages/daemon/test/merge-quarantine-pass1-degraded-union-guard.mjs --ref HEAD`
(`HEAD` = `2ba1f25e`). `round5-own-raise-lifts-past-inferred-evictee` re-verified GREEN with the belt
reverted — the proof that the clear-side fix alone fixes Round 4's blocker. All 27 scenarios in this
file, all 29 `merge-quarantine*.mjs` files individually, and all 30 static guards re-verified green.

## Do not

- Do not call `armQuarantineKey` directly from `reenterMergeQuarantinesAtBootImpl`'s read loops — route
  every call through `armKeyUnlessDegradedCollision` (or its `armCurrentKeyUnlessDegradedCollision`
  primary-arm wrapper), or a future call site reopens this exact bug class at a new location.
- Do not check only `prior`/`entry`'s own identities when deciding whether a key collision is legitimate
  — scan every `registeredRepoPaths` entry via `isKeyVerifiedFor`; the real owner can be a third,
  not-yet-processed party (`9a55fb90`'s own shape).
- Do not evict a `prior` entry from every key in its own `armedKeys` when it loses only ONE contested key
  — filter `armedKeys` down to the surviving keys and `replaceEntryEverywhere`; a blanket full-evict
  destroys a `prior` that legitimately holds OTHER keys too (the `82032b5c` `E`/`k1` shape).
- Do not extend `activeMergeQuarantineFor`'s new pending-match branch to a RESOLVABLE queried `repoPath`
  — that is exactly the `direct-verified-guard`/`8a1bc2ef` shape (a subdir genuinely sharing its
  enclosing repo's own key with an unrelated, unverified occupant), and substituting there regresses it.
- Do not let this branch ever return `undefined` — it must always fall back to `direct` when no pending
  match is found; the hard invariant is "changes WHICH entry, never WHETHER one."
- Do not assume filename-hash-based boot ordering is ~50/50 in a test fixture — lexicographic comparison
  of hex digests depends on where the FIXED side's own hash happens to sit, which can make one order's
  hit rate arbitrarily close to 0% or 100%; size retry caps generously, not as a coin-flip assumption.
- Do not re-litigate `82032b5c`'s old "either outcome" acceptance as still valid — one of its two
  accepted outcomes (the boot-time union with `E`) was always this card's own bug, just never checked
  directly; the single correct outcome (both parties stay independently clean) is what both boot orders
  now assert.
- **SUPERSEDED BY ROUND 3** — do not re-bind-on-trim or splice-and-dedup-on-zero-keys as a per-eviction
  fix at all; Round 2's own two bullets below described exactly that approach, and each one individually
  opened a NEW durable-loss hole one round later (B1/B2 above). Round 3 removes the class instead: capture
  each divert's entry at divert time, never re-read `byRepoKey` by key at flush, and never let eviction
  touch `degradedDivertsToFlush` at all — see "Round 3 — the fix" above for what replaced these two rules.
  (Historical, kept for the "why not just re-bind harder" record:) Round 2 required re-binding every
  `degradedDivertsToFlush` record still targeting an evicted key onto a trimmed survivor's OWN surviving
  key, and required checking `pendingUnresolvedQuarantines` by object identity before a zero-keys push to
  avoid a duplicate — both now replaced.
- Do not assume a bug that a FIRST boot's own `listActiveMergeQuarantines()` can't see is therefore
  absent — its Set-based dedup collapses two pending wrappers sharing the SAME in-process object
  reference; a REBOOT re-parses from disk, where that coincidence no longer holds and a real duplicate
  becomes visible. Check across a reboot, not just the first boot, for this class of bug.
- Do not discard a degraded (or, since Round 3, a genuinely resolvable) `prior` in the zero-remaining-keys
  branch under ANY condition, including the traced-but-unreachable case Round 2 believed existed — Round
  3's B2 disproved it. A duplicate pending reference beats a silent loss every time.
- Do not dedup a zero-keys push by entry identity alone — dedup on the EXACT `(entry, sourceFile)` pair.
  A second, genuinely different sourceFile for the same logical entry (e.g. two physically distinct latch
  files that both legitimately name it) must still get its own reference, or that second file's own
  content goes untracked.
- Do not gate the clear-side's degraded-occupant protection on repoPath IDENTITY — use TOKEN OVERLAP
  (`unincorporatedOccupantRepoPathAt`) instead. A repoPath compare false-positives on the pre-existing
  UNION-KEYS shape (Round 3, item 4 above).
- **SUPERSEDED BY ROUND 4** — do not gate EITHER clear-side protect pass on whether the entry BEING
  CLEARED is itself resolvable/unresolvable, in any direction. Round 3's own "only when unresolvable"
  gate missed a RESOLVABLE eviction winner's clear destroying a foreign file at one of its OTHER armed
  keys (P1) and a degraded entry that remounts before its own clear (P2) — the hazard depends entirely on
  whether some OTHER record still legitimately owns the physical file, never on the clearing entry's own
  resolvability. Round 4 removed the gate: the PRIMARY ownership check (scans
  `pendingUnresolvedQuarantines` for a surviving, differently-identified record naming this exact file)
  and the token-overlap BACKSTOP both now run unconditionally, on every clear.
- Do not trust a fix verified only against this card's OWN new scenarios — run every `merge-quarantine*.mjs`
  file individually before reporting done. Round 3's own general union-rebind fix and its clear-side
  protection fix each regressed a DIFFERENT, pre-existing file's own scenario
  (`merge-quarantine-migrate-source-owner-durable.mjs`'s `round4-minor1-safety-recovery-double-report`,
  `merge-quarantine-unresolvable-path.mjs`'s `UNION-KEYS`) that this card's own test file never exercised.
  Round 4 reinforces the SAME lesson from the opposite direction: the gate ITSELF (not just its omission)
  can be the bug, and a CR round that reproduces against the real shape (not just reasons about it) is
  what actually found both P1 and P2.
- **REFINED BY ROUND 5** — do not trust the PRIMARY ownership check's `foreignPending` match
  unconditionally once found (Round 4's own description above still holds for FINDING the match; Round 5
  adds a gate on ACTING on it). A `foreignPending` claim can itself be wrong — a prior eviction's own
  inference can have named the WRONG file as that entry's `sourceFile`. Verify `final`'s own on-disk
  content (`quarantineFileRepoPathIdentity`) against `clearIdentity` before copying it aside; a file that
  already names the clearer has no foreign data to lose, and copying it can only resurrect the clearer.
- **SUPERSEDED BY ROUND 6** — do not add a `degradedDivertsToFlush`-queued early-skip, or a
  verify-then-divert-to-an-unwritten-name fallback, to the zero-keys eviction branch's sourceFile
  inference, in any form. Round 5's own version of this bullet (immediately above the two findings) was
  ITSELF the bug: skipping the push when `prior` is already queued for its own later flush ignores that
  the flush can cover a DIFFERENT physical file than the one actually at risk (finding a); and tracking a
  verified mismatch under `pendingDivertFilenameFor` produces a name that is NEVER written to disk and
  NEVER a member of `allBootWriteTargets`, so Phase 0 can never protect it (finding b) — a later
  successful write for that key then destroys it outright, with no safety-tmp and no surviving original.
  Round 6 reverts this branch to Round 3's own unconditional `priorSourceFile =
  path.basename(quarantinePathForKey(key))` inference, byte-for-byte — no verification, no early-skip.
  That inference can still land a sourceFile claim that doesn't match what's physically at that path (the
  exact Round 5 "own raise" blocker above) — but the fix for THAT is the CLEAR-side primary check's own
  content-identity gate (the bullet immediately above this one), not an eviction-side defense; Round 4's
  own eviction-side shape was independently CR-verified fail-open clean, and two further CR rounds each
  tried to harden it anyway and each opened a new hole. Do not try a third time without a reproduced,
  CR-verified counter-example driving the change, not reasoning alone.

See `docs/decisions/4480b077-migrate-branch-unions-fresh-hash-target.md`'s own corrected "unionEntry
guaranteed resolvable" claim, and `docs/decisions/883e29bc-pass1-degraded-arm-never-unions-a-verified-sibling.md`
for the original "never unions a verified sibling" principle this card extends.
