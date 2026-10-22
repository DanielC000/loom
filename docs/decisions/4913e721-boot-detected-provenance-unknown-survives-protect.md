# 4913e721 — a boot-detected (in-memory-only) `provenanceUnknown` mark survives `protectDegradedOccupantBeforeDelete`'s own copy-aside

A reviewer's question (not independently verified before this card): `protectDegradedOccupantBeforeDelete`
derived `provenanceUnknown` ONLY from `final`'s on-disk bytes, via its shared tail
`protectOccupantContentBeforeDelete`. `detectUnknownProvenance` (db0a9db0) is a pure in-memory,
boot-time inference — it becomes durable on disk only when SOME OTHER write happens to persist it that
same boot. A degraded occupant whose file is left "AS WRITTEN" (`reenterMergeQuarantinesAtBoot`'s own
standing rule: never write/migrate/overwrite on an unresolvable or already-self-consistent degraded key)
can carry `provenanceUnknown:true` in memory forever while the physical bytes never reflect it. A later
clear of a DIFFERENT identity colliding with the degraded occupant's own key then built a protective
pending-divert copy from stale, unmarked disk bytes — laundering legacy/unknown provenance to "unmarked"
and reopening the exact fail-OPEN clear-by-id db0a9db0 exists to close. Confirmed via a hermetic repro
(ancestor-walk-collision shape, same as `merge-quarantine-pass1-migrate-union.mjs`'s own
"gone-subdir-reblocks-once-then-clearable" scenario) before any fix was written: the protective copy's
`provenanceUnknown` was `undefined`, and a subsequent `clearMergeQuarantineLatchFile` on its own id
succeeded (`ok:true`) instead of being refused.

db0a9db0's own pin (3) fixture (`merge-quarantine-unknown-provenance.mjs`) writes `provenanceUnknown:true`
directly into the on-disk bytes, so it never covered this case — the mark there was always disk-derived in
the first place.

## The fix

- `inMemoryProvenanceUnknownFor(repoPath)` (new helper, next to `ownIdentityEntryFor`) — OR across **every**
  in-memory entry for an identity, **both tiers** (`activeQuarantines` AND `pendingUnresolvedQuarantines`),
  never just the first match. `d4b25feb`'s own "two objects per identity" case (one active-only, one
  pending-only, disjoint tokens) is exactly why a single-match lookup (`ownIdentityEntryFor`) is the wrong
  shape here — the mark can sit on the object a first-match lookup would not have returned.
- `protectOccupantContentBeforeDelete`'s own `provenanceUnknown` derivation now ORs three sources: the
  on-disk bytes (unchanged), `inMemoryProvenanceUnknownFor(occupantRepoPath)` (the live scan), and an
  optional `knownOccupant` parameter — gated on `directPathIdentity(knownOccupant.repoPath) ===
  directPathIdentity(occupantRepoPath)` before it is ever trusted.
- `knownOccupant` exists because the live-map scan alone is insufficient for the MOST COMMON repro shape:
  `clearMergeQuarantineByKey` captures `entry = activeQuarantines.get(key)` and then unconditionally
  deletes every key in `keysToLift` (including `key` itself) from `activeQuarantines` **before** it ever
  calls `deleteMergeQuarantineLatchByKey` → `protectDegradedOccupantBeforeDelete`. By the time the protect
  call runs, the degraded occupant's own live map slot — the SAME object the disk content belongs to — is
  already gone from both tiers (it was never pushed to `pendingUnresolvedQuarantines` either, since the
  ordinary "already correctly filed at its own ancestor-walked key" boot path never diverts). `knownOccupant`
  is `deleteMergeQuarantineLatchByKey`'s own `clearedEntry` parameter — a pre-delete snapshot the caller
  already captured — threaded through `protectDegradedOccupantBeforeDelete` into the shared tail, used ONLY
  as a hint, identity-gated, never trusted blind.
- `reconcileMarkedBasenameBeforeWrite`'s 702b4241 re-ingestion branch also discarded the caller's own live
  `entry.provenanceUnknown` outright, replacing it with disk-only re-derivation — fixed to OR it in too, per
  db0a9db0's "carry forward at EVERY copy site" rule. This is a narrower, defensive fix: the ONE site that
  creates a `702b4241` unreadable-placeholder entry (`divertUnreadableBootLatch`) never sets
  `provenanceUnknown` on it, so no independently-reachable hermetic repro was found for this one specific
  branch within this card's own scope — reported as a finding, not guessed into a fabricated test.

