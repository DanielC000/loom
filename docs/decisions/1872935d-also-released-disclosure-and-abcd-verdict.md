# 1872935d — A+D ruling: self-clear-by-genuine-owner stays unconditional; add a post-hoc `alsoReleasedRepoPaths` disclosure

From card 1872935d's investigate-first phase (reproduced `/clear(r)` lifting `[r, s]` via 6de79dc0's own
`(explore-clear-r)` fixture: `S` genuinely owns its own key `Ks` but is ALSO dual-armed at a wholly
unrelated key `Kr` a real sibling repo `R` genuinely owns; `R`'s own `/clear` unconditionally wipes `S`'s
genuinely separate quarantine too). The Lead's ruling: **A + D**.

## The verdict

- **A (release both, as today) — PERMANENT.** A self-clear by a genuine key owner releases everything the
  entry holds, contributors included — consistent with `82032b5c`'s "collision releases everything" design
  and `3be11be4`'s own CASE 1/2 (a genuine owner's self-clear must still fully release, contributors
  included). `R` here is clearing its OWN, genuinely-owned key `Kr`; the mechanism is the SAME one CASE 1/2
  already protects, reached via a sibling union instead of a same-key ancestor-collapse one.
- **B (refuse `/clear(r)` while `S` genuinely owns a live key) — REJECTED.** Dead-end proof, traced in code
  before ruling it out: `/clear(s)` and clear-by-path(s) already refuse (6de79dc0's own
  `selfClearRefusesForStaleKeyContributors` guard fires on the sibling-key OR condition); clear-by-id
  already fails closed as ambiguous for ANY non-empty `contributorRepoPaths` (`82032b5c`'s own DoD
  narrowing, pre-existing, confirmed via `3be11be4`'s own investigation). The ONLY route that works for
  this shape today is `/clear(r)` itself. Refusing it too leaves **no human route to release either
  identity** — an UNCONDITIONAL dead end, worse than card `9497bb7e`'s (which needs a specific, fragile
  boot-unreadable-then-reingest precondition to occur at all).
