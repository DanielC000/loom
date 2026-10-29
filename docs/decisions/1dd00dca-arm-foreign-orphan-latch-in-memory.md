# 1dd00dca — arm a kept foreign orphan latch in memory, this process only, the moment its own sweep proves it safe to keep

From Code Review `745c3736` of card `f2cc5f18` (gen 424, 2026-10-18). After `f2cc5f18`, when a full clear's
own orphan sweep KEEPS an orphan latch file O because its content names a foreign repo T's real,
uncovered token, O survives on disk, but nothing arms T in memory. T is not enforced within the same
process until the next daemon boot, where PASS 1's own ordinary per-file read loop — NOT "PASS 2"; that
label in the original card body was loose, and the real mechanism is content-driven, not filename-hash-
driven — constructs an entry from O's surviving content and arms it. Confirmed reproducible on current
main via a hermetic scratch repro (own LOOM_HOME, real git repos) before any fix was written:
`activeMergeQuarantineFor(T)` read `undefined` in the SAME booted module instance right after the clear
that kept O, even though O (holding T's real foreign token) survived on disk.

## The fix

`sweepOrphanLatchFileIfUnreferenced`'s own keep branch now calls a new helper,
`armForeignOrphanContentInMemoryIfUnenforced`, synchronously and inline (never deferred to a later pass),
the moment `orphanSweepSafeToDelete` proves a kept file's content is genuinely foreign (not the clearer's
own stale content, `ownContent`) and genuinely armable (repoPath/branch/reason all parse as strings).
`orphanSweepSafeToDelete`'s own return type was widened, additively only, to also carry that already-
parsed `{repoPath, branch, reason, enteredAt, tokens}` record (`armable`) — the SURVIVING token set (raw
on-disk tokens minus whatever is already tombstoned under T's own identity), never the raw set — so the
new helper never needs a second read/parse of the same file.

The helper arms T ONLY when `resolveQuarantineFor(T)` currently answers `undefined` — the SAME lookup
`assertRepoNotQuarantined` itself calls to decide whether a canonical-mutating operation should refuse.
Because `activeMergeQuarantineFor`'s own lookup order always returns something truthy whenever ANY
identity already occupies T's canonical key (even an unrelated one), this ONE check correctly answers
BOTH of the manager-ruled exclusions in one read: T's own identity is already enforced somewhere, OR T's
canonical key is already occupied by a different identity. Either way, the helper is a no-op — today's
keep-and-wait-for-the-next-boot behavior, unchanged.

**Superseded (card `25d0d45b`, Round 4):** this originally disclosed the no-op via an additive
`contentKeptNotArmedReason: "already-enforced"` field, deliberately never threaded past this one call
site. That field was REMOVED once `25d0d45b`'s own Round 3/4 work made it genuinely dead (the disposition
decision now always re-derives this same "already enforced" fact via `classifyKeptRepoPath`/
`stillBlockedEntryFor`, which can never disagree with the arm attempt that just ran synchronously before
it) — and the disclosure IS now threaded all the way up, as a structured `blockedBy: {repoPath, id?}`
naming WHICH different identity's own entry is doing the refusing, carried on `contentKeptBlockedBy`
through every clear-result-returning function this module exports. See card `25d0d45b`'s own decision
record for the full design.

When `resolveQuarantineFor(T)` answers `undefined`, the helper arms T:
- Resolvable → directly into `activeQuarantines` at `canonicalRepoLockKey(T)`. Safe to `.set()`
  unconditionally: the `resolveQuarantineFor(T) === undefined` precondition already proves that key is
  UNOCCUPIED (see the lookup-order argument above), so this can never clobber an existing occupant.
- Unresolvable → `pendingUnresolvedQuarantines.push({entry, sourceFile: orphanBasename})`, mirroring PASS
  1's own posture for an unresolvable path.

