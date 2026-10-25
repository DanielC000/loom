# 58ae4b34 — a degraded occupant's own contributors were never independently enforced (not a relocation regression)

Found by `4b6c8d24`'s second Code Review (reviewer `6b9a4d0d`, probe P2, round 3, item "Q"): a protected,
relocated occupant `X`'s own `contributorRepoPaths` (`82032b5c`) survives the relocation as DATA, but
`assertRepoNotQuarantined(xSub)` read `ok:true` (unblocked) regardless. The card's own open probe framed
this as "a contributor of a still-blocked entry is no longer enforced" — implying `clear(R)`'s relocation
of `X` is what stops the enforcement.

## The premise was investigated and falsified before any fix was written

Reproduced the exact (L) fixture (a ghost `X`, never created, squatting `R`'s own canonical key, carrying
`contributorRepoPaths:[xSub]`) and checked `assertRepoNotQuarantined(xSub)` at every stage: **before**
`clear(R)` ever ran (`X` still directly armed, nothing relocated), **after** `clear(R)` relocates `X` to
the pending tier, and **after a reboot-sim** of that relocated pending record. All three read identically
`ok:true` (unenforced). A fourth probe pushed a PENDING entry carrying a contributor directly
(`pushPendingQuarantineTestOnly`, never cleared or relocated at all) — same result.

