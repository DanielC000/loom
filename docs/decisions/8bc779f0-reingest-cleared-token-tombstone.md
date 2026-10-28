# 8bc779f0 — apply the clearedTokens tombstone filter in both reingest arms

From `4e987303`'s own Code Review (session `d74446b3`) — a question, pre-existing, not a regression.
Folded in by the manager's own ruling (same session, same round): a second site with the IDENTICAL
defect, `reconcileClearedEntryIfPlaceholder`, was found and fixed as part of this card rather than left
for a separate one — see "Round 2" below.

## The bug

`reconcileMarkedBasenameBeforeWrite`'s REINGEST branch (fires when `entry` is card `702b4241`'s own
UNREADABLE placeholder and the marked basename's disk content is genuinely readable, non-placeholder
JSON) built `reingested = latchEntryFromParsedRecord(parsed)` and unioned `reingested.tokens` directly.
`latchEntryFromParsedRecord` reads `parsed.tokens` RAW — it has no `clearedTokens` tombstone filter at
all; that filter lives only in `readSurvivingOnDiskTokens` (`.surviving`), which the GENERIC (non-reingest)
branch a few lines below already calls via its own `resurrectable`. So a token this process had already
tombstoned into the module-global `clearedTokens` set (via a prior, successful, unmarked clear), but which
still sits in the SAME marked basename's stale on-disk bytes, rode straight back into memory — and into
the next durable write — the next time any write reached that basename's reingest branch.

## The fix

Added `const { surviving: reingestedSurvivingTokens } = readSurvivingOnDiskTokens(parsed);` right after
`reingested` is built, reusing the SAME shared helper the generic branch already trusts (never a
re-derivation), and changed the token union to use `reingestedSurvivingTokens` in place of the raw
`reingested.tokens`. The pre-existing `dropped.tokens` filter (this call's own explicit `DroppedSets`
subtraction) still runs after, unchanged.

## Round 2 (manager ruling) — `reconcileClearedEntryIfPlaceholder` had the identical defect, folded in

`reconcileClearedEntryIfPlaceholder` (the HUMAN-CLEAR twin of the branch above — same
`isUnreadablePlaceholderEntry` gate, called ONLY from the three identity-wide human-clear routes) has the
exact same shape: `reingested = latchEntryFromParsedRecord(parsed)`, then
`tokens: [...new Set([...entry.tokens.filter(...), ...reingested.tokens])]` — raw, unfiltered. Fixed
identically: `const { surviving: reingestedSurvivingTokens } = readSurvivingOnDiskTokens(parsed);` added
right after `reingested`, and the union now uses `reingestedSurvivingTokens` in place of
`reingested.tokens`. Same reasoning, same helper, no re-derivation.

## Why filtering by `clearedTokens` can never drop a genuinely outstanding token — NARROWED (round 3)

**This claim held only for the SAME-IDENTITY case, and was FALSE as an unqualified claim** — a Code
Review reproduced the counter-example (see "Round 3" below): token uniqueness (no two raises, for any
identity, ever share a token value) stops two raises sharing a value, but it does NOT stop ONE raise's
token sitting in TWO identities' own *records* at once (the pre-existing cross-identity bleed class,
`398f476c`/`f575cebf`) — identity Y's own record can wrongly list identity X's token too. Clearing Y then
tombstoned X's own, genuinely-still-outstanding token, and a later reconcile of X's OWN (unbled) record
wrongly excluded it. The TRUE, narrower claim: filtering a record's own tokens by `clearedTokens` can
never drop a genuinely outstanding token **when the filter is scoped to the SAME identity that record
declares itself as** — which is exactly what round 3's redesign below makes structurally true, by
construction, rather than by a token-uniqueness argument alone.

## What `clearedTokens` means, and when it's populated (investigate-first checkpoint)

