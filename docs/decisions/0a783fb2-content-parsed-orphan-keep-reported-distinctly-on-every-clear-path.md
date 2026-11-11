# 0a783fb2 — a content-parsed orphan keep is reported distinctly, on every clear path

_Split out of the former single `8db913e2` record by card `3608937e` so each record's injected Do-not extract fits the per-record cap; every section below is verbatim from it (pinned blob `2f1a55286d01`). The core record keeps the card's own rounds 1 and 3 and holds the index of every split-out record (rounds 2 and 4 of the card are in `sha:d529d42d`, record `d529d42d-raise-divert-rounds-2-and-4-chokepoint-union-and-in-memory-repoint.md`): `8db913e2-raise-diverts-instead-of-overwriting-a-kept-occupant.md`._

## Follow-up 0a783fb2 — a content-parsed orphan keep is reported distinctly, on every clear path

From CR#2 (`e726e2ba`) of card `f2cc5f18`. That card's own fix only reported a content-based orphan keep
(`sweepOrphanLatchFileIfUnreferenced`'s fail-closed branch) via `clearMergeQuarantineLatchFile`'s
RAW-FALLBACK branch — three other call sites (`clearTokenFromPendingIndices`, `clearMergeQuarantineByKey`,
`clearMergeQuarantineByRecordedPath`) discarded it with only a `console.error`, and the pending-match
branch of `clearMergeQuarantineLatchFile` itself never tracked a kept-but-UNATTRIBUTED result at all. The
RAW-FALLBACK branch also OVERLOADED `referencingRepoPaths` — a content-parsed repoPath (no live entry
backs it) and a true in-memory referencer both landed in the same field, which `64283e06`'s own "Do not
overload `referencingRepoPaths`" bullet did not yet cover (it was scoped to the `stillQuarantined`
ambiguity only).

**Fix:** `sweepOrphanLatchFileIfUnreferenced` now returns `contentKeptRepoPath?: string`, SEPARATE from
`referencingRepoPaths` (true referencers only). A new shared helper, `foldOrphanSweepResult`, folds one
sweep result into a caller's running `{referencing, contentKept, unattributed}` state — used at every
TRUE orphan-sweep call site (`clearTokenFromPendingIndices`, `clearMergeQuarantineByKey`,
`clearMergeQuarantineByRecordedPath`, `clearMergeQuarantineLatchFile`'s pending-match AND RAW-FALLBACK
branches — FIVE sites, not four; `clearTokenFromPendingIndices`/`clearMergeQuarantineLatchFile`'s
pending-match branch each sweep orphan files at their own, separate call site in addition to the other
three), plus the pending-match branch's own `ownSweep`/`finalSweep` calls (structurally compatible via
TypeScript's optional-property assignability — `sweepOwnLatchFileUnlessOwnedElsewhere` never sets
`contentKeptRepoPath` at all, so it passes through as an always-absent optional field). **CORRECTION
(round 2): the helper does NOT cover `tmpSweep`** (`sweepTmpResidueForHashIfUnreferenced`) — that function
has no content-parse branch at all, and its `keptEntries` can span MULTIPLE distinct `{repoPath,
sourceFile}` pairs per call, which the helper's one-sourceFile-per-call signature can't represent; its own
unattributed case stays a deliberate 2-line inline check, with a guard comment stating exactly why (Code
Review 47289f8d, item 4). A new `contentKeptRepoPaths?: string[]` field threads through
`clearMergeQuarantineByKey`/`ByRecordedPath`/`Reporting`/`LatchFile` and all three REST handlers
(`gateway/server.ts`) — never folded into `stillBlockedCoOccupants` (no live entry exists to clear by id
for mere on-disk content). The TWO sites reached only via the auto-clear path
(`clearMergeQuarantineByToken`, `void` by design, no human-facing return) instead console.warn, mirroring
the existing "no human route reaches this path — logging only" convention already used there for a
relocated co-occupant.

**Behavioral/test-contract change:** `clearMergeQuarantineLatchFile`'s RAW-FALLBACK branch (scenario F in
`merge-quarantine-orphan-sweep-content-aware.mjs`) now reports a parsed foreign repoPath via
`contentKeptRepoPaths`, not `referencingRepoPaths` — the test's own assertion was migrated accordingly,
and a new assertion confirms `referencingRepoPaths` no longer carries it.

**ROUND 2 (Code Review `47289f8d`, MERGEABLE-after-one-Major):** round 1's own `stillBlockedCoOccupants`
extension — a TRUE referencer found by the orphan-sweep now ALSO feeds `stillBlockedCoOccupants` (via
`blockedCoOccupantForReferencer`) at the four previously-fully-discarding sites, not just
`contentKeptRepoPaths` — introduced a REGRESSION the round-1 worker never tested: `clearMergeQuarantineByRecordedPath`
processes a query identity's own `matched` (active) entries before its own `matchedPending` entries, so a
delegated `clearMergeQuarantineByKey` call for one matched active entry can find that SAME identity's own
UNTIED pending twin (or a later `matched` active entry, the `d4b25feb` "two independent raise-groups"
shape) still live in memory and report it as a TRUE referencer — the cleared identity ends up reported as
its OWN `stillBlockedCoOccupants` entry, with `latchKept:true` and a route id that no longer exists once
the whole clear finishes (R3's own repro, Code Review 47289f8d: `listActiveMergeQuarantines()` for that
identity reads `0` immediately after, confirming nothing was actually still blocking it).