Either way, the constructed entry's `orphanLatchFiles` (active case) or `sourceFile` (pending case) names
the kept orphan file itself — so T's own LATER clear, in this same process, naturally sweeps and deletes
it via the existing, already-tested orphan/own-sourceFile sweep machinery. No new disk-writing code was
needed for that cleanup path.

NEVER touches disk. The kept orphan file is left exactly as the existing keep logic already decided to
leave it. The next boot's own PASS 1 reads the identical bytes and arms T exactly as it does today — this
fix changes nothing about what boot persists or re-derives, so there is nothing for it to double-arm or
double-count.

## Why the boot-only degraded-collision machinery was NOT reused

`reenterMergeQuarantinesAtBootImpl`'s own `armKeyUnlessDegradedCollision`/`armCurrentKeyUnlessDegradedCollision`
closures (boot-scoped, over `registeredRepoPaths`/`hashToRepo`/`degradedOccupiedKeys`, none of which exist
at runtime clear-time) implement a freshness/eviction/union dance that has taken six-plus Code Review
rounds to get right (see `e7652e06`, `c9114934`, `6c04633d`, `f575cebf`). Replicating or adapting that
machinery for a single-file, single-identity, runtime arm was judged a correctness minefield not worth
opening for this card. The conservative "skip whenever ANYTHING already occupies the relevant slot"
design above sidesteps the whole class: it never unions, never evicts, and never needs to reason about
freshness at all.

## Deliberately deferred (follow-up cards, not this one)

- The `.tmp-residue` twin, `sweepTmpResidueForHashIfUnreferenced` — the IDENTICAL same-process
  enforcement gap exists there too (see `docs/decisions/1fea8b15-content-check-the-clear-time-tmp-sweep.md`'s
  own "fail-open at runtime" accepted residual, which this card does NOT touch or revise — that residual
  stays true for the tmp twin until its own follow-up card lands). `armForeignOrphanContentInMemoryIfUnenforced`
  is written to take an already-parsed record + a bare basename specifically so that follow-up can adopt
  it with no copy.
- Consolidating the three near-identical "every on-disk token is covered" loops (`markedFinalFullyCoveredByClear`,
  `orphanFileTokensAccountedForByUpdate`, `orphanSweepSafeToDelete`) behind one polarity-parameterized
  helper — the card's own second CR nitpick. Deferred to its own refactor card so a polarity-sensitive
  refactor is never mixed into this behaviour change.

## Round 2 — targeted re-review (Code Review `745c3736`, HEALTHY/no blockers; manager rulings 1-5)

1. **FIX (token-set route asymmetry) — RETRACTED BY ROUND 3, see below; kept here as the historical
   record of what was tried and why it was wrong.** `orphanSweepSafeToDelete`'s own `armable.tokens` used to be the
   raw `surviving` set — every on-disk token not already tombstoned under the orphan's OWN identity
   (`parsedRepoPath`). That never subtracted the CALLER's own `candidateTokens` (the tokens THIS clear is
   itself lifting), so an orphan record that legitimately carries both a foreign repo's own token AND the
   clearer's own token (e.g. a broadly-unioned record later split across identities) could arm the
   foreign identity with the clearer's own, already-lifted token folded in. Fixed by computing
   `accountedFor` (the `candidateTokens` set) BEFORE `armable` and filtering it out of `armable.tokens`.
   This holds for every clear route uniformly — the fix is keyed on `candidateTokens`, which every route
   already threads into `orphanSweepSafeToDelete`, never on tombstone call ORDER (which differs between
   routes but was never actually the mechanism). Verified via scenario (H): the SAME orphan-content shape
   (clearer's own token + a genuinely foreign token) run through both the token route
   (`clearMergeQuarantineByToken`) and the human route (`clearMergeQuarantineReporting`) now arms the
   foreign identity with ONLY its own token in both cases.
2. **FIX (mutation-hazard gate).** `armForeignOrphanContentInMemoryIfUnenforced`'s own gate used to call
   `resolveQuarantineFor` directly — the same MUTATING lookup `assertRepoNotQuarantined` itself calls (lazy
   pending graduation, cross-tier sibling absorption — see decisions `4b6c8d24`/`2a169469`'s own "Do not"
   on this exact hazard). Calling a mutator FROM INSIDE a clear's own sweep, mid-decision, is the class
   those decisions warn against. Replaced with `stillBlockedEntryFor` — the existing PURE peek
   (`ownIdentityEntryFor` when unresolvable, else `activeMergeQuarantineForPeek`) that already mirrors
   `resolveQuarantineFor`'s own lookup order exactly, with no mutation. Enforcement-equivalence is now
   asserted directly: every scenario in the test file cross-checks `stillBlockedEntryFor(repoPath) !==
   undefined` against a new `resolveQuarantineForTestOnly` boolean pass-through to the real, mutating
   lookup, called AFTER the scenario's own arm decision has already happened (so it can never change what
   the real gate already decided — it only proves the two never disagree).
