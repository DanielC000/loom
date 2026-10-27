# 6de79dc0 — a key-owning primary's self-clear refuses when a SIBLING key's genuine contributor is folded in

From card `3be11be4`'s own CR3, a pre-existing WRONG RELEASE out of that card's own scope. `S` genuinely
owns its own canonical key `Ks` (`identityAtRaise` equals `Ks` exactly) but is ALSO dual-armed at a
wholly SEPARATE, unrelated key `Kr` via a legacy stale `resolvedKey` field. `R` is a REAL, independent
sibling repo whose own genuine canonical key IS `Kr`. When `R` raises for real, `enterMergeQuarantine`'s
`existing` branch folds it into `S`'s union as a mere `contributorRepoPaths` member, with no freshness
check on whether `S`'s own occupancy of `Kr` was ever genuine. `/clear(s)` then lifts EVERY key `S` is
live-armed at — including `Kr` — destroying `R`'s own, genuinely separate, outstanding quarantine.
`3be11be4`'s own guard does not catch it: it refuses only when the union's own frozen `identityAtRaise`
is NESTED under a live-armed key; `Ks`/`Kr` are unrelated siblings, never an ancestor/descendant pair.

**Evidence (full narrative, every round's own repro/fix/test, the exhaustive spread-audit table):**
`docs/decisions/6de79dc0-self-clear-refuses-sibling-key-genuine-contributor-evidence.md` — kept separate
to stay under the per-record injection byte cap. Read it before trusting any summary below.

## The fix (summary — see Evidence for the full history, including two corrections)

A new persisted field, `genuineContributorKeys?: string[]` (`MergeQuarantineEntry`), named for the SUBSET
of an entry's own live-armed keys where a genuine, independently-verified raiser folded in as a
contributor at a key that is NOT the entry's own `identityAtRaise`. `selfClearRefusesForStaleKeyContributors`
ORs a second condition in: refuse when a live-armed key is EITHER nested under the entry's own identity
(3be11be4's shape) OR named in `genuineContributorKeys` (this card's shape).

**Legacy fail-closed, two tiers:** `identityAtRaise === undefined` fails closed per 3be11be4's own rule.
`identityAtRaise` present but `genuineContributorKeys === undefined` (predates this card) ALSO fails
closed, but BROADLY — refuse on ANY live-armed key differing from `identityAtRaise`. Only once the field
is present (even `[]`) does the PRECISE check apply.

**Carried forward ONLY via the one shared `unionGenuineContributorKeysAbsorbing` helper, at every
multi-input merge site — NEVER a bespoke per-site reimplementation, and NEVER the plain OR-union
`contributorRepoPaths` itself uses.** Absence here means "no precise per-key record exists," not "nothing
to contribute" — it must be ABSORBING (if ANY input is `undefined`, the result is `undefined`,
unconditionally). Two Round-1 claims — "carried forward at every copy/union/parse site" and "a dropped
field only re-widens to the safe fallback" — were **both FALSE**, each reproduced TWICE across Rounds 2
and 3 (CRITICAL-1, CRITICAL-2, two further MINORs — see Evidence). Re-derive the site list from the
Evidence file's own audit table; never trust a restatement, including this one.