- **C (split: lift only `Kr`, leave `S` armed at `Ks`) — DEFERRED.** Related to, but not identical to, the
  PROMOTE the Lead rejected in `3be11be4` (that PROMOTE re-pointed a union's `.repoPath` naming/ownership
  with a contributor tie-break; C never touches `.repoPath`, it un-arms one secondary key of a multi-key
  entry). Deferred because: (1) it needs a genuinely new primitive — every multi-key entry in
  `clearMergeQuarantineByKey` today deliberately lifts EVERY armed key, a hard-won invariant across several
  cards (`8db913e2`/`6be6c9ff`/`1fc3a561`/`d69a6744`); (2) it would reverse `reduceForeignUnionContributor`'s
  own documented `3b1944b6` (Round 2) "do not" — that function deliberately never touches `armedKeys`,
  with its own stated rationale ("no safety reason to attempt it"); (3) real boot-reentry/atomicity
  questions, the same category of risk the Lead already weighed once for PROMOTE; (4) narrow payoff — a
  LEGACY/unknown-`genuineContributorKeys` `S` would have to fail back to A anyway (no reliable per-key
  provenance to confirm the un-arm is safe), and since tokens are a flat, untagged set
  (`24ed371f`'s own doc), a safe C can only ever un-arm the KEY, never actually split `R`'s token out of
  `S`'s union — it unblocks `R`'s identity query, nothing more.
- **D (built in this card) — shipped.** See below.

## What D actually ships (as of Round 2 — see "Round 2" below for what Round 1 shipped and why it was wrong)

Two new exported helpers in `merge-quarantine.ts`:

- `alsoReleasedRepoPaths(liftedRepoPaths, addressedRepoPaths)` — every identity in `liftedRepoPaths` whose
  own `canonicalRepoLockKey` DIFFERS from every one of `addressedRepoPaths`'s own `canonicalRepoLockKey`.
  **Not a path-nesting check and not a bare `directPathIdentity` diff** — see "Round 2" below for why a
  nesting-based version was wrong. A key-walk failure on the LIFTED side reports rather than excludes
  (over-reporting is the safe direction for a disclosure that already happened). Deduped, order-preserving.
- `alsoReleasedWarningFor(alsoReleased)` — a human-readable, explicitly POST-HOC (never pre-action)
  confirm-no-process string, `undefined` for an empty input.

Wired at all three REST clear routes:
- `/clear` and `/clear-by-path {repoPath}` — addressed against the literal given `repoPath`, computed at
  the gateway layer.
- `/clear-by-path {id}` — the id form has no independent repoPath to address against; `addressedRepoPaths`
  is a NEW field `clearMergeQuarantineLatchFile` itself returns (the id's own resolved identity/identities),
  forwarded by the gateway. Round 1 passed `liftedRepoPaths` against ITSELF here, making the field
  permanently dead — see "Round 2" below.

Present only when non-empty (absent, never an empty array/string, for an ordinary clear) — checked against
`CLAUDE.md`'s named response-shape guards (`entity-row-fields-guard.mjs`, `worker-status-projection-
guard.mjs`, `agent-session-full-field-guard.mjs`, `platform-config-redaction-drift.mjs`, `mcp-project-
fields-chokepoint-guard.mjs`, `project-mcp-sessionenv-redaction.mjs`, `project-response-redaction-drift-
guard.mjs`) and a corpus grep for these route paths / `liftedRepoPaths` — none pin an exhaustive key set
for these routes; a new optional field is safe to add.

## A route asymmetry found while writing the REST-level test

`/clear-by-path {repoPath}` (`clearMergeQuarantineByRecordedPath`) **cannot reach this shape for `R`'s own
address at all.** Its own matching (`activeMatchesAndLiftedKeysFor`) is identity-only — card `abccee85`'s
own rule: never a fresh `canonicalRepoLockKey` recompute — so it only matches an entry whose OWN
`.repoPath` equals the given path. `R` is a mere contributor (`.repoPath` is `S`), so nothing matches `R`
directly; the call falls through to `stillQuarantinedReason`'s "ANOTHER repo's own, separate quarantine"
branch and refuses, lifting nothing. Confirmed via a throwaway probe (own LOOM_HOME, scratch-only) before
writing any test. Only `/clear` (projectId-resolved, which calls `clearMergeQuarantine`'s fresh-key route)
reaches the shape — the REST-level test (`(AQ)`, `merge-quarantine-clear-by-path.mjs`) is routed through
`/clear {projectId}` for exactly this reason, never `/clear-by-path {repoPath}`.

## Round 2 — Code Review (session `b100ff5a`, snapshot `f8d25351`): NOT-SHIP, one MAJOR, one MINOR

Verified clean otherwise: no behaviour change (A/B/C untouched), the discriminating tests, the route
asymmetry finding, and the EOL fix were all confirmed accurate.

### MAJOR — `sameTreeAsAddressed` (path nesting) hides a genuinely separate repo's released quarantine

Round 1's `alsoReleasedRepoPaths` excluded any lifted identity nested either direction (`isNestedUnderKey`)
under an addressed one. Measured on real fs: construct a genuinely separate repo (its own `.git`, its own
canonical key) physically INSIDE the addressed repo's directory, folded in via the SAME sibling-key
dual-arm mechanism (6de79dc0) — `alsoReleasedRepoPaths` returned `[]` while that repo's quarantine was
genuinely, separately lifted. Same result for the mirror direction (the addressed repo nested inside the
other). The `ySub` shape Round 1 built the exclusion for is NOT an example of "nesting is safe to
exclude" — it works only because `ySub` (a bare subdirectory with no `.git` of its own) has NO canonical
key of its own at all; its `canonicalRepoLockKey` already equals the addressed key. Nesting was never the
real discriminator.

**The fix:** `alsoReleasedRepoPaths` now compares `canonicalRepoLockKey(lifted)` against every
`canonicalRepoLockKey(addressed)` — report when none match. This is a POST-HOC DISCLOSURE, not a refusal
decision, so `3be11be4`'s own "never decide a REFUSAL from a live fs re-walk" rule does not apply: a live
key walk here only NAMES what a clear already did, it does not decide whether to act. A key-walk failure
on the lifted side reports (over-reporting is the safe direction here, unlike a refusal).

**Tests:** `(nested-inner)` (the genuinely separate repo lives inside the addressed one's own directory)
and `(enclosing)` (the mirror — the addressed repo lives inside the other's own directory), both in
`merge-quarantine-6de79dc0-sibling-key-contributor-wrong-release.mjs`. Both shown RED against `f8d25351`
(a real `git checkout <sha> --` revert/rebuild/restore/rebuild cycle, never committed mid-cycle), GREEN
after the fix. `(owner)`'s pre-existing negative control (the same-key bare-subdirectory `ySub` shape)
still passes unchanged — confirming the key-based rule gives the SAME correct answer for that shape too,
by the right reasoning this time.

### MINOR — the `{id}` route's own field was permanently dead

`gateway/server.ts`'s `/clear-by-path {id}` branch computed `alsoReleasedRepoPaths(result.liftedRepoPaths,
result.liftedRepoPaths)` — addressed against ITSELF. Every lifted entry trivially matches something in its
own list, so the field could never be non-empty, regardless of what `clearMergeQuarantineLatchFile`
actually lifted. This route addresses an ID, never a repoPath, so there was no independent "addressed"
value available at the gateway layer at all.

**The fix:** `clearMergeQuarantineLatchFile` itself now returns a new `addressedRepoPaths?: string[]`
field — the identity the id ACTUALLY resolves to, computed where the function already knows it:
`[activeMatch.entry.repoPath]` for an active match (today this always yields an empty `alsoReleased`,
since clear-by-id's own pre-existing ambiguity refusal, `82032b5c`, already blocks every case where this
branch's own `liftedRepoPaths` could hold more than the addressed entity); `[matchedRepoPaths[0]]` for the
PENDING multi-claimant branch (`882d6cff`), which CAN hold several genuinely distinct identities sharing
one id by a real hash collision (never a shared key). `matchedRepoPaths[0]` is a designated reference, not
a principled "the" address — there is no single canonical owner when multiple distinct-keyed identities
share one id purely by collision; passing the FULL set would reopen the same self-referential dead-field
bug one level in (every lifted entry is itself a member of that set). The gateway now forwards
`result.addressedRepoPaths ?? []` instead of `result.liftedRepoPaths`.

**Test:** `(id-multi-claimant)` — two genuinely different-keyed real repos share one crafted latch id via
an identical `sourceFile` basename (`PENDING_DIVERT_RE`-shaped, so `pendingLatchIdFor` hashes the full
basename rather than deriving anything from a key — the real-world mechanism `882d6cff`'s own shape
depends on, built directly via `pushPendingQuarantineTestOnly` rather than reproducing the rare natural
coincidence). Clear-by-id succeeds (no ambiguity refusal — neither identity carries `contributorRepoPaths`/
`provenanceUnknown`), lifts both, and the disclosure names the one not addressed. Shown RED against
`f8d25351` (same revert/rebuild cycle as above), GREEN after the fix.

### Lead review (after Round 2) — a failed ADDRESSED key walk could report the addressed path against itself

Round 2's own key-based fix had a residual: if `canonicalRepoLockKey(addressed)` ever failed, every
`addressedKeys` entry became `undefined`, matching nothing — so the addressed path (always present in its
own `liftedRepoPaths`) would wrongly report ITSELF as "also released." **The fix:** an exact
`directPathIdentity` match against `addressedRepoPaths` is excluded FIRST, independent of key resolution —
the literal identity the human addressed is never "also released," whatever the key walk does.
`alsoReleasedRepoPaths` gained a third, optional `keyFn` parameter (defaulting to the real
`canonicalRepoLockKey`) purely as a TEST SEAM: `canonicalRepoLockKey` cannot be made to throw with any
cheap real input (verified empirically — even a NUL-byte path is absorbed internally), so the
`(key-throws-unit)` test drives a hand-injected throwing function directly rather than hunting for a real
filesystem shape that fails. The bug itself was also confirmed by hand (never committed) by running the
OLD algorithm — key-comparison only, no identity exclusion — against the same fixture: it reported the
addressed path as "also released."

**Known, accepted limit (documentation only, not fixed):** `canonicalRepoLockKey` on a since-DELETED or
unmounted nested repo resolves to its ENCLOSING repo's own key instead of its own (the same hazard
`24ed371f`'s own manual-escape note already records) — if that happens to coincide with the addressed
path's key, a genuinely separate repo's release could go unreported. Accepted: this is a post-hoc
disclosure of a path that, by the time this matters, no longer exists to confirm "no process" against.

## Do not

- **⛔ SUPERSEDED BY ROUND 2 — do not follow this bullet's own recipe.** It originally said: "exclude
  anything on the SAME physical path-tree as what was addressed (`isNestedUnderKey` either direction, or
  equal)." That is WRONG — path nesting hides a genuinely separate repo's released quarantine whenever it
  happens to be nested inside, or enclose, the addressed one. The current, correct rule: compare
  `canonicalRepoLockKey`, never filesystem path relationships. See "Round 2" below.
- Do not compute `alsoReleasedRepoPaths`'s PRIMARY comparison via a bare `directPathIdentity` diff — that
  was Round 1's OWN first-tried-and-rejected version (see "Round 1" above); the real discriminator is the
  canonical KEY. `directPathIdentity` DOES still gate one thing — see the next bullet.
- Do not drop the exact `directPathIdentity` match against `addressedRepoPaths` — it is what keeps the
  addressed path from reporting ITSELF when its own key walk fails (Lead review, after Round 2); the key
  comparison alone is not sufficient on its own for that one case.
- Do not call `alsoReleasedWarningFor`'s text a pre-action warning — it is computed strictly AFTER the
  clear already ran; its own wording says so, and must keep saying so.
- Do not expect `/clear-by-path {repoPath}` to reach the sibling-key-contributor shape for a contributor's
  own address (e.g. to repro or test it) — it structurally cannot (see "route asymmetry" above); use the
  project-resolved `/clear {projectId}` route instead.
- Do not pass `clearMergeQuarantineLatchFile`'s own `liftedRepoPaths` as its own `addressedRepoPaths` input
  at the `/clear-by-path {id}` route — that is self-referential and makes the field permanently dead
  (Round 1's own bug). Source `addressedRepoPaths` from the function's own new return field instead.
- Do not pass the FULL `matchedRepoPaths` set as `clearMergeQuarantineLatchFile`'s own `addressedRepoPaths`
  for the PENDING multi-claimant branch — every lifted entry is itself a member of that set, so this is
  the SAME self-referential dead-field bug one level in. Use `matchedRepoPaths[0]` (see "Round 2" below).
- Do not revisit B without first inventing a genuinely new release route for this shape — refusing
  `/clear(r)` alone, with nothing else changed, is a proven unconditional dead end.
- Do not start C by re-deriving the Lead's PROMOTE ruling from `3be11be4` as if it settles C too — C is
  related but distinct (never touches `.repoPath`); re-derive its own atomicity/boot-reentry questions from
  scratch rather than reusing PROMOTE's own analysis as a substitute.

## Tests

`merge-quarantine-6de79dc0-sibling-key-contributor-wrong-release.mjs`: `(explore-clear-r)` — `alsoReleasedRepoPaths`
names exactly `s`, the warning names `s` + confirm-no-process wording + is explicitly post-hoc; `(owner)`
— the same-key ancestor-collapse negative control (empty, `alsoReleasedWarningFor([])` is `undefined`);
Round 2's own `(nested-inner)`/`(enclosing)` (the genuinely-separate-repo-nested-either-direction MAJOR
fix) and `(id-multi-claimant)` (the clear-by-id MINOR fix); `(key-throws-unit)` (the Lead-review addendum
— a pure unit test driving a hand-injected throwing `keyFn`, since `canonicalRepoLockKey` cannot be made
to throw with any cheap real input) — see "Round 2" above for each. `merge-quarantine-
clear-by-path.mjs`: `(AQ)` drives the sibling-key fixture through a real `app.inject()` call against
`/clear {projectId}`, asserting the field/warning over real HTTP, plus its own negative control. Every new
assertion set (Round 1, Round 2, and the Lead-review addendum) shown RED against the pre-change source (a
captured-and-restored `git` revert/rebuild/restore/rebuild cycle — `git checkout <sha> --`, never a stash,
never committed mid-cycle) before being shown GREEN — the Lead-review fix's own bug was additionally
confirmed by hand (a throwaway script replicating the OLD algorithm, run once, never committed), since the
`keyFn` seam itself did not exist before that fix to revert to. Full non-regression after Round 2: `6de79dc0`, `3be11be4`, `24ed371f`,
`merge-quarantine-clear-by-path`, `merge-quarantine-lazy-graduation-sibling-key-collision-90306240`,
`merge-quarantine-raise-protect-failure`, `merge-quarantine-runtime-union-provenance`, `merge-quarantine-
boot-unreadable-vs-corrupt`, `loopback-write-guard`, `quarantine-reason-windows-guidance` — all green, both
`env -u LOOM_DEV -u LOOM_SUPERVISED` and `LOOM_DEV=1` (where applicable). `pnpm --filter @loom/daemon
guards`: 31/31 green, including `working-tree-eol-guard.mjs`.
