# 4b6c8d24 — name every genuinely-known lifted identity from the shared clear helper, never a guessed one

From Code Review `fb1580b8` (e7652e06's third review round), SF-1 — a pre-existing two-path asymmetry.
`clearMergeQuarantineLatchFile` (clear-by-id) already returned `liftedRepoPaths`, but the project-scoped
`/internal/merge-quarantine/clear` (`clearMergeQuarantineReporting`) and clear-by-path
(`clearMergeQuarantineByRecordedPath`) returned only `wasQuarantined`/`stillBlockedCoOccupants`.

**Round 3 (Code Review `6b9a4d0d`) found three more gaps in Round 2's own mechanism — read "Round 3"
below before trusting any claim elsewhere in this record about `provenanceByCandidate`/candidate
membership as still accurate; Round 2's "The fix" section above is updated in place, not superseded.**

**Round 2 (Code Review `12ae5f67`) rewrote the mechanism below — read this record as describing the
CURRENT, round-2 design; Round 1's own "add `identityRepoPath` + `entry.repoPath` unconditionally"
mechanism is RETRACTED (see "Round 2" below for exactly why it was wrong, in both directions).**

## The bug, measured

On a `provenanceUnknown` union recorded under one party (say the entry's own `repoPath` field is `F`,
armed at both `F`'s and `Y`'s own canonical keys), `/clear(Y)` genuinely lifts the WHOLE union — both `Y`
and `F` — but the response carried no field naming that `F` was also lifted. A human calling `/clear`
with one repo's path had no way to learn a second, different repo was collaterally unblocked.

## The fix (current, round 3)

`clearMergeQuarantineByKey` — the one shared clear helper every identity-wide human-clear route is built
on (`clearMergeQuarantine`'s resolvable branch, `clearMergeQuarantineByRecordedPath`'s matched-active
loop, `clearMergeQuarantineLatchFile`'s active-match branch) — now always returns `liftedRepoPaths:
string[]` (never `void`) plus an optional `provenanceUnknown?: true` notice, instead of `void` on its own
"nothing kept" success path.

**`liftedRepoPaths` is derived by RE-RESOLVING a CANDIDATE set, after every mutation this clear performs
— never by trusting a candidate's pre-clear field value unconditionally** (the round-2 fix; Round 1's own
unconditional-add mechanism is what this replaces). Candidates, gathered BEFORE any mutation:
- the caller's own `identityRepoPath` — but ONLY when it was genuinely blocked BEFORE this call
  (`!!entry || !!ownIdentityEntryFor(identityRepoPath)`, captured before any mutation) — round 3, R2:
  clearing a repo that was never quarantined at all must never report it lifted;
- the matched `entry`'s own recorded `repoPath` (which can be a DIFFERENT real identity than what was
  asked for — exactly the Y/F shape above) — always "was blocked before" by construction, since `entry`
  itself is the proof;
- `entry.contributorRepoPaths` — runtime-folded identities (`82032b5c`): recorded FACTS, not guesses,
  and exactly the field clear-by-id's own ambiguity check already refuses on;
- every pending twin of the clearing identity that this SAME call genuinely DROPS (`action: "remove"`,
  never `"reduce"`) — together with ITS OWN `contributorRepoPaths`.

A candidate is reported lifted ONLY if, after every mutation, {@link ownIdentityEntryFor} finds NO
surviving entry (active or pending) for its identity — a PURE, READ-ONLY scan (see "Round 2 — the
mutation hazard" below for why this must never be `resolveQuarantineFor`/`activeMergeQuarantineFor`).
`excludeRepoPaths` (every repoPath this same clear already knows is kept/relocated/content-kept) is an
EXPLICIT, additional guard on top of that scan — an identity must never appear in both `liftedRepoPaths`
and `stillBlockedCoOccupants`. **Round 3, Q:** whenever `entry` itself ends up in `excludeRepoPaths`
(a PROTECTED, foreign occupant — M2's own shape), `entry.contributorRepoPaths` is added to
`excludeRepoPaths` too — a protected owner's own contributors ride entirely on ITS surviving record, and
`ownIdentityEntryFor` can never independently verify them (nothing's own `repoPath` is a mere
contributor).

`provenanceUnknown` fires ONLY for a candidate whose OWN pre-clear entry was marked, AND that candidate
survived into the final, re-resolved `liftedRepoPaths` list — never for a protected-but-still-blocked
occupant's own mark (see "Round 2 — M2" below). The per-candidate marks are tracked in
`provenanceByCandidate`, a `Map<directPathIdentity, boolean>` written ONLY through `markProvenanceCandidate`
— a STICKY OR (`round 3, R1`): a later, unmarked candidate sharing the same identity (e.g. a separate
UNMARKED pending entry for an already-marked active identity) must never reset an earlier `true` back to
`false`. Keyed by `directPathIdentity`, not the raw string, so a case/realpath spelling variant merges
into the same slot.

`clearMergeQuarantineByRecordedPath` runs the SAME re-resolve, over the union of its own direct
pending-drop candidates (identity + contributors) and every delegated `clearMergeQuarantineByKey` call's
own `liftedRepoPaths`/`provenanceUnknown` (treated as candidates again, never trusted blindly, since this
function's own LATER pending sweep can still mutate state after an earlier delegated call returns) — it
ALREADY never adds the raw `repoPath` argument unconditionally (its own "not found" branch returns
`liftedRepoPaths: []` directly), so round 3's R2 fix was needed only in `clearMergeQuarantineByKey`.
`clearMergeQuarantineReporting` forwards both fields unconditionally (the same field-consistency
discipline `stillBlockedCoOccupants` already follows). The two REST routes (`POST
/internal/merge-quarantine/clear`, `POST /internal/merge-quarantine/clear-by-path` with `{repoPath}`) in
`gateway/server.ts` destructure and surface both fields the same way the existing `{id}` form already
does.

`wasQuarantined` on `clearMergeQuarantineByKey`'s own return is a REAL boolean (`!!entry ||
pendingPlan.size > 0`), never a lying `true` literal — the function can be called with nothing at all tied
to `identityRepoPath` (round 2, nit).

## Round 2 (Code Review `12ae5f67`) — the round-1 mechanism was wrong in BOTH directions

**M1 (under-states):** `clearMergeQuarantineByKey` never read `entry.contributorRepoPaths` at all.
Repro: `enterMergeQuarantine(A)`, then `enterMergeQuarantine(A/sub)` (a plain subdirectory, no own
`.git`) — A/sub hits the `existing` branch and becomes a runtime contributor (`82032b5c`), recorded
*exactly* on A's own entry. `clearMergeQuarantineReporting(A)` returned `liftedRepoPaths: ["A"]` only, no
`provenanceUnknown`, yet `A/sub` was ALSO genuinely unblocked. Not a guess — contributors are named
exactly, by the entry itself; the fix reads them as candidates too.

**M2 (over-states):** Round 1 added `entry.repoPath` to `liftedRepoPaths` UNCONDITIONALLY. When the
matched `entry` is actually a FOREIGN, degraded occupant sitting at the SAME key as the identity being
cleared (the `clearingRepoPath`/`c9114934` shape — a ghost-path entry `X` armed at
`canonicalRepoLockKey(R)`, clearing `R`), that occupant is PROTECTED and diverted to its own pending
record, never lifted — yet Round 1 reported it lifted anyway, while `stillBlockedCoOccupants` ALSO named
it kept. Fixed by re-resolving every candidate after the clear (see "The fix" above) instead of trusting
`entry.repoPath` unconditionally.

### The mutation hazard — why the re-resolve must use `ownIdentityEntryFor`, never `resolveQuarantineFor`

The FIRST attempt at the re-resolve fix called `resolveQuarantineFor` (which, for a resolvable path,
delegates to `activeMergeQuarantineFor`) per candidate. That function is NOT read-only: querying it can
itself lazily ABSORB/graduate a pending sibling into the active entry (`8a1bc2ef`), as a side effect of
being merely asked "is this still blocked." Calling it from inside the SAME clear whose own bookkeeping
depends on the pending state staying put caused FIVE pre-existing, unrelated test files
(`merge-quarantine-535fd69d-bytoken-stale-mark-union.mjs`, `merge-quarantine-64119847-tied-twin-private-
tokens.mjs`, `merge-quarantine-b47cf261-reduce-branch-twin-resync.mjs`, `merge-quarantine-clear-by-
path.mjs`, `merge-quarantine-raise-protect-failure.mjs`) to go RED — each one's own carefully-engineered
pending-twin fixture was silently absorbed/mutated by the diagnostic re-resolve call before the test's own
assertions ever ran. Caught ONLY by running the full `merge-quarantine*.mjs` corpus, never by the new
scenarios alone. Fixed by switching to `ownIdentityEntryFor` — a PURE scan of `activeQuarantines` +
`pendingUnresolvedQuarantines` by identity, already used (read-only) by `resolveQuarantineFor`'s own
unresolvable branch and by `inMemoryProvenanceUnknownFor` — never the mutating tier-4 absorption path.

## Round 3 (Code Review `6b9a4d0d`) — two Majors plus one Lead ruling on top of Round 2

**R1 (regression vs round 1):** `provenanceByCandidate.set()` OVERWROTE on every call — a LATER,
unmarked candidate sharing an identity (e.g. a marked active entry for `F` plus a SEPARATE, unmarked
pending entry also for `F`) reset an earlier `true` back to `false`, losing the notice. Repro: marked
active `F` + unmarked pending `F`, `clearMergeQuarantineByRecordedPath(F)` ⇒ `liftedRepoPaths:["F"]` with
NO `provenanceUnknown`. Fixed via `markProvenanceCandidate`'s sticky OR (`set(key, (get(key) ?? false) ||
flag)`), keyed by `directPathIdentity` per the Lead's own "consider" note, at every one of the four
production `.set()` sites (`clearMergeQuarantineByKey`'s top-level `entry` + its pending-remove loop,
`clearMergeQuarantineByRecordedPath`'s delegated-result loop + its own matchedPending loop).

**R2 (also present in round 1, never caught until round 3):** `identityRepoPath` was added to candidates
UNCONDITIONALLY, so clearing a repo that was NEVER quarantined at all returned `{wasQuarantined:false,
liftedRepoPaths:[R]}` — a false disclosure. `clearMergeQuarantineByRecordedPath` already guarded this
(its own "not found" branch returns `liftedRepoPaths:[]` directly); `clearMergeQuarantineByKey` (and so,
transitively, `/clear`'s resolvable path) did not. Fixed per the Lead's general-form ruling — a candidate
counts as lifted only if it was blocked BEFORE the clear and is not blocked after — captured as
`identityWasBlockedBefore = !!entry || !!ownIdentityEntryFor(identityRepoPath)`, read BEFORE any
mutation. `!!entry` covers the KEY route (R's own query reads blocked even when the actual occupant is a
foreign ghost, M2's own shape — `entry.repoPath` and `identityRepoPath` can legitimately differ);
`ownIdentityEntryFor` separately covers a genuinely PENDING-only record for R's own identity with
nothing armed at any key yet. `entry.repoPath`/`entry.contributorRepoPaths`/dropped-pending-twin
candidates need NO equivalent guard — each is drawn from a real, already-existing record, so "was
blocked before" holds for them by construction.

**Q (Lead ruling, not a reviewer finding):** a protected/relocated occupant's OWN contributors (a ghost
`X` squatting `R`'s own canonical key, `X.contributorRepoPaths:[X/sub]`) must not be reported lifted
either — they ride entirely on `X`'s own surviving record. Fixed by adding `entry.contributorRepoPaths`
to `excludeRepoPaths` whenever `entry.repoPath` itself is already in `excludeRepoPaths` (see "The fix"
above).

**The ONE open probe (Lead's own instruction: describe, do not fix here):** in that SAME scenario,
`assertRepoNotQuarantined(X/sub)` reads `ok:true` — a contributor of a still-blocked, protected/relocated
entry is NOT itself independently enforced, even though its own enforcement was always supposed to ride
on `X`'s surviving record. `xSub` is never anyone's own `repoPath` in memory (it exists only as DATA
inside `X`'s `contributorRepoPaths` array, which the protective divert carries forward as a field, never
as a second queryable record) — so a direct query for it finds nothing blocking it. This is a genuinely
SEPARATE enforcement question (whether/how a contributor should be independently blockable at all, not a
reporting question this card's own scope covers) — recorded here, with the test's own probe output, for
the Lead to card separately. Probe: `packages/daemon/test/merge-quarantine-4b6c8d24-lifted-identities-
disclosure.mjs`, scenario (L), the `[4b6c8d24][L][FINDING]` console line.

## What did NOT change

- `clearMergeQuarantineLatchFile` (clear-by-id) is UNTOUCHED — its own `liftedRepoPaths` computation
  (re-resolving each matched identity via `resolveQuarantineFor` before/after) was already correct per
  this card's own framing, and it structurally never reaches a `provenanceUnknown`-marked union at all:
  its ambiguity check (`ambiguousIdentitiesFor`/`pendingUnknownProvenance`) refuses BEFORE any clear runs
  whenever `provenanceUnknown` is set, so `provenanceUnknown` can never be `true` on a clear-by-id success
  response by construction. (Its own `resolveQuarantineFor` calls are safe where THIS card's were not —
  they run strictly AFTER its own clear has already fully committed, never interleaved with it.)
- WHAT is lifted is unchanged — only what is REPORTED changed. No key/token/file decision inside
  `clearMergeQuarantineByKey`'s own body was altered.
- `656fdf39`'s `identityWideHumanClear` flag semantics are untouched; this card only reads already-decided
  state (`entry.repoPath`, `entry.contributorRepoPaths`, `entry.provenanceUnknown`) after that flag has
  already gated reconciliation.
- No `registeredRepoPaths` reverse-lookup was added — that information is not available at any of these
  clear call sites (`registeredRepoPaths` is a boot-time-only parameter, never a module-level value), and
  threading it through every clear route would be a materially larger, out-of-scope change.

## Do not

- Do not try to name a specific second/contributor identity for the `provenanceUnknown` notice — the
  whole point of that field (same as `db0a9db0`'s own field it reuses) is that the daemon genuinely does
  not know who else may be folded in; naming one anyway risks a confidently wrong disclosure.
  `contributorRepoPaths` is different — those are recorded facts, not guesses, and belong in
  `liftedRepoPaths` directly (see M1 above), never folded into the `provenanceUnknown` boolean.
- Do not add `entry.repoPath` (or any candidate) to `liftedRepoPaths` unconditionally, on the strength of
  it merely being the entry `clearMergeQuarantineByKey` happened to look up at `key` — re-resolve via
  `ownIdentityEntryFor` AFTER every mutation instead (M2 above). The matched entry can be a FOREIGN,
  protected occupant that was never actually lifted.
- Do not call `resolveQuarantineFor`/`activeMergeQuarantineFor` to decide what was lifted, from inside a
  clear whose own bookkeeping depends on the pending/active maps staying put for the REST of that same
  call — both can mutate state (lazy sibling absorption, `8a1bc2ef`) as a side effect of being queried.
  Use `ownIdentityEntryFor` (a pure scan) instead — see "the mutation hazard" above; this regressed FIVE
  unrelated test files the first time it was tried, caught only by the full corpus run.
- Do not let an identity appear in both `liftedRepoPaths` and `stillBlockedCoOccupants` — the explicit
  `excludeRepoPaths` guard in `resolveGenuinelyLiftedRepoPaths` exists on top of the `ownIdentityEntryFor`
  scan specifically so this invariant holds even if some future shape makes the two disagree.
- Do not route `clearMergeQuarantineLatchFile`'s own, already-correct `liftedRepoPaths` computation
  through `clearMergeQuarantineByKey`'s new fields — they answer the same QUESTION from two different,
  independently-verified mechanisms; re-wiring one onto the other without re-running clear-by-id's own
  extensive existing test corpus risks regressing a heavily round-tested function for no behavioral gain
  (clear-by-id never has anything new to disclose: it already refuses before reaching a marked union).
- Do not read `clearMergeQuarantineByRecordedPath`'s own `liftedRepoPaths` as exhaustive for a union
  whose recorded identity differs from the identity the caller asked for — that route matches ONLY by the
  entry's own stored `repoPath` identity (never a fresh key recompute), so the caller-vs-entry-repoPath
  asymmetry `clearMergeQuarantineByKey`'s own `identityRepoPath` capture closes for the KEY-addressed
  route (`/clear`) structurally cannot arise the same way for clear-by-path — see the test file's own (B)
  section for why only the union's own recorded identity is disclosed there.
- Do not trust a fix in this function verified only against its own new test scenarios — run the FULL
  `merge-quarantine*.mjs` corpus, individually, before reporting done. The mutation hazard above was
  invisible to every new scenario and was caught only by the full-corpus run.
- Do not write `provenanceByCandidate.set(key, flag)` directly anywhere in this module — always
  `markProvenanceCandidate(map, repoPath, flag)` (round 3, R1). A plain `.set()` lets a later, unmarked
  candidate sharing the same identity silently reset an earlier `true` to `false`.
- Do not add `identityRepoPath` to `clearMergeQuarantineByKey`'s own candidates unconditionally (round 3,
  R2) — gate it on `identityWasBlockedBefore` (captured before any mutation), or clearing a repo that was
  never quarantined at all reports it lifted.
- Do not forget `entry.contributorRepoPaths` when `entry` itself turns out to be a protected/excluded
  occupant (round 3, Q) — add them to `excludeRepoPaths` too; they have no record of their own that
  `ownIdentityEntryFor` could ever find independently.
- Do not attempt to fix the Round-3-Q probe's own enforcement gap (a contributor of a still-blocked,
  protected entry reads unenforced via `assertRepoNotQuarantined`) as part of this card — it is a
  separate enforcement question, deliberately left open per the Lead's own ruling; see "Round 3" above.

## Tests

`packages/daemon/test/merge-quarantine-4b6c8d24-lifted-identities-disclosure.mjs` — twelve scenarios:
- (A) `/clear` (`clearMergeQuarantineReporting`) on a Y/F provenanceUnknown union, called with Y: asserts
  `liftedRepoPaths` names BOTH Y and F, and `provenanceUnknown:true`.
- (B) clear-by-path (`clearMergeQuarantineByRecordedPath`) on a Y2/F2 union, called with the union's own
  recorded identity F2: asserts `liftedRepoPaths` names F2 and `provenanceUnknown:true`.
- (C) an UNMARKED single-identity clear via all three routes (`/clear`, clear-by-path, clear-by-id)
  reports `liftedRepoPaths` as exactly that one identity, with no `provenanceUnknown` notice.
- (D) clear-by-id on the SAME marked-union shape still REFUSES (unchanged), and nothing is lifted.
- (E, round 2, M1) the real `enterMergeQuarantine(A)` + `enterMergeQuarantine(A/sub)` runtime-contributor
  shape: `liftedRepoPaths` names both A and A/sub.
- (F, round 2, M2) a ghost-path `X` squatting `R`'s own canonical key: `liftedRepoPaths` names R, never
  X; X is named in `stillBlockedCoOccupants` instead; the never-in-both invariant is asserted explicitly.
- (G, round 2) a REDUCED (kept) pending twin (883e29bc's dual-tracked-twin shape, tied via
  `orphanLatchFiles`, holding a token outside the active entry's own set): the twin's shared identity does
  NOT appear in `liftedRepoPaths`, and still reads blocked afterward. Driven via `clearMergeQuarantineByKey`
  DIRECTLY (the one deliberate exception to "always exercise the real entry point" in this file — see the
  test's own comment: `clearMergeQuarantineReporting`'s `before`/`after` diagnostic queries would
  themselves absorb the twin ahead of the real clear, destroying the exact shape this scenario isolates).
- (H, round 2) one `buildServer`/`app.inject()` check per REST route (`/clear`, clear-by-path
  `{repoPath}`) — nothing could go RED at the wiring layer before, since the handlers never destructured
  either field at all.
- (I, round 3, R1) `clearMergeQuarantineByRecordedPath`: a marked active `F` plus a separate, UNMARKED
  pending entry also for `F` — `provenanceUnknown:true` survives the later unmarked candidate.
- (J, round 3, R1) the same shape as (I), tied via a shared token, driven through
  `clearMergeQuarantineByKey` directly (its own twin of the R1 repro).
- (K, round 3, R2) a genuinely never-quarantined repo reports `liftedRepoPaths:[]` via
  `clearMergeQuarantineByKey` directly, `clearMergeQuarantineReporting`, and the real REST `/clear` route.
- (L, round 3, Q) the ghost-`X`-squats-`R` shape with `X` ALSO carrying `provenanceUnknown:true` and
  `contributorRepoPaths:[xSub]`: `liftedRepoPaths` names only R (never X, never xSub);
  `provenanceUnknown` is ABSENT; plus the one open-probe console line documenting
  `assertRepoNotQuarantined(xSub).ok === true` (see "Round 3" above).

Round-1 RED/GREEN: 7 of the file's checks (A/B/C1/C2) failed on the pre-fix parent, all passed after.
Round-2 RED/GREEN (same negative-control invocation, against the round-1 parent): the 4 new E/F/G
assertions failed as expected; all pass on the round-2 fix; tree restored byte-identical both times.
Round-3 RED/GREEN (against the round-2 parent, `cf5d0721`): the 12 new I/J/K1/K2/K3/L assertions failed
as expected (the sticky-OR, R2, and Q fixes were all absent), all pass on the round-3 fix; tree restored
byte-identical.

Full `merge-quarantine*.mjs` corpus (73 files, this one included) run individually, both env states
(`env -u LOOM_DEV -u LOOM_SUPERVISED` / `LOOM_DEV=1 LOOM_SUPERVISED=1`), one lane — all green on the
FINAL (ownIdentityEntryFor-based) fix, re-confirmed after round 3's own changes. (The intermediate
`resolveQuarantineFor`-based attempt regressed 5 of these 73 files — see "the mutation hazard" above —
never shipped.)
`pnpm --filter @loom/daemon guards` — 30/30, green.