Every OTHER named copy/rebuild site (`mintPendingDivert`/`unionIntoOnDiskPendingEntry`,
`rewriteOrphanLatchFilesAfterPartialClear`, all three boot migrate-branch write passes, PASS 1/1b/safety-tmp
recovery's own `detectUnknownProvenance` calls, `mergeTokenIntoPendingEntries`, `divertRaiseEntry`) was
read and confirmed to ALREADY correctly OR `provenanceUnknown` across every in-memory entry it touches
(via `unionQuarantineEntries`'s own sticky OR, or an existing hand-rolled cross-matched OR) — no gap,
no change needed at any of them.

## Round 2 (CR e0b0ccd6) — accepted cost: the OR is identity-level sticky, by design

**Lead ruling:** the OR's own stickiness is scoped to an IDENTITY, not to a single physical record. A
clean, self-consistent record for identity Z is over-refused for clear-by-id whenever ANY other in-memory
object for that SAME identity (active or pending, anywhere) carries `provenanceUnknown` — even one Z's own
clearer never touches directly. This is INTENDED, not a residual bug: `inMemoryProvenanceUnknownFor`'s own
contract is "does ANY record for this identity carry the mark," and fail-closed means answering yes once
is enough, regardless of which specific object a given protect call happens to be building a copy for. The
remedy for this accepted cost is unchanged from db0a9db0's own original remedy — clear by path (which lifts
the WHOLE identity, not a single physical record) still works unconditionally; only the bare clear-by-id
shortcut is the one that pays this cost. Do not "fix" this by narrowing the OR's own scope to a single
physical record or a single key — that is exactly the shape the round-2 negative scenarios below prove
must stay fail-closed across DIFFERENT identities, and narrowing it the other way (per-identity instead of
per-record) would reopen the very gap this card exists to close.

Two negative scenarios pin the two gates that keep this stickiness IDENTITY-scoped (never PHYSICAL-KEY- or
CANONICAL-KEY-scoped, which would be a materially worse, cross-identity leak):

- **(d)** `knownOccupant`'s own identity gate (`protectOccupantContentBeforeDelete`,
  `directPathIdentity(knownOccupant.repoPath) === directPathIdentity(occupantRepoPath)`): a marked
  occupant Z is captured as `knownOccupant` before its own clear deletes it, but the PHYSICAL bytes at
  the cleared key now belong to a THIRD, clean, unresolvable identity W (sharing the same canonical key
  only incidentally). W's own protective copy must NOT inherit Z's mark. Pinned via `withDistMutation`:
  weakening the gate to a canonical-key match (instead of identity) goes RED.
- **(e)** `inMemoryProvenanceUnknownFor`'s own pending-tier exact-identity match: a clean, self-consistent
  occupant Z sits at the cleared key while a DIFFERENT identity Z2 — sharing Z's own canonical key purely
  incidentally — carries the mark on a pending twin. Z's own protective copy must NOT inherit Z2's mark,
  and clear-by-id on it must still succeed. Pinned the same way: weakening the match to a canonical-key
  comparison goes RED.

Both negative scenarios confirm the gate correctly EXCLUDES a different identity even when it shares a
canonical key — the accepted cost above is about the SAME identity's own multiple records, a deliberately
different (and intentionally wider) scope.

## Do not

- Do not re-derive `provenanceUnknown` for a protective copy from `final`'s on-disk bytes alone — route
  through `protectOccupantContentBeforeDelete`'s own three-source OR (disk / `inMemoryProvenanceUnknownFor`
  / `knownOccupant`), or a future caller reopens this exact fail-open.
- Do not use `ownIdentityEntryFor` (first-match) where a sticky OR across every object for an identity is
  needed — see `inMemoryProvenanceUnknownFor`'s own doc for why the two are not interchangeable.
- Do not trust `knownOccupant` without the identity gate — it is a hint captured by a DIFFERENT clear's own
  bookkeeping, not a verified fact about what `final`'s bytes actually belong to.
- Do not assume this closes the `reconcileMarkedBasenameBeforeWrite` branch's own reachability — it is a
  defensive carry-forward fix only; re-derive reachability from a real repro before relying on it, rather
  than assuming it was proven here.
- Do not re-derive a `withDistMutation` anchor's own literal text from the TypeScript source when a card
  changes the shape of a line it anchors — `merge-quarantine-unknown-provenance.mjs`'s own pins (3)/(10)
  went stale this exact way (widening a single-line ternary into a multi-line OR) and had to be re-derived
  from the real compiled `dist/git/merge-quarantine.js` text, matching its own indentation exactly.
- Do not narrow the OR's own stickiness from identity-scoped to physical-record- or key-scoped — see
  "Round 2" above; that is an accepted cost, not a defect, and a later "fix" would reopen db0a9db0's own
  original fail-open the moment two records for one identity disagree on the mark.
- Do not widen either identity gate (`knownOccupant`'s own check, or `inMemoryProvenanceUnknownFor`'s
  pending-tier match) from `directPathIdentity` equality to a canonical-key comparison — scenarios (d)/(e)
  exist specifically because that exact weakening leaks a mark across DIFFERENT identities that merely
  share a key, a strictly worse fail-open than this card's own original one.

Tests: `merge-quarantine-4913e721-provenance-unknown-survives-protect.mjs` — five scenarios. (a) the
primary repro (recovered via `knownOccupant`), (b) the "other tier" variant (the mark lives on a separate
pending-tier object for the same identity, recovered via `inMemoryProvenanceUnknownFor`'s own live scan),
(c) the `21ec39e5` tmp-residue-union path (`protectForeignTmpResidueBeforeSweep`), proving the fix at the
one shared chokepoint reaches that caller too — (a)/(b)/(c) all proven RED on `HEAD` / GREEN after /
byte-identical restore via `packages/daemon/scripts/negative-control.mjs`. (d)/(e) are the round-2 negative
scenarios above, each pinned via the file's own `withDistMutation` (a throwaway copy of the minimal import
closure, never the real shared `dist/`) rather than a HEAD revert, since the RED case is a hypothetical
weakened gate that was never actually shipped, not a prior commit to revert to.
