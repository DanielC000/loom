# ae79d492 — a partial token clear durably rewrites an 883e29bc dual-tracked entry's pending twin too

From round-3 Code Review `aad3dd72` of `1922be3a` — PRE-EXISTING, fail-closed, reproduced on all four of
the reviewer's dists.

## The bug

`883e29bc`'s PASS 1/1b diverts a degraded, unresolvable entry's walked-up key to
`pendingUnresolvedQuarantines`, pointing the pending record's `entry` field at the EXACT SAME object that
gets armed (by reference) at the entry's own recorded `resolvedKey` in `activeQuarantines` — a
"dual-tracked" entry. For this shape, the pending record's `sourceFile` is also the entry's ONLY durable
on-disk backing at boot time (`degradedOccupiedKeys` protects it from being overwritten by any other
write targeting the same key during that same boot pass).

When a partial clear (one token remains after removal) is reached via the ACTIVE path
(`clearMergeQuarantineByToken`'s identity scan → `clearActiveEntryTokenAtKey`), `replaceEntryEverywhere`
correctly re-points the pending twin's in-memory `.entry` reference to the reduced `updated` object — but
the function then only durably rewrote the ARMED key's own `sha(key).json` final
(`writeMergeQuarantineLatch`, inside the `armedKeysForEntry` loop). That final is a DIFFERENT physical
file from the pending twin's own `sourceFile` (the original legacy/degraded latch) — `writeMergeQuarantineLatch`
always targets `quarantinePathForKey`, never the twin's existing on-disk name. The twin's `sourceFile` was
left completely untouched, still carrying the PRE-clear token set.

A later reboot's PASS 1 reads BOTH physical files independently: the freshly-written `sha(key).json` (the
reduced set) and the still-stale `sourceFile` (the full, pre-clear set) — both resolve to the same
identity and get unioned back together, resurrecting the just-cleared token. Fail-closed (the repo stays
quarantined by a token that was genuinely cleared), never a false lift.

Reproduced via the "dual" fixture: a legacy file holding an unresolvable `X` with `resolvedKey` pointing
at a real repo `V`'s key `k2` and tokens `[ta, tb]`; boot with `[V, X]`; `clearByToken(x, "ta")`; reboot;
`ta` is back.

## The fix

`clearActiveEntryTokenAtKey`'s non-empty-remainder branch now ALSO durably rewrites every pending record
sharing the exact `updated` object reference (found via `collectPendingIndices((p) => p.entry ===
updated)`, meaningful only because `replaceEntryEverywhere` has already re-pointed any dual-tracked twin
onto `updated` earlier in the same function) via `writePendingDivertFile(pending.sourceFile, updated)` —
mirroring the symmetric fix `clearPendingEntryByToken` (the pending-side partial-clear branch) already
had for the reverse direction. A write failure here is logged exactly like the armed-key loop's own
failure: the pre-existing durable state is left untouched (never a false lift), only delaying the
eventual full clear until a successful rewrite.

Retiring the twin's `sourceFile` outright (deleting it) was considered and rejected: for this
dual-tracked shape, the pending record is the ONLY way `activeMergeQuarantineFor`'s 4th tier can ever
answer a query made directly against the degraded entry's OWN (unresolvable) identity — the entry is
armed only at its `resolvedKey`, never at its own degraded key, so a direct query by the degraded
identity has nothing else to find. Deleting the twin would make such a query falsely report "not
quarantined" while the entry is still genuinely armed — a fail-OPEN regression traded for a fail-closed
fix. Rewriting it in place keeps both physical copies of the one logical record in agreement instead.

## Round 2 (Code Review `f80250c9`) — two false-positive rewrites, plus a union-shape regression

Round 1's fix rewrites EVERY pending record sharing `updated`'s object reference, unconditionally. Code
Review `f80250c9` found two shapes where that rewrite is not merely redundant but actively regresses an
existing property, both about the SAME physical file the armed-key loop immediately above had already
durably handled — never about the twin's own identity.

### Minor 1 — the same-file dual shape drops `provenanceTracked:true`

When the twin's own `sourceFile` happens to BE the basename of an armed key's own final (the `4480b077`
shape — e.g. a legacy fixture written directly at `sha(resolvedKey).json`, never migrated to a
disjoint/legacy name), the armed-key loop's own `writeMergeQuarantineLatch` call just durably rewrote that
EXACT file, stamping `provenanceTracked: true` into the bytes on disk (the `db0a9db0` chokepoint). Round
1's own pending-twin loop then ran `writePendingDivertFile` against the SAME file a moment later —
`writePendingDivertFile` never stamps `provenanceTracked` (only `writeMergeQuarantineLatch` does), so this
second write silently ERASED the stamp `writeMergeQuarantineLatch` had just written, and fsynced the same
bytes twice for nothing.

