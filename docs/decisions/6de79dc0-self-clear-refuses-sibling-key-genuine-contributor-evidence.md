# 6de79dc0 — evidence (full narrative, split from the main record to keep it under the per-record byte cap)

Pointer target for `docs/decisions/6de79dc0-self-clear-refuses-sibling-key-genuine-contributor.md`'s own
"Evidence" line. Nothing here is deleted from the main record's own history — it was moved, verbatim.

## Verified, not assumed: what `/clear(r)` actually does in this shape

Per manager instruction: checked empirically before writing any remediation text, never assumed from the
mirror shape. `/clear(r)` — the genuine contributor's own clear — fully releases BOTH `r` and `s` in one
step (an `(explore-clear-r)` scenario in the test file, driven against real code). This matches
`remediationTextFor`'s own pre-existing "sequence-r-owns" wording verbatim (built and tested by `3be11be4`
for ITS OWN mirror shape) — confirmed it also holds for this card's own sibling-key shape, not assumed by
analogy.

## Non-regression: effect on the `merge-quarantine-runtime-union-provenance.mjs` CASE 1 / CASE 2 shapes

- **CASE 1** (`x` owns its key genuinely; `ySub` is `x`'s own subdirectory, no own `.git` — SAME canonical
  key by `7673d096`'s own rule, never two distinct keys): unaffected by construction. `liveArmedKeysOf`
  has exactly ONE key here, which equals `identityAtRaise` — there is no SECOND key for
  `genuineContributorKeys` to ever name, so the new OR condition can never fire regardless of its own
  content. Self-clear still lifts everything directly, byte-identical to before this card.
- **CASE 2 / "case B"** (`buildRuntimeUnionFixture`: a hand-authored, field-less, LEGACY, never-resolvable
  `X` manufacture-collides with `Y`'s own genuine key): already refused today, independent of anything this
  card adds — the pre-existing `identityAtRaise === undefined` rule fires first, unconditionally, before
  either OR branch is ever reached (`X` is deliberately field-less: "no current raise can ever produce this
  exact shape", per that fixture's own comment).
- Full 80-file `merge-quarantine*.mjs` corpus run individually (never `--only=`), both `env -u LOOM_DEV -u
  LOOM_SUPERVISED` and `LOOM_DEV=1`: exactly ONE pre-existing scenario's own expectation needed updating —
  `48bda567-no-fire-both-sides-informative-and-different` (a hand-built `isDeepStrictEqual` fixture that
  must list every field `unionQuarantineEntries` sets as an explicit own property, "even when `undefined`"
  — the exact same treatment its own comment already gives `contributorRepoPaths`/`reducedContributorRepoPaths`
  when THEY were added). A pure fixture-staleness update, not a behavior change — confirmed every OTHER
  check in that same scenario, and the rest of the 80-file corpus, is unaffected.

## Found while tracing (not in the original Phase-1 investigation)

`reconcileClearedEntryIfPlaceholder` (merge-quarantine.ts ~:2021) returns a disk-only `...reingested`
spread by default. Its own governing decision record, `656fdf39` ("Do not" list, Round 3 additions),
explicitly warns: "a future field added to `MergeQuarantineEntry` that this function's return literal does
not explicitly name will silently fall through from the DISK-ONLY `...reingested` spread — audit every new
field against this function specifically." `genuineContributorKeys` was exactly that gap — fixed by the
same union-forward treatment `contributorRepoPaths`/`reducedContributorRepoPaths` already get there.

## Why `consumeMatchedPendingsIntoArmedEntry` never ORIGINATES this field (read before "fixing" this)

`contributorRepoPaths`'s own doc comment names TWO origin sites for a runtime fold: `enterMergeQuarantine`'s
`existing` branch, and `consumeMatchedPendingsIntoArmedEntry`'s own cross-tier-sibling union. This card's
own `genuineContributorKeys` deliberately originates at ONLY the first — do not add a parallel stamp to
the second; it would be dead code at best and could manufacture a false "genuine" mark at worst.

`consumeMatchedPendingsIntoArmedEntry`'s own absorption is gated by `collectCrossTierSiblingIndices`
(~:491) / `isKeyVerifiedFor` (~:503): every PENDING entry it matches is independently, freshly VERIFIED —
`isRepoPathCurrentlyResolvable(p.entry.repoPath) && canonicalRepoLockKey(p.entry.repoPath) === key` — to
genuinely, currently own the EXACT SAME single `key` the new arm is being minted at. There is never a
second, distinct key in play at this fold site the way there is at `enterMergeQuarantine`'s `existing`
branch (where the pre-existing occupant's own key and the new raiser's own key can be two wholly unrelated
siblings, `Ks` vs `Kr`). A same-key-only fold has nothing of this card's own shape to record: the "genuine
contributor at a DIFFERENT key" condition this field exists to flag is structurally unreachable here.

It still correctly CARRIES the field forward when either side already has one — via its own delegation
into `unionQuarantineEntries` (`unioned = matched.reduce(..., unionQuarantineEntries, first.entry)`, which
unions `genuineContributorKeys` exactly like `contributorRepoPaths`), and via `armed`'s own `{...unioned,
...}` spread, which never drops it. That is the correct and sufficient treatment — carry, never originate.

## Accepted, named residual: `reduceForeignUnionContributor` never prunes a reduced contributor's own key

`reduceForeignUnionContributor` (~:5572) drops a reduced-out identity from `contributorRepoPaths` into
`reducedContributorRepoPaths`, but does NOT remove that identity's own key (if any) from
`genuineContributorKeys`. Accepted, not fixed — the shape it can produce is already SAFE, never a wrong
release:

- If the reduced-out identity was the ONLY contributor, `contributorRepoPaths` is now empty, and
  `selfClearRefusesForStaleKeyContributors`'s own FIRST line (`(entry.contributorRepoPaths?.length ?? 0)
  === 0 return false`) makes the whole predicate return `false` unconditionally — the stale
  `genuineContributorKeys` entry is never even read.
- If other contributors remain, a stale key can still name a NOW-defunct key that `liveArmedKeysOf(entry)`
  may no longer even include (the reduce path can leave it un-armed) — in which case the `.some()` never
  reaches it either.
- In the narrow residual case where a stale key both remains in `genuineContributorKeys` AND is still
  live-armed for some other reason, the predicate OVER-refuses (treats a key as still needing the
  sibling-genuine protection it no longer strictly needs) — never UNDER-refuses. The failure mode this
  card exists to close (a wrong, silent release) cannot reopen through this residual.

Not fixed in this card: pruning `genuineContributorKeys` in lockstep with `reduceForeignUnionContributor`
would need the same reduce-time bookkeeping `reducedContributorRepoPaths` already does for membership, for
a field that only ever makes the guard MORE conservative when stale — out of this card's own scope. A
future card may close it for precision; nothing here depends on it being closed for safety.

## Round 2 — Code Review (reviewer `1013157b`, at commit `b94fd210`): NOT-SHIP, two more CRITICAL wrong releases

Round 1's own claim "carried forward at every copy/union/parse site" and "a dropped field only re-widens
to the safe fallback, never a wrong release" were BOTH FALSE — reproduced directly against `b94fd210`
with hermetic probes before any further fix was written (`probeG`/`probeH`, reviewer's own scratch dir).

### CRITICAL-1 — `divertRaiseEntry`/`mergeTokenIntoPendingEntries` took one matched input alone, dropping a genuinely different input's own keys

Both functions build a merged entry from MULTIPLE matched inputs (`all`/`matched`) but round 1 only ever
wrote `genuineContributorKeys` forward from `base.entry` (the OLDEST matched twin) — a bare `...base.entry`
spread, never a cross-input union. `probeG`: `S` stale-armed `[Ks, Kr]`; `S` raises once while
unresolvable, minting a PENDING twin with its own precise `[]`; `R` then raises genuinely while `Kr`'s own
final is transiently unreadable, so `enterMergeQuarantine`'s `existing` branch diverts — `divertRaiseEntry`
merges the pending twin (`gck=[]`) with the existing-branch's own fresh fold (`gck=["r"]`) and, pre-fix,
kept only the OLDER twin's `[]`, silently dropping `r`. `/clear(s)` then wrongly lifted `[s, r]`. The same
shape reproduces at `mergeTokenIntoPendingEntries` with two PENDING twins for one identity.

**Fix:** a new shared helper, `unionGenuineContributorKeysAbsorbing(all)` (merge-quarantine.ts, next to
`unionArmedKeys`/`unionInformativeResolvedKeys` — same "one implementation, never two that can drift"
extraction those two already use). Both sites now call it across their own FULL input set (`all`/
`matched.map(p => p.entry)`), never `base.entry` alone.

### CRITICAL-2 — absence must be ABSORBING, not OR'd: `{undefined, []}` must stay `undefined`, never become `[]`

Three sites used the SAME plain-OR pattern `contributorRepoPaths` itself uses (`older.gck ||
newer.gck ? union([...older ?? [], ...newer ?? []]) : undefined`) — correct for `contributorRepoPaths`
(absence there really does mean "nothing to contribute"), WRONG for `genuineContributorKeys` (absence
means "no precise per-key record exists at all" — a LEGACY/round-1-era union). The plain OR silently
converts a field-absent legacy union into the PRECISE check it has no data to support the instant it
unions with ANY entry that happens to carry an empty-but-present `[]`. `probeH`: a genuine pre-6de79dc0
on-disk union (`identityAtRaise` stamped, no `gck` field at all) re-raises while transiently unresolvable;
graduation unions it with a fresh `[]`-carrying twin, and the plain OR turned `undefined` into `[]` —
`/clear(s)` then wrongly lifted `[s, r]` via the now-wrongly-precise check. Every 3be11be4-era union
already on disk hits this on its first boot under this card's own round-1 code.

**Fix — the ABSORBING RULE:** in EVERY union of this field, if EITHER side is `undefined`, the result is
`undefined`, unconditionally — legacy stays legacy forever, never narrowed by a later merge. Implemented
once, in `unionGenuineContributorKeysAbsorbing` (`if (all.some(e => e.genuineContributorKeys ===
undefined)) return undefined;`), and used at `unionQuarantineEntries` (~:1056), the existing-branch stamp
(~:3561, which ALSO needed its own fix — see next paragraph), `reconcileClearedEntryIfPlaceholder`
(~:2080), and both CRITICAL-1 sites (which reuse the SAME helper, so they get this rule for free).

The existing-branch stamp (~:3561) had a THIRD shape of the same bug: when `existing.genuineContributorKeys`
was `undefined` (legacy) and `existing` did not own `key`, round 1 computed `[...new Set([...(existing.gck
?? []), key])]` — narrowing `undefined` to `[key]`, the exact promotion the absorbing rule forbids. Fixed
to return `undefined` unconditionally when `existing.genuineContributorKeys` is itself `undefined`, never
narrowing it to a single-element array. **(Round 3 found this hand-rolled version still narrowed in a
different way — see "Round 3" below.)**

### Exhaustive spread audit (every `MergeQuarantineEntry`-merging site in the file)

Per the reviewer's own instruction, since this is the SECOND missed carry-site in two rounds. Every
function in the file whose own body builds an object from more than one `MergeQuarantineEntry` input,
classified (re-verified after Round 3's own fixes — this is the CURRENT table, not Round 2's original one):

| Site | Multi-input? | Union method | Status |
|---|---|---|---|
| `unionQuarantineEntries` (~:998) | yes (`a`,`b`) | `unionGenuineContributorKeysAbsorbing` | fixed (CR2) |
| `armQuarantineKey` (~:1107) | delegates to the above | same | safe (carries forward) |
| `reconcileMarkedBasenameBeforeWrite` reingest branch (~:1478) | wholesale `{...reingested}` adopt | `unionGenuineContributorKeysAbsorbing` (Round 3) | fixed (CR3) — Round 2 wrongly called this a no-op |
| `reconcileMarkedBasenameBeforeWrite` non-reingest branch (~:1512) | single-source `{...entry, ...}` | n/a | safe |
| `consumeMatchedPendingsIntoArmedEntry` (~:1800) | delegates to `unionQuarantineEntries` for its own reduce, then one single-field tweak on the result | same | safe |
| `reconcileClearedEntryIfPlaceholder` (~:2048) | yes (`entry`,`reingested`) | `unionGenuineContributorKeysAbsorbing` | fixed (CR2) |
| `writePendingDivertFile` → `unionIntoOnDiskPendingEntry` (~:2441/3271) | delegates to `unionQuarantineEntries` | same | safe |
| `mergeTokenIntoPendingEntries` (~:3025) | yes (`matched`, N-way) | `unionGenuineContributorKeysAbsorbing` | fixed (CR1) |
| `divertRaiseEntry` (~:3411) | yes (`all`, N-way) | `unionGenuineContributorKeysAbsorbing` | fixed (CR1) |
| `enterMergeQuarantine` existing branch (~:3515) | 2-logical-input stamp (`existing` + new raiser's `key`) | `unionGenuineContributorKeysAbsorbing` (Round 3; was a hand-rolled conditional in CR2) | fixed (CR2 + CR3) |
| PASS 2 orphan-reference merge (~:8848) | single-source `{...existing, orphanLatchFiles: mergedOrphans}` — only merges FILENAMES, never entries | n/a | safe |
| `clearActiveEntryTokenAtKey`/`reduceForeignUnionContributor`/`markIdentityAsReducedOnForeignKey`/etc. (~:4018, 5090, 8422) | single-source `{...entry, <one field>}` | n/a | safe |

No further sites found. `armQuarantineKey` and `unionIntoOnDiskPendingEntry` are "safe" specifically
because they delegate to the one fixed `unionQuarantineEntries`/`unionGenuineContributorKeysAbsorbing`
chokepoint rather than re-implementing a union — exactly the pattern this round's own fix generalizes.

### MAJOR — the refusal's named remediation route releases the primary's OWN quarantine too, unannounced

`/clear(r)` (the "clear each contributor first" step the refusal text recommends) returns `lifted:[r, s]`
in this card's own shape — `s` is a genuinely DIFFERENT, independently-raised repo, so clearing `r` also
releases `s`'s own, separately-outstanding unconfirmed-kill quarantine, with no warning attached to that
sentence. Verified empirically (`(explore-clear-r)`, now a real assertion, not exploratory logging) —
never assumed from 3be11be4's own analogous "(ii-ownerescape)" shape, which has no separately-meaningful
"primary's own quarantine" to warn about in the first place (there, the primary's own name has no
independent standing at its own key at all).

**Ruling, scoped to THIS card only:** `remediationTextFor` gained a new required parameter,
`ownKeyGenuinelyOwned` — true only when `ownRepoPaths` genuinely, independently owns the key the refusal
is about (Round 2 computed this as `entry.identityAtRaise === key`; **Round 3 found this itself wrong —
see "Round 3" below**). In the `noHonestClearByPathTarget` branch, when true, the text now states
explicitly that clearing a contributor can ALSO release `ownRepoPaths`' own quarantine, with the SAME
confirm-no-process discipline the clear-by-path branch's own `confirmClause` already gives. Threaded
through all 4 real call sites (`refuseSelfClearStaleKeyContributors`, `clearMergeQuarantineLatchFile`'s
own ambiguous-active-match branch, the pending-only branch — always `false`, never reaches this branch
anyway — and `assertRepoNotQuarantined`'s own ambiguous-id text).

**Explicitly out of scope (per ruling):** whether `/clear(r)` SHOULD lift `s`'s own genuine quarantine at
all is a PRE-EXISTING behavior (`82032b5c`'s own "collision releases everything" design already does this
for every union shape, not just this card's own) — carded separately; this card changes ONLY the
disclosure text, never the clear's own action.

### MINOR-1 — the legacy-fallback refusal text overclaimed a verified fact it does not have

When `genuineContributorKeys` is absent (the broad fallback fires) but `entry` DOES own `key`
(`identityAtRaise === key`), round 1's text said "is ALSO armed at a separate key that a genuinely
different, independently-raised repo owns" — a claim Loom has NOT verified in this branch (that is
EXACTLY why the broad fallback fired instead of the precise check). Added a fourth ownership-clause
branch: "...ALSO armed at a separate key from before Loom recorded which key (if any) a genuine
contributor came in at, so Loom cannot tell whether that separate key is a genuinely different repo's own
raise or merely a stale artifact of this entry's own history" — the same epistemic honesty 3be11be4's own
Round-4 MINOR-2 fix already gives a missing `identityAtRaise`.

### MINOR-2 — additional tests

`(minor2-clear-by-id)`: clear-by-id for this card's own shape (pre-existing, unaffected refusal posture —
`contributorRepoPaths` alone already refuses it). `(minor2-reboot)`: `genuineContributorKeys` round-trips
a real reboot, and the refusal (and R's own block) survives with it. The divert/pending-graduation carry
cases are covered by CRITICAL-1/2's own new scenarios above.

## Round 3 — Code Review (session `82283d65`, snapshot `0c371e7a`): NOT-SHIP, close

Both CRITICALs verified fixed (RED on `b94fd210`, GREEN at the tip, each single-site mutation RED, no new
fail-open). Three more findings.

### MAJOR — `ownKeyGenuinelyOwned` was computed PER LATCH KEY; the disclosed fact is ENTRY-level

Round 2's own fix compared `entry.identityAtRaise` against ONE specific key — the self-clear's own fresh
key, or (at the other 2 sites) whichever key a human's OWN query happened to resolve to. Reproduced: clear-
by-id with R's own latch id (`hash(Kr)`) omitted the clause in 8 of 8 runs even though `/clear(r)` DOES
lift S (`Ks !== Kr`, so the per-key comparison always reads "not owned" there, however genuinely S owns
`Ks`); `assertRepoNotQuarantined` picks `quarantineLatchFileIdsFor(q)[0]`, itself order-dependent on
`armedKeys`.

**Fix:** `entryGenuinelyOwnsALiveArmedKeyOfItsOwn(entry)` (merge-quarantine.ts ~:4869) — `identityAtRaise
!== undefined && liveArmedKeysOf(entry).includes(identityAtRaise)` — computed ONCE from `entry` alone,
correct regardless of which of its own live-armed keys a caller used to find it. Corrected count (CR3,
session `d839b41f`): replaces the per-key comparison at 3 of the 4 `remediationTextFor` call sites
(`refuseSelfClearStaleKeyContributors` ~:5691, `clearMergeQuarantineLatchFile`'s active-match branch
~:6876, `assertRepoNotQuarantined` ~:7205) — the 4th (the pending-only branch, ~:6964) passes a literal
`false` and was never touched: its own `ownPathViable` is always `true` there, so the clause can never
fire regardless of what its 4th argument carries.

**Tests (`(major-order-independence)`):** both `armedKeys` orderings forced directly (`setActiveQuarantineTestOnly`
on both keys, never relying on boot's own natural order), asserting the clause for BOTH clear-by-id
(`hash(Kr)`) AND `assertRepoNotQuarantined(r)`. Negative-controlled: reverting either of the 2 call sites
THIS test directly exercises (`clearMergeQuarantineLatchFile`'s ~:6876, `assertRepoNotQuarantined`'s
~:7205 — never `refuseSelfClearStaleKeyContributors`'s ~:5691, which this scenario doesn't reach) back to
the per-key comparison (one at a time, rebuilt, re-run, restored) went RED on 3 of the 4 new assertions.

### MINOR — the existing-branch stamp was a hand-rolled conditional that still narrowed `undefined`

Mutating ~:3564-3566 back to Round 1's `[...new Set([...(existing.gck ?? []), key])]` stayed GREEN on the
full suite — this card's own `(critical2-boot-graduation)` scenario reaches the ABSORBING RULE via
`mergeTokenIntoPendingEntries`'s own graduation path, never this stamp directly, so it never actually
pinned this site.

**Fix:** routed through `unionGenuineContributorKeysAbsorbing` itself — widened to accept a bare
`{genuineContributorKeys?}` shape (every real entry already satisfies it) so this site can pass a
synthetic `{genuineContributorKeys: [key]}` instead of hand-rolling the same check inline.

**Test (`(minor-stamp-legacy)`):** a genuinely legacy on-disk union (`identityAtRaise` stamped, no `gck`,
no contributor yet) boots, then R raises for REAL — hitting this exact stamp — and `gck` must stay
`undefined`, never narrow to `[Kr]`. Negative-controlled: reverting this one site back to Round 1's own
narrowing (rebuilt, re-run, restored) went RED on exactly this assertion, nothing else.

### MINOR — `reconcileMarkedBasenameBeforeWrite`'s reingest branch was a third, inconsistent path

Round 2's own audit table called this site's wholesale `{...reingested}` adopt "a no-op identical" to
using the absorbing helper — FALSE: a placeholder's own `entry.genuineContributorKeys` is always
`undefined`, but `reingested.genuineContributorKeys` (the real on-disk value) is NOT always `undefined` —
the wholesale adopt could carry a precise array straight through, while `reconcileClearedEntryIfPlaceholder`
(the sibling function for the SAME placeholder shape) already absorbed it to `undefined`. Two placeholder-
reconcile paths disagreeing on the SAME field is exactly the inconsistency the "exhaustive spread audit"
exists to catch.

**Ruling:** route it through the SAME absorbing helper, for consistency — fail-closed, broad is always
safe. Fixed at ~:1495: `genuineContributorKeys: unionGenuineContributorKeysAbsorbing([entry, reingested])`.
Since `entry` is always a placeholder here, this now ALWAYS resolves `undefined` regardless of the disk's
own value — a placeholder reconcile through THIS path permanently demotes a precise `gck` to the broad
fallback, same as `reconcileClearedEntryIfPlaceholder` already does, and it is never re-promoted back to
precise afterward. No dedicated new test added for this one site specifically (not explicitly requested,
unlike the MAJOR/MINOR items above) — covered by the full corpus re-run, which did not regress.

`contributorRepoPaths` at this SAME reingest branch is also disk-only (a narrower, pre-existing asymmetry)
— the Lead is carding that separately; not touched here.

## Round 4 — Code Review (session `d839b41f`, snapshot `2f3c9368`): SHIP, five small items folded in without a further review round

### Item 1 — `entryGenuinelyOwnsALiveArmedKeyOfItsOwn` failed OPEN (silently omitted the clause) for two shapes `/clear(r)` still releases

The boolean collapsed two different "false" shapes into one confident negative: LEGACY (`identityAtRaise`
undefined, dual-armed `[Ks, Kr]`) and STALE (`identityAtRaise` recorded but no longer among `entry`'s own
live-armed keys). Both silently OMITTED the disclosure clause, even though `/clear(r)` still lifts the
primary's own quarantine in both shapes — the exact fail-open MINOR-1 (Round 2) already closed for the
"legacy fallback claims a verified fact it doesn't have" shape, reopened here one level up.

**Fix:** the function now returns a tri-state `EntryOwnKeyOwnership = "owned" | "not-owned" | "unknown"`.
Both LEGACY and STALE resolve `"unknown"`; `remediationTextFor` gained a HEDGED variant of the clause for
it ("may ALSO release ...; Loom cannot tell whether it genuinely owns this key ..."), text-only, no
behavior change. `"not-owned"` is not produced by the function today — nothing in the current data model
gives a confident negative — but the type stays exhaustive (the pending-only call site, ~:6964, passes
the literal `"not-owned"` in place of the old literal `false`, since its own `ownPathViable` is always
`true` there and the clause can never fire regardless).

**Tests (`(hedge-legacy)`/`(hedge-stale)`):** both shapes, both `armedKeys` orderings (4 scenarios total),
asserting the HEDGED wording on both `clearMergeQuarantineLatchFile(hash(Kr))` and
`assertRepoNotQuarantined(r)`, and asserting the text is NEVER the confident ("can ALSO release") variant.
Negative-controlled: reverting `entryGenuinelyOwnsALiveArmedKeyOfItsOwn`'s own LEGACY/STALE branches back
to `"not-owned"` (rebuilt, re-run, restored) went RED on exactly the 8 new hedge assertions, nothing else
(106 of 114 checks in the file stayed green, including the pre-existing (major-order-independence) and
the new discriminator scenario below — confirming the revert's blast radius was isolated to this fix).

### Item 2 — the reingest-branch demotion (Round 3, MINOR) had no dedicated test

Round 2's own audit table called the sibling `reconcileMarkedBasenameBeforeWrite` reingest branch's
wholesale `...reingested` adopt "a no-op identical" to the absorbing helper — Round 3 found this FALSE and
fixed it, but left it "covered by the full corpus re-run, which did not regress" rather than a dedicated
scenario (see "Round 3" above). CR3 asked for one.

**Test (`query-after-boot-reingest-demotes-precise-gck`,** added to
`merge-quarantine-boot-unreadable-vs-corrupt.mjs`, which already owns the unreadable-at-boot-then-reingest
machinery `reconcileMarkedBasenameBeforeWrite`'s reingest branch needs): a real on-disk record hand-written
with a PRECISE, non-empty `genuineContributorKeys`, made unreadable at boot (`injectReadFailure`), then
queried once the glitch lifts — graduating the placeholder through the SAME reingest branch. Asserts the
in-memory AND on-disk `genuineContributorKeys` are both demoted to `undefined`, and that the demotion
survives a second reboot. Negative-controlled: reverting ~:1521 (`genuineContributorKeys:
unionGenuineContributorKeysAbsorbing([entry, reingested])`) back to letting it ride through the wholesale
`...reingested` spread (rebuilt, re-run, restored) went RED on exactly the 3 new assertions; the file's
other 25 scenarios (26 total) stayed green.

### Item 3 — DISCRIMINATED: `refuseSelfClearStaleKeyContributors`'s own per-key `entryOwnsKey` and the entry-level fact are NOT value-equivalent

CR3 asked whether `refuseSelfClearStaleKeyContributors`'s own per-key `entryOwnsKey` local (~:5680, used
for `ownershipClause`'s text) and the entry-level `entryGenuinelyOwnsALiveArmedKeyOfItsOwn` fact (~:5691,
used for `remediationTextFor`'s own hedge clause, since Round 3) are value-equivalent for every reachable
self-clear key — if so, document it; if not, add a discriminating test. **They are NOT equivalent.**

`activeMatchesAndLiftedKeysFor` dedupes a multi-armed entry to ONE `{key}` — whichever key
`activeQuarantines`' own Map iteration visits FIRST for that entry object, which is INSERTION order, not
`armedKeys` array order. A real reboot's own directory-scan order can insert a dual-armed entry's
SECONDARY key before its PRIMARY one (file read order depends on each key's own hash, not raise order).
Verified empirically: a synthetic entry (S genuinely owns `Ks`, dual-armed `Kr`, R folded in as a genuine
contributor at `Kr`) inserted via `setActiveQuarantineTestOnly(kr, entry)` THEN `setActiveQuarantineTestOnly(ks,
entry)` (forcing `Kr` first in Map insertion order, for two keys never before inserted) produces a
self-clear refusal whose text is SELF-CONTRADICTORY: the per-key clause reads *"it does not own this key
itself"* (keyed off the resolved `Kr`) in the SAME sentence the entry-level hedge clause reads *"it
genuinely owns this key"* (correctly `"owned"`, since S does own `Ks`).

**Not fixed here** — out of this round's own scope (CR3 asked only to discriminate-or-prove-equivalent,
not to repair). **Test (`entry-vs-perkey-discriminator`):** pins the CURRENT, observed, self-contradictory
text — explicitly documented in the scenario's own comments as a FINDING to report, never as an endorsed
or correct shape. The Lead should card this separately if a fix is wanted; a plausible direction is making
`ownershipClause`'s own `entryOwnsKey` ALSO entry-level (checking whether `key` is nested under, or equal
to, ANY live-armed key `identityAtRaise` genuinely owns) rather than a bare `identityAtRaise === key`
comparison — not attempted here, since CR3 did not ask for a fix and a repair risks its own regression
surface this round has no time to re-verify.

## Tests

`merge-quarantine-6de79dc0-sibling-key-contributor-wrong-release.mjs` — 114 checks across 15 scenarios:
real-git repro (`(bug)`, `(bug-clearbypath)`: RED pre-fix, GREEN post-fix), `(explore-clear-r)` (the
remediation route, verified not assumed), `(owner)` (non-regression), `(pre-fix-field-less)` (the
legacy-fallback pin, also asserting MINOR-1's text), `(critical1-divert)`/`(critical1-mergetoken)`,
`(critical2-boot-graduation)`/`(critical2-reconcile-placeholder)`, `(minor2-clear-by-id)`/`(minor2-reboot)`
— all as in Round 2 — plus Round 3's own `(major-order-independence)` and `(minor-stamp-legacy)` (both
described under "Round 3" above, both negative-controlled by a real single-site mutation/rebuild/restore
cycle, not just read) — plus Round 4's own `(hedge-legacy)`/`(hedge-stale)` (both `armedKeys` orders each)
and `(entry-vs-perkey-discriminator)` (described under "Round 4" above, the first two negative-controlled
the same way, the third a pinned finding, not a fix). `merge-quarantine-boot-unreadable-vs-corrupt.mjs`
gained Round 4's own `query-after-boot-reingest-demotes-precise-gck` (26 scenarios total in that file now),
also negative-controlled by a real single-site mutation/rebuild/restore cycle.

`merge-quarantine-3be11be4-self-clear-stale-key-contributor-refusal.mjs` and
`merge-quarantine-runtime-union-provenance.mjs`, plus the 9 other corpus files the Round 3 reviewer ran
(`raise-protect-failure`, `af948556`, `cross-tier-sibling-absorb`, `lazy-graduation-multi-pending`,
`unverified-raise-divert`, `boot-unreadable-vs-corrupt`, `migrate-source-owner-durable`, `2a169469`,
`64119847`) — full non-regression, both `LOOM_DEV` states.

Full 80-file `merge-quarantine*.mjs` corpus run individually (never `--only=`), both `env -u LOOM_DEV -u
LOOM_SUPERVISED` and `LOOM_DEV=1` — zero failures across all three rounds (the only expectation change in
any round was the single `48bda567` fixture-shape pin, Round 2). `pnpm --filter @loom/daemon guards`:
30/30, every round.