`clearedTokens` (module-global `Set<string>`, in-memory only, reset on reboot) is populated EXCLUSIVELY by
`tombstoneIfNotSurviving` — every clear call site calls it, never `.add()` directly. A token is tombstoned
only when, AT THAT MOMENT: (a) no surviving active OR pending record (scanned fresh across both
structures) still holds it, AND (b) none of the caller's own `touchedFinalBasenames` (the physical finals
THIS clear's write path touched/kept) is currently marked `keptUnreadableLatchFiles`.

For a record genuinely UNREADABLE at clear time, (b) is scoped to the specific finals the clearing call's
OWN write path touches — never every physical file anywhere that might hold the token. See "A separate
finding" below for the two call sites that pass no `touchedFinalBasenames` at all.

## A CLASS, not a site — every raw-parsed-token read in this module (checkpoint item, manager-requested)

Every site in `merge-quarantine.ts` that reads a parsed latch record's own tokens, classified:

| site | verdict | why |
|---|---|---|
| `readSurvivingOnDiskTokens` itself | shared helper | exposes BOTH `raw` (full on-disk set) and `surviving` (raw minus `clearedTokens`) — each downstream caller picks the one its own purpose needs |
| `reconcileMarkedBasenameBeforeWrite`'s GENERIC branch (`resurrectable`) | already filtered | uses `.surviving` — the reference shape this card's fix now mirrors in the reingest branch |
| `reconcileMarkedBasenameBeforeWrite`'s REINGEST branch | **filtered by this fix** | see above |
| `anotherLiveEntryOwnsFile`-shaped helper (`readSurvivingOnDiskTokens(parsed).surviving.includes(token)`) and its sibling boolean "any token overlap" checks | already filtered | `.surviving`, used only for a boolean decision, never for building a persisted/adopted entry |
| `unincorporatedOccupantRepoPathAt` (`existingTokens` via `.raw`) | deliberately raw | a coverage/ownership check ("already incorporated"), never builds a persisted entry from this value; needs `.raw` for its own legacy-single-`token`-field fallback, not for resurrection |
| `markedFinalFullyCoveredByClear` (`onDiskTokens` via `.raw`) | deliberately raw, with its own inline filter | `onDiskTokens.every(t => candidateTokens.includes(t) \|\| clearedTokens.has(t))` — a coverage PROOF that must positively account for every raw on-disk token; `.surviving` alone would silently fold "already cleared" into the array instead of deciding it here (its own doc comment states this explicitly) |
| `protectOccupantContentBeforeDelete` (`rawTokens`/`survivingTokens`) | already filtered where it matters | `rawTokens` only gates an early "every real token already cleared, skip the copy-aside" return; the tokens actually PERSISTED use `survivingTokens` (filtered) |
| `resolveRaiseOverwrite`'s two token reads (`.surviving` and `.raw`) | already filtered / deliberately raw | both used only for boolean "already incorporated / still held elsewhere" decisions, never to build a persisted entry |
| `orphanFileTokensAccountedForByUpdate` (`onDiskTokens` via `.raw`) | deliberately raw, with its own inline filter | `onDiskTokens.every(t => accountedFor.has(t) \|\| clearedTokens.has(t))` — same coverage-proof shape as `markedFinalFullyCoveredByClear` |
| `orphanSweepSafeToDelete` (`onDiskTokens` via `.raw`) | deliberately raw, with its own inline filter | same coverage-proof shape |
| identity-wide-clear reporting's `ownTokensByFile` builder | already filtered | `.surviving` — gated to the SAME identity as the clearer by its own surrounding `if`, before this call ever runs |
| `readPendingDivertFileAt` (~:3408) | already filtered | `.surviving` — reads a pending-divert record's own tokens; `writePendingDivertFile`'s own re-read branch (~:2642) consumes this, already filtered BEFORE `unionIntoOnDiskPendingEntry` ever runs (contradicts project memory note `2dd97aaa`'s stale "writePendingDivertFile's union ignores clearedTokens" claim — flagged to the Lead, not corrected here) |
| `reenterMergeQuarantinesAtBootImpl`'s THREE inline raw-token reads (PASS 1's main loop, PASS 1b's tmp-residue loop, the safety-tmp recovery loop — each duplicates `latchEntryFromParsedRecord`'s own `Array.isArray(parsed.tokens)...` shape inline rather than calling it) | deliberately raw | `reenterMergeQuarantinesAtBoot` has exactly one production caller (`index.ts`'s boot sequence), called once per process before any clear can ever run — `clearedTokens` is STRUCTURALLY GUARANTEED EMPTY at every one of these three reads, so filtering would be a no-op by construction, not a gap |
| **`reconcileClearedEntryIfPlaceholder`** (`latchEntryFromParsedRecord` → raw `reingested.tokens` union) | **fixed by this card (Round 2)** | the human-clear twin of the branch this card fixes (same `isUnreadablePlaceholderEntry` gate, called from the three identity-wide human-clear routes). Reported first, then folded in by the manager's own ruling — same class, same file, same fix. Test scenario 2 drives it through `clearMergeQuarantineLatchFile` (clear-by-id), one of the three routes |

## A separate finding, accepted as a note (manager ruling — no card)

`clearTokenFromPendingIndices`'s reduce (partial-clear) branch (`tombstoneIfNotSurviving([token])`, line
~4225) and `clearActiveEntryTokenAtKey`'s partial-clear branch (same call, line ~4348) both tombstone
`token` with an EMPTY `touchedFinalBasenames`, called BEFORE their own write loop runs. Condition (b) can
therefore never block either call, regardless of whether the entry's own armed key(s) are currently marked
`keptUnreadableLatchFiles` and still physically carry `token` in their stale, unrewritten bytes.

