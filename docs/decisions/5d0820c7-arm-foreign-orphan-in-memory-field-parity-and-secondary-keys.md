# 5d0820c7 — arm a foreign orphan/tmp-residue in memory with PASS 1's own field parity and secondary keys

Found by `028837ad`'s own CR rounds 1-2 (reviewers `eb000fdd`, `0d2a370d`, 2026-10-29) and explicitly
named as its deferred follow-up in that record's own Round 3 section ("Accepted, NAMED, pre-existing,
OUT-OF-SCOPE residual (tracked on card `5d0820c7`)"). Since `1dd00dca`, `armForeignOrphanContentInMemoryIfUnenforced`
armed a foreign orphan/tmp-residue's identity T from the narrow `ArmableOrphanRecord` (repoPath/branch/
reason/enteredAt/tokens only). The next boot's own PASS 1 instead reads the SAME bytes with 16
fields/derivations (repoPath, branch, reason, opId, enteredAt, tokens, orphanLatchFiles, resolvedKey,
resolvedKeys, identityAtRaise, genuineContributorKeys, placeholder, contributorRepoPaths,
reducedContributorRepoPaths, provenanceUnknown, provenanceTracked — the inline per-file entry-
construction block in PASS 1's own read loop, inside `reenterMergeQuarantinesAtBootImpl`) and
additionally attempts an ACTIVE arm at every `secondaryKeysToAttempt(entry, currentKey)` candidate (the
degraded-entry secondary-key loop feeding `degradedDivertsToFlush`, for the unresolvable branch; the
loop right after `armCurrentKeyUnlessDegradedCollision`'s own primary arm, for the resolvable branch) —
the in-process arm never attempted any key but T's own. So, in-process, a repo B
named by O's own `resolvedKey` (or a contributor C named by O's own `contributorRepoPaths`) was NOT
blocked until the next reboot — a fail-open window. This card landed as TWO separate commits (Step A,
then Step B) for bisection.

**Hermetic repros, executed at `bf191152` (028837ad already merged) before any fix was written:**
- Shape 1 (resolvedKey names a live repo B, T an UNRELATED ghost — not a subdirectory of B, so
  `canonicalRepoLockKey(T)`'s own ancestor walk does NOT reach B's key; only T's own `resolvedKey` field
  names it): in-process `stillBlockedEntryFor(B)` → `undefined` (FAIL); after a reboot → blocked (PASS).
- Shape 2 (contributorRepoPaths names a contributor C, an unrelated unresolvable identity, T resolvable):
  in-process `stillBlockedEntryFor(C)` → `undefined` (FAIL); after a reboot → blocked (PASS).
- Both isolated from `028837ad`'s own write/reduce-adopt mechanism by giving the orphan's content ONLY
  the foreign identity's own token (no overlap with the clearer's token), so no post-loop reduce ever
  touches the armed entry — a pure test of the bare arm, not of `028837ad`'s own durability fix.

**A narrower Shape 1 variant — T literally a ghost subdirectory UNDER B — is already closed by Step A
alone**, via a PRE-EXISTING mechanism (`883e29bc`'s own `findPendingIndicesFor` fallback,
`merge-quarantine.ts` ~`:7499`): it matches a still-unresolvable PENDING entry by key when
`informativeKeysFor(entry).length > 0` AND `canonicalRepoLockKey(entry.repoPath) === key` — and a ghost
subdirectory's own ancestor walk naturally reaches its parent's key regardless of any explicit
`resolvedKey`. Step A alone makes `informativeKeysFor` non-empty (by carrying `resolvedKey` through at
all), which is enough to satisfy that pre-existing lazy-lookup fallback for this narrower shape — proven
directly (RED before Step A, GREEN after, with NO Step B change in effect). This is a genuinely different,
weaker shape than the card's own real motivating one (a `resolvedKey` surviving a repo MOVE, where the
new path's own ancestor walk has no relation to the old key) — the UNRELATED-ghost Shape 1 above is what
actually requires Step B (see "Step B" below).

## Step A — field parity (no new keys touched)

