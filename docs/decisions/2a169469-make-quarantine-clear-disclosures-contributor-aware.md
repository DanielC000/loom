# 2a169469 — make quarantine clear disclosures contributor-aware

From `58ae4b34`'s Code Review (reviewer `aba50f3e`, findings 1 + 3). Since `58ae4b34` widened
`ownIdentityEntryFor` to also match an entry's own `contributorRepoPaths`, a repo (Y) can stay genuinely
quarantined through a DIFFERENT identity's (X's) `contributorRepoPaths` even after Y's own record is
cleared — but none of the three clear routes' own DISCLOSURE logic accounted for this.

## The three findings, confirmed by live repro against the real compiled module before any fix

Repro: Y unresolvable, holds its OWN active record at kY; unrelated active X has
`contributorRepoPaths:[Y]`.

1. **clear-by-id** (`clearMergeQuarantineLatchFile`) decided "lifted" via `sameIdentityStillQuarantined`
   — an identity-EQUALITY test (`after.repoPath === queried identity`) — at two sites (the active-match
   branch and the pending-match branch). `after = resolveQuarantineFor(Y)` resolves to X (via the
   contributor match), but `directPathIdentity(X) !== directPathIdentity(Y)`, so the test read `false`
   and the function fell through to its unconditional-success branch: `{ok:true, liftedRepoPaths:[Y]}`
   with no `stillQuarantined`/`reason` — a FALSE SUCCESS. `assertRepoNotQuarantined(Y)` immediately after
   still refused, naming X.
2. **clear-by-path** (`clearMergeQuarantineByRecordedPath`) never checked the queried identity's own
   post-clear status at all. It correctly reported `liftedRepoPaths:[]` (via
   `resolveGenuinelyLiftedRepoPaths`, which already used the widened `ownIdentityEntryFor`), but with no
   `stillQuarantined`/`reason` field — the human was never told WHY nothing lifted.
3. **`/clear`** (`clearMergeQuarantineReporting`) already gated on `if (after)` (correct, since `after`
   being truthy at all — regardless of whose identity it is — is the right lift/block decision), but its
   `reason` text came from `stillQuarantinedReason(after, before)`, which compared the PRE-clear `before`
   entry's `repoPath` to `after`'s — for a PURE contributor Y (no own record at all), `before` ALSO
   resolves to X (via the SAME contributor match, evaluated before the clear), so `sameAsBefore` read
   `true` and produced "repoPath is still quarantined by its own recorded entry (repoPath 'X', ...)" —
   wrong wording: X is Y's HOST, never Y's own entry.

## The fix

`stillQuarantinedReason` now takes the ORIGINALLY-QUERIED identity directly (a `string`) instead of the
pre-clear `before` entry, and distinguishes three cases by comparing `after` against THAT identity: the
queried repoPath's own surviving record ("its own recorded entry" — unchanged wording), a HOST entry the
queried repoPath is a recorded `contributorRepoPaths` member of (NEW: "quarantined because it is a
recorded CONTRIBUTOR folded into another, still-quarantined entry's own token set (host repoPath
'<X>'...)"), or a genuinely different, unrelated repo's own separate quarantine (unchanged wording —
"ANOTHER repo's own, separate quarantine").

Both `clearMergeQuarantineLatchFile` branches now gate on `ownIdentityEntryFor(<queried identity>)`
(truthy — PURE, "does ANY surviving entry, own OR contributor, still name this identity") instead of the
old identity-equality test. `clearMergeQuarantineByRecordedPath` gained a new, top-priority branch doing
the same `ownIdentityEntryFor` check for its own queried `repoPath`, mirroring
`clearMergeQuarantineReporting`'s existing precedence (when the queried identity is still blocked,
`stillQuarantined`/`reason` are returned and `latchKept`/`referencingRepoPaths` are not surfaced in that
same response — same established separation `182c01cc` already drew between "still quarantined" and "a
physical file survives on disk"). `clearMergeQuarantineByRecordedPath`'s and `clearMergeQuarantine`'s own
return types gained an optional `stillQuarantined?: true` field; the `/clear-by-path {repoPath}` REST
route (`gateway/server.ts`) forwards it unconditionally, the same shape the `{id}` form already had.

