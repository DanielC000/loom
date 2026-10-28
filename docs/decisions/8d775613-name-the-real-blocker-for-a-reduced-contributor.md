# 8d775613 — name the real blocker when `/clear` refuses a reduced contributor

From card `3b1944b6`'s THIRD Code Review (reviewer `aaa1c93f`, at `a29f09b1`), item 3. Card `3b1944b6`
records a reduced contributor `sub` in foreign union R's `reducedContributorRepoPaths`. After that reduce,
if R's own token is then settled via `clearMergeQuarantineByToken`, the union holds only sub's leftover
token. `/clear(sub)` was refused with "quarantined by ANOTHER repo's own, separate quarantine ... that
this clear never addressed" — FALSE: the only thing outstanding is sub's own raise. The disclosed remedy
(clear-by-path/clear-by-id on R) works (3b1944b6's own "THE TOKEN QUESTION"); only the text misled.

## Root cause

`isHostOfContributor` gated BOTH its disjuncts — the plain `contributorRepoPaths` match and the
`reducedContributorRepoPaths` match — on `!isRepoPathCurrentlyResolvable(queriedRepoPath)`. Correct for
the plain case (`2a169469` round 3: a resolvable plain contributor is already independently enforced via
the key-collapse/ancestor tier). WRONG for the reduced marker: it exists precisely for a resolvable,
key-collapsed path (no own `.git`, per `3b1944b6`) — a repeat `/clear` routes to the idempotent
`reduceForeignUnionContributor` arm regardless of resolvability, so gating the text on resolvability fell
through to the false wording. Even the FIRST clear hits this — the reduce runs synchronously inside the
same call `stillQuarantinedReason` then reports on.

## Round 1 (commit `3ef87ee0`, REJECTED by Code Review — do not re-implement)

The first fix dropped the resolvability gate for `reducedContributorRepoPaths` but kept the ORIGINAL
"folded into ... entry's own token set ... clearing repoPath directly never lifts a contributor" wording,
adding an exclusion for an identity still ALSO listed in `contributorRepoPaths`. That exclusion does NOT
separate the two mechanisms sharing the marker: a genuine token-absorption reduce
(`reduceForeignUnionContributor`) REMOVES the identity from `contributorRepoPaths` when adding it to
`reducedContributorRepoPaths`; 3b1944b6's own "shape A" marking (`markIdentityAsReducedOnForeignKey`, via
the shared `preClearForeignKeyStamp` chokepoint, fired by every route — including clear-by-id — clearing
an identity's own SEPARATE record while its fresh key is foreign) never had it in `contributorRepoPaths`
either. Both end up "reduced-only"; the exclusion only caught a synthetic, production-unreachable hybrid
test fixture, never the real shape A.

Measured (3b1944b6's own round5-shapeA-cc construction: R raised; sub raised with its OWN `.git`; sub's
`.git` removed, collapsing it onto R; `clearMergeQuarantineReporting(sub)` twice): at `3ef87ee0` BOTH
clears claimed "never lifts a contributor" and "folded into ... token set" — false twice over. The FIRST
clear genuinely DID lift sub's own record; sub's token was never inside R's token set.

## The ruling (round 2)

The marker field cannot distinguish the two mechanisms (3b1944b6 Round 5's own doc: "BOTH land `c` in the
exact same `reducedContributorRepoPaths` array"), so the text for a `reducedContributorRepoPaths` match
must be NEUTRAL — true for both, asserting neither token membership nor a per-clear "never lifts" claim
that is false on shape A's own first clear. No new discriminator predicate, no second marker field (Round
5's one-shared-field ruling stands); the remedy suffix stays routed through the existing
`selfClearRefusesForStaleKeyContributors`/`broadUnionTargetFor` machinery, unchanged.

Text: `"repoPath's identity is recorded as reduced under another, still-quarantined entry (host repoPath
'<R>', latch id '<id>') — repoPath's own clear cannot resolve this further; clearing '<R>' is what lifts
it."` Premise verified with a real-git probe BEFORE writing this, for BOTH shapes: clearing R afterward
genuinely names `sub` in `liftedRepoPaths`, leaving `assertRepoNotQuarantined(sub).ok === true` — true for
the absorption-reduce shape (3b1944b6's own "still-liftable" control) and for shape A alike.

## Do not

- Do not gate the `reducedContributorRepoPaths` disjunct on resolvability — reopens the original bug.
- Do not reintroduce an exclusion (e.g. on `contributorRepoPaths` membership) or any other discriminator
  to separate the two mechanisms — the data cannot tell them apart; a discriminator only narrows to
  catching a synthetic test fixture while leaving the real shape-A regression open. Keep the text neutral.
- Do not claim token-set membership or "never lifts a contributor" — false for shape A's first clear.
- Do not change `clearMergeQuarantine`'s routing or what any route lifts — text-only.
- Do not add a second marker field — `3b1944b6` Round 5 chose one shared field.

## Tests

`packages/daemon/test/merge-quarantine-8d775613-reduced-contributor-real-blocker-text.mjs` — both the
card's genuine-absorption shape AND 3b1944b6's own shape-A construction, each asserted through the REAL
REST `/clear` route (`buildServer`+`app.inject`) on the first and a repeat clear, plus the premise proof
(clearing R names the other identity in `liftedRepoPaths`). Negative control: an unrelated entry keeps
"ANOTHER repo's own" unchanged. `3b1944b6`'s round5-shapeA-cc/-crc gained reason-text assertions.
`2a169469`'s `clear-by-id-resolvable-contributor-own-record-wording` stale pin (predating this card and
3b1944b6's own shape-A marker reaching clear-by-id) updated to neutral wording. RED on `3ef87ee0`
(overclaiming) for shape-A, RED on `eaede872` (pre-fix) for card-shape, GREEN after — via
`pnpm --filter @loom/daemon negative-control --ref 3ef87ee0 --file
packages/daemon/src/git/merge-quarantine.ts --test
packages/daemon/test/merge-quarantine-8d775613-reduced-contributor-real-blocker-text.mjs`, same with
`--ref eaede872`. Full `merge-quarantine*.mjs` corpus run individually, foreground, all green.