**Fix:** the armed-key loop now records the basename of every final it successfully wrote
(`writtenFinalBasenames`); the pending-twin loop skips any record whose `sourceFile` is in that set.

### Minor 2 — the PASS 1b tmp-residue dual shape resurrects a just-swept tmp

When the twin's own `sourceFile` is a PASS 1b tmp-residue latch (`<hash>.json.tmp-<pid>-<hex>`) sharing a
hash with an armed key the loop above just wrote to, that loop's own
`sweepTmpResidueForHashIfUnreferenced` call can delete that exact tmp file as now-superseded residue
(`sweepTmpResidueForHashIfUnreferenced` checks `orphanLatchFiles` cross-references, never
`pendingUnresolvedQuarantines`'s own `sourceFile` field, so it has no way to know this tmp IS the twin's
own backing). Round 1's own pending-twin loop then unconditionally called `writePendingDivertFile` against
that now-deleted path, RECREATING a tmp-shaped residue file the system had just correctly cleaned up.

**Fix:** the pending-twin loop also skips any record whose `sourceFile` no longer exists on disk — once
the armed-key loop's own write durably supersedes it (or its sweep removes it as redundant), the twin's
content is already safe via the fresh final / the in-memory reference alone, so skipping the rewrite never
leaves anything genuinely un-persisted.

### The union-shape regression — `enterMergeQuarantine`'s own `existing` branch never touches the twin's sourceFile at all

A SEPARATE gap, found by the same review: when a genuinely resolvable repo (`V`, whose own real key `k2`
happens to be a degraded entry `X`'s recorded `resolvedKey`) raises AFTER boot, `enterMergeQuarantine`'s
`existing` branch unions `V`'s fresh token into the degraded entry and durably rewrites only the armed
key's own final (`sha(k2).json`) — it never looks at `pendingUnresolvedQuarantines` at all, so `X`'s own
dual-tracked twin (its legacy `sourceFile`) is left holding the PRE-union token set. A later partial clear
through `clearActiveEntryTokenAtKey` (this card's own round-1 fix) still correctly rewrites the twin at
THAT point — proven by the new `union-then-partial-clear` scenario below, which is RED with round 1's own
rewrite loop removed and GREEN with it present, confirming round 1's fix already covers this shape; no
further code change was needed for this specific finding.

## Do not

- Do not delete/retire an 883e29bc dual-tracked twin's `sourceFile` on a partial clear instead of
  rewriting it — the pending record is load-bearing for `activeMergeQuarantineFor`'s 4th-tier lookup by
  the degraded entry's own identity; removing it reopens a fail-open query gap.
- Do not assume `replaceEntryEverywhere`'s in-memory re-point is sufficient on its own — it never touches
  disk. A dual-tracked twin's `sourceFile` is a genuinely separate physical file from any armed key's
  `sha(key).json` final and needs its own explicit durable write.
- Do not gate this rewrite on `entryStillOwnsKey`-style key ownership — the twin is matched by object
  REFERENCE (`p.entry === updated`), which is the same discriminator `replaceEntryEverywhere` itself uses
  and is already precise for this shape.
- **(Round 2)** Do not rewrite the pending twin's own `sourceFile` unconditionally — first check whether
  it is the SAME physical file an armed key's own write just durably handled (drops `provenanceTracked`)
  or has already been deleted as superseded residue (resurrects a swept tmp). Skip in both cases; only a
  genuinely stale, still-existing, distinct file needs the rewrite.

## Tests

`packages/daemon/test/merge-quarantine-degraded-occupant-guard.mjs` (NOT
`merge-quarantine-unverified-raise-divert.mjs` — corrected, round 2): the card's own "dual" fixture
(`dual-partial-clear-rewrites-pending-twin-sourcefile`): `clearByToken(x, "ta")` then a real reboot
asserts `ta` stays cleared and `x` is queryable only via `tb`; a second, full-clear scenario
(`dual2-full-clear-before-any-reboot-stays-clean`) asserts clearing both tokens stays clean across a
reboot too. Both proven RED on pre-fix code (round 1) and GREEN after.

Round 2 adds: `dual-same-file-shape-preserves-provenance-tracked` (Minor 1 — the legacy fixture written
directly at `sha(resolvedKey).json`, asserting `provenanceTracked:true` survives a partial clear);
`dual-pass1b-tmp-shape-does-not-resurrect-swept-tmp` (Minor 2 — a PASS 1b tmp-residue dual shape, asserting
no tmp-shaped file is recreated after the armed-key loop's own sweep removes it); and
`dual-existing-branch-union-then-full-clear` (the union-shape regression — `V` raises at runtime over the
degraded `X`, `clearByToken(x, "ta")` then reboot, then clear the remaining two tokens and reboot again,
asserting `ta` stays cleared throughout and both `V` and `X` end up free). All three proven RED with round
1's own rewrite loop reverted to HEAD and GREEN with it restored, via `scripts/negative-control.mjs`.