`orphanSweepSafeToDelete`'s own `armable` record (and `sweepTmpResidueForHashIfUnreferenced`'s
per-identity union of several such records) is now built via the ALREADY-EXISTING, already-shared
`latchEntryFromParsedRecord` (`702b4241`'s own helper, built for ONE other caller,
`reconcileMarkedBasenameBeforeWrite`) — never a THIRD hand-mirrored field list (Lesson 277: two prior
attempts to widen `ArmableOrphanRecord` field-by-field each missed a field). Two fields
`latchEntryFromParsedRecord` does not carry are computed the same way PASS 1 itself does, for full
fidelity: `.tokens` is overridden with `orphanSweepSafeToDelete`'s own already-computed `surviving` set
(never raw on-disk tokens — `1dd00dca` Round 3's own invariant: this arm must mirror what the next boot
would arm from the SAME bytes, and `surviving` already accounts for in-process tombstones a fresh boot
would never see). `.placeholder` is computed via `isPlaceholderEntryShape(parsed)`, and
`detectUnknownProvenance(armable, hash)` runs unconditionally, mirroring PASS 1's own ordering rule
(`db0a9db0`: before any other branch/mutation) — closing the "deliberately excluded... for no benefit
this card's own repro needs" scope `028837ad` Round 2 left open (that exclusion was correct for THAT
card's narrower problem; this card's whole purpose is full field parity).

`armForeignOrphanContentInMemoryIfUnenforced` now takes the FULL `MergeQuarantineEntry` (never
`ArmableOrphanRecord`, retired) and carries every field through on both the active-set and pending-push
branches, via `{ ...record, orphanLatchFiles: [...new Set([...(record.orphanLatchFiles ?? []), ...basenames])] }`
— unioning (never overriding) any secondary `orphanLatchFiles` reference the record's own content
already carried, on top of the caller-supplied basenames.

`sweepTmpResidueForHashIfUnreferenced`'s own `armableByIdentity` union (several tmp files sharing one
identity) now merges via `unionQuarantineEntries` — the SAME shared helper every other multi-record merge
in this module uses — instead of a second, token-only hand-rolled union; this also unions
`contributorRepoPaths`/`resolvedKeys`/etc. across multiple files for one identity, which the old
token-only union never did.

**The "never widen `ArmableOrphanRecord`" guards in `1dd00dca`/`028837ad` are correctly read as
superseded by this card, not violated by it** — see the supersession notes added to those two records
(and to `702b4241`, whose "ONE new caller" framing now has a second). Those guards prohibit HAND-mirroring
fields one at a time (the Lesson-277 failure mode); routing through `latchEntryFromParsedRecord` — an
EXISTING, independently-tested helper built for exactly this shape — satisfies their intent rather than
repeating the mistake they warn against. `028837ad` Round 3 itself named this card as the deliberate
continuation.

## Step B — secondary-key arming, fail-closed relative to a reboot