3. **TEST GAP (closed).** The original scenario (E) uses an UNRESOLVABLE ghost subdir for T, so a
   bypassed gate there would only hit the PENDING-push branch, never the dangerous ACTIVE `.set()` branch
   that can blindly clobber an existing occupant. New scenario (E2) uses a REAL, EXISTING subdir of R (no
   `.git` of its own, so `isRepoPathCurrentlyResolvable` is true while `canonicalRepoLockKey` still
   collapses to R's own key) — the shape that actually reaches the dangerous branch. Scenario (I) proves
   E2's own "dangerous case" label is not just a name: a scoped, in-test dist-mutation (a throwaway copy of
   the minimal dist import closure, same technique as
   `merge-quarantine-4913e721-provenance-unknown-survives-protect.mjs`'s own `withDistMutation` — the real
   shared `dist/` is verified byte-identical before and after) bypasses the gate and reruns E2's own setup;
   with the gate bypassed, R's live entry really is overwritten (a different object, missing R's own
   token). The real, un-mutated dist always passes E2 clean.
4. **ACCEPTED, record only.** An unresolvable T armed PENDING (`sourceFile` the orphan basename) can later
   be absorbed by pending-graduation into a NEW parent repo D's entry when D raises, so D's own in-process
   auto-clear no longer lifts D (T's token stays folded into D's entry). **Known downstream union
   (accepted):** this is exactly what a reboot's own PASS 1 pending tier would also do, through the SAME,
   pre-existing cross-tier-sibling-absorption machinery (`8a1bc2ef`) — a pending entry sharing a canonical
   key with a later-resolving parent has always been eligible for absorption into that parent, regardless
   of whether the pending entry arrived via a real boot read or via this card's own in-process arm. This
   card treats it as the established boot-equivalent precedent, not a new bound to add here.
5. **NIT (fixed).** The test file's own header narrative (the card-history paragraph) was trimmed to a
   pointer at this record, keeping only the scenario/contract summary.

## Round 3 — targeted re-review found Round 2's own fix #1 regressed durability; reverted + a real mechanism found

