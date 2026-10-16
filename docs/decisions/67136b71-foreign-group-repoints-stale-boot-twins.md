# 67136b71 — the raise-divert branch's `foreignGroups` arm re-points a stale boot twin too, mirroring af948556

From the af948556 Code Review (session `bfa97ca3`) — that record's own "Do not" section explicitly
flagged `foreignGroups` (~L1526-1544) as "a SEPARATE, as-yet-untouched same-class candidate, carded
separately." This card is that candidate: code-read hypothesis, confirmed REACHABLE by a hermetic repro
(including a demonstrated fail-open, not merely an invariant violation), then fixed — the exact same
shape and fix as af948556, one branch over.

## Severity: fail-open

In `consumeMatchedPendingsIntoArmedEntry`'s raise-divert branch (`skipDegradedOccupantGuard` true, the
fold-in read of the raiser's own fresh key returns `"unreadable"`), every matched pending index is
spliced out of `pendingUnresolvedQuarantines` at the top of the function. Pre-fix, the `foreignGroups`
arm (every OTHER identity canonically colliding at the raiser's key, as opposed to `ownGroup` — the
raiser's own identity, fixed by af948556) unioned a `group.length > 1` member's own matched entries into
a NEW `foreignUnion` object and pushed/durably-wrote it to pending — but never called
`replaceEntryEverywhere` for that group. If a foreign-group member is ITSELF an 883e29bc/64283e06 boot
twin (the SAME object reference also armed in `activeQuarantines` at its own stale/degraded key), that
active slot was left holding the STALE, pre-raise object.

Reproduced: F (a foreign identity — a subdirectory of the raiser TOP, sharing TOP's own canonical key
once both are real, per card 7673d096's toplevel walk) carries a pre-existing 883e29bc/64283e06 boot twin
PLUS a wholly separate, later pending record (never unioned with the twin until the raise event) — three
matched pending entries total in F's own foreign group. TOP (a genuinely new identity) raises for the
first time, landing in the raise-divert branch. Pre-fix: `assertQuarantineIdentityInvariantTestOnly()`
reports a genuine violation (2 non-reference-equal, token-OVERLAPPING objects for F's identity)
immediately after the raise, before any query. Worse: clearing F's two ORIGINAL twin tokens one at a time
(`clearMergeQuarantineByToken`) empties the STALE active-side object, whose own empty-sweep (mirroring
af948556's own SCENARIO 2 mechanism) ALSO lifts the SEPARATE pending-side `foreignUnion` object by
identity — even though `foreignUnion` still carries the third, never-cleared token. Measured pre-fix: F
(and TOP, its cross-tier sibling) falsely report OPEN while that third token is still outstanding — a
real, silent, in-process fail-open, not merely a tripped invariant check.

## The fix

`for (const p of group) replaceEntryEverywhere(activeQuarantines, p.entry, foreignUnion);`, added inside
the `foreignGroups.values()` loop's `group.length > 1` arm, right after `foreignUnion` is fully assembled
(post `orphanLatchFiles` merge) and before the group's own pending push/write — byte-identical shape to
af948556's own `ownGroup` fix, one branch over, and the same `c9114934` "replacement only, never a union
source" discipline.

## Reachability precondition (same as af948556)

Reachability requires an unreadable `final` at the raiser's own fresh key exactly where
`consumeMatchedPendingsIntoArmedEntry`'s own internal fold-check reads it — rare in production (a
transient I/O failure on that one specific read), but real, same class every other
`keptUnreadableLatchFiles` call site in this module already treats as live. Unlike af948556 (where the
affected identity IS the raiser), here the affected identity is a DIFFERENT, foreign identity that merely
shares the raiser's canonical key — requiring either a genuinely nested/subdir registration (card
7673d096's own cross-tier-sibling shape) or two separately-registered repos later discovered to be the
same physical repo.

## Sweep (card instruction, 2026-10-17): every multi-source merge/union construction site in this file

Grepped every `unionQuarantineEntries(` call site, every hand-rolled multi-entry merge (`.reduce(`/
`flatMap(` combining more than one source entry), and every `armQuarantineKey`/
`armKeyUnlessDegradedCollision` boot-time union wrapper. Each site below either re-points every active
slot that held the pre-merge object(s) via `replaceEntryEverywhere`, or provably never has an armed old
object to strand (a write-only computation, never armed into `activeQuarantines`/`byRepoKey`).

| Site (function, line) | Shape | Status |
|---|---|---|
| `armQuarantineKey` (~L817-833) | boot-time union primitive, `prior`+`entry` | OK — `replaceEntryEverywhere(byRepoKey, prior, armed)` at L829, identity-gated (deliberately: a union across two DIFFERENT identities sharing one key must never auto-replace — see `fd189d91`/`a2f381dc`) |
| `consumeMatchedPendingsIntoArmedEntry` main/non-raise `unioned` (~L1458-1459) | lazy-graduation/sibling-absorb union | OK — `replaceEntryEverywhere` for every anchor (`extra` + every matched entry) at L1557-1561, L1565 |
| `consumeMatchedPendingsIntoArmedEntry` `ownGroup`/`raiserUnion` (~L1498) | raise-divert, raiser's own identity | OK — af948556's own fix, `replaceEntryEverywhere` at L1520 |
| `consumeMatchedPendingsIntoArmedEntry` `foreignGroups`/`foreignUnion` (~L1536) | raise-divert, foreign identity | **FIXED this card** — `replaceEntryEverywhere` added |
| `protectOccupantContentBeforeDelete` `toWriteUnfiltered`/`kept` (~L2091, L2119) | union against on-disk occupant content | OK — both the write-failure (`kept`, L2127) and write-success (`toWrite`, L2150-2151/2157) branches re-point BOTH `atFilenameIdx` and `atFinalBasenameIdx` old entries |
| `unionIntoOnDiskPendingEntry` (~L2403), via `reconcilePendingDivertTarget` | unions a fresh in-memory `entry` against DISK-READ content | OK — never unions an in-memory object REFERENCE (always a fresh disk read on the "old" side), so there is no live reference to strand; its two callers (`mintPendingDivert`, `protectOccupantContentBeforeDelete`) already re-point their own `entry` input |
| `divertRaiseEntry` hand-rolled `merged` (~L2534-2563) | unions every same-identity pending match + the diverted raise itself | OK — `replaceEntryEverywhere` for every `matched` entry (L2562) AND the passed-in `entry` (L2563) |
| `mintPendingDivert` (~L2491-2516) | re-point on reconcile + double-fault safety-tmp fallback | OK — `replaceEntryEverywhere` at L2496 and L2510 |
| `mergeTokenIntoPendingEntries` hand-rolled `merged` (~L2191-2217) | unions every same-identity pending match (still-unresolvable raise) | OK — `replaceEntryEverywhere` for every `matched` entry (L2217) |
| `sourcesOnlyUnion` (~L5273-5281, boot Phase 0 safety content) | unions migrate sources for a protective safety-tmp WRITE only | OK — never armed into `activeQuarantines`/`byRepoKey`, so no live object is ever stranded |
| Boot PASS1/1b/2 single-entry folds (`trimmedPrior` L4583, `folded` L5456/5528/5650/5666, `armedForWrite` L5602, `updated` L5701) | single-entry field evolution (orphanLatchFiles/armedKeys trim, never a multi-entry merge) | OK — each already paired with its own `replaceEntryEverywhere` immediately after construction |
| `armKeyUnlessDegradedCollision`/`armCurrentKeyUnlessDegradedCollision` (many boot call sites) | wraps `armQuarantineKey` + its own eviction path | OK — delegates to `armQuarantineKey` (already covered) and its own eviction branch re-points via `replaceEntryEverywhere` at L4587 |

**Sweep conclusion: no other instance of this bug class found.** af948556 (`ownGroup`) and 67136b71
(`foreignGroups`) were the only two gaps — both inside the same function's raise-divert branch, which is
exactly why they shared one shape and were carded as a pair.

## Do not

- Do not call `replaceEntryEverywhere` with `foreignUnion` as a UNION SOURCE elsewhere in this branch —
  it is a REPLACEMENT target only, consumed by `group`'s own prior values (c9114934), same rule as
  af948556's own `raiserUnion`.
- Do not assume the `group.length === 1` arm needs a matching fix — it re-inserts the EXACT SAME,
  unchanged object reference (no new object is ever created there), so no active-side slot is ever left
  stale by it.
- Do not re-derive the sweep table above by grepping for `readdirSync` or any other single textual marker
  — it was built by reading each site's own code and its immediate neighbours, not by pattern-matching;
  a future change here needs the same manual check, not a regrep of this table's own wording.
- Do not trust a mid-window assertion that runs after `activeMergeQuarantineFor(top)` (or any query of
  TOP's own fresh key) as proof of a SPECIFIC outstanding token — querying a cross-tier sibling
  legitimately lazy-graduates it together with whatever else shares its canonical key (card 8a1bc2ef),
  which can pull in a THIRD party's own still-outstanding token (TOP's own fresh raise token, in this
  card's own SCENARIO 2) that a naive "clear everything I set up" sequence can forget about. This is not
  a bug — it is the correct, designed behavior for genuine cross-tier siblings — but it means a fail-open
  test's own "fully lifted" sanity check must account for every token a query along the way may have
  absorbed, not just the ones the test itself explicitly raised.

## Tests

`packages/daemon/test/merge-quarantine-foreign-group-stale-twin-67136b71.mjs` — its own dedicated file,
mirroring af948556's own structure (two scenarios, each a freshly-imported module instance).

- **SCENARIO 1** — mid-window, strictly before any query: the GLOBAL identity invariant holds, exactly
  one F-repoPath object exists. Witnesses (exactly 3 reads of the raiser's own fresh key's final; the
  raise diverted rather than overwrote; a pending record for the raiser exists) confirm the raise-divert
  branch was actually reached, not some other path.
- **SCENARIO 2** — THE FAIL-OPEN: F's foreign group has three matched pending members (the boot twin
  pair, plus a third, wholly separate pending record injected via `reenterMergeQuarantinesAtBootTestOnly`'s
  own seam, modelling a later, independent raise of F while still unresolvable). Clears F's two original
  twin tokens; asserts F/TOP both stay BLOCKED (the third, never-cleared token is still outstanding); then
  clears that third token AND the raiser's own fresh raise token (absorbed via the cross-tier-sibling
  lazy-graduation the "TOP stays BLOCKED too" check itself triggers — see the "Do not" above) and confirms
  both are then fully lifted.

Proven RED (SCENARIO 1's two invariant checks, SCENARIO 2's "stays BLOCKED"/"still enforcing" checks — 5
checks total) on pre-fix `HEAD` (only the `replaceEntryEverywhere` line deleted) / GREEN after, via a
surgical delete-rebuild-restore (`tsconfig.tsbuildinfo` cleared each time), restore confirmed byte-identical
via `git diff`.
