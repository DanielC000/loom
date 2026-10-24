# e7652e06 — boot-time collision resolution: freshness for the both-resolvable gate, provenance-marking for the rest

**Round 3 (below) changed the shipped mechanism again — read it before trusting any "declined"/"evicted"
claim elsewhere in this record as still true for every shape.** Rounds 1-2 (kept below for the regression
history) used FRESHNESS to DECLINE/EVICT a stale secondary claim whenever it collided with a different,
currently-resolvable identity. A Code Review (round 3) found that rule itself regresses established,
accepted over-blocks (a shared-ancestor sibling's own enforcement surviving its later divergence; a
legacy cross-repo dual-arm partner; `db0a9db0`'s own "mark it `provenanceUnknown`, fail closed on
clear-by-id" resolution for a manufactured collision) — turning each into a silent UNBLOCK instead. Round
3's fix reverts the DECLINE/EVICT behavior for the shape the reviewer's own two vectors exploit (a ghost
racing — or poisoning `degradedOccupiedKeys` ahead of — the real collision) and replaces it with: let the
union form, mark it `provenanceUnknown` (reusing `db0a9db0`'s own existing field and clear-by-id
refusal), never decline or evict for it. CASE 2 and CASE 3 (the both-resolvable, freshness-gated
decline/evict below) are UNCHANGED by round 3 — they still close the plain Y/F shape (no ghost involved)
exactly as rounds 1-2 shipped it. Round 3 only changes what happens OUTSIDE that gate, where a ghost can
otherwise bypass it entirely. See "Round 3" below for the full mechanism and why.

From `f575cebf`'s own investigation (worker `05000a50`): a latch ALREADY contaminated on disk
(`resolvedKeys` naming another registered repo's canonical key — e.g. written by a pre-`d69a6744` build
on a real user's disk) is re-armed at boot by PASS1 with NO identity check at all, independent of
`f575cebf`'s own write-time fold-in fix. `armKeyUnlessDegradedCollision` (`merge-quarantine.ts`) only ran
its eviction/registered-backing check when `priorResolvable !== entryResolvable`. For two distinct,
BOTH-resolvable repos it fell straight through to `armQuarantineKey`'s unconditional union.

## The bug, reproduced

`Y` is a real, resolvable, registered repo whose own on-disk latch (hand-written directly — never
produced by any raise/clear/fold-in) carries `resolvedKeys:[kY, kF]`, where `kF` is a separate, real,
resolvable, registered repo `F`'s own genuine canonical key. First-ever boot on this disk layout, F's own
file read before Y's: PASS1 unions Y's secondary arm at `kF` into F's own genuine entry with zero identity
check. Result: Y's own identity becomes unreachable at `kF` (it still resolves via `kY`, but the merged
object at `kF` now carries F's identity), F's own entry is durably contaminated with Y's token, and F's
own human clearing F's own, only-ever-legitimate token leaves F wrongly STRANDED by a token it never
owned.

## Why resolvability parity cannot discriminate this from the legitimate case

The SAME fallthrough is also how a GENUINE toplevel-recompute collision ("one physical repo, two
latches") is meant to resolve — e.g. a repo `R` with its own genuine quarantine, and a plain subdirectory
`S` of `R` with no `.git` of its own, whose OWN pre-existing latch (filed back when `S` had its own
distinct toplevel, now flattened into `R`) migrates at boot to `R`'s own key. `R` and `S` are both
currently resolvable, both differ in `directPathIdentity`, and MUST still union — this is the
`883e29bc`/`9a55fb90` precedent `armKeyUnlessDegradedCollision`'s own doc comment protects. Resolvability
parity alone cannot tell these two shapes apart: in BOTH, `prior` and `entry` are equally resolvable.

The triage note's naive generalization of `f575cebf`'s `positivelyForeignKey` ("a live, different-identity
occupant makes a key foreign") was evaluated and rejected for the same reason: it fires identically on
both shapes (a live, different-identity occupant exists in both the Y/F bug and the legitimate R/S
collision), so applying it at boot time would regress the R/S precedent. **`positivelyForeignKey` is NOT
widened to cover boot time** — see "Do not" below.

## The fix — FRESHNESS, gated to the ONE precondition the bug needs (both sides resolvable)

Inside `armKeyUnlessDegradedCollision`'s cross-identity branch, the pre-`e7652e06` resolvability-MISMATCH
code (the `priorResolvable !== entryResolvable && !backed` branch, including its own eviction and
registered-backing check) is kept **completely unchanged, byte-for-byte**, and stays the ONLY logic for
every shape it already covered — any ghost/degraded party on EITHER side (`e1cb7d33`/`9a55fb90`/
`c9114934`'s own precedents). Freshness only ever applies in the ONE precondition the card's own bug
needs: **`priorResolvable && entryResolvable && !degradedOccupiedKeys.has(key)`** — both sides genuinely
resolvable RIGHT NOW (where resolvability parity gave the pre-fix code nothing to check at all), and the
key not exclusively backing some OTHER degraded entity's only durable physical copy (see Round 2 below
for why that second guard is load-bearing, not defensive).

Only inside that gate:

- `entryFresh = entryClaimIsTautological` — a PRIMARY arm's `key` IS entry's own live canonical key by
  construction (the caller computed it FROM `entry.repoPath` in this exact call) — always fresh. A
  SECONDARY arm's candidate keys explicitly exclude `currentKey` (`secondaryKeysToAttempt`), so a
  secondary arm's claim at `key` is NEVER fresh.
- `priorFresh = isKeyVerifiedFor(prior.repoPath, key)` — the SAME existing helper the pre-`e7652e06` code
  already called, just re-targeted at `prior` specifically instead of only ever scanning
  `registeredRepoPaths` generically.

Three outcomes, all within the both-resolvable, not-degraded-protected gate:

1. **Both fresh** — two independently-verified identities genuinely, freshly share one physical toplevel
   right now (the R/S shape). Legitimate same-toplevel union, unchanged.
2. **`priorFresh && !entryFresh`** — prior genuinely, freshly owns `key` right now; entry's claim here is
   purely historical (a stale `resolvedKeys`/`resolvedKey` secondary — the Y/F bug, forward read order:
   F's own latch read first). Entry has no standing to union OR evict. Decline entry's claim at THIS key
   only; prior is left completely untouched.
3. **`entryFresh && !priorFresh`** — entry's claim is tautologically fresh; prior's occupancy here is NOT
   (the Y/F bug, REVERSE read order: Y's own contaminated latch read first, claims `kF` outright since
   nothing occupies it yet; F's own latch is read second and its tautological primary arm now collides
   with Y sitting at `kF`). Entry's live claim wins: evict `prior` from THIS key only (it may still
   legitimately hold others, with every token intact there). **This is what makes the fix
   order-independent** — whichever side PASS1 happens to read second still reaches the correct outcome.
4. **Neither fresh** (within the gate — both resolvable, neither is its own fresh owner at `key`) — falls
   through to the SAME union as outside the gate, unchanged from pre-`e7652e06` (a both-resolvable
   collision always fell through to union; this sub-case was never part of the bug and is left untouched).

Everything else — EITHER side unresolvable, or the key is degraded-protected — routes through the
UNCHANGED pre-existing mismatch code: legitimate only when backed by SOME registered repo's own fresh
identity (`9a55fb90`'s own "real owner can be a third, not-yet-processed party" — the `x`/`z`/`sub`
shape); otherwise whichever side is NOT currently resolvable loses. An unprovable key is kept, never
guessed.

Eviction (both the pre-existing mismatch branch and case 3 above) is factored into a shared
`evictPriorFromKey` helper — trims `prior`'s own `armedKeys` down to its surviving keys
(`replaceEntryEverywhere`) when it has others, or diverts it to `pendingUnresolvedQuarantines` (NEVER
discarded, per `d163aef5`'s round-3 ruling) when `key` was its only one — so the two eviction sites can
never drift from each other.

## Round 2 — two regression waves found by the full-corpus verification, not by review

The FIRST version of this fix applied freshness unconditionally (any cross-identity collision, regardless
of resolvability), using an `entrySquatting`/`priorSquatting` qualifier (`resolvable && !fresh`) to try to
let a permanently-unresolvable ghost with no competing identity still absorb into a genuine sibling. The
full `merge-quarantine*.mjs` corpus run (never the new scenarios alone) caught TWO separate regression
waves this reasoning missed, both found by running every file, not by code review:

**Wave 1 (8 files: `degraded-occupant-guard`, `latch-id-collision`, `legacy-match-walked-up-4783df46`,
`migrate-source-owner-durable`, `pass1-degraded-key-writes`, `pass1-migrate-union`, `protect-write-
failure`, `unresolvable-path`)** — the qualifier treated "not fresh" alone as enough to decline/evict,
but a PERMANENTLY unresolvable ghost absorbing into a genuinely-resolvable sibling (`e1cb7d33`/`9a55fb90`)
is not a squatter at all — it has no competing identity anywhere. Fixed by requiring the OTHER side to
ALSO be resolvable before calling it a squatter.

**Wave 2 (3 MORE files, found only after Wave 1's fix: `dual-key-persistence-43cf3b26`,
`pass1-degraded-union-guard`, `runtime-union-provenance`)** — even with Wave 1's fix, a `prior` that is
itself a RESOLVABLE identity (e.g. `x`) that reached `key` only by absorbing an EARLIER, legitimate union
with a DEGRADED sibling (`z`, via the pre-existing registered-backing fallback) still read as "squatting"
when a THIRD, genuinely-fresh owner (`sub`) later collided with that union via its own tautological
primary arm. Evicting the union there (even without any disk write) destroyed the union's own dual-arm
state (`armedKeys`) that `9a55fb90`'s own clear-by-id ambiguity detection depends on — `sub`'s own
migrate-write was ALSO refused by `degradedOccupiedKeys` (protecting `z`'s exclusive physical file), so
evicting in-memory while the physical file stays unioned is exactly the in-memory/on-disk mismatch the
write-protection machinery exists to prevent.

**The fix that survived both waves**: stop trying to special-case "ghost absorption" via a qualifier at
all. Gate the ENTIRE freshness mechanism on `priorResolvable && entryResolvable` (not a looser
"resolvable-or-not" qualifier) — any shape involving a ghost/degraded party on either side, including one
absorbed into an otherwise-resolvable union, now never reaches the new code at all; it falls straight
through to the ORIGINAL mismatch branch, untouched. Add `!degradedOccupiedKeys.has(key)` as a second,
independent gate for the same reason wave 2 needed it — a key exclusively backing a degraded entity's own
physical file must never be decided by identity freshness alone, in-memory or not.

Verified clean after this: all 12 files touched by either wave pass individually, negative-control RED/
GREEN re-confirmed, and the full 71-file `merge-quarantine*.mjs` corpus passes under BOTH env states
(`env -u LOOM_DEV -u LOOM_SUPERVISED` / `LOOM_DEV=1 LOOM_SUPERVISED=1`), one lane, fresh `LOOM_HOME` per
file.

## Round 3 (Code Review, two reproduced vectors) — the DECLINE mechanism itself regressed established accepted over-blocks; replaced with provenance-marking

Code Review found Round 2's fix (the both-resolvable freshness gate above) did not close the card — it
left the exact OLD resolvability-MISMATCH fallthrough (kept "completely unchanged" by Round 2, by
design) reachable by introducing a THIRD, ghost party:

- **Vector 1**: a ghost `Z` (manufactured `resolvedKey = kF`) is read via the degraded-divert branch
  BEFORE `F`'s own real latch — this both arms `Z` at `kF` AND adds `kF` to `degradedOccupiedKeys`. When
  `F`'s own primary arm later collides with `Z` there, the gate's own `!degradedOccupiedKeys.has(key)`
  condition EXCLUDES this collision from CASE 2/3 entirely, routing it to the unchanged mismatch
  fallthrough — which unions `F` into the `Z` entry (backed by `F` itself) with no identity check on
  whoever ELSE later collides there. `Y`'s own secondary arm at `kF` then hits that SAME fallthrough
  (mismatched resolvability against whatever currently occupies `kF`) and unions in too, backed by `F`'s
  OWN registered identity — the exact cross-contamination this card exists to close, reopened via a
  ghost the freshness gate never gets a chance to see.
- **Vector 2**: `Z` is named at its OWN fresh hash and made OLDER than `F` by `enteredAt` — `Z`'s PRIMARY
  (tautological) arm claims `kF` outright (nothing there yet), never touching `degradedOccupiedKeys` at
  all. `Y`'s secondary arm then collides with `Z` (mismatch: `Z` unresolvable) and unions in, backed by
  `F`. `F`'s own primary arm later collides with the `Y`+`Z` union (still `Z`'s identity, "older wins")
  and ALSO unions in, backed by itself.

Both vectors confirmed, 3/3 runs, orders `Z,F,Y` and `Z,Y,F`, both env states — same contamination class
as the card's own headline `Y`/`F` shape, just reached through a party the both-resolvable gate's own
`priorResolvable`/`degradedOccupiedKeys` conditions never get a chance to evaluate `Y` against.

### Why the ruling rejected an upfront DECLINE as the fix for this gap

A first attempt (since reverted) declined ANY secondary arm meeting `(i)` entry currently resolvable,
`(ii)` entry's own fresh key ≠ `key`, `(iii)` `key` `isKeyVerifiedFor` a different-identity registered
repo — independent of whatever currently occupies `key`. Verified against the FULL corpus, not just new
scenarios, and found to regress THREE separate, already-established, accepted shapes by turning each
one's accepted OVER-block into an UNBLOCK:

- `pass1-migrate-resolvedkey-8bff3cae.mjs`'s `shared-ancestor-sibling-survives-divergence` and
  `realistic-raise-source-a-retention` — a repo's own secondary key was recorded at a moment when
  `canonicalRepoLockKey` GENUINELY, VERIFIABLY equaled it (a real git toplevel-walk, confirmed by the
  test's own precondition, not an injected field) and diverged only after a REAL later `git init`. The
  predicate's `(ii)` is satisfied here for the SAME reason it's satisfied in the Y/F bug — divergence
  looks identical to contamination from this predicate's own vantage point — so declining it un-blocked
  the shared-ancestor sibling the SAME boot its divergence happened, a real regression of
  `8db913e2`/`8bff3cae`'s own established "source (a) retention" ruling.
- `pass1-migrate-union.mjs`'s `dual-armed-sibling-at-non-first-key-text-and-id-agree` (`9a55fb90` CR
  `e31c5809` finding 2) — its own `x` needs to be genuinely dual-armed at two keys for the
  armedKeys-order-vs-offered-latch-id disagreement to exist at all; declining `x`'s secondary arm removes
  the dual-arm and makes the whole scenario unreachable via this fixture.
- `unknown-provenance.mjs`'s `round2-migrate-branch-fails-closed-then-clear-by-path-lifts-both` —
  `db0a9db0`'s OWN established resolution for a "manufactured resolvedKey collision" (its own fixture's
  literal wording) is to ALLOW the union and mark it `provenanceUnknown`, never to decline it. Declining
  here directly contradicts a shipped, already-tested card answering the identical shape.

**The hazard in the reviewer's own two vectors is not that `Y` blocks at `kF`** — db0a9db0 already treats
a manufactured cross-repo collision landing at a key as something to ALLOW and mark, not refuse. **The
hazard is that `Y`'s identity merges into `F`'s entry un-marked, so a clear-by-id aimed at one can
silently lift the other.** `db0a9db0` already has the general answer for exactly this: allow the union,
mark it `provenanceUnknown`, let clear-by-id's own existing fail-closed refusal (`"...this union's own
provenance is incomplete..."`) do the real work. Shipping a SECOND, contradictory answer (decline) for
the identical shape is what this round's fix avoids.

### The fix (shipped)

`secondaryArmClaimsADifferentRegisteredIdentitysKey(entry, key, entryClaimIsTautological)` — the SAME
`(i)`-`(iii)` predicate, kept exactly as a predicate, never an early return. Checked right before
`armKeyUnlessDegradedCollision` calls `armQuarantineKey`, ONLY when a union is actually about to happen
(`priorStillAtKey` — a DIFFERENT, still-standing identity that was neither declined nor evicted by CASE
2/3 or the unchanged mismatch-evict branch): if the predicate holds, `entry = { ...entry,
provenanceUnknown: true }` before the union. `unionQuarantineEntries`'s own pre-existing sticky-OR
(`db0a9db0`) then carries that mark onto the merged result automatically — no parallel marker, no new
field. CASE 2 and CASE 3 themselves are completely UNCHANGED: the plain Y/F shape (no ghost) still
resolves via decline/evict exactly as Rounds 1-2 shipped it, since in that shape `Y`'s secondary arm
reaches CASE 2/3 directly and never needs the union+mark path at all. The two mechanisms are
complementary, not competing: whichever one a given read order's collision actually reaches is the one
that closes it.

### Verification

Both reviewer probes (`probe.mjs`, `probe2.mjs`), re-expressed per the ruling's own framing (the STATED
harm — a clear aimed at one lifts the other — not "no union at all"): assert the union forms and is
marked `provenanceUnknown`, clear-by-id on `F`'s own latch id REFUSES (ambiguous/incomplete provenance),
`Y` stays blocked after that refused clear, `F` stays blocked after its OWN refused clear-by-id (nothing
silently lifted), and clear-by-path correctly lifts the whole union afterward. Confirmed across both
`probe.mjs` orderings and all 4 `probe2.mjs` `older`/`newer` × `before`/`after` combos — in the orderings
where CASE 2/3 already resolve the collision without any ghost interference, no union forms at all and
clear-by-id succeeds cleanly (consistent, not a regression — the ghost never got a chance to interfere).

All 5 files Round 3's own DECLINE attempt regressed (`58957b1e-armed-latch-stale-mark-union`,
`pass1-migrate-resolvedkey-8bff3cae`, `pass1-migrate-union`, `unknown-provenance`, plus this card's own
`merge-quarantine-e7652e06-boot-freshness-discriminator.mjs`) pass UNCHANGED under the shipped fix — the
provenance-marking addition never changes WHETHER a union forms, only whether it carries the
`provenanceUnknown` mark, and none of those files' own assertions depend on that mark being absent.

## Shared predicate with fold time — deliberately NOT unified (Lead ruling)

Boot time and fold time (`f575cebf`'s `reconcileMarkedBasenameBeforeWrite`/`positivelyForeignKey`)
deliberately use DIFFERENT rules, and the reason is structural, not a missed opportunity: fold time has
NO tautological-primary concept at all — `reconcileMarkedBasenameBeforeWrite` only ever deals with
newly-folded SECONDARY candidates being retained into `entry.resolvedKeys`, so it never has an `entryFresh`
input to reason about. A `prior`-is-currently-live check alone (which is all `positivelyForeignKey` has)
is exactly the signal this card's own "Why resolvability parity cannot discriminate" section shows is
insufficient once a genuine same-toplevel PRIMARY-arm collision enters the picture — a case fold time
never has to handle, but boot time structurally does (PASS1 processes every registered repo's own primary
arm, not just secondary candidates). Unifying the two predicates would mean adding a boot-only input to a
fold-time-only chokepoint for no fold-time benefit, or weakening boot's own discriminator to fold time's
narrower shape and reopening the R/S regression. **`positivelyForeignKey` itself is untouched by this
card.**

### `f575cebf`'s own accepted-residual shape 2 ("F live but PENDING") — now closed AT BOOT, not at fold time

`f575cebf`'s own "Accepted residual" section named three shapes its write-time filter cannot catch,
because `positivelyForeignKey` only ever reads the LIVE `activeQuarantines`-shaped map it's given:

1. An EMPTY slot (the foreign repo never raised, or was already cleared).
2. F live but PENDING (degraded-diverted, unreadable-diverted, or not yet graduated into
   `activeQuarantines`) at fold time.
3. The slot already holds a PASS1-merged union whose winning identity is Y itself (this card's own
   territory before the fix).

Shape 2 is now closed **at boot**, not by widening the fold-time predicate: `isKeyVerifiedFor(prior.repoPath,
key)` checks `prior`'s repoPath DIRECTLY (resolvable + canonical key match) — it does not care whether
`prior` already has a live `byRepoKey` entry at fold time, only whether `prior`'s own identity genuinely,
freshly backs `key` at the moment PASS1 actually reads it. Combined with case 3's eviction (above), the
fix is order-independent: regardless of whether F's own real latch or Y's contaminated secondary is read
first in a given boot, PASS1 always converges on F alone owning `kF` and Y alone owning `kY` — F "merely
pending" at the moment Y's contamination was folded in no longer matters, because the NEXT boot (or the
one after that, whenever F is next registered/read) resolves it correctly regardless of arrival order.
Shapes 1 and 3 are untouched by this card — shape 1 has no live signal to discriminate on by construction
(nothing to verify against), and shape 3 is precisely the case this card fixes going FORWARD (a NEW
PASS1-merged union can no longer wrongly adopt Y's identity at `kF` in the first place).

### Residual search for a fold-time-only shape that still reaches a live union (bounded, not exhaustive)

Checked whether any RUNTIME (non-boot) path walks a raising/existing entry's own `resolvedKeys` array to
arm/union at a DIFFERENT, secondary key the way PASS1's `secondaryKeysToAttempt` +
`armKeyUnlessDegradedCollision` does:

- `findPendingIndicesFor(repoPath, key)` — every one of its four tiers matches a PENDING entry against
  THIS query's own identity/ancestor-identity/fresh-canonical-key; none of them iterate the pending
  entry's or the query's own `resolvedKeys` to probe a DIFFERENT key. It cannot pull `F`'s entry into a
  union driven by `Y`'s contaminated secondary.
- `consumeMatchedPendingsIntoArmedEntry` — a pure reducer over indices the CALLER already matched via
  `findPendingIndicesFor` above; it does not independently re-derive which pendings are legitimate.
- `enterMergeQuarantine`'s own `existing` branch (the runtime union `9a55fb90`'s round-2 "known residual"
  names) — reached via `activeQuarantines.get(canonicalRepoLockKey(repoPath))`, i.e. the RAISING repo's own
  fresh key, never a stale secondary from its own `resolvedKeys`.

Did not find a path where the fold-in's own contamination reaches a live cross-identity union WITHOUT an
intervening boot. This is a bounded, reasoned check of the obvious candidate chokepoints, not an
exhaustive formal proof — if a future reader finds one, it belongs as its own residual note here, not a
silent assumption that none exists.

## Do not

- Do not gate the cross-identity branch on resolvability PARITY (`priorResolvable !== entryResolvable`)
  — it cannot discriminate a stale secondary squatting on someone else's live key from a genuine
  same-toplevel collision; both shapes can have `prior`/`entry` equally resolvable. Use freshness
  (`entryFresh`/`priorFresh` above).
- Do not widen `f575cebf`'s `positivelyForeignKey` to cover boot time, even though the triage note that
  opened this card proposed exactly that — it regresses the `883e29bc`/`9a55fb90` same-toplevel-union
  precedent (see "Why resolvability parity cannot discriminate" above). Boot time and fold time stay two
  deliberately different rules.
- Do not evict `prior` from every key in its own `armedKeys` when it loses only the ONE contested key —
  `evictPriorFromKey` filters down to the surviving keys (the pre-existing `82032b5c` `E`/`k1` shape
  `d163aef5` already established, now shared with case 3 too).
- Do not assume case 3's order-independence generalizes without the eviction-side guarantee: a `prior`
  evicted from one key must stay armed (with every token intact) at its own OTHER keys — `evictPriorFromKey`
  is the SAME helper case 4's own pre-existing eviction uses, so the two paths can never drift.
- Do not read this card as closing `f575cebf`'s accepted-residual shapes 1 or 3 — only shape 2 (F live but
  pending at fold time) is closed, and only because a LATER boot re-arm resolves it regardless of read
  order; shape 1 has no live signal to discriminate on, and shape 3 describes exactly the pre-`e7652e06`
  bug this card fixes going forward.
- **SUPERSEDED BY ROUND 2** — do not try to special-case "a permanently-unresolvable ghost may still
  absorb into a sibling" via an `entrySquatting`/`priorSquatting`-style qualifier (`resolvable &&
  !fresh`) on top of an otherwise-unconditional freshness check. Two separate regression waves (8 files,
  then 3 more) came from exactly this shape of reasoning — gate the WHOLE mechanism on
  `priorResolvable && entryResolvable` instead, so any ghost/degraded party on either side never reaches
  the new code at all.
- Do not apply freshness at a key `degradedOccupiedKeys` names, even when both `prior` and `entry` are
  independently resolvable — Round 2's wave 2 is a real, reproduced regression of exactly this shape
  (evicting a resolvable union in-memory, with no write at all, still breaks `9a55fb90`'s own dual-arm
  tracking). Fall through to the pre-existing union behaviour instead. **This exclusion is SCOPED to CASE
  2/3's own decline/evict branch only** — Round 3's `provenanceUnknown` marking deliberately does NOT
  exclude a `degradedOccupiedKeys`-protected key: marking is purely additive (a boolean field, no write,
  no eviction, no change to which identity occupies which key), so it carries none of the in-memory/
  on-disk-mismatch hazard the decline/evict exclusion above exists to prevent. Confirmed by the full
  corpus still passing with marking applied unconditionally wherever a union is about to form.
- **SUPERSEDED BY ROUND 3** — do not DECLINE (or evict) a secondary arm for colliding with a different,
  currently-resolvable, registered identity, no matter how narrowly the predicate is written — Round 3's
  own "why the ruling rejected an upfront DECLINE" section is the record of exactly why: the SAME
  predicate that correctly identifies the Y/F bug ALSO, structurally, matches a real, VERIFIED
  shared-ancestor divergence (`8bff3cae`), a legacy cross-repo dual-arm partner, and `db0a9db0`'s own
  already-accepted "manufactured collision" resolution — there is no way to narrow the predicate itself
  to exclude those without reintroducing a case-by-case guessing game. Mark `provenanceUnknown` and let
  the union form instead; never decline, never evict, for this specific shape.
- Do not trust a fix in this function verified only against its OWN new test scenarios, however thorough
  they look — run the FULL `merge-quarantine*.mjs` corpus, individually, before reporting done. Both of
  Round 2's regression waves, AND Round 3's own three regressed files, were invisible to the new
  scenarios alone and were caught only by running every pre-existing file.

## Verification

- `packages/daemon/test/merge-quarantine-e7652e06-boot-freshness-discriminator.mjs` — five scenarios:
  - `forward-order-bug-fixed` (CASE 2) — F read before Y; Y stays blocked by its own identity, F's entry
    never carries Y's token, F unblocks cleanly after clearing its own token.
  - `reverse-order-case3` (CASE 3) — Y read before F; F's tautological primary arm evicts Y from `kF`; Y
    stays blocked at its own `kY` with its own token intact (the case-3 regression bar); F unblocks
    cleanly after clearing its own token.
  - `legit-r-s-union` (CASE 1) — the genuine toplevel-recompute collision; R and S correctly union,
    carrying both genuine tokens.
  - `third-party-backed-case4-unchanged` (CASE 4) — the `9a55fb90`/`d163aef5` `x`/`z`/`sub` shape; `x` and
    `z` still union, backed by `sub`'s own genuine, not-yet-processed identity.
- RED/GREEN via `pnpm --filter @loom/daemon negative-control --file packages/daemon/src/git/merge-quarantine.ts
  --test packages/daemon/test/merge-quarantine-e7652e06-boot-freshness-discriminator.mjs` (default `--ref HEAD`,
  this card's true parent, commit `38f35bdb`) — 5 of the new file's checks fail on the parent (the
  headline forward-order fail-open AND the reverse-order stranding), all pass after the fix, tree restored
  byte-identical.
- Full `merge-quarantine*.mjs` corpus (71 files), individually, fresh `LOOM_HOME` per file, both env
  states (`env -u LOOM_DEV -u LOOM_SUPERVISED` / `LOOM_DEV=1 LOOM_SUPERVISED=1`), one lane — re-run clean
  after EACH of Round 2 and Round 3's own shipped fixes; every regression either round's own intermediate
  attempt caused was caught by this exact run, never by review or the new scenarios alone.
- `pnpm --filter @loom/daemon guards`, committed first.
- See "Round 3" above for the reviewer-probe verification specific to that round's own fix.