A second targeted re-review of commit `780330d9` found and PROBED one BLOCKING MAJOR: Round 2's own
subtraction fix (finding 1 above) makes T's own later clear NON-DURABLE across a reboot. Tombstones are
IDENTITY-scoped (`tokenTombstonedForIdentity` only checks whether a token was tombstoned UNDER the queried
identity specifically) — A's own clear tombstones `tA` for A only, never for T. So when `armable.tokens`
subtracted `candidateTokens` (A's own `tA`) from T's armed set, T was armed with `[tF]` only, while O's own
on-disk bytes still held `[tA, tF]` — nothing this function ever touches. T read LIFTED in-process once its
own single token was cleared (via EITHER clear route), but the next boot's PASS 1 — a fresh process, with
no tombstones carried over — read O's bytes fresh and re-armed T with EVERY on-disk token, including `tA`:
**RESURRECTED.** Reproduced and confirmed (hermetic probe, own `LOOM_HOME`, real git repos, before any fix
was written): swapping in `780330d9`'s own source and replaying the exact scenario now codified as (H)
showed `assertRepoNotQuarantined(T)` reading `{ok:true}` in-process, immediately followed by `{ok:false}`
after a reboot — the split, on BOTH clear routes. Round 1's own token set (`surviving`, unsubtracted) was
DURABLE for the same scenario: T's own clear (either route) genuinely accounted for every on-disk token,
so O was actually deleted, and a reboot stayed clear.

**THE RULING AND WHY:** drop the subtraction — go back to Round 1's armed set (`surviving`, unsubtracted).
The governing principle for this in-memory arm is **"mirror what the next boot's own PASS 1 would arm from
the SAME bytes"** — so the in-process state and the after-reboot state can never split. Shrink the surface,
don't add a new non-enforcing token concept. The accepted cost: a clear that releases only ONE of several
tokens an orphan's content carries (e.g. `clearMergeQuarantineByToken(T, tF)` alone, when O also carries
`tA`) can leave T still blocked by the other token — that is CONSISTENT in-process and after reboot, never
a split, and nothing in-process ever legitimately "held" that other token on its own authority anyway (it
came from disk, as part of mirroring boot). A human, identity-wide clear (`clearMergeQuarantineReporting`)
lifts every token for an identity at once and deletes O durably — that path was never affected either way.

**A FURTHER VERIFIED MECHANISM, found while building the (H) durability scenario, worth recording because
it is easy to mis-model:** `clearMergeQuarantineByToken`'s own top-level loop
(`for (const [k, entry] of activeQuarantines) { if (!entry.tokens.includes(token)) continue; ... }`) scans
EVERY entry in `activeQuarantines` for the token being released, not just the clearer's own. Per the
ECMAScript `Map` iteration spec, a key inserted DURING iteration is visited later in that SAME iteration. So
when A's own full lift (deep inside this same loop, via `clearActiveEntryTokenAtKey` →
`clearMergeQuarantineByKey`) arms T with the boot-equivalent set `[tA, tF]` (which, after this round's
revert, includes `tA`), T's own `tokens.includes(tA)` now matches too — and the SAME outer loop re-visits
T, reducing it to `[tF]` via the ordinary partial-clear branch, which also tombstones `tA` under T's OWN
identity as a side effect. **This means the token route's REAL, immediate post-arm state for T is already
`[tF]`, not the raw boot-equivalent `[tA, tF]`** — a materially different shape than the human route (which
has no such cross-entry scan and genuinely stays at `[tA, tF]` until T's own clear). Both routes still
satisfy the SAME governing invariant (no in-process/on-disk split) — they just reach it by different paths.
See scenario (H)'s own comments for the full account; do not assume "boot-equivalent" describes the token
route's observable state at every instant — it only describes what `orphanSweepSafeToDelete` computes from
the file, not what a DIFFERENT, unrelated clear's own cross-entry scan may do to it microseconds later.

**Round 4 (re-review `efbfe9d1`, HEALTHY):** `clearMergeQuarantineByToken`'s active-entry loop now carries
a guard comment at the real loop site noting it relies on `Map` visiting entries inserted mid-iteration; a
`[...activeQuarantines]` snapshot refactor there would NOT fail scenario (H1)'s own top-level invariant (it
would make T STRAND on the dead token rather than split) — the ONLY thing that catches that regression is
the load-bearing pin at the test's own "T1's in-memory set is ALREADY reduced" check, relabeled accordingly.

## Do not

