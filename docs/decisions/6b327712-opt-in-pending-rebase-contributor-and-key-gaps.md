# 6b327712 — the opt-in pending rebase's contributor-resurrection and resolvedKey-conflict gaps

Split out of `97a5b64f` (whose two named write-site shapes were closed by `5d0820c7`'s complete arm).
Investigate-first card: all three named shapes were REPRODUCED via real mechanisms, not manufactured
states, before any fix was written. Covers `writePendingDivertFile`'s OPT-IN `rebaseOntoRealDiskRecord`
path (`028837ad`; used only at `clearTokenFromPendingIndices`'s reduce, via
`unionIntoOnDiskPendingEntry`).

## Item 1 — a reduced contributor can be resurrected from a dual-tracked twin's own stale pending file

A dual-tracked twin (`883e29bc`) X armed at a real key K AND separately held pending via its own
physical pending-divert file P (same object reference in both `activeQuarantines`/
`pendingUnresolvedQuarantines`). Contributor C gets reduced out of X's record via
`reduceForeignUnionContributor`/`markIdentityAsReducedOnForeignKey` — these durably write ONLY to
`ownedKeys` (key-addressed final files, gated on `fs.existsSync(quarantinePathForKey(k))`), never a
separate pending `sourceFile`. P's own on-disk bytes stay stale (still naming C) forever. A LATER
token-clear on X's pending side (`clearTokenFromPendingIndices`'s reduce, the ONLY caller of
`rebaseOntoRealDiskRecord:true`) rebases onto P's stale content via `unionIntoOnDiskPendingEntry`, whose
`contributorRepoPaths` union is a plain OR with no awareness of `entry.reducedContributorRepoPaths` —
RESURRECTS C from DISK alone, when memory had already, correctly, dropped it. Confirmed end-to-end: a
real `clearMergeQuarantineByKey(K, X, …)` afterward lists C in `liftedRepoPaths` — an over-report, since
C's own quarantine state was already correctly accounted for via `reducedContributorRepoPaths`, which
`clearMergeQuarantineByKey`'s own candidate-gathering (the unconditional `contributorRepoPaths` loop,
never gated by `reducedCandidateBlockedByEntry` the way the `reducedContributorRepoPaths` loop is) cannot
tell apart from a genuinely new contributor.

**Round 1's fix over-corrected (BLOCKING, Round 2 CR).** `reducedContributorRepoPaths` is STICKY (never
pruned — it names every contributor ever durably reduced, for the entry's whole lifetime), and
`enterMergeQuarantine`'s own `existing` branch LEGITIMATELY re-folds a previously-reduced contributor C
back into `contributorRepoPaths` when C raises again onto the same key — so BOTH fields naming C at once
is a VALID, reachable state, not only the stale-disk-resurrection shape above. Round 1's fix stripped C
unconditionally whenever it appeared in `reducedContributorRepoPaths`, even when the IN-MEMORY
`entry.contributorRepoPaths` ALSO (legitimately) named it — so `ambiguousIdentitiesFor` (`:671`/`:747`)
stopped seeing C, and the clear-by-id ambiguity refusal (`82032b5c`/`9a55fb90`,
`clearMergeQuarantineLatchFile` `:8130`) no longer fired: clear-by-id returned `ok:true` and hard-lifted
C's own genuinely live, just-re-raised token. Reproduced directly (the dual-track construction above,
plus a REAL `enterMergeQuarantine(C)` re-raise before the pending-side token clear): RED at `ae4db934`
(clear-by-id wrongly `ok:true`; C read unblocked, in-process and after a reboot).