**Must not change WHAT is lifted (`656fdf39`'s `identityWideHumanClear`) — verified**: every change here
is to the RESPONSE a clear reports, never to which keys/tokens/files a clear actually mutates. The false
success in finding 1 was a disclosure bug, not an under-clearing bug — Y's own record was always correctly
removed; only the claim that Y was thereby freed was false.

## A regression found and fixed before this card could be reported done

An early version of this fix used `resolveQuarantineFor(<queried identity>)` directly for the new/widened
`after` checks — the literal shape the manager's own approval message described. Running the required
regression sweep (`merge-quarantine-raise-protect-failure.mjs`) surfaced 5 failing assertions across three
pre-existing scenarios (`r2-shared`, `r2-eperm`, `crnit2`), each sharing one shape: a ghost identity `d`
that is a non-existent subdirectory of an actively-quarantined real repo `r`.

Root cause: `resolveQuarantineFor`'s ancestor-walk fallback branch reaches `activeMergeQuarantineFor`,
which is NOT pure — it can LAZILY ABSORB a pending sibling into an active entry as a side effect of being
merely queried (card `8a1bc2ef`). This is EXACTLY the "mutation hazard" `4b6c8d24`'s own decision record
already names and already works around, by using `ownIdentityEntryFor` (a pure scan) instead of
`resolveQuarantineFor`/`activeMergeQuarantineFor` for its own re-resolve. Introducing a NEW call to
`resolveQuarantineFor` at these three sites reopened the identical hazard class at a new location: in the
`r2-shared`/`crnit2` scenarios, the absorption durably merged `d2`'s own separate pending entry into `r`'s
active one as a side effect of this card's own NEW disclosure check, so a later reboot-sim no longer found
`d2` as its own standalone entry.

Switching all three new/widened `after` computations to `ownIdentityEntryFor` (matching the card's own
"Direction" text verbatim — "clear-by-id's lifted/still-blocked decision asks 'does ANY surviving entry
still name this identity' (`ownIdentityEntryFor`, as `resolveGenuinelyLiftedRepoPaths` does)") closed the
regression (3/3 clean reruns of the regression file, both `LOOM_DEV` states) while leaving every scenario
in this card's own new test file green, unchanged.

**Consequence, named plainly (round 1 — SUPERSEDED by round 2 below, kept for history):** the three routes
agree on the identity/contributor case but disagree on the ancestor-fallback edge case, which was declared
out of scope. **Round 2 closes this edge case too** — see below.

## Round 2 (Code Review 85b2edc7) — a NEW false positive in the opposite direction, plus three minors

Round 1's `ownIdentityEntryFor`-based fix (above) was itself WRONG, in the OPPOSITE direction from the
original bug: `ownIdentityEntryFor` matches `contributorRepoPaths` regardless of whether the queried path
is RESOLVABLE, but `resolveQuarantineFor` — what `assertRepoNotQuarantined` actually enforces — only ever
consults `ownIdentityEntryFor` for an UNRESOLVABLE path (see that function's own doc, `~:5059-5064`). A
RESOLVABLE contributor (ghost `X` naming a real, resolvable repo `Y` as a contributor, where `Y` ALSO has
its own independent real raise) therefore got a NEW false `stillQuarantined` — clearing `Y` by id reported
it still blocked, while `assertRepoNotQuarantined(Y)` read `ok:true`. Confirmed live before any fix.

### The fix: ONE shared, PURE helper mirroring `resolveQuarantineFor` EXACTLY

`stillBlockedEntryFor` (exported) replaces every `ownIdentityEntryFor`/`resolveQuarantineFor` call this
card's disclosure logic makes, at ALL THREE routes (including `clearMergeQuarantineReporting`'s own
`after` — see the one deliberate exception below for `before`). It mirrors `resolveQuarantineFor`'s own
lookup order EXACTLY — the resolvability split; `ownIdentityEntryFor` only for an unresolvable path; the
key-based tiers (including the ancestor walk) for every path — via a NEW pure mirror of
`activeMergeQuarantineFor`, `activeMergeQuarantineForPeek`: the SAME tier chain, but it never absorbs a
cross-tier sibling into an armed entry (`8a1bc2ef`) and never graduates a resolvable pending entry into
`activeQuarantines` (`188b145f`) — both durable mutations the real function performs. **Round 3 correction
(below): the claim that followed this sentence through round 2 — "neither omission changes WHICH IDENTITY
a query resolves to" — was FALSE; see "Round 3" for the real shape and the fix.**

This closes finding 3 (the round-1 "Consequence" above) for free: an ancestor-blocked ghost subdirectory of
an actively-quarantined real repo now correctly reads `stillQuarantined` through clear-by-id and
clear-by-path too (previously only reachable through route 3), with NO mutation hazard reopened — proven
by the SAME `merge-quarantine-raise-protect-failure.mjs` regression file staying green throughout (see
"Pre-existing test files updated" below for the OTHER files finding 3's closure did require updating).

### `before` stays impure in `clearMergeQuarantineReporting` — the ONE deliberate exception

`clearMergeQuarantineReporting`'s `after` uses `stillBlockedEntryFor`, but its `before` DELIBERATELY keeps
calling the real, mutating `resolveQuarantineFor`. Found via a real regression
(`merge-quarantine-boot-unreadable-vs-corrupt.mjs`'s `human-clear-after-unreadable-final-readable-does-not-rearm`
scenario): `d` is a real, resolvable repo, pending (fail-closed) after an injected boot-time read failure;
the glitch clears, then a human `/clear` runs. The OLD `before = resolveQuarantineFor(d)` call's own
ancestor-walk fallback reaches `activeMergeQuarantineFor`, which — since `d` is NOW resolvable — GRADUATES
the pending placeholder into a durably-written active entry AS A SIDE EFFECT of merely computing `before`.
That durable write (`writeMergeQuarantineLatch`) RECONCILES a stale `keptUnreadableLatchFiles` mark for
that basename as an ordinary consequence of a legitimate write (`656fdf39`/`702b4241`). `clearMergeQuarantine(d)`'s
own subsequent REAL clear then finds an already-reconciled, mark-free entry and cleanly removes the file.

With a PURE `before` (no graduation), the placeholder is NEVER durably reconciled before the real clear
runs. `clearMergeQuarantineByKey`'s OWN pending-reconciliation (`reconcileClearedEntryIfPlaceholder`,
gated on `identityWideHumanClear`) only updates the IN-MEMORY object's fields — it performs NO durable
write, so it cannot clear the stale mark either. The real clear's own coverage-proof then fails (the
placeholder's synthetic token ≠ the real file's token), and the file is left on disk, "kept, unconfirmed"
— a MATERIALLY DIFFERENT, WORSE real-world outcome (a latch file that should be cleanly removed stays
behind) than a mere disclosure-wording difference. This is a genuine, pre-existing LATENT GAP in
`clearMergeQuarantineByKey`'s own pending-handling path, papered over — for the ONE caller that ever
mattered (`clearMergeQuarantineReporting`) — by `resolveQuarantineFor`'s own incidental mutation. Fixing
the latent gap itself (making `clearMergeQuarantineByKey` durably reconcile a pending placeholder before
trusting its tokens) is a materially larger, separate change, out of THIS card's scope — reverting `before`
to the real `resolveQuarantineFor` is the narrow, safe fix: both forms return the IDENTICAL boolean for
`wasQuarantined` (the pure mirror's whole point) — only the side effect differs, and only `before`, here,
ever needed it. `after` has no equivalent dependency (by the time it runs, the real clear has already
settled the entry one way or the other).

### Minor 2 — clear-by-path's `stillQuarantined` branch now carries the SAME kept-file fields clear-by-id does

The new top-priority branch in `clearMergeQuarantineByRecordedPath` now spreads in `latchKept`/
`referencingRepoPaths`/`contentKeptRepoPaths` (computed from the SAME local `keptReferencingRepoPaths`/
`anyKeptUnattributed`/`keptContentRepoPaths` the other branches already use), alongside `stillQuarantined`
— mirroring `clearMergeQuarantineLatchFile`'s own active-match branch (`activeLatchKeptFields`). Verified
with a dedicated fixture carrying BOTH a host-contributor block AND a genuine content-kept orphan
reference simultaneously (this card's own test scenario J).

### Minor 3 — a PURE contributor on clear-by-path now names the host instead of a bare "not found"

The `if (!wasQuarantined)` NOT-FOUND branch now checks `stillBlockedEntryFor(repoPath)` first. `wasQuarantined`
stays FALSE, DELIBERATELY: `82032b5c` round 4's "a contributor is never cleared by its own path" ruling is
UNCHANGED (this route genuinely acts on nothing of the queried repoPath's own), and
`merge-quarantine-runtime-union-provenance.mjs`'s own pre-existing "contributor path does nothing"
assertions (restored by its own "Round 5 TEST GAP (b)") depend on `wasQuarantined` staying false for this
exact shape — confirmed by a real regression when an earlier draft set it `true`. `wasQuarantined:false`
with `stillQuarantined:true` together is therefore a DELIBERATE, new combination this card introduces —
this card's own scenario K tests it directly.

### Minor 4 — HTTP-level proof that `/clear-by-path {repoPath}` forwards `stillQuarantined`/`reason`

Added section (AP) in `merge-quarantine-clear-by-path.mjs` — the `{repoPath}` twin of (AC)'s own `{id}`
proof. Also fixed a stale comment at `gateway/server.ts` (~3287-3293): it claimed `/clear-by-path`'s
`{repoPath}` form delegates to `clearMergeQuarantineReporting` — it actually calls
`clearMergeQuarantineByRecordedPath` directly (there is no project to resolve on this route).

### The `liftedRepoPaths`-vs-`stillQuarantined` contradiction, found and fixed while closing finding 3

Closing finding 3 surfaced a genuine self-contradiction: `resolveGenuinelyLiftedRepoPaths` (UNCHANGED —
still `ownIdentityEntryFor`-only, deliberately never widened to the ancestor tier, to avoid re-litigating
that function's own, separately-reviewed mutation-safety argument) could still list the QUERIED repoPath
itself as "lifted" even when `stillBlockedEntryFor`'s wider ancestor check correctly found it still
blocked. `clearMergeQuarantineByRecordedPath`'s `if (after)` branch now explicitly filters the queried
identity back out of `liftedRepoPaths` — a repoPath is never reported both lifted AND still-quarantined in
the same response. `clearMergeQuarantineLatchFile`'s own two branches never had this risk: the active
branch hardcodes `liftedRepoPaths: []` when `after` fires (never delegates to the shared resolver for that
one identity), and the pending branch's own per-repoPath loop already pushes to EITHER `liftedRepoPaths`
OR `stillBlockedReasons`, never both, by construction.

### Pre-existing test files updated (closing finding 3 is a real behavior change, not a defect)

Every change below is a MORE COMPLETE disclosure of a fact that was already true before this card (the
ancestor relationship, or the "never cleared by its own path" distinction) — never a change to WHAT is
cleared, and never a loosening of what a prior round's fix proved. `merge-quarantine-raise-protect-failure.mjs`
needed NO changes in the final state (minor 2's kept-field merge made its pre-existing `latchKept===true`
assertions pass again on their own, since they never asserted `stillQuarantined`'s absence).

1. **`merge-quarantine-clear-by-path.mjs`, scenario (X)** (round-7 last-resort-fallback repro, card
   `abccee85`) — `typoX` is a never-quarantined, typo'd ghost subdirectory of an actively-quarantined real
   `outerX`. OLD: asserted `wasQuarantined === false` and a bare "not found" reason naming
   `GET /internal/merge-quarantine/list`. NEW: `wasQuarantined` STAYS `false` (unchanged — minor 3's own
   rule; nothing of `typoX`'s own was ever touched), but `stillQuarantined === true` with a reason naming
   `outerX` as the ancestor blocker. WHY an improvement: the ORIGINAL round-7 property this scenario exists
   to prove — "outer's genuinely separate, real quarantine is NEVER collaterally LIFTED" — is the THIRD
   check in this scenario and is completely UNCHANGED, still passing; only the previously-silent "why
   nothing happened" is now disclosed, honestly, instead of a misleading blanket "not found" (which was
   technically true about `typoX`'s own record but silent about the real, already-known fact that `typoX`
   is still blocked via its ancestor).
2. **`merge-quarantine-degraded-occupant-guard.mjs`, scenario `p5b-...`** (card `8567df22` round 5) — `X`
   (`w/gone-subdir`) has TWO of its own duplicate tracked records, cleared via `clearMergeQuarantineLatchFile`;
   `w` (a SEPARATE, real repo) has its own independent, still-active raise. OLD: asserted
   `clearResult.liftedRepoPaths.includes(x) && !clearResult.stillQuarantined`. NEW: split into two checks —
   `X`'s own two duplicate records are verified BOTH genuinely gone via direct in-memory state
   (`listActiveMergeQuarantines().filter(e => e.repoPath === x).length === 0`, the card `8567df22` property
   this scenario actually exists to prove), and `clearResult.stillQuarantined === true` naming `w`. WHY an
   improvement: `liftedRepoPaths` means "genuinely unblocked NOW" (4b6c8d24's own established semantics —
   a repoPath whose own record was touched but is still blocked some other way, e.g. the M2
   protected/relocated case, was NEVER "lifted" even before this card) — `X` is NOT genuinely unblocked
   (`w`'s own real, separate raise still blocks it via the ordinary ancestor tier), so asserting
   `liftedRepoPaths.includes(x)` was testing the WRONG field for the mechanical fact it actually cared
   about. This scenario's OWN pre-existing comment, written before this card, already named exactly this
   relationship ("a direct query for X before clearing W would legitimately surface W's own entry via that
   KEY-based tier") — the new assertion makes an already-known fact explicit instead of leaving a
   previously-blind field to omit it.
3. **`merge-quarantine-runtime-union-provenance.mjs`** and **`merge-quarantine-lazy-graduation-contributor-attribution-b5c94cbe.mjs`**
   — NO final changes (their pre-existing "contributor path does nothing" / "clearMergeQuarantineByRecordedPath(D)
   still reports wasQuarantined:false" assertions are exactly what minor 3's `wasQuarantined:false` design
   decision was reverse-engineered FROM — an earlier draft that set `wasQuarantined:true` broke both; fixed
   by keeping it `false`, confirmed clean against both files afterward).
4. **`merge-quarantine-boot-unreadable-vs-corrupt.mjs`** — NO final changes (the "`before` stays impure"
   exception above restores byte-identical prior behavior for this file).

## Disjointness verified

The new `stillQuarantined`/`reason` channel names the SUBJECT identity itself when a contributor
relationship blocks it. `stillBlockedCoOccupants`/`contentKeptRepoPaths` name OTHER repoPaths discovered
as a side effect of the sweep (foreign tmp residue, orphan cross-references) — architecturally disjoint by
construction, since the identity being cleared is never itself a "co-occupant found during the sweep."
Verified directly in the new test file's scenario (A): `stillBlockedCoOccupants` is exactly empty while
`stillQuarantined` is true.

## Do not

- Do not call `resolveQuarantineFor`/`activeMergeQuarantineFor` for a disclosure-only "is this identity
  still blocked" check anywhere in this module — both can MUTATE state (lazy sibling absorption,
  `8a1bc2ef`; lazy graduation, `188b145f`) as a side effect of being merely queried. Use
  `stillBlockedEntryFor` (round 2's shared pure helper — **not** a bare `ownIdentityEntryFor` call, round
  1's own fix, RETRACTED by round 2: it false-positives on a RESOLVABLE contributor). This is the SAME
  rule `4b6c8d24`'s own decision record already states; this card is now a THIRD independently-confirmed
  specimen (round 1's `after` sites, and round 2's own `before` investigation below) of exactly the hazard
  that record warns about.
- **(Round 2 exception, narrow and deliberate)** `clearMergeQuarantineReporting`'s own `before` is the ONE
  call in this card's own new/touched code that KEEPS calling the real, mutating `resolveQuarantineFor` —
  see "`before` stays impure" above for the full reasoning (a real regression, not a hypothetical). Do not
  "fix" this to `stillBlockedEntryFor` without re-deriving that reasoning from scratch; the TWO forms agree
  on the boolean, so a naive drift-elimination pass will look correct right up until a pending-but-now-
  resolvable entry's own latch file is left kept on disk instead of cleanly removed.
- Do not pass a pre-clear `before` entry to `stillQuarantinedReason` — pass the ORIGINALLY-QUERIED
  identity (a string) directly. A `before` entry can already BE the contributor-matched host (evaluated
  before the clear), making a `before`-vs-`after` comparison trivially "same" even when neither is the
  queried repoPath's own entry at all.
- Do not widen any CLEAR route to let a contributor be cleared by its own path — `82032b5c` round 4's
  ruling stands unchanged; only the DISCLOSURE (what a clear reports) changed here, never what a clear
  actually does. `clearMergeQuarantineByRecordedPath`'s NOT-FOUND branch (minor 3) deliberately keeps
  `wasQuarantined: false` for exactly this reason even when it now names a genuinely blocking host.
- Do not read the three routes as now agreeing on EVERY shape at EVERY field — they agree on the
  identity/contributor AND ancestor-fallback cases for `stillQuarantined`/`reason` (round 2 closes finding
  3 too), but `wasQuarantined` keeps its OWN, route-specific, pre-existing meaning at each route (route 3's
  `wasQuarantined` has always meant "was ANYTHING blocking you"; routes 1/2's has always meant "did I find
  YOUR OWN record" — this asymmetry PRE-DATES this card and is not something it tries to unify).
- Do not let `resolveGenuinelyLiftedRepoPaths` (the `liftedRepoPaths` computation) see the ancestor tier —
  it stays `ownIdentityEntryFor`-only, deliberately, to avoid re-litigating that function's own,
  separately-reviewed mutation-safety argument for an unrelated widening. Instead, filter the QUERIED
  identity back out of its result whenever `stillBlockedEntryFor` finds it still blocked — never report a
  repoPath as both lifted and still-quarantined in the same response (see
  `clearMergeQuarantineByRecordedPath`'s own filter, and the "liftedRepoPaths-vs-stillQuarantined
  contradiction" section above for the real test failure this closes).
- Do not assume a pre-existing test's stale assertion is wrong to touch — closing finding 3 is a REAL
  behavior change (more complete disclosure of an already-true fact), not a defect introduced by this
  card. See "Pre-existing test files updated" above for every one touched, and why each is an improvement,
  never a loosening, of what it already proved.

## Tests

`packages/daemon/test/merge-quarantine-2a169469-contributor-aware-clear-disclosure.mjs` — eleven
scenarios, each its own process + fresh `LOOM_HOME` (driver/child pattern):
- (A) clear-by-id on the "Y is both" shape: `liftedRepoPaths` exactly empty, `stillQuarantined` exactly
  true, reason names the host, `stillBlockedCoOccupants` exactly empty, `latchKept` absent; a negative
  control confirms `assertRepoNotQuarantined(Y)` still genuinely refuses afterward.
- (B) clear-by-path on the same shape: the same disclosure, now present where it was previously absent.
- (K, round 2, minor 3) clear-by-path on a PURE contributor: names the host, but `wasQuarantined` stays
  EXACTLY false (never cleared by its own path), `stillQuarantined` exactly true.
- (C) `/clear` on a PURE contributor (no own record at all): the new wording, never "its own recorded
  entry".
- (D) cross-route agreement: three independent "Y is both" fixtures, one per route, all three discernibly
  agree on the host-contributor clause and none claims a false lift.
- (E) the pre-existing `d4b25feb` same-identity shape (two independent records for one identity): the
  OLD "its own recorded entry" wording is unchanged, never the new contributor wording.
- (F) the pre-existing ancestor-fallback shape, exercised through `clearMergeQuarantineReporting`: the OLD
  "ANOTHER repo's own, separate quarantine" wording is unchanged (round 2: now via `stillBlockedEntryFor`
  for `after`, same wording either way).
- (G, round 2, BLOCKING fix) a RESOLVABLE contributor (ghost `X` naming a real, independently-raised `Y`):
  clear-by-id reports `lifted:[Y]`, `stillQuarantined` ABSENT — matching main exactly.
- (H, round 2, finding 3) an ancestor-blocked ghost subdirectory of a real, actively-quarantined repo,
  with its OWN separate, unrelated record: clear-by-path reports `liftedRepoPaths` exactly empty (never a
  false "lifted"), `stillQuarantined` exactly true, naming the real ancestor.
- (I, round 2) the mirror-of-enforcement invariant, looped over six shapes: own unresolvable record, pure
  unresolvable contributor, resolvable contributor (round 2's own fix), never-quarantined resolvable path,
  ancestor-blocked ghost, same-identity independent second record — `!!stillBlockedEntryFor(identity) ===
  !assertRepoNotQuarantined(identity).ok` for every one.
- (J, round 2, minor 2) `stillQuarantined` and a genuine content-kept orphan reference firing TOGETHER on
  clear-by-path: both `latchKept`/`contentKeptRepoPaths` and `stillQuarantined`/reason are present in the
  SAME response, never one dropped for the other.

RED→GREEN proven via `pnpm --filter @loom/daemon negative-control --file
packages/daemon/src/git/merge-quarantine.ts --file packages/daemon/src/gateway/server.ts --test
packages/daemon/test/merge-quarantine-2a169469-contributor-aware-clear-disclosure.mjs --test
packages/daemon/test/merge-quarantine-raise-protect-failure.mjs`, against pre-fix `HEAD` (round 1): RED as
expected, GREEN restored, tree confirmed byte-identical after. Round 2's own fixes (the BLOCKING finding,
minors 2-4, the `before`-stays-impure exception, the `liftedRepoPaths` filter) were each verified live
against the real compiled module before being folded into this file's own scenarios, and via the full
corpus sweep below rather than a second formal negative-control invocation.

Full `merge-quarantine*.mjs` corpus (77 files, this one included) run individually — TWICE, back to back,
after the round-2 fixes settled: all green, both the default env state and `LOOM_DEV=1 LOOM_SUPERVISED=1`.
Round 1's own named 13-file subset (the 7 files from the card's own checkpoint approval plus
`-58ae4b34-contributor-enforcement.mjs`, `-unverified-raise-divert.mjs` (`64283e06`), `-clear-by-path.mjs`
(`182c01cc`), `-1fea8b15-tmp-sweep-content-check.mjs`, `-d6670822-partial-clear-evicted-final-guard.mjs`,
and this card's own test file) is a subset of that full sweep, not re-enumerated separately.

## Round 3 (Code Review 8bfcbcfc, MERGEABLE verdict; one minor, one major, two docs/test nits)

Round 2 was found MERGEABLE (69/69 A/B pairs agree), but with four residual findings, all wording/doc —
none changes any boolean or any lift.

### Minor 1 — `activeMergeQuarantineForPeek` could name the WRONG winner on a cross-tier union

Round 2's own doc comment (restated above, now corrected) claimed "neither omission changes WHICH
IDENTITY a query resolves to." **That claim was FALSE.** `unionQuarantineEntries` keeps the OLDER
(non-placeholder-first) side's own identity fields (`repoPath`/`branch`/`reason`/`opId`/`enteredAt`/
`resolvedKey`) — so when the real function absorbs a cross-tier sibling into `direct` (or graduates a
pending match alongside one), and that sibling is OLDER than the winner Peek would otherwise return, the
REAL union's winning `repoPath` differs from what Peek reported.

Repro (confirmed live before any fix): `r` real, active (newer `enteredAt`); a resolvable real subdirectory
`r/sub` (no own `.git`, so it canonically collapses onto `r`'s own key) PENDING at that same key with an
OLDER `enteredAt`; a ghost subdirectory `r/ghostsub` with its OWN, independent active record. Clearing
`r/ghostsub`: all three routes, pre-fix, named `r` as the still-blocking identity, while
`assertRepoNotQuarantined(r/ghostsub)` — which reaches the REAL, mutating `activeMergeQuarantineFor` and
triggers the actual absorption — named `r/sub` instead (the union's real winner). Main's own `/clear`
already named `r/sub` correctly in this shape (it calls the real resolver for `before`, not Peek-based
`after` alone, prior to this card's own `after` fix); this was therefore a disclosure REGRESSION this
card's round 1/2 fix introduced, not a pre-existing gap.

**The fix:** `activeMergeQuarantineForPeek` now computes the would-be union winner PURELY — same
`unionQuarantineEntries` calls, same fold order as `consumeMatchedPendingsIntoArmedEntry`'s own chain (the
real function's mutating helper) — in BOTH branches that used to just return a fixed value: the
`direct`-exists-and-key-verified branch (fold the cross-tier siblings together first, then union the
result with `direct` as the trailing `extra`, mirroring `consumeMatchedPendingsIntoArmedEntry(siblingIndices,
key, direct)`) and the no-`direct`/pending-match branch (fold the matched indices' entries together with
any cross-tier siblings, no trailing `extra`, mirroring `consumeMatchedPendingsIntoArmedEntry(allIndices,
key)`). Never via `consumeMatchedPendingsIntoArmedEntry` itself, which also splices
`pendingUnresolvedQuarantines` and writes to disk — only the pure `unionQuarantineEntries` calls are
reused. The doc comment above (and this record's own "Round 2" text) is corrected: the two omissions
(absorb/graduate) do NOT change whether a query resolves to something, but CAN change WHICH entry wins —
Peek now mirrors that too.

### Minor 2 — `stillQuarantinedReason`'s `isHostOfContributor` ignored resolvability

The same premise error round 2 fixed for `stillBlockedEntryFor`'s own boolean (contributor wording must
apply ONLY for an UNRESOLVABLE queried path) had not been applied to `stillQuarantinedReason`'s own
`isHostOfContributor` check, which matched `contributorRepoPaths` regardless of resolvability.

Repro: real `r` and a real subdirectory `r/sub`, both independently raised (so `sub` folds into `r`'s own
record as a contributor via the ordinary runtime union). `clearMergeQuarantineByRecordedPath(r/sub)` said
"a recorded CONTRIBUTOR … the HOST must be cleared" — but `r/sub` is RESOLVABLE, and a `/clear` on it
actually lifts `[r/sub, r]` together; `r/sub` is blocked (when it is) via the ordinary key-collapse/ancestor
tier, never via the contributor relation, which applies only to an unresolvable identity.

**The fix:** `isHostOfContributor` now additionally requires `!isRepoPathCurrentlyResolvable(queriedRepoPath)`
— the same split `stillBlockedEntryFor`/`resolveQuarantineFor` already use for `ownIdentityEntryFor` itself.

### Nit 3 — stale test-file header claim

The test file's own header claimed `stillBlockedEntryFor` is used for `clearMergeQuarantineReporting`'s
own `before` AND `after`. Round 2's own "`before` stays impure" section (above) already states `before`
deliberately keeps calling the real, mutating `resolveQuarantineFor` — the header was never updated to
match. Corrected.

### Nit 4 — scenario (I) extended to loop shapes × real clear ROUTES

Round 2's own scenario (I) proved the mirror-of-enforcement invariant directly against `stillBlockedEntryFor`,
but never exercised a REAL clear route's own `stillQuarantined` field end to end. Added a second loop,
building each shape FRESH per (shape, route) so clearing one can never contaminate another's state,
asserting AFTER each route's clear that the route's own "still blocked" signal agrees with
`!assertRepoNotQuarantined(identity).ok`, AND that the two sides' NAMED BLOCKER (parsed from each one's own
reason text) agrees too — never just the boolean. Three shapes, each run through every route that can
meaningfully address it: a resolvable contributor via clear-by-path and via `/clear` (clear-by-id already
covered by round 2's own scenario G); a ghost subdirectory of a real ancestor holding ONLY a PENDING
(never-active) entry — the pending tier of the ancestor walk, not just the active one — via clear-by-path
and `/clear`; and minor 1's own cross-tier-sibling-union shape, via all three routes (it has a genuine own
active record to address by id). `clearMergeQuarantineReporting` ("/clear") has NO `stillQuarantined`
field of its own (a route-specific asymmetry this record already documents) — its "still blocked" signal
for this loop is instead the presence of a `reason` shaped like `stillQuarantinedReason`'s own output, the
only branch that embeds a `repoPath '...'` clause.

### Verification

Negative control: `pnpm --filter @loom/daemon negative-control --file packages/daemon/src/git/merge-quarantine.ts
--test packages/daemon/test/merge-quarantine-2a169469-contributor-aware-clear-disclosure.mjs`, against
pre-round-3 `HEAD` — RED as expected (**six** checks failed, not two as this section originally claimed —
corrected by round 4's CR3 — on the minor-1 shape's three routes, two checks each: "named blocker agrees"
and "named blocker is the expected" for clear-by-id/clear-by-path/clear-reporting), GREEN restored, tree
confirmed byte-identical after. This control covers ONLY round 3's minor-1 Peek-winner fix, never round 3
as a whole — minor 2's own resolvability gate is pinned separately, round 4, below (that gap was named,
not closed, until then).

The 12-file named subset (this card's own test file, `-clear-by-path.mjs`, `-degraded-occupant-guard.mjs`,
`-raise-protect-failure.mjs`, `-boot-unreadable-vs-corrupt.mjs`, `-runtime-union-provenance.mjs`,
`-lazy-graduation-contributor-attribution-b5c94cbe.mjs`, `-4b6c8d24-lifted-identities-disclosure.mjs`,
`-58ae4b34-contributor-enforcement.mjs`, `-unverified-raise-divert.mjs`,
`-1fea8b15-tmp-sweep-content-check.mjs`, `-d6670822-partial-clear-evicted-final-guard.mjs`) — all green,
individually, in BOTH the default env state and `LOOM_DEV=1 LOOM_SUPERVISED=1`.

Full `merge-quarantine*.mjs` corpus (77 files) run individually in three foreground batches, once, after
round 3's fixes settled — all green. No pre-existing assertion needed changing for round 3 (unlike round
2's "Pre-existing test files updated" section above) — every fix this round is additive (a new pure
computation in `activeMergeQuarantineForPeek`, a narrower `isHostOfContributor` gate, test/doc corrections)
and no existing scenario's own fixture shape exercised the gap either fix closes.

## Round 4 (final Code Review CR3, reviewer ff7ea5aa, MERGEABLE verdict; two un-pinned gaps, one doc nit)

CR3 found round 3's own fix genuinely correct (Peek stays pure 21/21 with a working control, its named
blocker matches enforcement 21/21, no lift/refusal behaviour changed) but TWO of round 3's own claims had
no pinning test, plus the doc-count error already corrected above.

### Minor 1 — round 3's own contributor-wording resolvability gate (`isHostOfContributor`) was pinned by NO test

Reverting round 3 left every wording check in this file green — nothing exercised the exact shape that
gate exists for. Repro (reviewer-supplied, verbatim): a real repo X with an active entry at `kX` carrying
`contributorRepoPaths:[X/sub]`, and `X/sub` (resolvable) with its own SEPARATE active entry. Clearing
`X/sub`'s own id must say it is blocked by "ANOTHER repo's own, separate quarantine" (the ordinary
key-collapse tier) — never the contributor clause round 2 used to say ("a recorded CONTRIBUTOR … the HOST
must be cleared").

Added scenario `clear-by-id-resolvable-contributor-own-record-wording` — a RESOLVABLE X (real `.git`,
armed at its own REAL `canonicalRepoLockKey`, not an arbitrary string: an arbitrary key only works for an
UNRESOLVABLE X found via `ownIdentityEntryFor`'s identity scan, never for a resolvable key-based `direct`
lookup) with `contributorRepoPaths:[Y]`, `Y = X/sub` resolvable with its own separate active record.
Clearing Y's own id: `stillQuarantined` true, reason uses the "ANOTHER repo's own, separate quarantine"
wording, never the contributor clause; a negative control confirms `assertRepoNotQuarantined(Y)` still
refuses afterward, naming X. Proven RED on `90d03c6c` (round 2, before round 3's gate existed at all) via
`negative-control --ref 90d03c6c`, GREEN restored, tree byte-identical.

### Minor 2 — Peek's own union object could offer a latch id that doesn't exist yet

`quarantineLatchFileIdsFor`'s old fallback — reached whenever `entry` has no owned `armedKeys` of its own
AND is not itself one of the real `pendingUnresolvedQuarantines` wrapper objects by reference (true for any
SYNTHETIC union `activeMergeQuarantineForPeek` builds via `unionQuarantineEntries`, which always returns a
brand-new object, never a raw reference, whenever more than one entry folds together) — offered
`quarantineHashFor(winner.repoPath)`: the hash of the key the union WILL occupy AFTER graduation. No file
exists there yet. Reachable via `clearMergeQuarantineByRecordedPath`'s not-found branch and
`clearMergeQuarantineLatchFile`'s own pending loop (both call `stillQuarantinedReason`, which derives the
offered id from this same function) — a human (or the reason text's own clear-by-id suggestion) acting on
that id got `{ok:true, wasQuarantined:false, liftedRepoPaths:[]}` while the repo stayed genuinely blocked.

Reviewer's named repro shapes: `multi-pending-plus-sibling` (r and r/sub each hold two pending entries;
r/sub's oldest wins the union identity) and `ancestor-fallback-with-older-sibling` (r pending; r/sub
pending, older, wins), both queried BEFORE any enforcement call — i.e. before anything has durably
graduated, exactly the window `stillQuarantinedReason`'s own disclosure runs in.

**The fix:** `quarantineLatchFileIdsFor`'s fallback branch now recovers the REAL pending entries that fed
the synthetic union — the SAME tier match (`findPendingIndicesFor` + `collectCrossTierSiblingIndices`)
`activeMergeQuarantineForPeek` itself used to build it — and offers THEIR ids (via `pendingLatchIdFor`)
instead of a fabricated future-key hash. Every offered id is now backed by a real on-disk `sourceFile`.
Only reached when the two prior branches (owned `armedKeys`, pending-by-reference) both miss, so every
other caller of `quarantineLatchFileIdsFor` (`assertRepoNotQuarantined`, the remediation helper at
`~:2359`) is unaffected in the common case and only benefits in the rare case it too would have hit this
fallback.

Added scenario `offered-clear-by-id-is-real-before-graduation`, both reviewer shapes, each built fresh:
`stillBlockedEntryFor` (pure) finds the blocker, `quarantineLatchFileIdsFor(before)[0]` gets the SAME
offered id `stillQuarantinedReason` would, and `clearMergeQuarantineLatchFile` on that id must report
`wasQuarantined:true` — never the false `wasQuarantined:false` no-op the bug produced. Proven RED on
`0fa574f1` (round 3's own tip — the bug was round 3's own regression, introduced by its winner-synthesis
fix, not present at round 2's `90d03c6c`) via `negative-control --ref 0fa574f1`, GREEN restored, tree
byte-identical.

### Purity re-verified

The reviewer's own `purity.mjs` harness (CR3's scratch artifacts, copied to this round's own
`$LOOM_SCRATCH_DIR` and run against a scratch copy of this round's `dist/git/merge-quarantine.js`, patched
with four `__cr3*` probe-only export wrappers — never added to the real source) re-run after both fixes:
21/21 cases pass — `activeMergeQuarantineForPeek` is still pure (no state mutation, no log output) and its
winner still matches enforcement's own named blocker, for every probed shape.

### Known residual, named but out of scope (per the Lead's own ruling)

`consumeMatchedPendingsIntoArmedEntry`'s own `unionResolvedKeysRetaining` call can, in principle,
`console.error` an eviction that never actually happens for a Peek-only (never-written) union — left as a
named residual, not fixed here.

### Doc nit

The round-3 "Verification" section above claimed the negative control's RED phase failed "two checks" —
the pinned snapshot shows **six** (two checks × three routes), and that control covers only round 3's own
minor-1 Peek-winner fix, never round 3 as a whole. Corrected in place above.