**Conclusion: this is not an enforcement loss caused by relocation.** `contributorRepoPaths` was never
consulted by the actual blocking-decision functions (`resolveQuarantineFor` → `ownIdentityEntryFor`/
`activeMergeQuarantineFor`) at any lifecycle stage — only by disclosure (`4b6c8d24`'s `liftedRepoPaths`)
and the clear-by-id ambiguity refusal (`82032b5c`'s `ambiguousIdentitiesFor`). No decision record ruled
this in as intended; `4b6c8d24` round 3 Q explicitly flagged it as a separate, unfixed enforcement
question for the Lead to card — this card.

## The nuance that bounds the fix's real-world reach

A **resolvable** subdirectory contributor (the common/primary production shape — `82032b5c`'s own
mechanism, `82032b5c` round 6's own real-sibling-subdirectory case, e.g. `enterMergeQuarantine(A)` then
`enterMergeQuarantine(A/sub)`) is **already** independently enforced, with zero relocation involved and
zero dependence on `contributorRepoPaths` at all: `A/sub`'s own `canonicalRepoLockKey` ancestor-walks
straight to `A`'s own key (no `.git` of its own), so `activeMergeQuarantineFor(A/sub)` finds `A`'s entry
via the ORDINARY KEY path. `resolveQuarantineFor` only ever reaches `ownIdentityEntryFor` for an
UNRESOLVABLE repoPath — a resolvable contributor never takes that branch at all. The gap this card closes
is real only for a contributor whose own identity does NOT canonical-key-collapse onto its host — i.e.
the `c9114934` "degraded occupant" shape (a stale/manufactured `resolvedKey`, or any contributor whose
real ancestor tree is itself gone) — a reachable production shape (`c9114934`'s whole card is about
exactly this kind of occupant), not a synthetic-only concern.

## The fix

`ownIdentityEntryFor` (`git/merge-quarantine.ts`) now ALSO matches an entry's own `contributorRepoPaths`
via `directPathIdentity`, for both the active-tier scan and the pending-tier `.find()` — a pure read,
reusing the field exactly as already-maintained data (82032b5c's own "carried forward, never originated,
at every copy/rebuild site" invariant already keeps it correct through union/re-point/boot). No new
index or state.

**Every caller of `ownIdentityEntryFor` enumerated, each verified unaffected or correctly improved:**

1. **`clearMergeQuarantineByKey`'s `identityWasBlockedBefore`** (gates whether `identityRepoPath` joins
   `candidateIdentities` for lift-disclosure). This is its ONLY use (grepped) — it never reaches
   `wasQuarantined` (`anythingProcessed = !!entry || pendingPlan.size > 0`, independent). Widening can only
   add a contributor's own path as a disclosure CANDIDATE in a case it previously wasn't; the SAME
   post-mutation re-check in `resolveGenuinelyLiftedRepoPaths` (below) re-queries the (also widened)
   `ownIdentityEntryFor` afterward, so a surviving host still correctly suppresses the false "lifted"
   report. Verified no change in outcome by direct reasoning through every reachable shape (a clear
   targeting the host's own key leaves `entry` truthy regardless of this widening; a clear targeting some
   OTHER key, with a contributor's own path passed as `identityRepoPath`, never touches the host's real
   armed key at all, so the host — and therefore the widened re-check — is unaffected either way).
2. **`resolveQuarantineFor`** — the actual fix target; drives `assertRepoNotQuarantined` and
   `clearMergeQuarantineReporting`'s own before/after diagnostic reads.
3. **`resolveGenuinelyLiftedRepoPaths`** (`4b6c8d24`'s lift-disclosure re-resolve, called from both
   `clearMergeQuarantineByKey` and `clearMergeQuarantineByRecordedPath`) — `4b6c8d24` round 3's own Q fix
   already adds a protected entry's `contributorRepoPaths` to `excludeRepoPaths` whenever the entry itself
   is excluded, so the widened `ownIdentityEntryFor` is REDUNDANT with that explicit guard for the shape
   it was built for (the `excludeRepoPaths.has(candidate)` check short-circuits first). For a GENUINELY
   lifted host (deleted, not relocated), nothing survives to match a contributor's path either way, so
   the widened scan still correctly returns "lifted". Verified empirically: the full 12-scenario
   `merge-quarantine-4b6c8d24-lifted-identities-disclosure.mjs` file (scenario (L) updated to assert the
   fix — see below — the other 11 untouched) stays green, including a fresh negative-control RED/GREEN
   proof.

**A side effect that needed no further code**: once a contributor's query resolves to its host entry,
`assertRepoNotQuarantined`'s existing refusal-text machinery (`ambiguousIdentitiesFor`/
`remediationTextFor`, `82032b5c` round 4) already names the host's own `repoPath`/latch id and the one
working clear-by-path route whenever `contributorRepoPaths` is non-empty (`ambiguousIdentitiesFor` already
returns `entry.contributorRepoPaths` verbatim) — so the refusal a blocked contributor now gets is
automatically actionable, naming the HOST, with zero changes beyond the `ownIdentityEntryFor` widening
itself. `clearMergeQuarantineReporting`'s own `before`/`after` diagnostic (`stillQuarantinedReason`)
gets the same benefit for free, for the same reason.

**`contributorRepoPaths` membership never shrinks per-token, by design, and this fix inherits that**:
`clearMergeQuarantineByToken` removes a contributor's own token (e.g. on its unconfirmed-kill auto-clear)
but cannot prune it from `contributorRepoPaths` — nothing in this module maps a token back to the
identity that raised it — so an unresolvable contributor whose own raise was auto-cleared this way stays
BLOCKED until a human clears the host; this is INTENDED, fails closed, and matches the key-collapse
semantics a resolvable contributor already got for free before this card ever existed (its own token
clearing never un-blocked it independently of its host's key either).

## Round 2 (Code Review `ebfdb799` on commit `cd9c51c9`) — round 1 was HEALTHY, four follow-ups

Round 1's own fix was verified sound (3 callers checked, the widened match reaches only absent-on-disk
paths, every newly-blocked path is clearable via the host's own clear-by-path, RED/GREEN reproduced
independently). Four follow-ups, none blocking:

**1. The "names the HOST" test assertions were VACUOUS.** `xSubAfterClear.reason.includes(X)` passes
trivially whenever the reason merely contains `xSub` too, since `xSub` is `X` with a `/subdir` suffix —
a bare substring check cannot tell "names the host's own path" apart from "names a path that happens to
start with the host's path." Fixed in both this card's own test file and `4b6c8d24`'s updated scenario
(L): assert the EXACT `blocking repo '<path>'` clause `assertRepoNotQuarantined`'s reason template always
produces, via a shared `namesAsBlockingRepo(reason, repoPath)` helper in each file.

**2. `ownIdentityEntryFor` did not give an own-identity match precedence over a contributor match.** A
path can simultaneously hold ITS OWN record (active or pending) AND be named as a CONTRIBUTOR of some
unrelated entry. Round 1's single-pass scan returned whichever match it hit first — a function of Map
insertion order and which tier happened to be scanned first, never a deliberate choice — so the refusal
could name the wrong entry. Fixed: `ownIdentityEntryFor` is now two-pass — own-identity across BOTH tiers
(active then pending) FIRST, then the contributor match across both tiers only if no own-identity match
was found. New scenario `own-identity-wins-over-contributor-match` (the reviewer's own repro shape): `Y`
holds its own pending record while ALSO being named in an unrelated active `X`'s `contributorRepoPaths` —
`assertRepoNotQuarantined(Y)` must name `Y`, never `X`. RED against round 1 alone (Y's query resolved to
`X`, since `X` is active and the single-pass scan hit it first); GREEN after.

**3. Added a precision negative.** An absent, UNRELATED sibling of a contributor's own host (e.g. `P/other`
— never listed in `P`'s `contributorRepoPaths` at all, unlike the genuine contributor `P/contrib`) must
stay unblocked — proves the widened match is scoped to genuinely recorded contributors, not every path
sharing a string prefix with a blocked identity. Added to the `pending-entry-contributor-blocked` scenario;
passes in both RED and GREEN phases (never broken by round 1 either — a true negative control, not a
disguised repeat of item 2's own repro).

**4. Noted, not fixed (reviewer's own Q4) — disclosure and enforcement apply the resolvability gate
asymmetrically.** `4b6c8d24`'s disclosure (`resolveGenuinelyLiftedRepoPaths`) honours a contributor
regardless of whether that contributor is CURRENTLY resolvable — it only asks whether a surviving entry
still names it. Enforcement (`resolveQuarantineFor`) reaches `ownIdentityEntryFor` only for an
UNRESOLVABLE query (`resolveQuarantineFor`'s own gate, unchanged by this card). In a CONTRIVED shape where
a recorded contributor becomes resolvable again (its directory recreated) while its host is still being
cleared, disclosure could still correctly report it lifted (no resolvability gate there) while a direct
enforcement query for that now-resolvable path takes the ORDINARY key-based `activeMergeQuarantineFor`
path instead of `ownIdentityEntryFor` — meaning this card's own widening never even runs for it. The two
functions could disagree, but only in the UNDER-reporting direction for enforcement (a resolvable
contributor falls back to ordinary key-collapse, which is itself either correct or silently misses it
depending on whether the ancestor walk still lands on the host's key) — never OVER-reporting (claiming
something is blocked that genuinely isn't). Not reproduced, not fixed here — recorded as a known,
accepted-asymmetry residual for a future reader to pick up if a concrete repro ever surfaces.

## Do not

- Do not widen any CLEAR route to let a contributor be cleared by its own path. `82032b5c` round 4's
  ruling stands unchanged: clear-by-path/clear-by-id still cannot clear a contributor directly — only the
  ENFORCEMENT/REFUSAL check (`ownIdentityEntryFor`) is widened here. **Scoped to `/clear-by-path`
  (`clearMergeQuarantineByRecordedPath`):** verified directly, clearing a contributor's own path via that
  route is still a genuine no-op (`wasQuarantined:false`) — see the `ghost-contributor-enforcement-
  lifecycle` scenario's own negative control. The project-resolved `/clear`
  (`clearMergeQuarantineReporting`) does NOT behave the same way any more: calling it with a contributor's
  own path now returns `wasQuarantined:true`, with a `stillQuarantinedReason` naming the host (a side
  effect of its own `before`/`after` diagnostic now routing through the widened `resolveQuarantineFor`,
  same as the refusal-text benefit noted above) — nothing is actually cleared either, but the reported
  shape differs by route. That reason's own "its OWN recorded entry" wording is a known imprecision when
  `repoPath` is itself a contributor rather than the entry's own primary identity — carded as a follow-up,
  not fixed here.
- Do not read this fix as closing `398f476c`'s own identity-model scope, or `f00e9de8`'s own finding that
  `armQuarantineKey`'s boot-time cross-identity union never stamps `contributorRepoPaths` at all — this
  card only widens what happens WITH an already-recorded `contributorRepoPaths` value; it does nothing for
  a union that never recorded one in the first place (that remains `398f476c`'s scope).
- Do not assume this closes "eviction" or "re-pointing" (a SECOND collision re-pointing an
  already-relocated pending reference, `protectOccupantContentBeforeDelete`'s own `atFilenameIdx`/
  `atFinalBasenameIdx` mechanics) — this was explicitly NOT reproduced before the fix shipped. Code reading
  (`82032b5c`'s own "carried forward, never originated" invariant) gives good reason to expect
  `contributorRepoPaths` survives a re-point too, but it is UNPROVEN, not asserted as verified here.
- Do not re-derive "the gap is caused by relocation" from this card's own title history — the ORIGINAL
  card title ("keep enforcing a protected quarantine entry's contributors") presumed exactly that, and it
  was falsified by direct repro (before/after/reboot, and a never-relocated pending entry, all identical)
  before any fix was designed. The Lead retitled at merge; the premise itself did not survive investigation.
- Do not re-derive `ownIdentityEntryFor`'s own three call sites by grepping a pattern — grepped directly
  (`grep -rn "ownIdentityEntryFor(" packages/daemon/src/`): exactly three, all in `merge-quarantine.ts`,
  all enumerated above. Re-grep if this function gains a new caller before trusting this count.
- Do not assert "names the host" via a bare `reason.includes(hostPath)` (round 2, item 1) — a
  contributor's own path contains its host's path as a string PREFIX, so that check passes vacuously even
  when the reason only ever names the contributor. Assert the exact `blocking repo '<path>'` clause
  instead (`namesAsBlockingRepo` in both test files).
- Do not scan `ownIdentityEntryFor` as a single pass over "own-identity OR contributor" (round 2, item 2)
  — a path can hold both an own record and a contributor mention of an unrelated entry at once, and a
  single combined pass returns whichever match Map-insertion order or tier-scan order happens to hit
  first. Own-identity must win, checked across both tiers before either tier's contributor scan runs.
- Do not treat the Q4 asymmetry (round 2, item 4) as proof of an over-reporting bug — it is, at most, an
  UNDER-reporting gap in a contrived, unreproduced shape; see that item's own paragraph before trying to
  "fix" it without a concrete repro in hand.

## Tests

`packages/daemon/test/merge-quarantine-58ae4b34-contributor-enforcement.mjs` — four scenarios, each its
own process + fresh `LOOM_HOME` (driver/child pattern, matching `merge-quarantine-pass1-migrate-union.mjs`):
- `ghost-contributor-enforcement-lifecycle` — the (L) shape standalone: `xSub` reads blocked before any
  clear, after `clear(R)` relocates `X`, and after a reboot-sim of the relocated pending record; the
  refusal names `X` (the host, via the exact `blocking repo '<path>'` clause — round 2, item 1) and the
  clear-by-path route at every stage; clearing `X` by its own path then cascades to unblock `xSub`; a
  negative control confirms clearing `xSub` directly is still a no-op.
- `pending-entry-contributor-blocked` — a PENDING-tier entry (never relocated/cleared at all) carrying a
  contributor: the contributor reads blocked, naming the host pending entry; plus a round-2 precision
  negative (item 3) — an unrelated, non-contributor sibling of the same host stays unblocked.
- `resolvable-subdir-contributor-unaffected` — the CONTROL: a real, resolvable subdirectory contributor
  (the common production shape) is unaffected by this fix, enforced via ordinary key-collapse exactly as
  before.
- `own-identity-wins-over-contributor-match` (round 2, item 2) — the reviewer's own repro: `Y` holds its
  own pending record while also being named as a contributor of an unrelated active `X`;
  `assertRepoNotQuarantined(Y)` must name `Y`, never `X`.

`merge-quarantine-4b6c8d24-lifted-identities-disclosure.mjs`'s scenario (L) updated: the former
`[4b6c8d24][L][FINDING]` console-logged probe is now a real assertion (`xSub` reads blocked, naming `X`
via the exact clause; clearing `X` cascades to unblock it); the other 11 scenarios are untouched and stay
green.

Round 1 negative-control RED→GREEN proof (`pnpm --filter @loom/daemon negative-control --file
packages/daemon/src/git/merge-quarantine.ts --test
packages/daemon/test/merge-quarantine-58ae4b34-contributor-enforcement.mjs --test
packages/daemon/test/merge-quarantine-4b6c8d24-lifted-identities-disclosure.mjs`, against pre-fix `HEAD`):
exactly the ten new/changed assertions (6 in the lifecycle scenario, 2 in the pending-entry scenario, 2 in
the updated (L) scenario) failed RED; the control scenario's own checks stayed green even reverted. GREEN
restored after, tree confirmed byte-identical after.

Round 2 negative-control RED→GREEN proof (same command, re-run against commit `cd9c51c9` — round 1's own
committed fix — as `--ref`): exactly the two `own-identity-wins-over-contributor-match` assertions (item 2)
failed RED (round 1's single-pass scan resolved `Y`'s query to the unrelated active `X`, since `X` is
scanned first and `namesIdentity(X)` matched via the contributor list); the round-2 precision negative
(item 3) stayed GREEN in both phases (never broken by round 1 either — a true negative control, not a
disguised repeat of item 2's own repro); every round-1 assertion, including the now-corrected
`namesAsBlockingRepo` ones (item 1), stayed GREEN in both phases (round 1's own behavior already satisfied
the stricter assertion for every shape it was tested against). GREEN restored after, tree confirmed
byte-identical after.

Full `merge-quarantine*.mjs` corpus run file-by-file, both env states, plus `pnpm --filter @loom/daemon
guards` and the working-tree EOL check: see the worker's own `done` report for the exact counts.