**Fix (Round 2):** strip a contributor from the rebase's unioned `contributorRepoPaths` ONLY when DISK
resurrected it — i.e. it is in `entry.reducedContributorRepoPaths` but NOT in `entry.contributorRepoPaths`
(memory's own current, authoritative set). Memory stays authoritative for BOTH fields; a legitimate
re-raise's own contributor fold is never touched. `reducedContributorRepoPaths` itself is still left as
the union's own result, unchanged. Scoped to this ONE call site only.

**Not independently probed:** whether the (now-fixed) resurrection shape could ALSO have caused a
wrongful `refuseSelfClearStaleKeyContributors` refusal on a later self-clear of X itself — plausible (that
function reads `contributorRepoPaths` too, via `ambiguousIdentitiesFor`), but not constructed or verified.

**Also unproven (Round 2 CR, reviewer's residual — no fixture built):** one identity can legitimately
hold TWO independent records sharing one `sourceFile` — a stale `883e29bc` pending twin B, plus an
active A whose own key-final file B's `sourceFile` happens to BE (`d4b25feb` ~:5762, `ae79d492` round 2).
If A legitimately re-folds a contributor C (the re-raise shape above) and durably writes THAT file, B's
OWN later pending-side rebase reduce could read it, see C as reduced in B's own `reducedContributorRepoPaths`
and absent from B's own `contributorRepoPaths`, strip C from disk anyway, and a reboot would then lose
A's own fold — the clear-by-id ambiguity refusal failing open for A's own identity, not B's. This residual
is a consequence of item 1's shape as a WHOLE (Round 1's own strip was broader than this), not of the
Round 2 fix specifically — reachability is unproven; no fixture constructs it here.

## Item 2 — a multi-entry pending merge degrades `genuineContributorKeys` to legacy

Reproduced mechanically: merging a precise pending entry (`genuineContributorKeys:[]`) with a SECOND
pending record for the same identity lacking the field (`mergeTokenIntoPendingEntries` ->
`unionGenuineContributorKeysAbsorbing`'s own "ANY undefined -> undefined" absorbing rule) durably
degrades the merged record to legacy, in-process and on disk. Confirmed this is REACHABLE on a current,
non-legacy daemon: every boot-time PLACEHOLDER construction in this file (CORRUPT/UNREADABLE/UNRESOLVED
shapes, ~10+ sites) never stamps `genuineContributorKeys` — none of them are legacy artifacts, they are
minted by today's own fail-closed boot code whenever a latch is corrupt/unreadable.

**Verdict: working as designed, not a defect.** `unionGenuineContributorKeysAbsorbing`'s own doc and
`6de79dc0`'s Round-2 CRITICAL-2 ruling are explicit that `undefined` here means "no precise per-key record
to trust," and must never be treated as empty. A placeholder's content is, by definition, unverified —
Loom genuinely does not know whether a real contributor is folded in there, and there is no safe value to
stamp on it (`[]` would be an unverified precision claim). The degrade to legacy is the correct,
conservative outcome. No src change. Landed as a pin test only (`@decision 6de79dc0`) confirming the
degrade, so it cannot silently regress into something unsafe in either direction later.

## Item 3 — a disk/memory `resolvedKey` conflict drops BOTH keys (fail-open on the key-addressed path)

The divergence ORIGINATES in `5d0820c7`'s own Step B: `armForeignOrphanContentInMemoryIfUnenforced` calls
`armQuarantineKey` UNCONDITIONALLY for an unresolvable/pending identity's own secondary key (the
decline-on-different-occupant guard `5d0820c7` rounds 2-3 added is explicitly scoped to the
resolvable/active branch only). `armQuarantineKey`'s own LEGACY union (no `explicitResolvedKeyRule`) sets
`resolvedKey = older.resolvedKey` bluntly, with no conflict detection — confirmed directly
(`armQuarantineKeyTestOnly`): when T itself is OLDER than the secondary key's occupant (so T's own
identity survives `unionQuarantineEntries`'s own `{...older}` spread) and the occupant carries its own
genuinely different, non-self-referential `resolvedKey` (a dual-armed `[keyU, keyV]` shape `5d0820c7`'s
own record already names as real, in a different context), `armQuarantineKey`'s own `48bda567` self-key
correction overwrites T's own self-referential `resolvedKey` with the occupant's — diverging from the
pending identity's own on-disk bytes, durably (the arm never touches disk). This card's own fix is scoped
to the REBASE's handling of that divergence, not to the arm itself — `5d0820c7`'s Step B is tracked
separately on card `188ebf31`, not changed here.

A LATER partial-token-clear rebases onto the stale disk file via `unionIntoOnDiskPendingEntry`'s EXPLICIT
rule: when both sides carry a DEFINED, DIFFERENT scalar `resolvedKey`, the rule's final branch returns
`resolvedKey:undefined` AND (because `conflictExclusions` is the symmetric difference of the two
single-key `informativeKeysFor` sets) `filterConflicts` stripped BOTH keys out of the plural
`resolvedKeys` too — total loss. Confirmed the consequence after a reboot: `stillBlockedEntryFor` read
`undefined` for BOTH candidate repos even though the record's own real token was still outstanding —
fail-open on the key-addressed path specifically (the identity-addressed pending lookup still found it).

**Fix (POLICY — Lead ruling): keep both conflicting keys as PLURAL candidates instead of dropping them.**
Added `options.retainConflictingKeysInResolvedKeys` to `unionQuarantineEntries` (defaults OFF,
byte-identical everywhere else) and threaded it through `unionIntoOnDiskPendingEntry`'s own same-named
option (also defaults OFF) — opted into ONLY at `writePendingDivertFile`'s `rebaseOntoRealDiskRecord`
call site. `unionQuarantineEntries`'s explicit rule has ANOTHER direct caller
(`protectOccupantContentBeforeDelete`'s own `oldAtFilename` union, ~:3636, with its own separate
re-filter immediately after) and
`unionIntoOnDiskPendingEntry` has two OTHER callers (`writePendingDivertFile`'s `keptUnreadableLatchFiles`
branch; `reconcilePendingDivertTarget`'s two call sites) — none of them pass the new option, so their
conflict semantics are unchanged. The scalar `resolvedKey` stays `undefined` on conflict exactly as
before; only the plural array's own exclusions are widened. Verified: after the fix, a reboot arms BOTH
originally-named keys (never a third, invented one) and both read blocked while the real token is
outstanding — PASS 1's own `secondaryKeysToAttempt`/`armKeyUnlessDegradedCollision` still arbitrate each
candidate on its own merits at boot, so this is fail-closed, not a blanket re-widening.

## Do not

- Do not pass `retainConflictingKeysInResolvedKeys:true` (or `explicitResolvedKeyRule:true` at all) from
  any NEW call site without re-deriving whether that caller's own `entry` is already a correct
  union/reduce `028837ad`'s own "Do not" already warns rebasing onto raw disk would wrongly override.
- Do not strip a contributor from the item-1 rebase based on `entry.reducedContributorRepoPaths` ALONE
  (Round 1's own BLOCKING bug) — a re-raise can legitimately re-fold a reduced contributor back into
  `entry.contributorRepoPaths`; only strip a contributor that is reduced AND absent from memory's own
  current `contributorRepoPaths`, never one memory itself still affirms.
- Do not widen the item-1 contributor fix's exclusion source from `entry.reducedContributorRepoPaths` to
  `unioned.reducedContributorRepoPaths` — the in-memory `entry` is the deliberately more-authoritative
  side; disk's own copy can itself be stale in the opposite direction.
- Do not attempt to fix item 3 by changing `armForeignOrphanContentInMemoryIfUnenforced`'s own
  unconditional Step B union for unresolvable identities — tracked separately on card `188ebf31`, not
  this card's scope.
- Do not read item 2's pin test as license to stamp `genuineContributorKeys:[]` on any boot-time
  placeholder construction site "to fix the degrade" — that would be a false precision claim about
  content Loom has never verified; the degrade is the correct behavior to preserve.
- Do not construct the item-1/item-3 test scenarios via a real orphan-sweep dance only — a direct
  `setActiveQuarantineTestOnly`/`pushPendingQuarantineTestOnly` construction of the SAME end-state is
  sufficient and documented by those seams' own doc comments as modeling a genuine `883e29bc` twin; pair
  it with `armQuarantineKeyTestOnly` (item 3) to independently confirm the real union mechanism that
  produces the precondition, rather than re-enacting the full arm chain end to end.

## Tests

See `merge-quarantine-6b327712-*.mjs` (per-item files). RED proof, Round 1: `negative-control.mjs --ref
52eb6075e4f6cc38301739aee8c69b0784dd2f62` (the sha immediately before this card's own commits). RED
proof, Round 2 (the re-raise shape B1 fixed): `negative-control.mjs --ref ae4db934` (Round 1's own commit,
which carried the over-corrected strip).