**THE FIX:** `sweepOrphanLatchFileIfUnreferenced` gained `excludeIdentities?: ReadonlySet<string>`, applied
to all three of its own referencer scans (`activeQuarantines`, `pendingUnresolvedQuarantines`,
`physicalOwnerRepoPaths`) — every orphan-sweep call site now passes the identity (or, for
`clearMergeQuarantineLatchFile`'s pending-match branch, the SET of identities — `882d6cff`'s multi-claimant
shape can span several at once) the CURRENT clear is already in the middle of lifting. **Why exclude,
never defer:** a same-identity record's own "still quarantined" status is already `stillQuarantined`/
`resolveQuarantineFor`'s job, re-resolved FRESH after the whole clear completes — `referencingRepoPaths`/
`stillBlockedCoOccupants` means a DIFFERENT repo, with a real, standing clear-by-id route; a same-identity
entry can never be that, in EITHER direction (a same-identity entry already cleared can't come back, and
one not yet cleared is about to be). Excluding it costs nothing in content-safety: `orphanSweepSafeToDelete`
still runs independently afterward and still fails closed on any genuinely uncovered token, same-identity
or not (see the primitive-level argument in `sweepOrphanLatchFileIfUnreferenced`'s own doc comment).

**MINOR fixes, same round:** (1) `clearMergeQuarantineByKey` now returns an EXPLICIT `unattributed?: true`
field — `clearMergeQuarantineByRecordedPath` used to INFER "unattributed" from an empty
`referencingRepoPaths`, which misfired the instant `latchKept` was true SOLELY because
`contentKeptRepoPaths` fired (a content-only keep, wrongly reported with the "no specific other claimant
can be named" wording instead of naming `contentKeptRepoPaths`). (2) Two new shared reason-text helpers,
`contentKeptOnlyReasonFor`/`unattributedKeptReasonFor`, replace `keptOnlyReasonFor`'s own garbled "0 other
claimant(s) … ()" text (produced when called with an empty `refs` array) at every site that can report a
content-only or purely-unattributed keep — `clearMergeQuarantineReporting`'s own latchKept branch now picks
the right base reason by WHICH kind of keep fired, never `keptOnlyReasonFor` unconditionally; two
`clearMergeQuarantineByRecordedPath` branches that used to give NO reason at all for a content-only keep
now compose one.

Tests added: `merge-quarantine-clear-by-path.mjs`'s own (AM) proves the R3 self-reference fix directly
(latchKept absent, `stillBlockedCoOccupants` empty, zero entries survive for the identity, all RED on
`ad3b2c35`); `merge-quarantine-orphan-sweep-content-aware.mjs`'s own (L)/(M)/(N)/(O) each prove a TRUE,
DIFFERENT-identity referencer still correctly reaches `stillBlockedCoOccupants` (or, for (O)'s auto-clear
site, `console.warn`) at `clearMergeQuarantineByKey`/`ByRecordedPath`/`LatchFile`'s pending-match branch/
`clearTokenFromPendingIndices` respectively — proving the self-exclusion fix narrows the bug without
regressing the legitimate cross-identity case the `stillBlockedCoOccupants` extension exists for.

## Do not (extends `64283e06`'s own bullet)

- Do not fold a CONTENT-parsed repoPath (from `orphanSweepSafeToDelete`'s fail-closed branch) into
  `referencingRepoPaths` — that field means a TRUE in-memory referencer only, now enforced by
  `sweepOrphanLatchFileIfUnreferenced`'s own return shape. Use `contentKeptRepoPath(s)` instead, and never
  fold it into `stillBlockedCoOccupants` (no live entry backs it).
- Do not hand-roll a new per-site fold of an orphan-sweep result — route it through `foldOrphanSweepResult`
  so a future site can't silently drop either kind of keep the way FIVE sites did before this card (the
  four this card's own investigation found, plus the RAW-FALLBACK branch's own pre-existing hand-rolled
  fold, migrated onto the helper too for consistency — never "four", see the corrected count above).
- Do not claim `foldOrphanSweepResult` covers `sweepTmpResidueForHashIfUnreferenced` — it does not, and
  never will without a signature change neither its no-content-parse contract nor its multi-entry
  `keptEntries` shape can satisfy; its own unattributed case stays a deliberate, commented inline check.
- Do not let an orphan-sweep's own true-referencer check treat a SAME-IDENTITY record (active or pending)
  as a genuine co-occupant — exclude it via `excludeIdentities`, at every call site, for the identity (or
  identities) the CURRENT clear is already in the middle of lifting. A same-identity record's own "still
  quarantined" status belongs to `stillQuarantined`/`resolveQuarantineFor` alone, re-resolved AFTER the
  whole clear completes — never to `referencingRepoPaths`/`stillBlockedCoOccupants`, which name a
  DIFFERENT repo with a real, standing clear-by-id route.
- Do not have a caller re-INFER `clearMergeQuarantineByKey`'s own "unattributed" state from an empty
  `referencingRepoPaths` — read its EXPLICIT `unattributed` field instead; the inference misfires the
  instant `latchKept` is true solely because `contentKeptRepoPaths` fired.
- Do not call `keptOnlyReasonFor` unconditionally for a kept-latch reason — it assumes a true referencer
  and reads as a garbled "0 other claimant(s) … ()" when there is none. Pick the base reason by which kind
  of keep actually fired (`keptOnlyReasonFor` / `contentKeptOnlyReasonFor` / `unattributedKeptReasonFor`),
  and never silently return no reason at all for a content-only or purely-unattributed keep.
