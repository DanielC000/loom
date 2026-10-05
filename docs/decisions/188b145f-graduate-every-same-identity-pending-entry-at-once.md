# 188b145f — graduate every same-identity pending quarantine entry at once

From Code Reviewer `eccb3d10`'s review of `be79f4d5` (see
docs/decisions/be79f4d5-lazy-graduation-source-latch-ownership.md) — a pre-existing defect that review
found but explicitly left out of scope: "the reviewer's OTHER finding — that `activeMergeQuarantineFor`
graduates only ONE of several same-hash pending entries per query, silently leaving the rest pending
forever rather than reconciling them... a separate, already-filed follow-up card." This card is that
follow-up; it does not restate be79f4d5's own ownership narrative, only the parts that changed because of
it.

## The bug

`activeMergeQuarantineFor`'s lazy-graduation branch (`git/merge-quarantine.ts`) found only the FIRST
`pendingUnresolvedQuarantines` entry matching a repo's identity (`findIndex`) and `splice(idx, 1)`'d only
that one out. When PASS 1b had pushed more than one same-hash pending entry for ONE repo (two
`.json.tmp-<pid>` residues sharing a hash — see
`merge-quarantine-lazy-graduation-source-latch-owner.mjs` scenario 6 for how this arises), every OTHER
matching entry was left behind in `pendingUnresolvedQuarantines`. Every LATER query for that same repo hit
the `direct` fast path (`activeQuarantines.get(key)`) at the top of the function and returned before ever
examining `pendingUnresolvedQuarantines` again — so the rest sat there FOREVER: never merged into the real
armed entry, their own tokens invisible to anything reading the armed entry's own `tokens` field, and (per
`listActiveMergeQuarantines`, which reports both maps) the same repo showed up TWICE in any diagnostic
listing, permanently. That leftover state is exactly what be79f4d5's own scenarios 6/7 deliberately
exploited as scaffolding to reach ITS ownership gap, rather than fixing it.

## The fix

Every tier of the existing three-tier match cascade (direct identity → ancestor identity →
resolvable-canonical-key, same precedence as before) now collects ALL matching indices at whichever tier
actually produces a hit, not just the first (mirroring the `.filter(...)` pattern
`clearMergeQuarantineLatchFile`/`clearMergeQuarantineByRecordedPath` already use for their own pending
match loops). Once resolvable, every matched index is spliced out in one step (descending order, so
earlier indices stay valid), and the matched entries are reduced via the existing `unionQuarantineEntries`
helper (the same one PASS 2/`armQuarantineKey` already use elsewhere in this module) — unioning tokens and
`orphanLatchFiles`, keeping the EARLIEST non-placeholder identity, never arbitrarily "whichever entry
`findIndex` happened to hit first". **Doc nit (round 2, Code Reviewer 638ee0bc):** `unionQuarantineEntries`
spreads the WHOLE older entry (`{...older, ...}`), not just a hand-picked subset of fields — `repoPath` is
inherited from it too, same as branch/reason/opId/enteredAt. In every scenario this fix exercises, every
matched entry shares the SAME identity by construction, so this is never observable as a behavior change —
but a reader should know the chosen object is the older entry's own, verbatim, not a reconstructed one.
`resolvedKey` lands on the fresh key on the unioned entry, exactly as before.

Ownership generalizes from be79f4d5's one-entry rule to N entries: on a successful write, every matched
entry's own `sourceFile` is deleted via the existing `deleteSourceLatchIfSuperseded` (looped, one call per
file — the function is already a safe per-file no-op, so no new helper was needed). On a FAILED write,
EVERY matched `sourceFile` (skipping only one that already equals the fresh write target) is folded into
the unioned entry's `orphanLatchFiles`, not just the one a single-entry-only fix would have picked — so a
raw clear-by-id of ANY of their stale hashes keeps all of them, not just whichever one happened to be
folded in.

When only ONE entry matches (the ordinary, pre-existing case), the new code is byte-identical in behavior
to the old single-entry path: `unionQuarantineEntries` is never called (the `.reduce` over the remaining
matched entries is a no-op over an empty tail), and the per-file loops run their body exactly once.

Matching stays by IDENTITY (`directPathIdentity`/`ancestorAwarePathIdentity`/`canonicalRepoLockKey`),
never by filename hash — two entries sharing a hash prefix but belonging to two DIFFERENT repos (9cabd143's
own point: no real SHA-256 collision is needed for two latches to share a filename) are never collected
together. Proven directly: `merge-quarantine-lazy-graduation-multi-pending.mjs` scenario 4 manufactures
exactly this cross-repo shared-hash shape and asserts repoB's own pending entry survives repoA's
graduation untouched, then still graduates correctly on its own.

## Consequence for be79f4d5's own test file