Can this tombstone `token` while a marked/unread physical copy of it still exists? **Yes, confirmed by
reading.** Is this an over-filter or an under-filter? **Neither, by analysis** — not a new exposure.
Tokens are process-unique random UUIDs (the same invariant this card's own fix relies on), so `token`
can never collide with a different, still-legitimately-outstanding raiser's own value; tombstoning it here
reflects the CALLER's own already-applied in-memory removal (condition (a) correctly finds nothing
surviving), not a guess. The only cost is the pre-existing, ALREADY-documented residual this module
accepts elsewhere — **`63e49ee2`'s own "kept until a reboot or a later successful read" residual**: if
the subsequent write to that key's own final genuinely fails because the final is still unreadable, the
stale durable bytes are left un-rewritten until a later successful read or reboot — exactly the shape
this card's own fix now handles correctly (a later reconcile reading those stale bytes will, post-fix,
correctly exclude `token` via `clearedTokens` rather than resurrecting it). Accepted as a note, no card.

## Round 3 (Code Review, SHOULD-FIX, SHIP WITH FOLLOW-UP) — cross-identity bleed, reproduced (fixture B)

**S1, reproduced by the reviewer:** the class-table and "can never drop" claim above were WRONG — see
the narrowed claim above this section. Fixture: Y's in-memory/disk record wrongly lists X's own token
(`398f476c`/`f575cebf`'s pre-existing bleed class); X is an UNREADABLE placeholder holding only its own
synthetic token. A human clear of Y tombstones X's token too (Y's own `candidateTokens` include it,
unscoped); X's next raise/reconcile then filters X's OWN real token out via the SAME global
`clearedTokens` check this card had just added, and X wrongly lifts — a fail-OPEN this card's own fix
(pre-round-3) introduced at both reingest arms, on top of an exposure the GENERIC branch already had.

### The fix — `clearedTokens` identity-scoped at its source