The refusal text and the shared `remediationTextFor` both gained carefully-scoped disclosure branches
across all three rounds — see Evidence for the exact wording and why each was needed (3be11be4's own text
over/underclaimed ownership for this shape; `remediationTextFor`'s own `ownKeyOwnership` needed a
real, entry-level correction in Round 3 after Round 2's own per-latch-key version proved wrong, then a
tri-state widening in a later review round — see Evidence's own "Round 4" section).

## Consequences (CR3, session `d839b41f`) — the reingest demotion can strand a sibling-key union behind every REST clear route

Accepted by Lead ruling. `reconcileMarkedBasenameBeforeWrite`'s reingest branch (Round 3) permanently
demotes a PRECISE on-disk `genuineContributorKeys` to the broad `undefined` fallback the instant a boot
reads it back after a transient unreadable-at-boot glitch — and the broad fallback refuses on ANY
non-own live-armed key, so a genuinely sibling-key-dual-armed union can end up REFUSING every REST
clear route (self-clear, clear-by-path, clear-by-id) even after the human clears every real contributor.
The only escape is a project-resolved `/clear` for a project rooted at the stale secondary key's own
subdirectory, or a manual latch-file delete plus a daemon restart. This happens ONLY after the same
transient-unreadable-at-boot precondition the "Do not" list's own legacy-fallback rule already accepts
for a field-less union — never during ordinary operation. The placeholder is deliberately NOT minted with
`genuineContributorKeys: []` instead: an unreadable placeholder genuinely does not know its own
contributors, and `[]` there would be a FAIL-OPEN (a silently narrow, unverified "no contributors" claim),
the exact class of bug this whole card exists to close.

## Do not

- Do not widen `isNestedUnderKey`'s own bare-inequality check instead of adding `genuineContributorKeys` —
  3be11be4's own Round 2 already tried a bare `identity !== armedKey` inequality and found it too broad
  (fires on `82032b5c`'s own deliberately-permitted manufactured-collision shape). This card's own field is
  additive specifically so it never touches that history.
- Do not stamp `genuineContributorKeys` at `consumeMatchedPendingsIntoArmedEntry` — see the Evidence file's
  own "Why `consumeMatchedPendingsIntoArmedEntry` never ORIGINATES this field" section; its own fold is a
  verified same-key collapse, structurally incapable of producing this card's own shape.
- Do not "fix" `reduceForeignUnionContributor` to prune `genuineContributorKeys` without re-reading the
  Evidence file's own "Accepted, named residual" section first — the current behavior is a deliberately
  accepted, safety-neutral (over-refuse-only) residual, not an oversight.
- Do not compare a live-recomputed key against `genuineContributorKeys` at clear time — the whole field
  exists to avoid exactly the live-fs-recompute class 3be11be4's own Round 3 CRITICAL closed for
  `identityAtRaise`. Every member is frozen at fold time; never re-verify it later.
- **Do not union `genuineContributorKeys` with a plain OR (`a || b ? [...a,...b] : undefined`), and do not
  take ONE matched input's own value alone at a multi-input merge site.** Both were tried, both reproduced
  a real wrong release more than once. The ONLY correct union is the ABSORBING rule, via the one shared
  `unionGenuineContributorKeysAbsorbing` helper — never a per-site reimplementation, however small (Round
  3 found a THIRD hand-rolled reimplementation that still broke it).
- **Do not trust "carried forward at every copy site," "a dropped field only re-widens to the safe
  fallback," or "a no-op identical to X" without re-deriving it from the Evidence file's own current audit
  table.** All three were asserted across Rounds 1-3 and all three were FALSE when checked.
- Do not add a NEW multi-input `MergeQuarantineEntry` merge site to this file without checking it against
  the Evidence file's own exhaustive spread-audit table FIRST — update that table when adding one.
- **Do not compute "does this entry genuinely own its own key" against ONE specific latch key (a
  self-clear's own fresh key, a latch id's own resolved key, `quarantineLatchFileIdsFor(q)[0]`) — a human
  can address the SAME entry by ANY of its own live-armed keys, and the fact is about the ENTRY, not the
  key.** Use `entryGenuinelyOwnsALiveArmedKeyOfItsOwn(entry)` for `remediationTextFor`'s own
  `ownKeyOwnership` parameter specifically — never re-derive it per key.
- **Do not collapse `entryGenuinelyOwnsALiveArmedKeyOfItsOwn`'s tri-state back to a boolean** — a LEGACY
  entry and a STALE one must resolve `"unknown"` (a HEDGED clause), never `"not-owned"` (silence); see
  Evidence's own "Round 4" section for the two shapes this closes and why.