be79f4d5's scenario 6 (`merge-quarantine-lazy-graduation-source-latch-owner.mjs`) was written explicitly
exploiting the "only one of several same-hash pending entries ever graduates" shape this card closes — its
own setup comment said so. Once this card lands, there is no longer an "OTHER, still-pending" entry left
behind for that scenario's raw clear-by-id to separately match-and-delete: both of its same-repo tmps are
now folded into the ONE graduated entry's own `orphanLatchFiles` on a failed write, so a raw clear-by-id of
the shared stale hash correctly KEEPS BOTH now, where it previously (correctly, under the old shape)
deleted the one left behind as independently pending. Scenario 6 (and the file's own top-of-file summary
and the top-level pass/fail message) were updated in place to assert the new, generalized reality rather
than the now-structurally-impossible old one. Scenario 7 (a genuine cross-REPO hash collision, not a
same-repo multi-pending one) was unaffected and needed no changes.

## Round 2 (Code Reviewer 638ee0bc)

**Finding 1 (BLOCKING) — lost coverage.** Moving scenario 6 off the PENDING-MATCH branch (see above) meant
`clearMergeQuarantineLatchFile`'s belt-and-suspenders TMP sweep ON THAT BRANCH specifically
(`sweepTmpResidueForHashIfUnreferenced(id)`, reached only when the clear-by-id DOES match some pending
entry) lost its only test that could go RED against it — reverting that one call to the unconditional
`deleteMergeQuarantineTmpResidueForHash(id)` left all 15 `merge-quarantine*.mjs` files green. Fixed by
adding SCENARIO 9 to `merge-quarantine-lazy-graduation-source-latch-owner.mjs` — scenario 7's `.tmp-`
-sourced twin: repoG graduates from its own `.json.tmp-*` pending source with a FAILED write (folding that
tmp into its own `orphanLatchFiles`) while repoP stays genuinely PENDING on its own `.json.tmp-*` source
sharing the exact same hash prefix. Clearing by that hash matches ONLY repoP's still-pending entry,
provably hitting the PENDING-MATCH branch (`wasQuarantined===true`) — RED-proven directly against the
exact line-951-shaped mutation above, GREEN after. Scenarios 6, 7, and 9 now each assert `wasQuarantined`
explicitly (6: `false`, raw fallback; 7 and 9: `true`, pending-match) so which branch each one exercises is
unambiguous, never left to be inferred from the surrounding prose.

**Finding 2 — the same bug, a sibling call site.** `enterMergeQuarantine`'s own pending-merge branch (a
fresh RAISE on a repo that already has one or more pending, key-unverifiable latches) had the identical
`findIndex` + `splice(pendingIdx, 1)` shape — two same-identity pendings plus a re-raise left the repo
listed twice, the second pending's own token invisible, and its tmp residue stranded forever (same class,
reached through a RAISE instead of a QUERY). Fixed with the same collect-all-and-union treatment, sharing
`collectPendingIndices` (a new module-level helper, hoisted out of `activeMergeQuarantineFor`) rather than
duplicating the index-collection logic a second time. The pending side of the union is folded together
FIRST (in matched order, earliest-enteredAt-wins ties among them), then unioned with the fresh raise LAST —
this preserves the exact `unionQuarantineEntries(pending.entry, fresh)` argument order (and its tie-break)
the single-match case used before, so that case stays byte-identical. `enterMergeQuarantine` only ever
matched pending entries by `directPathIdentity` (one tier, never the two fallback tiers
`activeMergeQuarantineFor` also has) — that stays unchanged; only "first match" became "every match at that
one tier". RED-proven in `merge-quarantine-lazy-graduation-multi-pending.mjs` scenario 5, directly against
a mutation limiting the collected indices back to the first one, GREEN after.

**Finding 3 — doc nit.** Folded into "The fix" above (not restated here): `unionQuarantineEntries` spreads
the whole older entry, `repoPath` included.

