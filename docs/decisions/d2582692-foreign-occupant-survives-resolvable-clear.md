# d2582692 — a clear addressed at a resolvable repo must never destroy a different, foreign identity's only durable copy merely because it is armed at the same key

From `d163aef5` CR round 4 (`891bb19a`), finding 2 — the sibling of that round's own fixed finding 1
(round 5 in the decision record), reached through `clearMergeQuarantineReporting`/`clearMergeQuarantineByKey`
instead of a direct `armQuarantineKey` union. PRE-EXISTING, FAIL-OPEN; reproduced on main by reasoning
through the current code (the literal `cde2bdb3`-era union shape no longer reproduces on main after
`d163aef5`'s own earlier rounds, but the clear-side defect is independent of that union and still fires).

## The bug

`R`, a real, resolvable, UNREGISTERED repo, has its own genuine quarantine. `D = R/gone-subdir`, a
nonexistent path, never exists — its own `canonicalRepoLockKey` walks up to `R`'s own real key `K(R)`,
self-consistently (a tautological PRIMARY arm), and this arm legitimately EVICTS `R` to
`pendingUnresolvedQuarantines` (per `d163aef5` round 3's own "never discard" ruling) — `D` ends up the
sole in-memory occupant of `K(R)`, with its OWN `.tmp-<pid>` residue as its only durable backing (never
promoted/written to `K(R)`'s own final, since `D`'s `repoPath` never resolves).

A human REST clear of `R` (`clearMergeQuarantine(r)` → `clearMergeQuarantineByKey(K(R), r)`) resolves
`R`'s own fresh key and treats WHATEVER is currently armed there (`D`, wholly foreign) as "the entry being
cleared": it unconditionally deletes `D`'s in-memory record and then runs the key's own unconditional
`sweepTmpResidueForHashIfUnreferenced`, which checks ownership ONLY via `orphanLatchFiles` — `D`'s own tmp
residue was never self-referenced there (its arm was a PRIMARY, not a degraded DIVERT, so the
self-referencing code path `enterMergeQuarantine`'s degraded branch and the safety-tmp recovery loop both
use never ran for it) — so the sweep destroys `D`'s only durable copy as pure collateral.

Compounding this, the EXISTING clear-side protect (`protectUnincorporatedOccupantBeforeDelete` →
`unincorporatedOccupantRepoPathAt`) mis-fires in the OPPOSITE direction: it reads `final`'s own on-disk
content — which is genuinely `R`'s OWN data, since `D` never actually wrote there — and, comparing it
only against `D` (the in-memory entry ARMED at the key, never against the clear's own requester), wrongly
treats `R`'s OWN file as a foreign "unincorporated occupant" and duplicates it under a fresh
pending-divert name. That duplicate lazily re-graduates on the very next query, resurrecting `R`'s own
token and producing the confusing `stillQuarantinedReason` text "quarantined by ANOTHER repo's own,
separate quarantine (repoPath 'R'...)" — self-referential nonsense, since `R` is the very identity that
just asked to be cleared.

## The fix

1. **`unincorporatedOccupantRepoPathAt`/`protectUnincorporatedOccupantBeforeDelete`** gain an optional
   `clearIdentity` parameter: a SECOND, independent skip — `final`'s own on-disk content already naming
   `clearIdentity` (the clear's own requester) is never foreign data to protect, regardless of which
   entry happens to be ARMED at the key. `deleteMergeQuarantineLatchByKey` now threads its own
   `clearIdentity` through to this check (previously only `clearedEntry`'s identity was compared).
2. **`protectForeignTmpResidueBeforeSweep`** (new) runs inside `deleteMergeQuarantineLatchByKey`, right
   before the existing unconditional `sweepTmpResidueForHashIfUnreferenced` call: it reads each tmp
   residue matching the key's own hash prefix directly off disk and durably protects it (via the existing
   `protectOccupantContentBeforeDelete`, mirroring `protectDegradedOccupantBeforeDelete`'s own content-aware
   protection for `final`) when its content names a DIFFERENT, currently-UNRESOLVABLE identity than
   `clearIdentity` — exactly `D`'s shape. A currently-resolvable different occupant's leftover stays
   excluded (today's existing, legitimate overwrite case), as does content already naming `clearIdentity`
   itself.

## Round 2 (own worker, caught by running the full `merge-quarantine*.mjs` corpus before reporting done)

The first cut of `protectForeignTmpResidueBeforeSweep` protected EVERY foreign-unresolvable tmp residue
matching the key's hash prefix unconditionally — this regressed `merge-quarantine-latch-id-collision.mjs`
(`primary-distinct-ids-order-a/-b`, `every-listed-id-clearable-or-refused`): clearing a real, resolvable
sibling (`teamA`) that physically key-collides with an UNRELATED, already-correctly-diverted pending ghost
(`Y`, whose own safety-tmp recovery had ALREADY self-referenced its own filename into its own
`orphanLatchFiles` — the pre-existing, sufficient protection) caused the new function to ALSO protect `Y`,
re-pointing `Y`'s own already-correct pending reference onto a brand-new filename as a side effect —
silently changing `Y`'s own externally-visible clear-by-id, breaking its own later, unrelated clear.

**Fix:** `protectForeignTmpResidueBeforeSweep` first checks whether the tmp file is ALREADY owned by some
surviving entry's own `orphanLatchFiles` (the SAME check `sweepTmpResidueForHashIfUnreferenced` itself
honours) and skips it entirely when so — it only ever acts on a tmp residue that is genuinely about to be
destroyed with NOTHING tracking it, never re-protecting (and so never re-pointing) an entity that is
already perfectly fine.

## Tests

`merge-quarantine-pass1-degraded-union-guard.mjs`'s new scenario
`d2582692-clear-resolvable-protects-foreign-occupant` reuses `round3-degraded-walkup-to-resolvable-key`'s
own fixture (`R`/`D` as above) but clears `R` itself via `clearMergeQuarantineReporting`, not `D`. Proven
RED on the pre-fix code (D's token/content destroyed, the confusing re-block message appeared) and GREEN
after, including across a reboot. All 29 `merge-quarantine*.mjs` files re-verified individually (catching
the Round 2 regression above), and all 30 static guards pass.

## Interaction with card 398f476c (identity-model redesign, MAJOR #3)

As a side effect, `protectForeignTmpResidueBeforeSweep` is content-aware rather than identity-aware, so it
also protects card `398f476c`'s own documented "MAJOR #3" shape (two wholly-unresolvable identities L1/L2
sharing one manufactured `resolvedKey`, unioned in-memory, where clearing the union's own winning identity
L1 used to silently destroy L2's only copy too): clearing L1 now durably keeps L2 blocked as its own
pending entry, across a reboot — pinned by `d2582692-clearing-union-winner-keeps-loser-pending`; card
`398f476c`'s own redesign should start from this behaviour, not from scratch.

## Do not

- Do not treat whatever is currently ARMED at a key as "the entry being cleared" without checking its
  identity against the clear's own requester — a degraded, walked-up occupant squatting a resolvable
  repo's own key is foreign to that repo's own clear, even though it physically occupies the same slot.
- Do not gate a clear-side protect's skip condition on `clearedEntry`'s own identity alone — also check
  `clearIdentity` (the actual requester): content already belonging to the requester is never foreign,
  regardless of which in-memory entry happens to be armed at the key.
- Do not protect a tmp residue unconditionally just because it names a different, unresolvable identity —
  first check whether it is ALREADY owned via some surviving entry's own `orphanLatchFiles`; re-protecting
  an already-correctly-tracked entity re-points (and so silently changes) its own externally-visible
  clear-by-id as an unwanted side effect of clearing something else entirely at the same key.
- Do not trust a fix verified only against its own new scenario — run every `merge-quarantine*.mjs` file
  individually before reporting done; this card's own Round 2 regression was caught exactly that way, not
  by its own new scenario, which never exercised the latch-id-collision shape.