- Do not widen the in-memory arm to UNION into an existing representation for the same identity — the
  manager's ruling is a plain skip, never a union, for both "T already has some representation" and
  "T's canonical key is already occupied" (see `stillBlockedEntryFor`'s own single-check argument above).
- Do not replicate `armKeyUnlessDegradedCollision`'s freshness/eviction dance here — see "Why the
  boot-only degraded-collision machinery was NOT reused" above.
- Do not call the new arm helper from anywhere other than directly inside the SAME synchronous keep
  decision that proved the file safe to keep — Node's single-threaded, run-to-completion model is what
  makes this race-free; deferring the call to a later pass/loop reopens a window nothing here was ever
  built to guard against.
- **Superseded (card `25d0d45b`).** This used to say not to thread `contentKeptNotArmedReason` past this
  function's own immediate return. That field is gone; its successor, `blockedBy`, is now threaded
  all the way up deliberately — see this record's own updated paragraph above.
- Do not read `orphanSweepSafeToDelete`'s new `armable` field as populated whenever `safe` is `false` —
  it is populated whenever the record is genuinely armable (repoPath/branch/reason all strings),
  independent of `safe`; a caller must still check both.
- Do not edit `1fea8b15`'s own "fail-open at runtime" text as part of landing this card — that residual
  is still true for the tmp-residue twin until its own follow-up lands; this record's own "Deliberately
  deferred" section above is where that scoping decision lives, not a rewrite of `1fea8b15`'s text.
- **(Round 2)** Do not swap `armForeignOrphanContentInMemoryIfUnenforced`'s own gate back to
  `resolveQuarantineFor`/`activeMergeQuarantineFor` (the mutating lookups) — see finding 2 above; a reader
  tempted to "simplify" the gate back to the single shared lookup `assertRepoNotQuarantined` uses would
  reopen the exact mutation hazard this round closed.
- **(Round 2)** Do not add a special-case bound for the "Known downstream union (accepted)" shape (finding
  4 above) without a new card — it is accepted as the pre-existing boot-equivalent precedent, not a defect
  this card owns.
- ~~**(Round 2)** Do not read `orphanSweepSafeToDelete`'s `armable.tokens` as the raw `surviving` set — it
  is `surviving` MINUS whatever the caller's own `candidateTokens` already accounts for (finding 1
  above).~~ **RETRACTED BY ROUND 3.** The opposite now holds:
- **(Round 3)** Do not subtract the clearer's own `candidateTokens` from `orphanSweepSafeToDelete`'s
  `armable.tokens` — it IS the raw `surviving` set, full stop. Tombstones are IDENTITY-scoped, so
  subtracting a token here that a reboot would still see on O's own on-disk bytes durably SPLITS T's
  in-process state from what the next boot would re-derive (Round 3's own finding; see that section).
- **(Round 3)** Do not assume the token route's immediate post-arm state for T equals the raw
  boot-equivalent `surviving` set — `clearMergeQuarantineByToken`'s own cross-entry token scan can (and, in
  scenario (H)'s own shape, does) re-visit and reduce a JUST-armed entry within the SAME call, if that
  entry's armed tokens happen to include the token being released elsewhere. See Round 3's own "further
  verified mechanism" paragraph before writing a new scenario that assumes otherwise.

## Tests

`packages/daemon/test/merge-quarantine-1dd00dca-arm-foreign-orphan-in-memory.mjs`:
- (A) THE MAIN FIX — asserted at the `assertRepoNotQuarantined` consumer, not a bare `activeMergeQuarantineFor`
  peek: T reads as quarantined, same booted instance, immediately after A's clear keeps O.
- (B) negative control — same-identity ("ownContent") content is never armed (never resurrects the
  clearer's own identity from its own stale residue).
- (C) negative control — T already has a live, independent entry (its own real raise): no union, no
  double-arm; T's entry stays exactly its own original token set.
- (D) unresolvable T lands in the PENDING tier (verified via `listPendingMergeQuarantinesTestOnly`), never
  active, and is still enforced via the lazy-resolve lookup chain.
- (E) T's canonical key is already occupied by a different, genuinely active identity R (an ancestor-walk
  ghost-subdir collision, T UNRESOLVABLE): R's own entry is untouched (byte-identical token set); T is
  never separately armed, but still reads as blocked via R's own occupancy.
- (E2, Round 2) the SAME key-occupied shape but T is a REAL, EXISTING, RESOLVABLE subdir of R — the
  dangerous case E's own ghost never exercises (the active `.set()` branch, not the pending-push branch).
  R's entry survives as the SAME object; see (I) for the gate-bypassed negative control.
- (F) T's own clear, right after the in-process arm, lifts T AND content-aware-sweeps O for free; a
  subsequent reboot does not re-arm T (nothing left to re-arm it from).
- (G) a reboot after the in-process arm, with no clear in between, yields exactly ONE entry for T with an
  unchanged token count — no double-arm, no double-count.
- (H, Round 3 — REPLACES Round 2's own (H), which asserted a since-retracted claim) DURABILITY: an orphan
  carrying both the clearer's own token and a genuinely foreign token, run through BOTH clear routes.
  (H1, token route) verifies the REAL, verified immediate consequence (T's armed set is reduced to its own
  token by the cross-entry scan described in Round 3 above, not the raw boot-equivalent set), then clears
  T's own remaining token and asserts the PRE-reboot and POST-reboot `assertRepoNotQuarantined(T).ok`
  values AGREE — the actual governing invariant, stated without presupposing which value they agree on.
  (H2, human route) verifies T stays at the true boot-equivalent `[tA, tF]` until its own identity-wide
  clear, which lifts it AND durably deletes O (not merely reports clear while leaving O behind), confirmed
  by a reboot that does not re-arm it.
- (I, Round 2, unaffected by Round 3) NEGATIVE CONTROL via a scoped dist-mutation — bypassing the gate in
  `armForeignOrphanContentInMemoryIfUnenforced` and rerunning (E2)'s own setup really does clobber R's live
  entry, proving the gate is load-bearing rather than cosmetic. The real `dist/git/merge-quarantine.js` is
  verified byte-identical before and after.
- Every scenario (A-I) also cross-checks the PURE `stillBlockedEntryFor` peek against the real, mutating
  `resolveQuarantineFor` (via `resolveQuarantineForTestOnly`) for enforcement-equivalence (Round 2, finding
  2), evaluated after each scenario's own arm decision. This cross-check is a line-for-line MIRROR check
  (drift detection), never independent verification that the shared lookup order itself is correct.

Verified RED (on commit `91bb76277cac3986ef91ab85b5a32d96387847a6`, the sha immediately before this
card's own first commit) via `pnpm --filter @loom/daemon negative-control`, GREEN after, tree restored
clean (re-confirmed after Round 2's own fixes). Round 3's own (H) scenario separately verified RED on
commit `780330d9` (Round 2's own tip, carrying the now-reverted subtraction) and GREEN on the restored,
reverted source, tree restored byte-identical, via the same `negative-control` script with
`--ref 780330d9`. All 6 test files referencing `contentKeptRepoPath`/`contentKeptRepoPaths` re-run in full
and still pass unchanged (amendment E): `merge-quarantine-orphan-sweep-content-aware.mjs`,
`merge-quarantine-tmp-residue-content-check-21ec39e5.mjs`, `merge-quarantine-clear-by-path.mjs`,
`merge-quarantine-9497bb7e-broad-union-clear-route.mjs`,
`merge-quarantine-2a169469-contributor-aware-clear-disclosure.mjs`,
`merge-quarantine-1fea8b15-tmp-sweep-content-check.mjs`. All 94 `merge-quarantine*.mjs` files run
individually, serially, in both `env -u LOOM_DEV -u LOOM_SUPERVISED` and `LOOM_DEV=1 LOOM_SUPERVISED=1`,
green. `pnpm --filter @loom/daemon guards` green.
