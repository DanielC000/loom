# 3be11be4 — self-clearing a union by its own stale-key name REFUSES when a genuine contributor is folded in

From card `3b1944b6`'s own Code Review (reviewer `a648b462`): the MIRROR of that card's shape. There,
`R` (a real repo) was the union's own `.repoPath`, and `sub` (a stale-key subdirectory with no own
`.git`) was folded in as a mere `contributorRepoPaths` member — `/clear(sub)` wrongly lifted `R` too.
Here, the roles are reversed: `sub` raises FIRST (immediately collapsing onto `R`'s real toplevel key,
since `R` already has a `.git` on disk) and so WINS `unionQuarantineEntries`'s age-based "older wins the
`.repoPath` spread" tie-break; `R` raises SECOND, at its own genuine key (the SAME key `sub` already
occupies), and folds in as a mere `contributorRepoPaths` member. `/clear(sub)` and clear-by-path(sub)
then matched `sub`'s own identity trivially (the union's own `.repoPath` literally IS `sub`) and fell
through to the plain, unconditional fresh-key clear — `liftedRepoPaths:[sub, R]`, destroying `R`'s
genuinely separate, real quarantine.

## Investigation (before any fix)

Real-git repro (marker-only `.git`, in-process, against main HEAD `855c493a`) through all three real
routes:
- `/clear(sub)` (`clearMergeQuarantineReporting`): lifted `[sub, R]`. Over-clear confirmed.
- clear-by-path(sub) (`clearMergeQuarantineByRecordedPath`): identical — lifted `[sub, R]`.
- clear-by-id (using the one id this key hashes to, regardless of which identity's path derives it):
  already REFUSES (`ok:false`, "ambiguous ... had their own raise folded into this union's token set at
  runtime") — `ambiguousIdentitiesFor` already treats non-empty `contributorRepoPaths` as ambiguous
  (cards `82032b5c`/`9a55fb90`), pre-existing, not new to this card. Only `/clear` and clear-by-path were
  open.

Symmetric owner-escape check (3b1944b6's own "THE TOKEN QUESTION," mirrored): `/clear(R)` (R's own path)
still fully lifts both (R never matches its own identity in the union — `matched` is empty for R — so
this card's new guard, scoped to "repoPath IS the matched entry's own `.repoPath`," never reaches it).
clear-by-path(R) does NOT work (R is a mere contributor; clear-by-path can never address a contributor's
own path — the SAME pre-existing, documented limitation 3b1944b6 names for its own mirror direction).

## The Lead's ruling (Round 1)

Ship REFUSE, never PROMOTE. REFUSE is a pure read-only decision matching clear-by-id's own pre-existing
fail-closed posture. PROMOTE would need a durable in-place rewrite of an entry's own `.repoPath`, a
tie-break rule among more than one contributor with no precedent, and unverified boot-reentry
assumptions — disproportionate for a card that is already the mirror of an 8-round fix. PROMOTE is
explicitly out of scope; a separate card if ever wanted.

Scope: guard at exactly two sites — `clearMergeQuarantine`'s fresh-key fallback, and
`tryClearMergeQuarantineByOwnIdentity`'s active-tier loop (shared by clear-by-path's own "broad" sweep).
The Lead's own literal condition: "repoPath IS the matched entry's own recorded `.repoPath` AND that
entry has non-empty `contributorRepoPaths`."

## Round 1's own refinement — "owns its own key"

Implementing the Lead's literal condition verbatim regressed `merge-quarantine-runtime-union-provenance.mjs`'s
CASE 1/2: a repo `X` that GENUINELY OWNS its own key raises FIRST and wins the SAME age-based naming race
against a later-absorbed subdirectory contributor. That scenario asserts self-clearing BY the entry's own
real identity MUST continue to fully lift everything, contributors included (cards `82032b5c`/`9e826040`).
Round 1 added: repoPath must NOT own its own canonical key (`canonicalRepoLockKey(repoPath) !==
directPathIdentity(repoPath)`) — computed via a LIVE filesystem re-walk. This was the version sent to
Code Review `dede2ffd`.

## Round 2 — Code Review `dede2ffd`: the live-walk ownership check fails OPEN

### Finding 1 (CRITICAL) — ownership must be decided from a STORED key, never re-walked

`selfClearRefusesForStaleKeyContributors`'s own live `canonicalRepoLockKey(entry.repoPath)` re-walk fails
open three ways, each reproduced on real git (RED under the old predicate, confirmed via a manual
revert/rebuild/restore cycle — never a `git show HEAD:` snapshot):
- (a) `sub` gains its own `.git` AFTER the union forms — the live walk now resolves to `sub`'s own new
  key, matching its own identity, so the OLD predicate said "owns its own key" and let the clear proceed
  unguarded. Lifted `[sub, R]`.
- (b) `sub` is deleted/unmounted — the OLD predicate's own resolvability exemption (`if
  (!isRepoPathCurrentlyResolvable(...)) return false`) fired and skipped the check entirely. Lifted
  `[sub, R]`.
- (c) `R`'s `.git` is temporarily absent — `sub`'s own walk, finding no enclosing `.git` anywhere, returns
  `sub`'s own path as its own "key," again matching its own identity. Lifted `[sub, R]`.

**The fix:** every one of the four call sites that need this decision already has the key the entry is
CURRENTLY ARMED at as a stored fact (`freshKey` in `clearMergeQuarantine`, `m.key` in
`tryClearMergeQuarantineByOwnIdentity`'s loop, `activeMatch.key` in `clearMergeQuarantineLatchFile`, and a
new `resolveArmedKeyForLatchId` helper — factored out of `ambiguousIdentitiesForLatchId`'s own pre-existing
key derivation — for `assertRepoNotQuarantined`). `selfClearRefusesForStaleKeyContributors(entry,
armedKey)` now compares `directPathIdentity(entry.repoPath) === armedKey` — a PURE STRING comparison,
zero filesystem access, immune to all three bypasses by construction (none of them can change a STORED
key or a pure string normalization). The resolvability exemption is dropped entirely — there is nothing
left for it to guard against.

Re-verified GREEN under the fix for all three repros; automated as the `(bypass-a)`, `(bypass-b)`,
`(bypass-c)`/`(bypass-c-clearbypath)` scenarios in the card's own test file.

### Finding 1, continued — a bare inequality is still too broad

A bare `directPathIdentity(entry.repoPath) !== armedKey` (dropping Round 1's live walk but keeping its
"not equal, therefore refuse" shape) broke `merge-quarantine-runtime-union-provenance.mjs`'s CASE 2 and
"case B": a DEGRADED entry whose own stored key merely COLLIDES with an UNRELATED SIBLING's real key
(card `82032b5c`'s own manufactured-collision shape — two colliding identities under one physical slot,
never an ancestor/descendant relationship) is NOT the same as a genuine stale-key nesting accident, and
`82032b5c` already, deliberately, decided that shape should still release everything via self-clear.

**The fix:** added `isNestedUnderKey(identity, armedKey)` — a pure `path.relative`-based check (still zero
filesystem access: `path.relative` is a string/segment computation) — true only when `identity` denotes a
location textually INSIDE `armedKey` (`rel !== "" && rel !== ".." && !rel.startsWith(".."+sep) &&
!path.isAbsolute(rel)`). The guard now fires only when `identity !== armedKey` AND `isNestedUnderKey`
holds — a genuine ancestor/descendant relationship, never a mere key collision between unrelated
identities. Re-verified: `merge-quarantine-runtime-union-provenance.mjs` fully green (was 2
scenarios/12 checks failing with the bare-inequality version).

**Consistency with `directPathIdentity` (manager's own follow-up question, verified empirically, not
assumed):** `directPathIdentity`/`canonicalRepoLockKey` both bottom out in `fs.realpathSync.native` (or a
`path.resolve`/ancestor-walk fallback) plus a `.toLowerCase()` on win32 — confirmed via a real-git probe
that `directPathIdentity(R) === canonicalRepoLockKey(R)` for the SAME location, that a trailing separator
on the input normalizes away (`directPathIdentity(R + sep) === directPathIdentity(R)`), and that an
UPPER-CASED spelling of the same input normalizes to the identical lowercased string
(`directPathIdentity(R.toUpperCase()) === canonicalRepoLockKey(R)`). `fs.realpathSync.native` did not
produce a `\\?\`-prefixed path for any ordinary (non-extreme-length) input in this probe — a known,
named, UN-closed residual for a path long enough to require the Windows long-path prefix, which neither
this card nor any pre-existing caller of these two functions has ever verified either way; not chased
here. Separately verified `path.relative`/`path.win32.relative` ARE case-insensitive on Windows (so even
a hypothetical case mismatch reaching `isNestedUnderKey` directly would not misfire) and correctly reject
a sibling sharing a literal text prefix (`R/sub` vs `R/sub2`, `R` vs `R2` — both return a `".."`-prefixed
relative path, never treated as nested). All of this is pinned as the `(nest-i)`/`(nest-sibling)`/
`(nest-case)` scenarios in the card's own test file — direct tests of the exported `isNestedUnderKey`,
since it is a small, pure, self-contained string/path utility (the same testing posture this file already
gives `directPathIdentity`).

### Finding 2 (MAJOR) — the remediation text named a NO-OP route for a bare-subdirectory contributor

"Clear via the contributor's own project-resolved `/clear`... lifts the whole entry" is true when the
contributor genuinely owns a real identity (my own original mirror shape, `R`) but FALSE when the
contributor is ITSELF a bare subdirectory with no `.git` of its own (`merge-quarantine-lazy-graduation-
contributor-attribution-b5c94cbe.mjs`'s own `D`/`S` shape): `/clear(D)` there goes through
`reduceForeignUnionContributor` and lifts NOTHING — only a SECOND `/clear(S)` (the primary) afterward
actually releases the union, because reducing `D` out of `contributorRepoPaths` is what makes the primary
`S`'s own guard stop firing.

**The fix:** `remediationTextFor` now takes a THIRD argument, `ownPathViable: boolean` — `ownRepoPaths`
itself is ALWAYS the real own path(s), never emptied by a caller; `ownPathViable` carries whether
clear-by-path with them currently works. When no honest clear-by-path target exists at all (own path
non-viable, no sibling to name), the text now names a verified TWO-STEP sequence instead of a single,
shape-dependent claim: "clear each contributor's own quarantine directly FIRST... (this fully releases
the whole entry when that contributor itself owns a real repo identity of its own, or otherwise merely
drops it from this union without lifting anything by itself); once every contributor is cleared this way,
clear-by-path with one of [primary] releases whatever still remains." Driven end-to-end, per the Code
Review's own instruction, in BOTH contributor shapes (`(sequence-r-owns)`: step 1 alone fully releases,
step 2 is a harmless no-op; `(sequence-bare-subdir)`: step 1 lifts nothing, step 2 then releases
everything) — both verified against the real functions, not reasoned about.

**A second regression found while re-verifying this wording against the full corpus:**
`merge-quarantine-raise-protect-failure.mjs`'s own `bfc9356e` scenario asserted a refusal's combined
reason text matches `/unconfirmed-kill/ && /ambiguous/ && /collide/` — the ORIGINAL `remediationTextFor`'s
"normal" branch always said "...the listed path's own outstanding **unconfirmed-kill** quarantine...",
and this OTHER card's own disclosure-completeness check relied on that exact phrase being present even for
an entry whose own `reason` field never used it. The new "no honest target" branch dropped the phrase
entirely. Fixed by restoring it in that branch's own wording ("clear-by-path cannot release this entry —
including the listed path's own outstanding unconfirmed-kill quarantine — without also destroying..."),
verified via `git show 855c493a:...` as a scratch baseline (confirmed this exact check passes on
unmodified mainline, confirming the regression was wording-only, never a behavioral one) and re-verified
GREEN after the fix.

**Known residual, named but out of scope:** the two-step sequence's own first-step claim ("clear via the
contributor's own project-resolved `/clear`") is verified only for a contributor with no OTHER record of
its own anywhere (this card's own repro/tests). A contributor that ALSO independently holds its own,
separate active quarantine elsewhere could in principle route `/clear(contributor)` into
`clearMergeQuarantine`'s OTHER branch (`ownMatchesElsewhere`) rather than the ancestor-collapse fallback
this text relies on — never observed, never tested, left to a follow-up if it ever surfaces.

### Finding 3 (MINOR, folded in since REFUSE was chosen because it's read-only) — check the guard before `preClearForeignKeyStamp`

`preClearForeignKeyStamp` (called from `clearMergeQuarantine`'s `freshIsForeign` branch and
`clearMergeQuarantineByRecordedPath`) does its OWN independent, fresh `canonicalRepoLockKey` walk of
`repoPath` — which can coincidentally resolve to a WHOLLY UNRELATED foreign entry (reviewer's probe3
shape: `R` and `A=R/a` each own `.git`; `B=R/a/b` does not; raise `B`, `A`, `R` — `R` wholly standalone;
delete `A`'s `.git` — `B`'s own fresh walk now resolves PAST `A`, to `R`'s real key) and durably stamp
THAT unrelated entry's own `reducedContributorRepoPaths`, even though the overall call ultimately refuses
and is supposed to write nothing durable.

**The fix:** both routes now check this card's own guard — scanning `matched` for an entry where
`selfClearRefusesForStaleKeyContributors` holds — BEFORE calling `preClearForeignKeyStamp` at all, and
refuse immediately (writing nothing) if it fires. `clearMergeQuarantineByRecordedPath` now computes
`matched`/`hasOwnPendingMatchForStamp` itself, up front, reusing them for BOTH the new pre-check and the
pre-existing `identityHasOwnRecordAnywhere`-equivalent computation it already needed for
`preClearForeignKeyStamp`'s own `ownRecordBeingCleared` argument.

Verified via the reviewer's exact probe3 construction: RED via a manual revert (removing the pre-check,
simulating the pre-fix ordering) — R's own standalone latch file WAS mutated by both a refused `/clear(B)`
and a refused clear-by-path(B); GREEN after the fix — R's file is BYTE-IDENTICAL before and after both
calls. **The guard's own decision (Finding 1 above) is now consulted BEFORE any durable write on every
route that reaches it — this closes the last place where a refusal could still have a side effect, making
"REFUSE is a pure read-only decision" (the premise Finding 3's own title names) actually true, not merely
intended.** Automated as the `(probe3)` scenario.

### Finding 4 (test quality) — fixed per the Code Review's own instructions
- `?.` added at the `result.reason?.includes(...)` assertions in `(i-clear)` (a negative-control revert
  can legitimately leave `reason` undefined; a bare `.includes` there crashed past every later scenario).
- `(v-nounion)` no longer asserts `wasQuarantined===true`/`!refusedBeforeClear` on
  `clearMergeQuarantineReporting`'s own result — that wrapper's return type never carries
  `refusedBeforeClear` at all (see "Do not" below), so that half of the old assertion was non-
  discriminating by construction; only "sub reads clear afterward" actually distinguishes the guard firing
  from not firing.
- Added `(owner-site1)`: the SAME non-regression as `(owner)` (a repo that genuinely owns its own key
  still releases everything by self-clear), but driven via `/clear(x)` specifically — `clearMergeQuarantine`'s
  OWN fresh-key fallback (SITE 1), never `clearMergeQuarantineByRecordedPath`'s own
  `tryClearMergeQuarantineByOwnIdentity` call (SITE 2) that `(owner)` already covers.
- `merge-quarantine-lazy-graduation-contributor-attribution-b5c94cbe.mjs`'s own SCENARIO 3b post-reboot
  check now also asserts `S` (the refused clear's own target) stays enforced, not just `D` — a refusal
  means NOTHING was lifted, `S` included, and the old check only verified half of that.

## A third pre-existing file conflicts with this card's own target shape: `merge-quarantine-raise-protect-failure.mjs`

A full-corpus run (the Code Review's own instruction) surfaced 15 failing checks across three scenarios
(`item1`, `n4` — card `dd34da46`'s own regression suite for `markedFinalFullyCoveredByClear`'s stale-mark
unlink decision; `probeA` — card `25f6a7dc`'s own regression test for that same function's
`clearedTokens.has(t)` disjunct). All three construct the IDENTICAL shape this card targets (a
hand-written `d2 = r2/gone-subdir` latch, `repoPath: d2`, folded into `r2`'s own `existing`-branch raise
as a contributor once `r2` genuinely raises) and drive it through the PUBLIC `clearMergeQuarantineByRecordedPath(d2)`
specifically to exercise their OWN internal logic — logic that lives inside `clearMergeQuarantineByKey`,
which this card's new guard now sits ABOVE (in the public wrapper), REFUSING before that internal logic is
ever reached. Unlike `b5c94cbe` (where the public-route behavior itself was the thing under test, and
updating the assertion to "refuses" was simply correct), updating these assertions the same way would
silently stop them from testing what `dd34da46`/`25f6a7dc` exist to test at all.

**Full re-audit (not just the 15 failing checks):** `grep`-ing the whole corpus for the `gone-subdir`
fixture-naming convention this file (and 9 others) uses found ~40 occurrences across this ONE file alone.
Rather than manually trace all 40, a temporary runtime trace on `selfClearRefusesForStaleKeyContributors`
(gated behind an env var, removed before committing) recorded every live invocation with a non-empty
`contributorRepoPaths` across a full run of the file: exactly 13 invocations total, mapping to exactly
five scenarios — `item1`/`n4`/`probeA` (refuses; the three above), `bfc9356e` (refuses, but only affects
disclosure TEXT — the scenario's own boolean assertions about blocking state are unaffected; fixed as part
of Finding 2's wording restoration), and cards `050a4428`/`d524d1c4` (invoke the predicate — mixed
true/false results — but never call a public clear route on the non-owning identity's own name at all;
their own assertions are about dual-arm `resolvedKey` persistence and triple-fault write bookkeeping,
never about whether self-clearing releases the union). No other scenario in this file, or in the other 9
files sharing the `gone-subdir` convention, invokes this predicate with contributors present at all.

**Classification (per the Code Review's own A/B/C scheme):**

| Scenario | Card | Class | Action |
| --- | --- | --- | --- |
| `item1` | `dd34da46` | (A) internal stale-mark/unlink logic | Swapped `clearMergeQuarantineByRecordedPath(d2)` → `clearMergeQuarantineByKey(K2, d2, undefined, true)`; added a new, PRECEDING assertion that the public route itself refuses and writes nothing (`final` untouched) |
| `n4` | `dd34da46` | (A) internal EPERM-unlink-failure logic | Same swap; same preceding public-route refusal assertion |
| `probeA` | `25f6a7dc` | (A) internal `clearedTokens` coverage logic | Same swap (`clearMergeQuarantineByKey(KrA, dA, undefined, true)`); same preceding public-route refusal assertion |
| `bfc9356e` | `bfc9356e`/`721c1123` | (B) public disclosure-text behaviour | Text restored (see Finding 2) — no call-site change; the scenario's own `assertRepoNotQuarantined` calls are themselves about disclosure, not about this card's own clearing decision |
| `050a4428` | `050a4428` | (C) unrelated — never calls a public clear on the non-owning identity's own name | No change; confirmed via the runtime trace that this card's guard never gates any of its assertions |
| `d524d1c4` (both its scenarios) | `d524d1c4` | (C) unrelated — same reason as `050a4428` | No change |
| every other `gone-subdir` occurrence in this file (and the other 9 files sharing the convention) | various | (C) never invokes this card's own predicate at all (confirmed via the exhaustive runtime trace, not by manual per-call-site tracing) | No change |

**RED proof that each swapped scenario still exercises its own original fix** (one representative check
per card id, via a manual revert/rebuild/restore cycle, never a hand-rolled recipe):
- `dd34da46`: temporarily made `markedFinalFullyCoveredByClear` unconditionally `return false` (simulating
  "pre-`dd34da46`: always keep on a stale mark") — `item1`'s own `final`-is-UNLINKED/token-lifted
  checks, and `probeA`'s own checks, went RED (10 of the file's checks, spanning several OTHER scenarios
  too, confirming this function is load-bearing well beyond this card's own 3 scenarios). Restored; GREEN.
- `25f6a7dc`: a NARROWER revert — dropped only the `|| clearedTokens.has(t)` disjunct, keeping the rest of
  `dd34da46`'s own fix intact — and EXACTLY `probeA`'s own 3 checks went RED, with `item1`/`n4` unaffected,
  cleanly isolating `25f6a7dc`'s own specific contribution from `dd34da46`'s broader one. Restored; GREEN.

## Tests

`packages/daemon/test/merge-quarantine-3be11be4-self-clear-stale-key-contributor-refusal.mjs` — 14
scenarios covering: the original mirror repro and symmetric-escape non-regression (`(i-clear)`/
`(i-clearbypath)`/`(iii-clearbyid)`/`(ii-ownerescape)`/`(owner)`/`(owner-site1)`/`(v-nounion)`); the three
Round 2 live-fs bypasses (`(bypass-a)`/`(bypass-b)`/`(bypass-c)`/`(bypass-c-clearbypath)`); the
remediation-text two-step sequence in both contributor shapes (`(sequence-r-owns)`/`(sequence-bare-subdir)`);
the `preClearForeignKeyStamp`-ordering probe3 (`(probe3)`); and the `isNestedUnderKey` consistency/
sibling-false-positive/case-and-slash-tolerance checks (`(nest-i)`/`(nest-sibling)`/`(nest-case)`). 108
checks total, solo runtime well under a second — no `TEST_TIMEOUT_OVERRIDES` entry needed.

`merge-quarantine-lazy-graduation-contributor-attribution-b5c94cbe.mjs` — SCENARIO 3b updated (Round 1;
Round 2 strengthened its post-reboot check to also cover `S`, not just `D`).

`merge-quarantine-raise-protect-failure.mjs` — `item1`/`n4`/`probeA` each gained a preceding public-route
refusal assertion and had their own internal-logic call site swapped to `clearMergeQuarantineByKey`; the
`bfc9356e` scenario needed no code change once Finding 2's wording was restored.

Full `merge-quarantine*.mjs` corpus (79 files) run individually (batched into foreground-safe chunks,
one lane, never concurrent), BOTH the default env state and `LOOM_DEV=1 LOOM_SUPERVISED=1`: 0 failures in
both, after all of the above. `pnpm --filter @loom/daemon guards`: 30/30 green.

## Round 3 — Code Review `ffc8eec4` (at commit `137636b1`): two more CRITICALs, both still a live re-walk one level up

### Investigation first — does the "owns its own key" narrowing (Round 1/2) have a real reason to exist?

Before changing anything, the Lead's round-3 ruling (default: drop the narrowing entirely, refuse
whenever `contributorRepoPaths` is non-empty) was checked against a concrete repro: CASE 1/2 of
`merge-quarantine-runtime-union-provenance.mjs` (cards `82032b5c`/`9e826040`) — a repo `X` that genuinely
owns its own real key and raises FIRST, with a later bare-subdirectory `Y` folded in as a mere
contributor. Self-clearing `X` by its own real identity must still fully release everything, `Y` included.
Reproduced directly: `X` IS the matched entry's own `.repoPath`, and `contributorRepoPaths` is non-empty —
the plain rule's bare trigger condition fires here too, so a plain rule with no narrowing at all would
wrongly refuse this self-clear. The narrowing survives; it must be fixed, not dropped.

### Finding 1 (CRITICAL) — bypass (b) via a real alias (junction/symlink/subst/`\\?\`/macOS `/var`)

Round 2's own fix compared a value computed LIVE at clear time (`directPathIdentity(entry.repoPath)`)
against a key STORED at raise time (`armedKey`). That is still "decided from a live fs re-walk" one level
up: real-git repro — `B` a real dir, `J` a junction to `B`, `R = J\R` with a marker `.git`, `sub =
J\R\sub` (no own `.git`). Raise `sub` then `R` via the alias (`sub` becomes the union's own `.repoPath`,
`R` folds in as contributor). Delete the real `sub` directory. `directPathIdentity(entry.repoPath)` now
falls back to a bare `path.resolve` (no filesystem lookup at all, since `sub` no longer exists) on the
UNRESOLVED alias spelling (`J\R\sub`), which is not textually nested under the STORED, already-resolved
key (`B\R`) — `isNestedUnderKey` returns `false`, the guard exits, and `/clear(sub)`/clear-by-path(sub)
both lift `[sub, R]`. Reproduced with a real win32 junction (`mklink /J`) before any fix was written.

**The fix:** record the entry's own identity ONCE, at raise time, with the SAME alias-resolving primitive
every stored key already uses (`ancestorAwarePathIdentity`, which bottoms out in
`findExistingAncestorRealpath` — the same primitive `canonicalRepoLockKey` itself uses), and persist it as
a new field, `identityAtRaise` (see its own doc comment on `MergeQuarantineEntry`). The predicate now
compares this FROZEN value against the entry's live-armed keys — no filesystem call, and no live
recomputation of ANY kind, at clear time. Changing the alias chain AFTER raise (the junction itself
removed, retargeted, or a subst drive unmapped) can no longer reopen this, because nothing is recomputed
from the alias at all once the entry is armed — both sides of the comparison are frozen at the instant
they were each actually true. Verified with three more real-alias repros beyond the original: the alias
ITSELF removed after raise, the alias RETARGETED to an unrelated directory after raise, and (where the
host permits creating one) a real directory SYMLINK in place of a junction — all three still refuse.

**LEGACY entries (persisted before this field existed, `identityAtRaise === undefined`) fail CLOSED:**
refuse unconditionally whenever `contributorRepoPaths` is non-empty, never fall back to any live
recomputation for them either. The remediation text's own two-step sequence (clear each contributor
first, then the primary) still names a WORKING route for every shape this round actually drove end-to-end
— but "working" is not always a single clean clear of the contributor: for a genuinely UNRESOLVABLE
LEGACY primary (never created on disk — the `buildRuntimeUnionFixture`/`writePreFixLatch` shape), clearing
the contributor alone triggers the pre-existing degraded-occupant protection (cards `07e3ad30`/`e0192ffb`)
and only DIVERTS the primary to a fresh pending record; the SECOND step (clear-by-path on that fresh
pending record) is what actually completes the release. For a RESOLVABLE contributor whose own key
happens to equal the union's key directly (the `(sequence-r-owns)` shape), ONE clear of the contributor is
enough. Both are verified, by their own distinct real repro, never assumed to generalize from one to the
other. **This does NOT hold for every legacy shape** — see "Round 4 residual (MAJOR-1, routed to card
`24ed371f`)" below for a narrow, fail-closed shape where NO human route releases the primary short of a
manual file edit.

### Finding 2 (CRITICAL) — bypass (a) across a reboot: one representative key is not every live-armed key

`activeMatchesAndLiftedKeysFor` (and the loops in `tryClearMergeQuarantineByOwnIdentity`/
`clearMergeQuarantineByRecordedPath`) match an entry under the FIRST key seen and evaluate the predicate
for that ONE key — but `clearMergeQuarantineByKey` lifts EVERY key the entry is live-armed at. Real-git
repro: build the mirror union in-process (`sub` raises first, no own `.git`, folds onto `R`'s key; `R`
raises second, folds in as contributor); THEN give `sub` its own real `.git` (its own fresh canonical key
now diverges from the stale key the union is actually stored/armed under); reboot via a real child
process (`reenterMergeQuarantinesAtBoot([R, sub])`) — the entry comes back dual-armed, `armedKeys:
[sub's own fresh key, the stale key]`. The checked (first-seen) key is `sub`'s own, which trivially "owns
itself," so the Round-2 guard exited `false` and `/clear(sub)` lifted `[sub, R]`.

**The fix:** `selfClearRefusesForStaleKeyContributors` now takes ONLY `entry` (no `armedKey`/`key`
parameter at all, at any of its six call sites) and evaluates the predicate over EVERY key in
{@link liveArmedKeysOf}`(entry)` — refusing the instant ANY one of them is a key `identityAtRaise` is
nested under (and does not itself equal). A dual-armed entry can own one of its live keys and still be
nested under another; checking the full set, not one representative, is what catches that. Verified via a
real reboot leaving the entry dual-armed exactly as reproduced above — still refuses.

### Correcting Round 2's own MINOR/NIT (Code Review `ffc8eec4`)

- **"Zero filesystem access / immune by construction" (Round 2's own Finding 1 fix text) was FALSE as
  written**, and CR2 was right to flag it: `directPathIdentity` itself calls `fs.realpathSync.native` —
  Round 2's predicate recomputed this LIVE, at clear time, so the comparison was never filesystem-free in
  practice, only the `===` operator itself was "pure." **This is now actually true, for the comparison
  itself:** Round 3's predicate reads `entry.identityAtRaise` (a value in memory, already computed) and
  compares it against `liveArmedKeysOf(entry)` (also already-stored keys) — zero filesystem calls at
  clear time. The computation that FEEDS `identityAtRaise` still calls the filesystem once, at raise time
  (via `ancestorAwarePathIdentity`) — never claim the FIELD itself is filesystem-free, only the
  CLEAR-TIME COMPARISON.
- **"Ancestor/descendant relationship" was imprecise** — `isNestedUnderKey` accepts exactly ONE direction
  (`identity` textually inside `armedKey`, i.e. `identity` is a DESCENDANT of the key, never the reverse —
  pinned directly by the `(nest-i)` scenario's own reversed-pair check). Read every prior "ancestor/
  descendant" phrase in this record as "descendant (never ancestor)."

## Tests (Round 3 additions)

`merge-quarantine-3be11be4-self-clear-stale-key-contributor-refusal.mjs` grew six more scenarios:
`(alias-deleted)` (real win32 junction, CR2's own CRITICAL-1 repro, both `/clear` and clear-by-path);
`(alias-junction-removed)`/`(alias-retargeted)` (the alias itself removed, or repointed, after raise —
proving the fix needs no live walk at all, in either direction); `(symlink-deleted)` (a real directory
symlink variant, SKIPPING with a printed reason on a host with no `SeCreateSymbolicLinkPrivilege` — this
host printed that skip); `(reboot-dual-arm)` (CR2's own CRITICAL-2 repro, a real child-process reboot);
`(legacy-entry)` (a hand-written latch with no `identityAtRaise`, proving the fail-closed refusal fires
AND that its own two-step remediation route actually releases the union end-to-end); and
`(persistence-round-trip)` (raise → real reboot → `identityAtRaise` is still present and unchanged on
disk). 154 checks total (was 108 after Round 2 — the NIT this record's own Round 2 section carried; a
check count stated once goes stale the moment a later round adds scenarios, which is exactly why this
file no longer restates it as a durable fact — see `CLAUDE.md`'s own "point at a source of truth" rule).
Solo runtime ~1.5s — no `TEST_TIMEOUT_OVERRIDES` entry needed.

**⛔ SUPERSEDED BY ROUND 4, MAJOR-2 — do not follow this paragraph's own recipe.** It originally stamped
`identityAtRaise` onto three hand-written fixtures (`buildRuntimeUnionFixture`'s `X`, `4b06875f`'s `S`,
`writePreFixLatch`'s `X`) on the claim that `directPathIdentity`/`ancestorAwarePathIdentity` agree
whenever no alias sits in the path's ancestry. Code Review `cb267228` (Round 4) correctly rejected this:
(1) a current raise can NEVER produce these exact field-less shapes, so stamping them hid a real
behavior change for an upgraded owner who hits one for real; and (2) the "no alias" premise was never
actually verified for 8.3-short-name aliasing specifically — a Windows CI `os.tmpdir()` can itself return
an 8.3-shortened ancestor segment (e.g. a long runner username folding to `RUNNER~1`), which IS an alias
`ancestorAwarePathIdentity` resolves away and `directPathIdentity`'s non-existent-path fallback does not;
this was never independently confirmed clean on such a host. **Round 4 reverted all three stamps** — see
"Round 4, MAJOR-2" below for what replaced them (the field-less fixtures are now the PINNED tests of the
LEGACY fail-closed default itself, not a stand-in for a modern raise).

Full `merge-quarantine*.mjs` corpus (79 files) re-run individually, BOTH env states, after all of the
above: 0 failures in both. `pnpm --filter @loom/daemon guards`: 30/30 green.

## Round 4 — Code Review `cb267228` (at commit `3475c2ed`): NOT-SHIP, two MAJORs, no CRITICAL

Both Round 3 CRITICALs stayed closed; the reviewer found NO wrong release anywhere — unions, persistence,
and forgeability all held.

### MAJOR-2 — the three `identityAtRaise` test-fixture stamps were themselves wrong

Round 3 stamped `identityAtRaise` onto three hand-written, field-less fixtures (`buildRuntimeUnionFixture`'s
`X` and the inline `S` in `4b06875f-post-union-filter-clear-sticks`, both in `merge-quarantine-runtime-
union-provenance.mjs`; `writePreFixLatch`'s `X` in `merge-quarantine-runtime-provenance-stamp.mjs`) on the
claim that this matches what a real raise would produce. It does not: **a CURRENT raise can never produce
these exact shapes field-less** — every real `enterMergeQuarantine` call stamps the field now (that is the
whole point of this card) — so a REAL upgraded owner who hits one of these exact shapes for real ALWAYS
carries the field, and the field-less version is PURELY a pre-upgrade artifact. Stamping it hid a genuine
behavior change for that owner: with the stamps in place, all four of these checks read green while
silently asserting the WRONG thing (a direct self-clear SUCCEEDING, when a genuinely LEGACY owner who
hits this exact shape for real would now be REFUSED):
- `merge-quarantine-runtime-union-provenance.mjs`: `redirect-targets-named-in-refusal-text-actually-clear`
  (CASE 2, active+degraded), `ambiguous-refusal-never-embeds-unconfirmed-kill-clear-route` (CASE B),
  `4b06875f-post-union-filter-clear-sticks`.
- `merge-quarantine-runtime-provenance-stamp.mjs`: `sibling-absorb-into-legacy-unknown-entry-stays-
  unknown-after-reboot`.

**The fix:** reverted all three stamps — these fixtures are now the PINNED tests of the new LEGACY
fail-closed default itself (field-less, by construction, forever — never a stand-in for a modern raise).
Each affected scenario now: (1) asserts the DIRECT self-clear REFUSES (`liftedRepoPaths.length === 0`,
never a `wasQuarantined` check alone — see "Do not" below for why); (2) drives the remediation route the
refusal text actually names (clear the genuine contributor first, then clear-by-path on the primary) to
an ACTUAL release, verified via `assertRepoNotQuarantined`, not assumed from a return shape. Driving this
for real surfaced a real, pre-existing mechanical split (never assume one generalizes to the other without
its own repro):
- For a RESOLVABLE contributor whose own canonical key already equals the union's key (the `(sequence-r-
  owns)` shape, and `4b06875f`'s own `r`), clearing the contributor ALONE fully releases the whole union
  in one step — `clearMergeQuarantineByKey`'s own unconditional per-key delete reaches it directly.
- For a genuinely UNRESOLVABLE LEGACY primary (never created on disk — `buildRuntimeUnionFixture`'s/
  `writePreFixLatch`'s `X`), clearing the contributor instead triggers the PRE-EXISTING degraded-occupant
  protection (cards `07e3ad30`/`e0192ffb`, unrelated to this card) and only DIVERTS the primary to a fresh
  pending record — it stays reported as quarantined. The SECOND step (clear-by-path on that fresh pending
  record) is what actually completes the release; this card's own guard structurally never reaches a
  pending-only match, so the primary's LEGACY status no longer blocks it there.

Also narrowed Finding 1's own "LEGACY entries... fail CLOSED" paragraph above: "the two-step sequence
still fully releases" is true only for the shapes this round actually drove — see that paragraph's own
inline correction, and MAJOR-1 immediately below for a shape where it does NOT hold.

### MAJOR-1 — named residual (routed to card `24ed371f`, NOT fixed here)

**The shape:** a LEGACY `S` dual-armed `[Ks, Kr]` (the SAME `4b06875f-post-union-filter-clear-sticks`
construction), plus a DEGRADED occupant `D` sitting at `hash(Kr)`, plus a `fs.readdirSync` ORDER during
boot that makes a later `/clear(r)` call RELOCATE `S`'s own record (rather than releasing it) because
`D`'s own stale secondary arm happens to resolve to `S`'s real key under that specific order. `S` then
keeps a STALE contributor reference (`[r]`, even though `r` was already cleared) and every human route —
direct clear, the two-step sequence, clear-by-id — refuses, since `contributorRepoPaths` never empties.

**Why this is accepted, not fixed here:** it fails CLOSED (no wrong release anywhere — the reviewer
confirmed this directly); it is NARROW (needs a contaminated pre-upgrade latch, a THIRD occupant sharing
the same physical key, AND one specific readdir order — not the general two-step shape this round already
verified); and its root cause is squarely card `24ed371f`'s own stated scope: a settled/reduced
contributor can outlive its own membership in the host union's `contributorRepoPaths`, which is exactly
what `24ed371f` exists to address generically. Building a narrower pruning mechanism just for this one
card's own shape would duplicate, and likely conflict with, whatever `24ed371f` ships.

**The manual escape, stated honestly (Round 5 correction — see "Do not" below for what the ORIGINAL
version of this paragraph got wrong):** no human-facing route (clear-by-id, clear-by-path, the two-step
sequence) releases `S` while it carries this stale `[r]` reference.

- **Identify the file by its latch ID, never by re-deriving a key.** `canonicalRepoLockKey(S)` is a LIVE
  filesystem walk — once `S` is deleted or unmounted, it resolves to the ENCLOSING repo's own key instead,
  so "find the file via `canonicalRepoLockKey(S)`'s own hash" would delete a wholly DIFFERENT, genuinely
  separate repo's own latch. Get the id instead — from `GET /internal/merge-quarantine/list`, or from the
  id a refusal's own text already names — and find the matching file by that id's own hash, under EITHER
  `MERGE_QUARANTINE_DIR/<hash>.json` (an active/boot-armed latch) OR `MERGE_QUARANTINE_DIR/pending-
  <hash>.json` (a pending-divert record) — check both; this residual's own shape can land in either.
- **Before deleting anything, read the file's own JSON and confirm two facts:** its `repoPath` field
  equals `S` (never delete a file belonging to some OTHER identity on the strength of a hash match alone),
  and every identity named in its `contributorRepoPaths` has ALREADY been cleared independently (never
  delete a file that still protects a genuinely outstanding contributor's own quarantine).
- Once both are confirmed, remove that one file and **restart the daemon** so boot re-arms cleanly from
  whatever else is still genuinely outstanding on disk. (A human cannot call
  `reenterMergeQuarantinesAtBoot` directly — that is an internal function, not an operator-facing action.)

This is a last-resort manual file edit, not a supported remediation route — treat it as such, and prefer
waiting for `24ed371f` over normalizing this escape. The SAME corrected recipe is also filed directly onto
card `24ed371f`'s own body, so whoever picks that card up starts from the right recipe rather than
re-deriving it.

### MINOR-1 — a verified brand-new raise diverted with no `identityAtRaise`

`enterMergeQuarantine`'s `verified` branch (merge-quarantine.ts, the `mustDivert` call to
`divertRaiseEntry({repoPath, …})`) built its diverted entry inline, omitting `identityAtRaise` — this is a
genuinely NEW, VERIFIED (`repoPath` currently resolves) raise that merely can't write to its own key right
now (a confirmed foreign, persistently-unreadable occupant); it is not legacy by any definition and must
not read as one.

**The fix:** stamp `identityAtRaise: ancestorAwarePathIdentity(repoPath)` at this call site too —
`divertRaiseEntry`'s own `{...base.entry}` spread carries it through lazy graduation unchanged, with no
further plumbing needed. New test `(verified-divert-not-legacy)` in the card's own test file: a
persistently-unreadable foreign occupant forces this exact divert (mirroring `merge-quarantine-raise-
protect-failure.mjs`'s own SHAPE 1 construction), asserts the diverted pending entry carries
`identityAtRaise`, then graduates it into an active entry (via a direct identity query) and asserts the
field survives graduation too.

**Boot-time PLACEHOLDERS stay unstamped, on purpose.** A `PLACEHOLDER_BRANCH_UNRESOLVED`/
`PLACEHOLDER_BRANCH_UNREADABLE`/`PLACEHOLDER_BRANCH_CORRUPT` entry (the three representative construction
sites in `reenterMergeQuarantinesAtBoot`, each now carrying an inline `@decision 3be11be4` comment of its
own — every OTHER `PLACEHOLDER_BRANCH_CORRUPT` site shares the first one's own note) is, by definition,
never a real raise — it is boot-time fail-closed bookkeeping for content the daemon could not verify.
Leaving `identityAtRaise` unset for these makes them read as LEGACY under this card's own guard, which is
the CORRECT, already-fail-closed posture every one of these placeholders already has for every other
purpose — never a gap to close.

### MINOR-2 — the refusal text claimed ownership knowledge Loom does not have

`refuseSelfClearStaleKeyContributors`'s own `reason` text unconditionally said "`'<repoPath>'`... does not
own this key itself" — true for the NESTED (non-legacy) shape this guard also catches, but FALSE for a
LEGACY entry: Loom never established raise-time identity for it, and in the CASE-1/2 shape this same
guard protects, the entry genuinely DOES own the key — Loom just can't prove it anymore. The Round 3
triage note's own suggestion that clear-by-id would be a working LEGACY route was itself wrong (clear-by-
id already fails closed as ambiguous for ANY non-empty `contributorRepoPaths`, legacy or not) and is
retracted here — it was never actually acted on in the Round 3 implementation.

**The fix:** `refuseSelfClearStaleKeyContributors` now branches its own ownership clause on
`entry.identityAtRaise === undefined` — a LEGACY entry says "was raised before Loom recorded a raise-time
identity for it, so Loom cannot tell whether it genuinely owns this key or not"; a non-legacy (nested)
entry keeps the original "does not own this key itself" wording unchanged. Pinned by new assertions in
both affected test files: the refusal text never contains the literal phrase "does not own this key" for
a LEGACY entry, and the two-step sequence clause is present instead.

### MINOR-3 + NIT — record corrections

- The Round 2 "Do not" bullet naming `directPathIdentity(entry.repoPath) === armedKey` as the correct,
  filesystem-free comparison is now marked SUPERSEDED **inline, in that bullet itself** (not only in a
  later section) — the on-Read guard-extract hook can truncate the narrative between an early "Do not"
  section and a later one on a large record, so a correction living only in a later section is not a safe
  substitute for fixing the stale bullet where it stands.
- "Ancestor/descendant" is removed everywhere it described `isNestedUnderKey`'s own behavior, here and in
  the predicate's own code comment — the check accepts exactly ONE direction (a genuine DESCENDANT of the
  key), never the reverse; say "descendant," never "ancestor/descendant."
- "The two-step sequence still fully releases a legacy-primaried union" is narrowed to the two shapes this
  round actually drove (resolvable-contributor-one-step; unresolvable-primary-two-step), with MAJOR-1's
  own shape named as the exception where no route releases it at all.
- The "no alias in the path" premise behind the (now-reverted) `identityAtRaise` test stamps is corrected
  in place — an 8.3-short-name ancestor segment (plausible on a Windows CI host, e.g. a long runner
  username folding to `RUNNER~1`) is itself an alias `ancestorAwarePathIdentity` resolves and
  `directPathIdentity`'s non-existent-path fallback does not; this was never independently verified clean
  on such a host, so the claim is corrected rather than merely dropped silently.

### Tests (Round 4)

New: `(verified-divert-not-legacy)` in the card's own test file (MINOR-1, above). Rewritten (field-less
fixtures restored, assertions now drive the two-step remediation to an actual release): `merge-quarantine-
runtime-union-provenance.mjs`'s CASE 2/CASE B/`4b06875f-post-union-filter-clear-sticks`; `merge-quarantine-
runtime-provenance-stamp.mjs`'s `sibling-absorb-into-legacy-unknown-entry-stays-unknown-after-reboot`.
`merge-quarantine-lazy-graduation-contributor-attribution-b5c94cbe.mjs` and `merge-quarantine-raise-
protect-failure.mjs` needed no change — confirmed (again) their own hand-written fixtures represent the
genuine stale-key-victim shape, where refusing is already correct under every round of this card.

Full `merge-quarantine*.mjs` corpus (79 files) re-run individually, BOTH env states, after all of the
above: 0 failures in both. `pnpm --filter @loom/daemon guards`: 30/30 green.

## Round 5 — Code Review `dc073b88` (at commit `e0db9d8e`): SHIP, one MUST (text/assertion only)

No CRITICAL or MAJOR, and no wrong release anywhere — the Round 4 MAJOR-2 fix held in every tier. One
MUST (MINOR-3) before merge: the record's own manual-escape recipe could destroy a DIFFERENT repo's
genuine quarantine if followed literally. Text and assertion fixes only — no production logic changed
except one string softened (MINOR-1 below); no new test scenarios.

### MINOR-3 (MUST) — the manual escape recipe was itself unsafe

The MAJOR-1 residual's own "manual escape" paragraph told a human to find the file to delete "via
`canonicalRepoLockKey(S)`'s own hash" — but that is a LIVE filesystem walk: once `S` is deleted or
unmounted (plausible, since this residual exists precisely because `S` is stuck quarantined), the SAME
call resolves to the ENCLOSING repo's own key instead, and the recipe as written would delete THAT
repo's genuine latch file instead of `S`'s. It also assumed the record always lives at `<hash>.json`
(never `pending-<hash>.json`), never told the human to VERIFY the file before deleting it, and told a
human to "call `reenterMergeQuarantinesAtBoot` again," which is an internal function, not something an
operator can invoke directly.

**The fix:** rewrote the recipe to (a) identify the file by its LATCH ID (from `GET /internal/merge-
quarantine/list`, or from the id a refusal's own text already names) rather than re-deriving any key; (b)
check both `<hash>.json` and `pending-<hash>.json`, since this residual's own shape can land in either;
(c) require reading the file's own JSON first and confirming its `repoPath` equals `S` AND every name in
its `contributorRepoPaths` has already been cleared independently, before deleting anything; (d) say
"restart the daemon," never "call `reenterMergeQuarantinesAtBoot` again." The same corrected recipe was
also filed directly onto card `24ed371f`'s own body (`appendBody`), so whoever picks that card up starts
from the safe recipe rather than this record's own first-draft one.

### MINOR-1 — a remediation-text parenthetical overclaimed

`remediationTextFor`'s own "no honest target" branch said clearing a contributor "fully releases the
whole entry when that contributor itself owns a real repo identity of its own" — false in the degraded-
LEGACY-primary-plus-real-contributor shape every one of Round 4's own rewritten scenarios actually drives
(clearing the real contributor there only DIVERTS the primary, per cards `07e3ad30`/`e0192ffb`; it never
releases in one step). **The fix:** softened to "may release everything... if the listed path is still
reported quarantined afterward, do the next step" — true for every shape this card has ever driven,
instead of a confident claim that was only ever true for ONE of them.

### MINOR-2 — the step-1 assertions this card's own Round 4 added were vacuous

Four new/rewritten step-1 checks (`runtime-provenance-stamp.mjs`'s `sibling-absorb-...`; `runtime-union-
provenance.mjs`'s CASE 2, CASE B, and `4b06875f-post-union-filter-clear-sticks`) asserted only `typeof
step1.wasQuarantined === "boolean"` — true on every call this function can ever return, proving nothing
about what step 1 actually did. Driving each site directly (never assumed from another site's own
construction, and — for `4b06875f`, below — never assumed from a SINGLE run either) found two, not one,
real behaviors:
- CASE 2, CASE B, and `sibling-absorb-...` (the three sites whose primary is genuinely unresolvable, with
  no third degraded occupant sharing the key): step 1 lifts NOTHING directly
  (`liftedRepoPaths.length === 0`) and reports the primary back in `stillBlockedCoOccupants`, every time.
- `4b06875f-post-union-filter-clear-sticks`: a FIRST pass fixed this site the same way as the other
  three, and it read GREEN once — but a SECOND, independently-hashed run of the identical repro showed
  step 1 fully releasing the primary in one step instead. This site's own construction shares a physical
  key with a THIRD, degraded occupant (`D`) via a stale `resolvedKey` collision — exactly card
  `24ed371f`'s own MAJOR-1 territory — so step 1's outcome here is genuinely ORDER-DEPENDENT (which of
  `D`'s/`S`'s own latch files a boot-time `fs.readdirSync` happens to process first), not a single fixed
  behavior. **The fix for this one site:** assert the real, bounded OUTCOME SET instead — step 1 either
  releases the primary directly or reports it as still-blocked, never anything else — and assert the
  final two-step state plainly, since it converges to the same released outcome either way.

**The fix for the other three:** replaced the vacuous check with the two assertions named above. A
pre-existing, correctly-non-vacuous step-1 check elsewhere — `(sequence-bare-subdir)`'s own "step 1 lifts
NOTHING... sSub is STILL blocked" pair, in the card's own test file — already asserted the real outcome
and needed no change; it is not one of these four sites, and (unlike `4b06875f`) is NOT order-dependent,
since its own contributor owns no key of its own to collide with anything.

### MINOR-4 — a third remediation shape, named for completeness

Round 4's own narrowing ("the two-step sequence... for the two shapes this round actually drove") missed
a THIRD shape that already existed in the card's own test file before Round 4: a LEGACY primary that
GENUINELY OWNS its own key (never degraded or unresolvable) plus a BARE-SUBDIR contributor with no `.git`
of its own — the `(sequence-bare-subdir)` shape, now simply with a LEGACY primary instead of a freshly-
raised one. There, step 1 (clearing the bare-subdir contributor) is a genuine NO-OP — it only reduces the
primary's own `contributorRepoPaths` membership, lifting nothing — and step 2 (clear-by-path the primary)
is what actually releases everything. This is DIFFERENT from both shapes Round 4 named: it is not the
one-step resolvable-contributor release, and it is not the divert-then-release unresolvable-primary
shape — it shares the unresolvable-primary shape's own "step 1 is a no-op" surface property for a
DIFFERENT underlying reason (the contributor owns no identity of its own at all, rather than the primary
being unresolvable). Named here for completeness; no new test needed — `(sequence-bare-subdir)` already
covers it and was never touched by Round 4's own LEGACY-fixture reverts (its own primary was never
stamped with `identityAtRaise` to begin with, since it was constructed via a real raise all along — see
that scenario's own code for the exact construction).

### NIT-1 — a garbled sentence

Finding 1's own second paragraph's closing sentence self-interrupted mid-thought ("a direct self-clear
succeeding where a real upgraded owner's file-less-from-day-one... no — where a genuinely LEGACY owner
would now be refused"). Rewritten to a single, complete sentence.

### NIT-2 — a weak OR in a test assertion

`4b06875f-post-union-filter-clear-sticks`'s own "the two-step sequence eventually unblocks s" check
accepted EITHER `assertRepoNotQuarantined(s).ok === true` OR `primaryClearS.liftedRepoPaths.length > 0` —
weaker than needed, since the VERY NEXT line already asserts the clean final state directly via
`assertRepoNotQuarantined`. This OR turned out to exist for a real reason — see MINOR-2's own correction
above: step 1's outcome here is genuinely order-dependent — but once that is pinned explicitly as its own
assertion, this particular check no longer needs a disjunction of its own: the final state converges to
"released" either way, so it is now asserted plainly via `assertRepoNotQuarantined` alone.

Full `merge-quarantine*.mjs` corpus not re-run in full for this round (text/assertion-only, no production
logic change except MINOR-1's one string) — the two touched test files plus the card's own test file were
run directly instead, per the Lead's own round-5 instruction (a `merge_batch` gate was live on this repo
at the time). `pnpm --filter @loom/daemon guards`: 30/30 green.

## Do not

- Do not implement the Lead's own literal condition ("repoPath IS entry.repoPath AND contributorRepoPaths
  non-empty") without ALSO requiring `repoPath` does NOT own its own key — the literal condition alone
  regresses `merge-quarantine-runtime-union-provenance.mjs`'s CASE 1/2 (a genuine repo identity that also
  happens to win a naming race). See "Round 1's own refinement" above.
- **⛔ SUPERSEDED BY ROUND 3/4 — DO NOT FOLLOW THIS BULLET'S OWN RECIPE.** It originally said: "Do not
  decide this guard's ownership question from a LIVE filesystem re-walk
  (`canonicalRepoLockKey(entry.repoPath)`)... Decide it from the key the entry is CURRENTLY ARMED at... via
  a pure string comparison (`directPathIdentity(entry.repoPath) === armedKey`)." That recipe is ITSELF a
  live filesystem re-walk one level up (`directPathIdentity` is computed LIVE, at clear time) and was the
  exact Round 3 CR2 CRITICAL-1 bypass (a real win32 alias changed after raise). The CURRENT, correct rule:
  compare the FROZEN `identityAtRaise` field (stamped ONCE, at raise time) against EVERY key in
  `liveArmedKeysOf(entry)`, never `armedKey` alone and never any value computed at clear time — see Round
  3/4's own sections above (and the "Do not (Round 3 additions)" section below) for the full detail.
- Do not use a bare `identity !== armedKey` inequality as the refusal condition — it also fires for a
  DEGRADED entry that merely COLLIDES with an unrelated sibling's key (`82032b5c`'s own shape, which
  deliberately releases everything). Narrow it to `isNestedUnderKey` — a genuine DESCENDANT relationship,
  never "ancestor/descendant" (the check accepts exactly one direction) — first.
- Do not compute `selfClearRefusesForStaleKeyContributors` without the active-map-membership check — a
  resolvable-but-PENDING match (abccee85 round 7's own shape) must never be reported as "this own-path
  route now refuses," since this card's guard structurally never reaches a pending-only match at all.
- Do not read `clearMergeQuarantineReporting`'s own return type as carrying `refusedBeforeClear` — it
  never has one (the SAME rule 3b1944b6's own Round 3 "Do not" already states for `stillQuarantined`);
  the refusal rides in `reason`/`liftedRepoPaths` alone through that wrapper.
- Do not treat `merge-quarantine-lazy-graduation-contributor-attribution-b5c94cbe.mjs`'s SCENARIO 3b, or
  `merge-quarantine-raise-protect-failure.mjs`'s `item1`/`n4`/`probeA`, as pure wording updates — the
  former's own BEHAVIORAL assertion changed because the underlying action changed; the latter three
  needed their own CALL SITE changed (to `clearMergeQuarantineByKey`) to keep testing what they test at
  all, never just a flipped assertion.
- Do not assume every pre-existing test using the `gone-subdir` fixture-naming convention is affected by
  this card — confirmed, via an exhaustive runtime trace (not manual per-call-site reasoning), that only
  five of the ~40 occurrences across the corpus ever invoke this card's own predicate with a contributor
  present, and only three of those call a public clear route on the non-owning identity's own name.
- Do not claim "clear via the contributor's own project-resolved `/clear`" is a GUARANTEED route for every
  shape `remediationTextFor` can be invoked on — it is verified only for a contributor with no OTHER
  record of its own anywhere (this card's own repro/tests); see "Known residual" above.
- Do not implement PROMOTE on this card — it is explicitly out of scope per the Lead's ruling; file a new
  card if it is ever wanted, and re-derive the atomicity/tie-break questions from scratch rather than
  reusing this card's own REFUSE-only design as a starting point.

## Do not (Round 3 additions)

- **Read the "Do not" bullet above naming `directPathIdentity(entry.repoPath) === armedKey` as
  SUPERSEDED, not current** — comparing a value computed LIVE at clear time (even via an alias-resolving
  primitive) against a key stored at raise time is STILL "decided from a live fs re-walk" one level up;
  see Round 3, Finding 1. The current, correct comparison is the FROZEN `identityAtRaise` field (stamped
  once, at raise time) against the entry's live-armed keys — never a value recomputed at clear time, by
  any function, ever.
- Do not decide ownership from ONE representative/matched key — evaluate the predicate over EVERY key in
  `liveArmedKeysOf(entry)` (Round 3, Finding 2). A dual-armed entry can own one of its live keys while
  still being nested under another; one key proves nothing about the others.
- Do not give `selfClearRefusesForStaleKeyContributors` an `armedKey`/`key` parameter again, at any call
  site — the function derives its own complete key set internally now; a parameter reopens exactly the
  one-representative-key bug Finding 2 closed.
- **⛔ SUPERSEDED BY ROUND 4, MAJOR-2 — do not follow this bullet.** It originally said a hand-written
  fixture simulating a shape a real raise "would produce" should be stamped with `identityAtRaise` to
  match. That premise is backwards: a CURRENT raise can NEVER produce the exact field-less shapes these
  three fixtures hand-write (every real raise stamps the field now), so stamping them hid a genuine
  behavior change for a real upgraded owner hitting the same shape for real. The correct rule: a
  hand-written fixture that bypasses `enterMergeQuarantine` is field-less BY CONSTRUCTION and stays that
  way — it is the PINNED test of the LEGACY fail-closed default itself, never a stand-in for a modern
  raise, no matter how closely its shape otherwise resembles one. See Round 4, MAJOR-2.
- Do not claim `identityAtRaise` itself is filesystem-free — only the CLEAR-TIME comparison is. The field
  is computed once, at raise time, via `ancestorAwarePathIdentity`, which does call `fs.realpathSync.native`
  (through `findExistingAncestorRealpath`). See the Round 3 MINOR correction above.
- Do not write "ancestor/descendant relationship" anywhere in a future revision of this record or its
  code comments — `isNestedUnderKey` accepts exactly one direction (descendant under the key); say
  "descendant," never "ancestor/descendant."

## Do not (Round 4 additions)

- Do not stamp `identityAtRaise` onto a hand-written test fixture just because its SHAPE resembles one a
  real raise could produce — check whether a CURRENT raise can produce that exact field-less state at
  all first. For all three fixtures this round touched, it cannot (every real raise stamps the field now),
  so the field-less fixture is the only honest simulation of genuinely pre-upgrade data; stamping it hides
  a real behavior change from whoever reads the test as a spec. See Round 4, MAJOR-2.
- Do not assert `wasQuarantined === true` (or `=== false`) as proof a clear succeeded or refused, on
  `clearMergeQuarantine`/`clearMergeQuarantineByRecordedPath`/`clearMergeQuarantineByKey`'s own return
  shape — on EVERY one of these, `wasQuarantined` means "there was something to act on," true for a
  refusal exactly as much as a success. Assert `liftedRepoPaths.length` (empty = nothing lifted) and/or
  a follow-up `assertRepoNotQuarantined` call instead. (`clearMergeQuarantineReporting`'s OWN
  `wasQuarantined` is a THIRD, different meaning again — "was quarantined before this call" — see that
  function's own doc; never assume any two of these three functions share one `wasQuarantined` semantic.)
- Do not assume clearing a genuine contributor always fully releases its host union in one step — it does
  for a RESOLVABLE contributor whose own key equals the union's key directly, but for a genuinely
  UNRESOLVABLE primary it only DIVERTS the primary to a fresh pending record (the pre-existing degraded-
  occupant protection, cards `07e3ad30`/`e0192ffb`, firing independently of this card). Drive and observe
  the REAL second step before asserting a remediation route "works end-to-end" — see Round 4, MAJOR-2's
  own two verified sub-shapes.
- Do not build a pruning mechanism for MAJOR-1's own residual (a settled contributor outliving its own
  membership under a specific readdir order) as part of this card — it is explicitly routed to card
  `24ed371f`, whose own stated scope already covers the general version of this defect. A narrower fix
  here would duplicate, and risk conflicting with, whatever that card ships.
- Do not leave a boot-time PLACEHOLDER (`PLACEHOLDER_BRANCH_UNRESOLVED`/`_UNREADABLE`/`_CORRUPT`) carrying
  `identityAtRaise` — it is never a real raise, and reading it as LEGACY (fail-closed) under this card's
  guard is the correct, already-established posture every such placeholder already has elsewhere.
- Do not claim a refusal "does not own this key" for an entry whose `identityAtRaise` is `undefined` —
  Loom never established that for a LEGACY entry (it may well own the key, as in CASE 1/2); say Loom
  cannot tell, per `refuseSelfClearStaleKeyContributors`'s own branch. See Round 4, MINOR-2.

## Do not (Round 5 additions)

- Do not tell a human to find a quarantine latch file by re-deriving `canonicalRepoLockKey(<repoPath>)`
  (or any other live recompute) — identify it by its latch ID instead (from a listing route, or from a
  refusal's own text), and read the file's own JSON to confirm its `repoPath` before deleting anything.
  A live key recompute for a deleted/unmounted path resolves to an ENCLOSING repo's own key, so this
  recipe can delete a wholly different, genuinely separate repo's own latch. See Round 5, MINOR-3.
- Do not tell a human to call an internal function (`reenterMergeQuarantinesAtBoot`) directly as part of
  a manual-recovery recipe — an operator restarts the daemon; there is no other human-facing lever.
- Do not assert only `typeof result.wasQuarantined === "boolean"` (or any shape-blind check) as proof a
  clear step did something specific — it is true on every call this module's clear functions can return,
  success or refusal alike. Assert `liftedRepoPaths.length` and/or `stillBlockedCoOccupants` instead; see
  Round 5, MINOR-2 for the real per-shape signal four such checks were missing.
- Do not claim a remediation route "fully releases" a union from a SINGLE verified shape and generalize
  it to every shape `remediationTextFor`'s own text can describe — the degraded-LEGACY-primary shape and
  the resolvable-contributor shape behave differently (divert-then-release vs. release-in-one-step); word
  production text to cover both, per Round 5, MINOR-1, rather than asserting the stronger claim that only
  held for the one shape originally driven.
- Do not assume a single test run pins a FIXED outcome for `4b06875f-post-union-filter-clear-sticks`'s own
  step 1 — its construction shares a physical key with a third, degraded occupant via a stale
  `resolvedKey` collision, exactly card `24ed371f`'s own MAJOR-1 territory, so its outcome is genuinely
  ORDER-DEPENDENT (confirmed by running the identical repro twice and observing both outcomes in this
  very round). Assert the bounded outcome SET, never one specific result, for this one site.