**Deliberately NOT fixed here** (per the round-2 reviewer's own scoping, filed as separate cards): a
cross-tier stranding gap and an N-file partial-unlink exposure the reviewer also found. Do not re-derive
either from this record.

## Round 3 (Delta Code Review `f61b7f6e`) — MAJOR: round 2 only covered the SUCCESSFUL-write path

Round 2's own commit claimed to "close `enterMergeQuarantine`'s stranding" but only generalized the
SUCCESS branch (collect-all, splice, delete). The reviewer reproduced the identical defect class ONE
level deeper: on a FAILED write, `enterMergeQuarantine`'s pending-merge branch neither spliced the matched
pendings nor folded their `sourceFile`s into `orphanLatchFiles` — it just left them exactly where they
were, armed in-memory under a `merged` entry that referenced none of them. Two same-hash pending tmps plus
a raise whose write fails (EACCES) reproduced: (a) the repo listed 3 times, and STILL 3 times after a
LATER raise that does persist (that later raise hits the `existing` branch, which never touches
`pendingUnresolvedQuarantines` at all — the stranded two stay stranded forever); (b) a raw clear-by-id of
the shared stale hash took the PENDING-MATCH branch (since both tmps were still literally sitting in
`pendingUnresolvedQuarantines`) and deleted BOTH outright — the merged entry's ONLY durable copies — so a
restart found the repo NOT quarantined at all: the exact silent fail-open class every round of this card
(and be79f4d5 before it) exists to close, reopened through a FOURTH call site shape (a failed write on the
RAISE path, never reached by any of rounds 1-2's own repros).

**The reviewer's Minor, fixed by the same change:** `enterMergeQuarantine`'s pending-merge branch also
never stripped a matched pending's own dangling self-reference from `orphanLatchFiles` BEFORE writing —
be79f4d5's own strip-before-write rule (ported to `activeMergeQuarantineFor` in round 1) was never ported
to this sibling call site. Reproduced at N=1 (a single matched pending already self-referencing its own
`sourceFile`) and N=2 (two matched pendings, each self-referencing its own).

### Fix

Extracted ONE shared helper, `consumeMatchedPendingsIntoArmedEntry` (`git/merge-quarantine.ts`), applying
graduation's EXACT rules regardless of caller: splice every matched index out of `pendingUnresolvedQuarantines`
UNCONDITIONALLY (before the write is even attempted); strip every matched `sourceFile` from the unioned
`orphanLatchFiles` before the write; on a SUCCESSFUL write, delete each matched `sourceFile` via
`deleteSourceLatchIfSuperseded`; on a FAILED one, fold each matched `sourceFile` (skipping one that already
equals the fresh write target) into `orphanLatchFiles` instead. `activeMergeQuarantineFor`'s own
lazy-graduation branch and `enterMergeQuarantine`'s own pending-merge branch now BOTH call this ONE
function — there is no second, hand-maintained copy left to drift out of sync with it again, which is
exactly how round 2's own fix silently missed the failure branch in the first place (it ported the
success-path shape by hand, without re-deriving the full rule from `activeMergeQuarantineFor`'s own
already-correct code).

The single-match, successful-write case (the overwhelming majority of real calls, both callers) is
byte-identical to round 2's own behavior — the helper's internal `.reduce`/strip/write/delete sequence is
exactly what each caller already did inline for that case; only the FAILURE branch and the
dangling-self-reference strip are new behavior, both previously missing from `enterMergeQuarantine` only.

Tests: `merge-quarantine-lazy-graduation-multi-pending.mjs` scenario 6 (the failed-write variant of
scenario 5 — listing count stays 1, `latchKept:true` on a stale-hash clear-by-id, and the quarantine
SURVIVES a restart) and scenarios 7/8 (N=1/N=2 dangling-self-reference strip on a successful raise,
asserting the PERSISTED file's own `orphanLatchFiles`, not just the in-memory entry). Each RED-proven
directly against the pre-round-3 code (scenario 6 by temporarily reverting `enterMergeQuarantine` to its
round-2 shape and rebuilding; the negative-control tool against the pre-round-3 commit for the full suite).

## Do not

- Do not re-introduce a single-index `findIndex`/`splice(idx, 1)` at ANY pending-merge site in this
  module — not just `activeMergeQuarantineFor`'s match cascade, but `enterMergeQuarantine`'s own
  pending-merge branch too (round 2's own finding: the identical defect lived in both). Any future
  pending-merge site must consume its matches through the ONE shared `consumeMatchedPendingsIntoArmedEntry`
  helper — never hand-roll a second inline copy of its splice/strip/write/delete-or-fold sequence, even a
  seemingly-faithful port of the success path alone. That is exactly how round 2's own fix passed review
  while still missing the failure branch entirely (round 3's own finding) — a hand-copied sequence drifts
  from its source the moment either one changes without the other; the shared helper is what makes that
  structurally impossible instead of merely "remembered".
- Do not match pending entries to graduate together by filename hash (or any hash-derived value) — match
  by IDENTITY only (the same three-tier cascade this function already used). A filename hash can be shared
  by two entirely unrelated repos (9cabd143), and unioning across that boundary would merge two different
  repos' quarantines into one.
- Do not assume `unionQuarantineEntries`'s tokens/`orphanLatchFiles` union needs a NEW helper for N
  entries — it already handles pairwise union correctly commutatively (it decides "older" via `enteredAt`/
  placeholder status regardless of argument order), so a `.reduce` over the matched list is sufficient.
- Do not skip the single-entry-identical check when touching this code again — the single-match path
  (ordinary case, the overwhelming majority of real queries) must remain byte-identical to the pre-fix
  behavior; a regression here would be caught by
  `merge-quarantine-lazy-graduation-multi-pending.mjs` scenario 3 (negative control) and every scenario in
  `merge-quarantine-lazy-graduation-source-latch-owner.mjs` except 6/7.
- Do not re-derive scenario 6's update from scratch if this file drifts again — read its own updated
  comment in `merge-quarantine-lazy-graduation-source-latch-owner.mjs` first; this record does not restate
  the scenario's full body, only why it needed to change.
