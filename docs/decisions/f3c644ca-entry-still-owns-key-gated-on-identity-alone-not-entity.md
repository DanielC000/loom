# f3c644ca — `entryStillOwnsKey` gated on identity alone, not entity

_Split out of the former single `8db913e2` record by card `3608937e` so each record's injected Do-not extract fits the per-record cap; every section below is verbatim from it (pinned blob `2f1a55286d01`). The core record keeps the card's own rounds 1 and 3 and holds the index of every split-out record (rounds 2 and 4 of the card are in `sha:d529d42d`, record `d529d42d-raise-divert-rounds-2-and-4-chokepoint-union-and-in-memory-repoint.md`): `8db913e2-raise-diverts-instead-of-overwriting-a-kept-occupant.md`._

## Follow-up f3c644ca — `entryStillOwnsKey` gated on identity alone, not entity

CRITICAL-CLASS over-unblock, pre-existing. `entryStillOwnsKey` (merge-quarantine.ts) treated ANY
same-identity occupant as automatically "the same logical entry" (bare `directPathIdentity` equality) —
contradicting decision d4b25feb, under which one identity can legitimately hold TWO INDEPENDENT records
at once. Found by the Code Reviewer of c93e9e7a (session eed46e01, gen 426), measured on c93e9e7a's own
build. The investigate-first phase (before any production edit) confirmed the Reviewer's own probe
script no longer reproduces on current main, post-cd5a3cf9 — a surgical negative control (checked out
`merge-quarantine.ts` at cd5a3cf9's own parent commit, rebuilt, re-ran) showed the SAME probe DOES
reproduce there, proving cd5a3cf9 incidentally closed that probe's own mechanism
(`protectOccupantContentBeforeDelete`'s basename-match, a DIFFERENT function) without ever touching
`entryStillOwnsKey` itself, which stayed byte-identical.

**Per-site table** (every `entryStillOwnsKey` caller, enumerated then independently re-verified by repro):

| Site | Shape | Reproduced on current main? |
|---|---|---|
| `clearMergeQuarantineByKey`'s pending sweep | LIFT | **YES** — independent active entry W's map slot deleted AND its physical latch file unlinked; durable (survives reboot) |
| `clearTokenFromPendingIndices` via `clearMergeQuarantineByToken` | LIFT | **YES** — same consequence |
| `clearMergeQuarantineByRecordedPath`'s `matchedPending` loop | LIFT | NO — structurally blocked: this function's own active-identity scan clears every same-identity active entry FIRST, by design, so nothing independent survives for the pending loop to wrongly catch; confirmed empirically |
| `consumeMatchedPendingsIntoArmedEntry`'s anchors loop | WRITE | NOT REPRODUCED within the time-box — every construction needed an ACTIVE entry with a stale `armedKeys` reference, and `armedKeys` is in-memory-only, never test-injectable for an active entry; a degraded/unresolvable-park construction kept being a genuine 883e29bc dual-tracked twin, legitimately re-absorbed by the raise's own pending-identity scan before this predicate ever mattered |
| `enterMergeQuarantine`'s existing-branch secondary-key write | WRITE | NOT REPRODUCED, same blocker |
| `clearActiveEntryTokenAtKey`'s write loop | WRITE | NOT REPRODUCED, same blocker |
| `ownedKeysIncluding`, `clearMergeQuarantineByRecordedPath`'s `activeLiftedKeys` collection | LIFT-adjacent | Not independently repro'd; same predicate, covered by the fix uniformly (Lesson 155) |
| `quarantineLatchFileIdsFor` | READ-only | No mutation; lower severity, covered by the fix uniformly |

**(i) Empty tokens:** confirmed, by code reading, that `tokens` is NEVER empty for a live entry reachable
by this predicate. Every fresh-entry construction site seeds `tokens` with ≥1 element (a real raise
token, or `randomUUID()` for a placeholder — ~12 sites across the file). Every on-disk parse path falls
back to `[parsed.token ?? randomUUID()]` when the array is missing/invalid/empty, never to `[]`. `unionQuarantineEntries` only ever grows a token set. Every clear path that would reduce
tokens to zero REMOVES the entry entirely from both `activeQuarantines` and `pendingUnresolvedQuarantines`
rather than leaving a live zero-token record. The fix's `occupant.tokens.length === 0 || entry.tokens.length
=== 0` guard is therefore defensive, never load-bearing on any real path — but required anyway, since an
empty set is vacuously a subset of anything, which would silently re-open the identity-only hole.

**(ii) Real-world reachability of LIFT A/B:** the repro injects a stale `armedKeys` via the
`testOnlyInjectUnprotectedPending` seam, standing in for a state this module's own history shows arising
naturally. 883e29bc's own record documents exactly this residual: a diverted pending copy "going inert
once its own path remounts to a DIFFERENT real key than the one it was diverted under (never explicitly
pruned — it just stops matching any future query's key)" — an ACCEPTED tradeoff at the time, reasoned
about only as "stops matching," never as "could still be CONSULTED by a later, unrelated clear's own
pending sweep." Project memory's `c9114934`/`d163aef5` investigations document the same general class
(a stale secondary arm destroying an unrelated occupant's content) as a recurring, real shape in this
module's development history. The fix goes ahead regardless of a fully-traced natural repro (per Lead
ruling); the seam-constructed state is a faithful stand-in for an already-documented residual, not a
purely synthetic contrivance.

**THE FIX (round 1, SUPERSEDED by round 2 below):** `entryStillOwnsKey` first shipped requiring, beyond
reference equality, a verified identity match AND a non-empty TOKEN-SUBSET relation in EITHER direction
(`entry.tokens ⊆ occupant.tokens || occupant.tokens ⊆ entry.tokens`). Round-2 Code Review found this
reopens a DIFFERENT over-unblock (below) — **do not re-add the `entry ⊆ occupant` half.**

**ROUND 2 — Code Review found the symmetric gate's `entry ⊆ occupant` half reopens a real over-unblock
via the AUTOMATIC settle-time clear.** Probe A: active `W` with TWO outstanding tokens `{s,u}`; pending
`P`, same identity, carrying only `{s}` (a genuine SUBSET of `W`'s own tokens) with a stale
`armedKeys:[K]` naming `W`'s own key — exactly scenario 3's (round 1) own state. `clearMergeQuarantineByToken(y,"s")`
— the route `git/worktrees.ts`/`git/batch-merge.ts` call automatically when an op settles — runs the
PENDING pass first; `P`'s last token makes it a full lift, `entryStillOwnsKey(K,P)` was `P ⊆ W` (true
under the round-1 gate), and `W`'s entire map slot AND physical latch were deleted before the ACTIVE pass
could reduce `W` to `{u}` on its own — `u` was lost, in memory AND after a reboot, breaking this module's
own token SET semantics (clearing one outstanding token must never lift the quarantine while another is
still outstanding). The ORIGINAL justification for keeping `entry ⊆ occupant` (round-1 scenario 3) used
`clearMergeQuarantineByKey` on an UNUSED key — a shape no real clear route takes. With `occupant ⊆ entry`
ALONE, Code Review ran every REAL human/automatic clear route against probe A's exact state
(`clearMergeQuarantine(y)` resolvable → `clearMergeQuarantineByKey`; `clearMergeQuarantine(y)`
unresolvable → `clearMergeQuarantineByRecordedPath`; `clearMergeQuarantineByRecordedPath(y)` directly) and
all three still lifted fully, in memory and after reboot, while all 47 other `merge-quarantine*.mjs` files
stayed green. `occupant ⊆ entry` is also the semantically safe direction at the
`consumeMatchedPendingsIntoArmedEntry` WRITE site.

**THE FIX (round 2, CURRENT):** `entryStillOwnsKey` requires, beyond reference equality, a verified
identity match AND `occupant.tokens ⊆ entry.tokens` — `occupant ⊆ entry` ONLY, never the reverse. Two
genuinely independent records (disjoint tokens, since tokens are fresh `randomUUID()`s per raise, never
reused) are correctly rejected. A genuinely overlapping-but-INCOMPARABLE pair (sharing SOME tokens,
neither a full subset of the other) is ALSO correctly rejected by this predicate — Code Review verified
such pairs still resolve cleanly through every real clear route via OTHER mechanisms, never through this
predicate claiming a false ownership; do not read that as "this predicate itself accepts them." The
`clearMergeQuarantineByRecordedPath`'s `activeLiftedKeys` collection and its own pending loop are
REDUNDANT/MOOT for the same-identity case specifically (Code Review's own finding) — do not
assert either direction is "needed" there; the function's own active-first clear ordering (see the
per-site table row above) already makes the independent-record shape unreachable through them. Per the
Lead's ruling, this stays a ONE-PREDICATE fix (Lesson 155) — no per-site gating, so the WRITE-type sites
stay safer too (`false` moves every caller toward over-block, the safe direction under this record's own
original ruling), even though the three WRITE sites themselves were not independently reproduced.

**ROUND 3 (re-CR, SOUND):** no new over-unblock and no stuck human clear found across W⊂entry, entry⊂W,
overlapping-incomparable, disjoint, and equal × every real clear route, in memory and after reboot — round
2 is never worse than round 1 or bare identity. Three doc/naming corrections only, no behavior change:
(1) `entryStillOwnsKey`'s own LEAD doc paragraph had drifted to describe the DROPPED `entry ⊆ occupant`
direction while the code is `occupant ⊆ entry` — fixed in place to match the code and this record. (2) the
test-only setter was renamed `setActiveQuarantineTestOnly` (see (iii) below) so its OWN name, not just its
doc comment, is what `no-src-testonly-import-guard.mjs` actually keys on. (3) the doc's "every real
human/automatic clear route still lifts a genuine rebuild fully" claim is now bounded, not absolute: one
HAND-BUILT exception stays fail-closed (never fail-open) — an entry armed at two keys (`armedKeys:[K,K2]`)
whose own `K2` slot was never synced to a later, same-identity SUPERSET build sitting there can leave that
`K2` slot un-lifted by the resolvable `clearMergeQuarantine` route specifically, while
`clearMergeQuarantineByRecordedPath` still clears it; no real path to that unsynced state was found
(`replaceEntryEverywhere` syncs every `===` slot).

**(iii) Pinning the non-empty-tokens clause:** an empty token set is vacuously a subset of anything,
which would silently reopen the identity-only hole for a pathological zero-token occupant. No real code
path can produce one (see (i) above), so it is pinned via a new, minimal TEST-ONLY export,
`setActiveQuarantineTestOnly(key, entry)` — directly arms the REAL, module-global `activeQuarantines` map
itself. This does NOT mirror `armQuarantineKeyTestOnly`'s own precedent: that one writes into a
CALLER-SUPPLIED `byRepoKey` map, isolated from the real singleton; this one has no such isolation and
mutates the live map directly, so its name's `TestOnly` suffix is load-bearing —
`no-src-testonly-import-guard.mjs` matches `/TestOnly$/` specifically to catch a future production import
of exactly this kind of live-map-mutating seam (round-3 CR). Verified RED when the guard clause is
removed (manual negative control, not committed).

**c93e9e7a (unmerged, branch `loom/dbc76bd19a0e`) — not touched, per Lead instruction.** Its own fixture
encoded W1 being DROPPED by `clearMergeQuarantineByKey(Kc2, y)` as the expected, asserted outcome (the
"W1-W3 as separate records" shape this card's own title names). Every assertion in that fixture expecting
W1 (or an equivalent independent same-identity record) to be LOST by that clear must flip to expect
SURVIVAL once that branch resumes and rebases past this fix — c93e9e7a's own round 2 note already flagged
this; this record is the pointer for whoever resumes it.

**Probe G** (Code Review's own round-2 finding): a pre-existing, same-general-class over-unblock, OUTSIDE
this predicate entirely — carded separately by the Lead. Not fixed here.

Tests: `merge-quarantine-f3c644ca-entity-gate.mjs` — 7 scenarios (2 LIFT repros, probe A, 2 real-clear-
route clearability sub-cases, the ONE kept `occupant ⊆ entry` clearability direction, the empty-tokens
guard pin, 1 ordinary-multi-raise regression sanity), 32 checks. RED (6 failures) on the bare pre-fix
identity predicate; RED (3 failures, probe A) with the round-1 SYMMETRIC gate restored; RED (1 failure,
the guard pin) with the non-empty clause removed; GREEN after the round-2 fix, byte-identical restore
each time. All 48 `merge-quarantine*.mjs` run serially, exit 0, in both env states
(`LOOM_DEV`/`LOOM_SUPERVISED` unset, and `LOOM_DEV=1`).