After the primary arm, every OTHER informative key `record` carries (`secondaryKeysToAttempt(record,
currentKey)`) is armed too, via `armQuarantineKey(activeQuarantines, key, armedEntry)` — the SAME
module-level, non-boot-scoped TERMINAL union primitive (`merge-quarantine.ts` ~`:1246`) PASS 1's own
`armKeyUnlessDegradedCollision` closure calls once ITS OWN freshness/eviction/registered-backing decision
tree settles on "union" — never that decision tree itself, which `1dd00dca` correctly called a
boot-scoped "correctness minefield" (six-plus CR rounds: `e7652e06` rounds 1-4, `c9114934`, `6c04633d`,
`f575cebf`) not worth replicating at a second, independent call site. `armQuarantineKey` is called
UNCONDITIONALLY for every secondary candidate (free or occupied) — there is no separate "is it occupied"
branch, because the function already does the right thing either way (plain arm when free; union, via
`unionQuarantineEntries`, when occupied) and threads `armedKeys` so every key the merged object ends up
at points at the SAME final object (mirroring PASS 1's own ~`:9108-9111` threading note). For the
unresolvable (pending) case, the `pendingUnresolvedQuarantines` push is deferred until AFTER this loop,
using the final, possibly-unioned object — mirroring PASS 1's own `degradedDivertsToFlush.push({ entry:
armedAtResolvedKey ?? entry, ... })` at ~`:9104`, which also defers until after its own secondary-key
loop.

**Confirmed via an executed repro that PASS 1 itself unions at an occupied secondary key, in the common
case (the occupant IS a registered project):** raised U for real; planted an unresolvable T whose orphan
content named `resolvedKey = canonicalRepoLockKey(U)` plus T's own uncovered token; after a reboot (with
U passed as registered), U's own armed entry carried BOTH tokens unioned together, and clearing U's own
token alone left U still blocked (the unioned token outstanding) — exactly the shape `armKeyUnlessDegradedCollision`'s
"legitimate same-toplevel union" fallthrough (~`:8826-8828`) produces when `registeredRepoPaths.some(p =>
isKeyVerifiedFor(p, key))` is true for the occupant. Step B's own unconditional `armQuarantineKey` call
reproduces this exact outcome without needing `registeredRepoPaths` at all — confirmed again with the
real Step B code, in-process (not just at boot): clearing the occupant's own single token afterward
leaves it still blocked, agreeing with a reboot taken at either point.

**Exactly which PASS 1 branches decline or evict a secondary claim where Step B instead unions — named
so the divergence is never silently assumed away:**
- CASE 2 (`armKeyUnlessDegradedCollision`, `merge-quarantine.ts` `:8830`): both the occupant and the
  secondary claim currently resolvable, `degradedOccupiedKeys` doesn't claim the key, and the occupant is
  freshly, verifiably the key's real owner while the (never-tautological) secondary claim is not — PASS 1
  DECLINES the secondary claim outright (`return undefined`), leaving the occupant completely untouched.
  Step B instead unions the secondary's tokens into the occupant.
- The resolvability-mismatch branch (~`:8818-8825`), when NO registered repo verifies the key at all
  (`!registeredRepoPaths.some(p => isKeyVerifiedFor(p, key))`): if the secondary claim is itself
  unresolvable, PASS 1 DECLINES it (`:8823`, `return undefined`); if the secondary claim IS resolvable
  (so the occupant is the unresolvable/degraded side), PASS 1 EVICTS the occupant from this one key
  (`evictPriorFromKey`, `:8824` — the occupant keeps any OTHER keys it holds, and is pushed to
  `pendingUnresolvedQuarantines` if that was its only key). Step B instead unions both sides' tokens at
  this key rather than cleanly evicting the occupant.
- CASE 3 (entry's claim IS tautological/fresh, i.e. the PRIMARY arm) is NOT reachable from Step B's own
  secondary-key loop at all (`entryClaimIsTautological` is always `false` there, and CASE 3 requires it
  `true`) — Step B never touches the primary-key path `1dd00dca`'s own "skip, never union" rule already
  governs.

**In every one of these three named divergences, Step B's own UNION result (before Round 2's fix below)
is never weaker on BLOCKING than a reboot would be — but "stricter, never weaker" is not the whole
picture, and Round 2 found the dimension it hides: a RESOLVABLE record's own CLEAR DURABILITY.**
Unioning a resolvable record into a different, fresh occupant does not just block MORE — it durably
REPLACES the record's own primary-key entry with the merged, occupant-identity-labeled object (see
Round 2's BLOCKING-1 below), which is a correctness defect, not a conservative one. The "stricter, never
weaker" framing holds cleanly ONLY for the UNRESOLVABLE case, where unioning never touches a primary-key
slot to begin with.

**`provenanceUnknown` is deliberately NEVER set by Step B's own secondary-key union, in any shape** —
checked at source, not assumed. PASS 1 only marks it (`:8833-8840`) via
`secondaryArmClaimsADifferentRegisteredIdentitysKey`/`priorHoldsKeyViaNonFreshClaimOnADifferentRegisteredIdentity`
(~`:8737-8747`), BOTH of which test membership in `registeredRepoPaths` — a BOOT-scoped list (the
roster of registered projects passed to `reenterMergeQuarantinesAtBoot`) with no runtime-clear-time
equivalent available to this card's own call sites. For the two shapes this card's own repros exercise
(T unresolvable vs. a resolvable, freshly-verified occupant), traced at source AND confirmed empirically
(the OCCUPIED-KEY test's own in-process vs. post-reboot check): PASS 1 itself does NOT mark it there
either (`secondaryArmClaimsADifferentRegisteredIdentitysKey` short-circuits on
`isRepoPathCurrentlyResolvable(entry.repoPath)` being false; `priorHoldsKeyViaNonFreshClaimOnADifferentRegisteredIdentity`
short-circuits on `!isKeyVerifiedFor(prior.repoPath, key)` being false). **Named, accepted residual
(corrected by round 3's own SHOULD-1 — the gap is NOT scoped to a resolvable claimant alone):** a
secondary claimant — RESOLVABLE (`secondaryArmClaimsADifferentRegisteredIdentitysKey`) OR UNRESOLVABLE
(`priorHoldsKeyViaNonFreshClaimOnADifferentRegisteredIdentity`, when the PRIOR occupant dual-arms a key
whose OTHER key is itself a different REGISTERED identity — e.g. U dual-armed `[keyU, keyV]` with V a
registered real repo, T a ghost whose own `resolvedKey` is `keyV`) — colliding with a different
REGISTERED identity's key is a shape where PASS 1 WOULD mark `provenanceUnknown` (closing `clear-by-id`
specifically) but Step B cannot, for lack of a runtime `registeredRepoPaths` equivalent, for EITHER shape
— the PRIMARY concern (the key staying blocked) is unaffected either way (the token union itself still
happens); only the narrower, additional `clear-by-id` refusal PASS 1 adds in these sub-shapes is not
mirrored. Stays a named, accepted residual — tracked on card `97a5b64f`, not fixed here. Not reproduced as
reachable from this card's own two named repro shapes (both of which collide with an UNREGISTERED
occupant, never a registered one).

**`97a5b64f` confirmed:** this card's own field-parity fix (Step A) closed BOTH of `97a5b64f`'s own named
write-site shapes (`mergeTokenIntoPendingEntries`, `rewriteOrphanLatchFilesAfterPartialClear`) with no fix
of their own — pinned by `merge-quarantine-97a5b64f-armed-latch-writes-keep-fields.mjs`. The
`registeredRepoPaths`-at-runtime residual above, and the other folded-in items that card carried, remain
open, tracked on their own separately-scoped follow-up cards.

## Round 2 (Code Review of `39e173ac`) — BLOCKING-1 (new commit(s), a durable strand for resolvable T), SHOULD-1 (a parity bug), SHOULD-2 (tests)

**BLOCKING-1 — `armQuarantineKey` REPLACES, never mutates, and Step B's own unconditional call durably
destroyed a RESOLVABLE record's own primary-key entry.** `armQuarantineKey` (~`:1246-1262`) builds a NEW
object via `unionQuarantineEntries` (`repoPath` = whichever side is OLDER), skips `replaceEntryEverywhere`
whenever the two sides are different identities (by design — see that function's own doc), and then its
own `for (const k of armed.armedKeys) byRepoKey.set(k, armed)` loop writes the MERGED object to EVERY key
in `armed.armedKeys` — which, for a RESOLVABLE record, already includes `currentKey` (T's OWN primary
key, set by this function's own earlier `armedEntry = {...armedEntry, armedKeys: [currentKey]}` line) at
the moment the secondary call runs. So a secondary union at an occupied key durably OVERWRITES
`activeQuarantines.get(currentKey)` with the merged, possibly-occupant-identity-labeled object — T's own
distinct existence at its own key is gone.

**Reproduced exactly as described, both clear orders, before the fix:** U raised live (`tU`, a real
resolvable repo); `O = {repoPath: T (a REAL resolvable repo), tokens: [tF], resolvedKey: key(U)}`; the
clear on A arms T (via the orphan sweep) and unions it into U's own occupied key. Querying T's OR U's
own entry by key, right after the arm, returns the SAME merged object (labeled with whichever side was
older). Clearing T's token FIRST then U's (or the reverse order) leaves BOTH T and U PERMANENTLY
blocked, in-process AND after a reboot, with a leftover `pending-<hash>.json` {repoPath: T, resolvedKey:
key(U), tokens: [tF]} never swept — a genuine on-disk cross-identity bleed (confirmed directly: a file at
T's own ORIGINAL orphan basename survives holding U's own real latch's `resolvedKey`, migrated at reboot
into a fresh file still naming the wrong key). At `bf191152` (pre-`5d0820c7` entirely) and in a `bootref`
control (PASS 1 booting the identical bytes) T and U are each correctly, independently unblocked in BOTH
orders — the corruption is specific to Step B's own unconditional runtime union for a resolvable record.

**The fix:** a RESOLVABLE record's secondary key, when occupied by a DIFFERENT identity that is
genuinely, freshly verified there (`isKeyVerifiedFor(occupant.repoPath, key)`), is now DECLINED before
ever calling `armQuarantineKey` — mirroring PASS 1's own CASE 2 (`armKeyUnlessDegradedCollision`,
`:8830`: occupant freshly, verifiably owns `key`; a secondary claim, like PASS 1's own, is never
fresh — see that function's own `entryFresh = entryClaimIsTautological` note). The occupant's own entry
is left completely untouched; T stays correctly, separately armed at its own primary key. UNRESOLVABLE
records are UNCHANGED (still unconditional) — they never set `armedKeys` at their own primary key in the
first place (never armed ACTIVE there at all, only pushed PENDING after the secondary loop), so the same
hazard cannot occur, and bootref's own union behavior is matched exactly either way.

**Scope of the decline, decided deliberately narrow — never attempts to distinguish a STALE occupant
from a fresh one:** PASS 1's own decision tree also EVICTS a stale, unresolvable occupant in one
narrower sub-case (the resolvability-mismatch branch, ~`:8818-8825`, when no registered repo backs the
key) rather than declining — a shape Step B does not attempt to replicate (that would require the SAME
boot-scoped `registeredRepoPaths` list Step B's own provenanceUnknown scoping already cannot access at
runtime). Declining uniformly for ANY different-identity occupant, fresh or stale, is the safe-direction
choice: the occupant's own existing representation is left EXACTLY as it already was (never more, never
less, blocked than before this arm attempt), and T stays fully, correctly blocked at its own primary key
regardless — nothing becomes LESS blocked than it already was. The cost is narrower than PASS 1's own
eviction: T's claim on that ONE secondary key specifically is not recorded, so a query addressed
SPECIFICALLY via that key (rather than T's own primary key or identity) would not find T through it —
accepted, since T's own primary-key path still fully, correctly blocks it either way.

**SHOULD-1 — a parity bug in Step A's own `detectUnknownProvenance` hash, specific to the `.tmp-residue`
path.** `orphanSweepSafeToDelete` always derived the hash as `orphanFile.slice(0, -".json".length)`
(~`:5185`, pre-fix) — correct for a `.json` orphan latch, but garbage for a `.json.tmp-<pid>-<hex>` tmp
residue filename (this same function is also called from the tmp sweep, ~`:5594`). PASS 1b derives a tmp
residue's own hash differently (`f.slice(0, f.indexOf(".json.tmp-"))`, `:9269` and `:9881`). Reproduced directly: a
tmp residue at the clearer's own key hash, T resolvable, 2 foreign tokens, no contributors (SHAPE2-TMP's
own contributors short-circuit `detectUnknownProvenance` before the hash is ever used — this is why that
scenario never caught it), `resolvedKey` matching the SAME key the tmp physically sits at — a correctly-
derived hash finds no mismatch (`provenanceUnknown` should read `undefined`), but the garbage hash from
the old slice always mismatches, reading `provenanceUnknown: true` in-process while a reboot (using PASS
1b's own correct derivation) reads `undefined` — confirmed RED at `39e173ac`, GREEN after deriving the
hash PASS 1b's own way for a `.json.tmp-` filename.

**SHOULD-2 (tests, folded into "Tests" below):** added the RESOLVABLE-T occupied-key case (BLOCKING-1's
own repro, both clear orders) and an OLDER-T unresolvable-occupied-key case (pinning that
`unionQuarantineEntries`'s own "keep the EARLIER identity" tie-break agrees with bootref regardless of
which side is older — unaffected by the BLOCKING-1 fix, since it only gates on `resolvableNow`). The
pre-existing `provenanceUnknown` equality check (`a === b`) is widened to first assert the compared
ENTRY exists on both sides — it passed trivially as `undefined === undefined` before when neither entry
even existed, proving nothing.

**NIT (recorded, not fixed) — Step B brings one of PASS 1's own PRE-EXISTING behaviors into the runtime
arm for the first time: identity swallowing when the OLDER side of a legitimate union is the occupant.**
When U (the occupant) is older than T, `unionQuarantineEntries` keeps U's own `repoPath`/`branch`/`reason`
in the merged object — T's own distinct identity is absorbed into U's, exactly as PASS 1 itself already
does for a genuine same-toplevel collision (this is the SAME class `398f476c` is scoped to investigate
for PASS 1 generally, not a new defect Step B introduces) — Step B's own decline (BLOCKING-1's fix) only
prevents this for the FRESH-occupant case; the "neither side fresh, legitimate union" fallthrough can
still legitimately reach it, now reachable at runtime too, not just at boot.

**Open question, stated honestly rather than fixed — NOT probed, given the round's own effort budget:**
could a PENDING entry hold a stale reference to U's OLD object after a Step B union changes U's own
object identity? `armQuarantineKey`'s `replaceEntryEverywhere` call is skipped whenever the merged
object's `repoPath` differs from the prior occupant's own identity (by design — see that function's own
doc: "never a union of two possibly-different identities sharing a key"). If U is ALSO a degraded,
dual-tracked PENDING twin (883e29bc's own shape — the SAME object reference held in BOTH
`activeQuarantines` at some key AND `pendingUnresolvedQuarantines` by reference) at the moment Step B's
union produces a DIFFERENT merged object (T's repoPath winning instead of U's), the pending twin
reference would keep pointing at U's OLD object, never repointed onto the new merged one — a potential
stale-reference residual this round did not construct or confirm either way.

## Round 3 (Code Review of `66167169`) — BLOCKING-1 widened to a STALE occupant, SHOULD-1/SHOULD-2 (record fixes), NIT-1/NIT-2 (tests/citations)

**BLOCKING-1 — round 2's own decline was itself conditioned on the occupant being FRESH, and a STALE
different-identity occupant fell through to the same unconditional union round 2 had just fixed for a
fresh one.** Round 2 declined a secondary union only when `isKeyVerifiedFor(occupant.repoPath, key)` was
TRUE — but a STALE occupant (its own repoPath renamed/removed, or resolvable-but-mis-keyed) makes that
check FALSE, so the condition at `merge-quarantine.ts` ~`:5271` fell through to the unconditional
`armQuarantineKey` call, reproducing the IDENTICAL identity-swap/on-disk-bleed corruption BLOCKING-1 was
written to close — now for a stale occupant instead of a fresh one. Reproduced directly: U raised live,
then its own directory renamed away (U still occupies `keyU` in `activeQuarantines`, but no longer
resolves); T a REAL resolvable repo, `O = {T, [tF], resolvedKey: keyU}`; the clear on A arms T via the
orphan sweep. At `66167169` (pre-round-3), querying T's OWN entry by its OWN key returns the merged
object labeled with U's identity — the SAME corruption as round 2's own BLOCKING-1 repro, confirmed RED
directly against `66167169` via `negative-control.mjs`.

**The fix:** drop the freshness term entirely — decline a secondary union for ANY different-identity
occupant, fresh OR stale, never conditioned on whether that occupant's own freshness check happens to
pass right now. The occupant's own entry is always left completely untouched; T stays correctly,
separately armed at its own primary key regardless of the occupant's own current resolvability.

**The residual this widening accepts, stated honestly rather than fixed — and scoped to `keyU` alone, not
to a stale occupant specifically:** this is not new to round 3's own widening; it dates from round 2's
own decline, which already declined unconditionally for a FRESH occupant. It applies to ANY declined
different-identity occupant at a secondary key, fresh OR stale, cleared FIRST: clearing the occupant (U)
FIRST leaves U correctly UNBLOCKED in-process (T's own secondary claim at `keyU` was declined, never
armed there, so in-process `keyU` reads nothing — none) — but a reboot taken at that SAME point still
reads `keyU` BLOCKED, re-armed as T. T's own on-disk orphan content still carries `resolvedKey = keyU`
(the in-process decline never writes anything to T's own physical file — see
`armForeignOrphanContentInMemoryIfUnenforced`'s own "left untouched on disk" invariant), and `keyU` is
now free for PASS 1 to re-arm T there on the next boot. A fail-open for `keyU` relative to a reboot, for
ANY declined secondary claim cleared first — T's own primary-key block is unaffected either way, and the
in-process state is never LESS correct than before this round's fix, only less STRICT than what a reboot
taken at that same instant would show. Clearing T FIRST instead shows no such gap, fresh or stale alike:
T's own orphan file is swept the instant T itself is fully lifted, so there is nothing left on disk for a
later reboot to re-arm from — confirmed empirically for both clear orders of the STALE case (see the
STALE-OCCUPANT-RESOLVABLE-T test below) and, by the identical mechanism, for the FRESH case too (see
OCCUPIED-KEY-RESOLVABLE-T's own optional mid-reboot check). Not fixed here — the same boot-scoped-
`registeredRepoPaths`-equivalent gap SHOULD-1 and the "Do not" list already name for the stale-occupant-
eviction and `provenanceUnknown` cases applies equally here: there is no runtime way to tell "this
occupant's own claim was never going to resolve again anyway" apart from "it just hasn't resolved YET"
without replicating PASS 1's own boot-scoped machinery.

**SHOULD-1 (record correction) — the `provenanceUnknown` residual's scope was stated too narrowly.** The
"Step B" section above originally scoped the named `provenanceUnknown` residual to a RESOLVABLE secondary
claimant colliding with a different registered identity's key. Round 3 found the SAME gap is reachable
for an UNRESOLVABLE T too, via the PRIOR-side predicate `priorHoldsKeyViaNonFreshClaimOnADifferentRegisteredIdentity`
(U dual-armed at `[keyU, keyV]` with V a registered real repo; T a ghost whose own `resolvedKey` is
`keyV`) — corrected in place above, in the "Step B" section itself, rather than restated here (this
card's own "point at a source of truth, never restate its content" discipline — see `CLAUDE.md`).

**SHOULD-2 — the "Do not" section below is kept under 4,500 bytes**, trimming the stale-occupant bullet
to a pointer at this Round 3 section instead of restating BLOCKING-1's own reasoning a second time.

**NIT-1 (test fix)** — the pre-existing OCCUPIED-KEY-RESOLVABLE-T test's own cross-identity-bleed check
claimed to cover "or vice versa" but only ever checked ONE direction (a file naming U while holding T's
token). Fixed to check BOTH directions, and the label corrected to say so plainly instead of claiming
vice-versa coverage it didn't have.

**NIT-2 (citation fixes)** — two stale line-number citations in this record, corrected in place above
rather than restated here: PASS 1's CASE 2 (`armKeyUnlessDegradedCollision`) is at `:8830`, not
`~:8799-8808`; PASS 1b's own tmp-residue hash derivation is at `:9269` (and again at `:9881`), not
`~:9257`.

## Do not

- Do not widen `ArmableOrphanRecord` again, or reintroduce a THIRD hand-mirrored field list anywhere in
  this mechanism — route through `latchEntryFromParsedRecord` (Step A) for any future field-parity need.
- Do not replicate `armKeyUnlessDegradedCollision`'s own freshness/eviction/registered-backing decision
  tree at runtime — call `armQuarantineKey` directly instead (Step B); the decision tree is boot-scoped
  and six-plus CR rounds deep. `1dd00dca`'s own "never replicate the boot-only degraded-collision dance"
  rule still governs the PRIMARY key only; it does not forbid this card's own secondary-key union step.
- Do not set `provenanceUnknown: true` on a Step B secondary-key union without FIRST re-deriving, at
  source, whether PASS 1 would mark it for that SAME shape (via the two named predicates in "Step B"
  above) — a runtime `registeredRepoPaths` equivalent would need to exist before this could ever be
  mirrored faithfully; setting it unconditionally changes a THIRD party's (the occupant's) own clear-by-id
  behaviour in a way a reboot would not, which is exactly the class of divergence this whole card exists
  to close, not reopen.
- Do not construct a "Shape 1" (resolvedKey names a different repo) test with T as a ghost SUBDIRECTORY
  of the named repo — `canonicalRepoLockKey`'s own ancestor walk finds the parent's key regardless of any
  explicit `resolvedKey`, via the pre-existing `883e29bc` pending-lookup fallback, and the test would pass
  on Step A alone without ever exercising Step B. Use a wholly UNRELATED ghost path for T.
- Do not raise an "occupant" test repo via the top-level `mod` import when the rest of the scenario
  operates on a freshly re-imported `booted` module instance — the occupant must genuinely occupy
  `booted`'s own `activeQuarantines` at the secondary key for the union to have anything to union with;
  raise it via `booted.enterMergeQuarantine(...)` instead.
- Do not call `armQuarantineKey` unconditionally for a RESOLVABLE record's own secondary key occupied by
  a different identity (round 2 BLOCKING-1, round 3 widened) — DECLINE first, for ANY different identity,
  fresh OR stale, never conditioned on `isKeyVerifiedFor`; the function's own armedKeys-driven
  write-everywhere durably replaces the record's own primary-key entry otherwise. UNRESOLVABLE records
  stay unconditional — they never occupy their own primary key in `activeQuarantines` to begin with.
- Do not construct an "occupied secondary key" test by writing content directly into
  `foldOrphanRefIntoOwnFinal`/`writeOrphanContent` WITHOUT first rebooting the module that raised the
  clearer — the clearer's own in-memory entry needs a REAL read-from-disk cycle to pick up the
  `orphanLatchFiles` edit written directly to disk, or the whole arm silently never fires.
- Do not assert "no files survive in `MERGE_QUARANTINE_DIR`" as a scenario's own cleanliness check in
  this test file — the directory is SHARED across every scenario in the file (one `useOwnLoomHome` for
  the whole file), so a bare directory-wide count is contaminated by whatever earlier scenarios left
  behind, unrelated to the scenario under test. Scope the check to a SPECIFIC tracked path (e.g. the
  scenario's own `orphanPath`) or to CONTENT (a cross-identity-bleed scan), never a raw count.
- Do not attempt to replicate PASS 1's own STALE-occupant eviction (the resolvability-mismatch branch's
  `evictPriorFromKey` sub-case) for a secondary key — it needs the SAME boot-scoped `registeredRepoPaths`
  list Step B's own provenanceUnknown scoping already cannot access at runtime; see Round 3's own section
  for why declining uniformly (fresh or stale) is the accepted substitute, and its own named residual.
- Do not read this card as closing `97a5b64f`'s own scope — that card is about LATER writes of an
  already-armed entry (`mergeTokenIntoPendingEntries`, `rewriteOrphanLatchFilesAfterPartialClear`)
  dropping fields independent of how complete the arm originally was. Completing the
  arm here (Step A) may shrink `97a5b64f`'s remaining scope — a later write might be able to safely carry
  the now-complete in-memory entry forward rather than needing to rebase onto disk to recover a field
  memory never had — but that is for `97a5b64f`'s own investigation to confirm, not assumed here.

## Tests

`merge-quarantine-5d0820c7-field-parity-and-secondary-keys.mjs`:
- (SHAPE1-SUBDIR, non-regression) T a ghost subdirectory of B: already blocked in-process by Step A alone
  (the pre-existing `883e29bc` pending-lookup fallback) — pinned as a non-regression, not attributed to
  Step B.
- (SHAPE1-UNRELATED, Step B) T a wholly unrelated ghost path (not nested under B), orphan content holding
  only T's own token plus `resolvedKey = canonicalRepoLockKey(B)`: in-process `stillBlockedEntryFor(B)`
  agrees with a reboot taken at either point — the card's own real motivating shape.
- (SHAPE2-ORPHAN / SHAPE2-TMP, Step A) contributor C, T resolvable: in-process `stillBlockedEntryFor(C)`
  agrees with a reboot taken at either point, for both the orphan (`.json`) and tmp-residue (`.tmp-<pid>`)
  paths — proving the two-path symmetry this card's own design requires (both reuse the SAME
  `armForeignOrphanContentInMemoryIfUnenforced` body).
- (OCCUPIED-KEY-UNRESOLVABLE-YOUNGER-T, Step B) k occupied by U (raised for real, via the SAME `booted`
  module instance the rest of the scenario operates on, entered BEFORE T); T unresolvable, `resolvedKey=k`,
  holding only its own token (no overlap with the clearer's or U's): right after the arm, U's entry
  carries both tokens unioned; clearing U's own token alone leaves k still blocked, in-process AND after
  a reboot taken at that same point; both sides' entry EXISTENCE is asserted before comparing
  `provenanceUnknown` (round 2, SHOULD-2 — never a vacuous `undefined === undefined`).
- (OCCUPIED-KEY-UNRESOLVABLE-OLDER-T, round 2 SHOULD-2) the identical shape, T's content planted BEFORE U
  is raised (T older) — pins that `unionQuarantineEntries`'s own tie-break agrees with bootref regardless
  of which side is older; unaffected by the BLOCKING-1 fix (gates on `resolvableNow` only).
- (OCCUPIED-KEY-RESOLVABLE-T, round 2 BLOCKING-1) U raised live; T ALSO a real resolvable repo, holding
  only its own token, `resolvedKey=key(U)`. Both clear orders (`T-then-U`/`U-then-T`): right after the
  arm, T's and U's own entries (queried by their OWN keys) are asserted genuinely, separately T's and
  U's own (never swapped); both fully lift in-process and after a reboot; T's own orphan file is swept
  (scoped to that one tracked path, never a directory-wide count — the directory is shared across every
  scenario in this file); no on-disk file names U while holding T's own token or vice versa (the
  cross-identity-bleed scan).
- (SHOULD1-TMP-PROVENANCE, round 2 SHOULD-1) T resolvable, 2 tokens, NO contributors, planted at the
  clearer's own key hash with `resolvedKey` matching that SAME key: `provenanceUnknown` agrees in-process
  vs. after a reboot (both `undefined` once the hash is derived PASS 1b's own way for a tmp filename).

RED proof, round 1: `node scripts/negative-control.mjs --file packages/daemon/src/git/merge-quarantine.ts
--test packages/daemon/test/merge-quarantine-5d0820c7-field-parity-and-secondary-keys.mjs --ref bf191152`
(the sha immediately before this card's own first commit) — 6 of 12 checks RED (every in-process check,
plus the OCCUPIED-KEY "entry carries both tokens" check; every REBOOT-leg check and the provenanceUnknown
agreement check still pass at the pre-fix code, since PASS 1 itself already gets those right), all 12
GREEN after the fix, tree restored byte-identical. RED proof, round 2: `node scripts/negative-control.mjs
--file packages/daemon/src/git/merge-quarantine.ts --test packages/daemon/test/merge-quarantine-5d0820c7-field-parity-and-secondary-keys.mjs
--ref 39e173ac` — 11 of 37 checks RED (BLOCKING-1's own OCCUPIED-KEY-RESOLVABLE-T identity-swap checks
RED in BOTH clear orders, confirming the corruption in both — the `U-then-T` order's own LATER checks
in that scenario happen to pass at `39e173ac` too, via a DIFFERENT pre-existing fail-closed "keep stale"
path the old code's own `stillBlockedEntryFor` gate takes for that ordering, not via the union-corruption
path `T-then-U` hits — the identity-swap checks are what actually discriminates the bug, in both orders;
SHOULD1-TMP-PROVENANCE RED in both its own checks), all 37 GREEN after the fix, tree restored byte-
identical. A standalone scratch repro of BLOCKING-1's own exact shape, built before this official test
existed, independently confirmed both T and U PERMANENTLY blocked with a surviving cross-identity-bled
file in BOTH clear orders — the stronger, unambiguous proof the "BLOCKING-1" section above describes. Targeted re-run (both env states) of every pre-existing `merge-quarantine*.mjs` file that greps
for `armForeignOrphanContentInMemoryIfUnenforced`, `latchEntryFromParsedRecord`, `secondaryKeysToAttempt`,
or `sweepTmpResidueForHashIfUnreferenced`, plus `merge-quarantine-3315b08a-replace-not-splice-stale-target.mjs`
(round 2) — the exact file list and per-file results are recorded in the worker's own `worker_report`,
not restated here.