`clearedTokens`: `Set<string>` → `Map<string, Set<string>>` (token → the `directPathIdentity`-normalized
identities whose own clear tombstoned it). `tombstoneIfNotSurviving(tokens, clearingIdentity,
touchedFinalBasenames?)` — `clearingIdentity` REQUIRED, no default, normalized via `directPathIdentity`
INSIDE the function (the one normalization point every caller relies on — pass a raw `repoPath` or an
already-normalized string, both collapse to the same key). `readSurvivingOnDiskTokens(parsed,
recordIdentity)` — `recordIdentity` REQUIRED (nullable), same one normalization point; a token is
subtracted from `.surviving` only when tombstoned under THIS SAME identity. A new shared helper,
`tokenTombstonedForIdentity(token, recordIdentity)`, gives the three inline `clearedTokens.has(t)`
checks (`markedFinalFullyCoveredByClear`/`orphanFileTokensAccountedForByUpdate`/`orphanSweepSafeToDelete`)
the identical identity-scoped check without re-deriving it by hand. `undefined` (repoPath not yet a
validated string) fails CLOSED at every one of these: nothing subtracted/tombstoned-for, every on-disk
token survives.

Every one of the ~12 `readSurvivingOnDiskTokens`/inline-check call sites in the class table above now
passes its own record's `parsed.repoPath` (or, where already extracted, its own `parsedRepoPath`/
`recordIdentity` local). Every one of the 7 `tombstoneIfNotSurviving` call sites now passes its own
clearing identity — 6 of 7 already had exactly one identity in local scope (confirmed by reading, not
assumed): `clearTokenFromPendingIndices`'s two branches (`identity`), `clearActiveEntryTokenAtKey`'s two
branches (`entry.repoPath`), `clearMergeQuarantineByKey` (`identity`), `tryClearMergeQuarantineByOwnIdentity`
(`identity`). The 7th — `clearMergeQuarantineLatchFile`'s own pending branch (~:7366) — is the ONE
genuinely plural site: `matchedPending` can span SEVERAL distinct identities sharing one bare latch id
(882d6cff's own multi-claimant shape). Fixed by bucketing `matchedPending` by `directPathIdentity` and
calling `tombstoneIfNotSurviving` once PER BUCKET, each under its own identity — never one flat call
under a single, arbitrarily-chosen identity.

### Investigate-first checkpoint answers (a)-(f), as reported and approved before any edit

(a) Every `tombstoneIfNotSurviving` caller and its identity: 4 token-scoped sites (safe by construction —
a token was minted FOR the caller's own repoPath), 2 identity-wide-but-single-identity sites
(`clearMergeQuarantineByKey`, `tryClearMergeQuarantineByOwnIdentity` — every contributing token, traced to
its source, is already filtered to one identity before reaching `candidateTokens`/`pendingCandidateTokens`),
and 1 genuinely plural site (`clearMergeQuarantineLatchFile`'s pending branch).
(b) Every reader: one shared helper (`readSurvivingOnDiskTokens`, ~10 callers) plus 3 inline checks —
exhaustive via `grep clearedTokens\.` (one writer, four readers total).
(c) Both reconcile functions already gate on `directPathIdentity(parsed.repoPath) ===
directPathIdentity(entry.repoPath)` before either branch runs — that guard was never the gap; the gap was
`clearedTokens` itself carrying no attribution.
(d) Unknown identity ⇒ token survives (fails closed) — see the per-reader polarity table below; no
migration concern (`clearedTokens` is in-memory-only, reset every reboot).
(e) Q1 (fixture A) preserved — verified by test (Scenario 3 below), green both before and after.
(f) The plan above; test list below.

### Per-reader polarity table (manager-requested) — every row fails CLOSED

| reader | what "survives" (not filtered) makes it DO | polarity |
|---|---|---|
| `reconcileMarkedBasenameBeforeWrite` (both branches), `reconcileClearedEntryIfPlaceholder`, `readPendingDivertFileAt` | token stays in the adopted/reconstructed entry's own tokens | KEEP enforcing (fail closed) — confirmed by test (Scenarios 1/2/4/5/6) |
| `differentUnresolvableOccupantRepoPathAt`, `resolveRaiseOverwrite`'s first call | counts as "still held elsewhere" | PROTECT / DIVERT rather than overwrite blind (fail closed) |
| `unincorporatedOccupantRepoPathAt`, `resolveRaiseOverwrite`'s second call | N/A — these read `.raw`, never `.surviving`; the identity param has no behavioral effect on either call | inert (not a decision point) |
| `protectOccupantContentBeforeDelete` | skips the "every real token already cleared, nothing to protect" early-return | PROTECT (makes a durable copy-aside) (fail closed) |
| `markedFinalFullyCoveredByClear` | `provenCoverage` becomes `false` → the unconditional-unlink branch's own guard trips → the file is never reached by the unlink at all | KEEP the file (fail closed) |
| `orphanFileTokensAccountedForByUpdate` | returns `false` ("not accounted for") | the orphan file's own reference set is left UNNARROWED this round (fail closed, never itself a delete) |
| **`orphanSweepSafeToDelete`** | `safe` becomes `false` | KEEP the file (fail closed) — **confirmed RED-then-GREEN by test (Scenario 7)**, named by the manager as a priority row |
| `ownTokensByFile` builder | already identity-gated by its OWN surrounding `if` (same identity as the clearer) before this call ever runs | inert for cross-identity purposes; correct either way for this already-narrowed case |
| `readFinalOnDiskSurvivingTokens` | feeds `survivingTokenHolderRepoPaths`'s `contentClaimants` set inside `deleteMergeQuarantineLatchByKey` — a surviving token here means another identity's own entry can be found still holding it | KEEP the file / PROTECT (same fail-closed direction as the table's general convention) — **added, NIT4 (card 0d3b64c6)** |
| **`confirmedDurableBackingElsewhere`** | **INVERSE polarity, by design.** A surviving token at ANOTHER of the SAME entry's own live-armed keys makes this return `true`, which `survivingTokenHolderRepoPaths`'s own `excludeFinalPath` branch then uses to EXCLUDE that entry from `contentClaimants` — i.e. "survives" here means LESS protection at THIS specific location, not more | Reasoned safe, not a contradiction of the convention above: the token is independently, durably confirmed to already be backed at the entry's OWN other key, so excluding it from blocking `final` here never loses it — it is enforced at the OTHER key instead. **Added, NIT4 (card 0d3b64c6)** |

No row leads to a delete or a lift when a token survives — every discriminating row keeps/protects more,
never less, matching this module's own "absence favors enforcement" convention throughout, **with the one
documented exception (`confirmedDurableBackingElsewhere`) directly above, which trades a LOCATION for a
CONFIRMED-ELSEWHERE guarantee rather than trading safety for anything.**

**NIT4 (card 0d3b64c6) — `ownTokensByFile`'s own lean:** the identity-gating `if` ahead of this builder
makes it inert for CROSS-identity purposes (as stated above), but on its own, UN-gated terms it would
LEAN OPEN (same shape as the general "survives ⇒ keep" rows: an un-filtered token would be reported as
one of the clearer's own, rather than withheld) — net-neutral only because the surrounding `if` already
narrows every input to the SAME identity as the clearer before this builder ever runs, so there is no
cross-identity token for the lean to act on in practice.

### N1 — stale check count (fixed above)

The Tests section below originally claimed 20 checks for the round-1/2 test file; the file has 18 (11 +
7). Fixed in place.

### N2 — `readPendingDivertFileAt` added to the class table; a stale project-memory note flagged, not corrected

Added above. Separately: project memory note `2dd97aaa`'s "writePendingDivertFile's union ignores
clearedTokens" claim is STALE (`writePendingDivertFile`'s own re-read branch, ~:2642, calls
`readPendingDivertFileAt`, whose `.surviving` is already clearedTokens-filtered, before
`unionIntoOnDiskPendingEntry` ever runs) — flagged to the Lead per instruction; this worker did not edit
project memory.

### N3 — test-header accuracy

`reenterMergeQuarantinesAtBootImpl` spans exactly `:7591-9287` (confirmed by direct grep) — the ONLY
production site that ever mints a `PLACEHOLDER_BRANCH_UNREADABLE` entry. Within one process (no reboot —
`clearedTokens` is in-memory only), the realistic route to "a cleared token still sits in a readable
record" is therefore a SIBLING record's own clear (the bleed class), never this record's own staleness —
every test scenario in this card ENGINEERS the placeholder/marked end-state directly via test-only hooks,
but exercises the real, unmodified production code path for everything after that point. Stated plainly
in the round-3 test file's own header.

### Tests (round 3)

`merge-quarantine-8bc779f0-round3-identity-scoped-tombstone.mjs` — 5 scenarios:

- **Scenario 3 (Q1, fixture A ported)** — a genuine durable-write FAILURE (`fs.openSync` → `ENOSPC`)
  during a partial clear still tombstones correctly (same identity throughout); the repo still fully
  lifts once every genuinely-outstanding owner clears. Green before AND after round 3 (regression pin,
  not a round-3 discriminator — round 3 never changes same-identity behavior).
- **Scenario 4 (S1, fixture B ported)** — Y's own bled record tombstones X's genuine token; X's own
  reconcile must not lose it, and X must stay quarantined until ITS OWN owner clears it. **RED on
  pre-round-3 code** (`xTok` vanishes from X's own reconciled tokens), **GREEN after.**
- **Scenario 5 (condition 1, normalization)** — the clearing identity (`y`, raised normally) and the
  record's own declared `repoPath` (forced to `y.toUpperCase().replace(/\\/g, "/")` in the stale disk
  snapshot) differ only in case and separator direction. Green both before and after (the bare pre-fix
  `Set<string>` never cared about identity at all) — proves `directPathIdentity` collapses them to the
  SAME key post-fix, so normalizing does not swap the fail-open for a forever-stuck.
- **Scenario 6 (the one plural-identity site, ~:7366)** — two unrelated identities' pending entries
  sharing one physical latch file (`pushPendingQuarantineTestOnly` with the same `sourceFile`, different
  `repoPath`/tokens), cleared together via one `clearMergeQuarantineLatchFile(id)` call. Each identity's
  own, separate, later record correctly keeps its OWN token tombstoned. Green both before and after (no
  bleed constructed between the two in this scenario — a positive confirmation the per-identity bucketing
  doesn't regress a legitimate multi-claimant clear, not an isolated exploit repro at this exact site).
- **Scenario 7 (condition 3, cross-identity coverage reader)** — `orphanSweepSafeToDelete`, reached
  through the REAL `clearMergeQuarantineByKey` → `sweepOrphanLatchFileIfUnreferenced` orphan-file sweep
  every identity-wide clear runs: Z's own record is bled with X's genuine token; X's OWN content sits at
  an arbitrary (non-canonical-key) filename referenced only via Y's own `orphanLatchFiles`; clearing Y
  must not let X's real file be judged "safe to delete." **RED on pre-round-3 code** (the file was
  deleted), **GREEN after.**

RED/GREEN proven via a captured patch (`git diff` → `git checkout HEAD --` → rebuild → run → `git apply`
→ rebuild → run), covering all 5 scenarios in one pass: pre-fix, exactly 2 checks FAIL — Scenario 4's
own `xTok`-survives assertion and Scenario 7's own file-survives assertion — isolating the two genuine
discriminators; Scenarios 3/5/6 stay green in BOTH states (regression pins / design confirmations, not
discriminators). Post-fix, all checks PASS; tree confirmed byte-identical after restoring. The pre-existing
round-1/2 test file (`merge-quarantine-8bc779f0-reingest-cleared-token-tombstone.mjs`) was re-run
unchanged and stays green, confirming no regression from the identity-scoping signature changes.

### Full-corpus regression found and fixed — `merge-quarantine-raise-protect-failure.mjs`

The mandatory full-corpus run (86 pre-existing files + this card's own 2) found ONE real regression:
three pre-existing scenarios (`7a7e041b-mixed`, `25f6a7dc-tombstoned`, `25f6a7dc-probeA`) each minted a
token via a deliberately UNRELATED "scratch" repo, fully cleared it there, then reused that exact string
inside a DIFFERENT identity's own fixture content — relying on the PRE-round-3, global `clearedTokens`
Set to recognize it as dead regardless of which identity's record it showed up in. That is exactly the
assumption S1 (the CR's own fixture B) proved unsafe — fixed by minting and clearing each scenario's own
"already-dead" token under the SAME identity the later fixture content declares (`d`/`z8`/`dA`
respectively), via a `pushPendingQuarantineTestOnly` pending-entry push rather than a real raise (so it
cannot collide with each scenario's own, separately-constructed canonical-key arming). 10 of 10 failures
in that one file resolved; the full 87-file corpus (both this card's own files plus every pre-existing
one) is green. No OTHER file in the corpus used this exact cross-identity "scratch mint, reuse elsewhere"
pattern (confirmed by `grep -l scratch` across the corpus, then re-running the full suite to verify no
other file's own assertions depended on it).

## Accepted residual — `clearedTokens` is in-memory only (parity with the generic branch, already true before this card)

`clearedTokens` resets on every reboot. After a restart, a still-unreadable marked file's own stale bytes
(carrying a token this process once tombstoned, in a PRIOR process lifetime) are no longer filtered by
either branch of `reconcileMarkedBasenameBeforeWrite` — the fresh process never cleared anything, so it
has nothing to tombstone against. This is NOT a new gap introduced or left open by this card: the GENERIC
branch has carried this exact same residual since `8db913e2`/`2dd97aaa` first added the `clearedTokens`
filter there, and this card's fix only brings the reingest branch to PARITY with that pre-existing,
accepted shape — never closes it further. A genuinely durable clear (one whose own write to every armed
key actually succeeded) is unaffected: the durable bytes themselves no longer carry the token, so there is
nothing for a later boot to resurrect.

## Tests

`merge-quarantine-8bc779f0-reingest-cleared-token-tombstone.mjs` — two scenarios.

SCENARIO 1 (`reconcileMarkedBasenameBeforeWrite`, the write-side chokepoint): single identity `y`, single
key `k`: two genuine raises (`t1`/`t2`), an ordinary unmarked `clearMergeQuarantineByToken(y, t1)` (the
only step that populates `clearedTokens` with `t1`; disk correctly drops to `[t2]`), then `k`'s physical
bytes are forced back to a stale snapshot still carrying `t1` (plus a third, disk-only token the in-memory
copy never learned), the in-memory entry is forced into `702b4241`'s own UNREADABLE-placeholder shape at
`k` (via the same `setActiveQuarantineTestOnly`/`markLatchFileUnreadableTestOnly` test-only hooks this
corpus already uses, e.g. scenario 4 of `merge-quarantine-4e987303-writelatch-adopt.mjs`), and `k` is
marked unreadable. A plain third raise then reaches the reingest branch with no drop of its own for `t1`.

SCENARIO 2 (`reconcileClearedEntryIfPlaceholder`, the human-clear twin): same shape — identity `z`, two
genuine raises (`s2t1`/`s2t2`), an ordinary clear of `s2t1`, then `z`'s key is forced back to a stale
snapshot still carrying `s2t1` (plus a disk-only token AND a genuine `contributorRepoPaths` entry, so the
clear fails closed on ambiguity rather than fully lifting the entry) and placeholder-shaped via the same
test-only hooks. Driven through `clearMergeQuarantineLatchFile` (clear-by-id) — one of the three
identity-wide human-clear routes named in that function's own doc comment. The refusal leaves the
just-reconciled entry observable in `activeQuarantines` (the reconcile+`replaceEntryEverywhere` happens
unconditionally, BEFORE the ambiguity check decides to refuse), so the resurrection is checked directly
against `listActiveMergeQuarantines()`.

RED/GREEN proven via two captured patches (`git diff` → `git checkout HEAD --` → rebuild → run →
`git apply` → rebuild → run), one per fix: scenario 1's fix reverted alone showed 2 of 12 scenario-1
checks FAIL (`t1` resurrects in memory AND on disk); scenario 2's fix reverted alone (scenario 1's fix
still applied) showed exactly 1 of scenario 2's own checks FAIL (`s2t1` resurrects in the reconciled
in-memory entry). Every sanity/precondition check in both scenarios (the genuine survivors, the
never-cleared disk-only tokens, the fresh raise's own token, the contributor fold) passes regardless of
either fix's state, isolating each failure to its own cleared token's resurrection specifically. Both
fixes restored: all 18 checks PASS (11 scenario 1 + 7 scenario 2); tree confirmed byte-identical to each
fix after restoring.

Full `merge-quarantine*.mjs` corpus (86 files, including the new one) run individually under
`env -u LOOM_DEV -u LOOM_SUPERVISED` (this change has no env-gated branch); `pnpm --filter @loom/daemon
guards` green. See the commit / worker report for the exact counts.

## Do not

- Do not re-derive `reingested.tokens`' own filtering by hand at a new call site — call
  `readSurvivingOnDiskTokens(parsed, recordIdentity)`, the one shared helper (now identity-scoped, see
  Round 3), exactly like both fixes above and the pre-existing generic branch all do.
- Do not assume there is a THIRD raw-union site waiting to be found without re-running the class
  enumeration above — the table is exhaustive as of this card; a future rebuild/rebuild-adjacent read site
  must be re-classified against it, not assumed covered.
- Do not fix the two `touchedFinalBasenames`-empty partial-clear tombstone call sites
  (`clearTokenFromPendingIndices`'s reduce branch, `clearActiveEntryTokenAtKey`'s partial-clear branch) —
  confirmed safe by analysis (token uniqueness), accepted as a note (see above), not a defect to close.
- Do not add a `clearedTokens` filter to any of the three boot-time (`reenterMergeQuarantinesAtBootImpl`)
  raw-token reads — `reenterMergeQuarantinesAtBoot` runs once per process, before `clearedTokens` can ever
  hold anything; filtering there would be a structural no-op, not a fix.
- Do not read the "accepted residual" section above as something this card could have closed — it is
  pre-existing parity with the generic branch's own long-standing in-memory-only scope, not a gap opened
  or left by this fix.
- Do not normalize an identity at a call site AND again inside `tombstoneIfNotSurviving`/
  `readSurvivingOnDiskTokens`/`tokenTombstonedForIdentity` as if both were required — normalization
  happens ONCE, inside those three functions, via `directPathIdentity`; a caller passes a raw `repoPath`
  or an already-normalized string, never pre-normalizes defensively (harmless if it does — `directPathIdentity`
  is idempotent on an already-resolved path — but it is not the documented contract).
- Do not revert `clearMergeQuarantineLatchFile`'s pending branch to one flat `tombstoneIfNotSurviving`
  call "for simplicity" — `matchedPending` can genuinely span several distinct identities (882d6cff); a
  flat call attributes every bucket's tokens to one arbitrary identity, silently reopening a narrower
  instance of this same class the next time a cross-identity bleed happens to land there.
- Do not trust the pre-round-3 "can never drop a genuinely outstanding token" claim (above, in this same
  file) as still true in its original, unqualified form — it is corrected in place, not restated twice;
  the TRUE claim is scoped to the same-identity case only.
