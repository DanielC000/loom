# 6c04633d — a divert union's arbitrary identity winner stranded the raiser's own tokens; a by-token clear now sweeps by token, not identity alone

_Split out of the former single `8db913e2` record by card `3608937e` so each record's injected Do-not extract fits the per-record cap; every section below is verbatim from it (pinned blob `2f1a55286d01`). The core record keeps the card's own rounds 1 and 3 and holds the index of every split-out record (rounds 2 and 4 of the card are in `sha:d529d42d`, record `d529d42d-raise-divert-rounds-2-and-4-chokepoint-union-and-in-memory-repoint.md`): `8db913e2-raise-diverts-instead-of-overwriting-a-kept-occupant.md`._

## Follow-up 6c04633d (CR4 of this card, finding 2 plus the note on finding 3) — a divert union's arbitrary identity winner stranded the raiser's own tokens; a by-token clear now sweeps by token, not identity alone

CR4 found (scratch probe `zz-cr4-probe.mjs`, commit `cb461f56`, never committed — deleted after use) that
`consumeMatchedPendingsIntoArmedEntry`'s own raise-divert branch (round 4's own fix, above) unioned EVERY
matched pending entry — the raiser's own plus every sibling sharing the canonical key via
`collectCrossTierSiblingIndices` — into ONE divert record, keyed to whichever matched entry
`unionQuarantineEntries` judged OLDEST. That is an ARBITRARY winner with no relation to who is actually
raising: an older SIBLING's identity could win outright, folding the raiser's own tokens under a record
`clearMergeQuarantineByToken` — which matches pending entries by identity alone — could never again reach
by the raiser's own repoPath.

### Z1 (the reviewer's own repro, reviewer `4c732a8c`)

1. R raises (t1), succeeds normally. A SIBLING S = R/sib-subdir has an OLDER pending entry (`enteredAt`
   far in the past), not yet existing on disk.
2. R raises again (t2) while `final`'s reads fail — diverts, carrying `t1,t2` forward under R's OWN
   identity (no sibling involved yet, since S does not yet resolve to R's own canonical key).
3. S now exists on disk — its own canonical key degrades (walks up, since it has no `.git` of its own) to
   R's real key.
4. R raises a third time (t3); only the fold-in read inside `consumeMatchedPendingsIntoArmedEntry`'s own
   sibling-absorb fails. Pre-fix: S (older) wins the union, so the new pending record carries identity S
   but holds R's `t1`, `t2` AND `t3`.
5. `clearMergeQuarantineByToken(r, t1)` matches pending entries by `directPathIdentity(r)` alone, so it
   can never find `t1` sitting in a record whose own `repoPath` is S. R stays blocked after every one of
   its own tokens is released, including across a reboot.

### Also from CR4

- **(a)** A PARTIAL by-token clear of a record with folded `orphanLatchFiles` left stale tokens in those
  orphan files — the `ae79d492` dual-tracked-twin rewrite only ever covered ONE reference-tracked pending
  twin, never the general `orphanLatchFiles` list. They re-armed after a reboot.
- **(b)** In the consume-divert fold, excluding `pendingDivertFilenameFor(armed.repoPath)` from the folded
  `orphanLatchFiles` assumed `divertRaiseEntry` always overwrites that exact file. When `divertRaiseEntry`
  instead reuses an unmatched same-identity pending's own `base.sourceFile` (a different physical file),
  the excluded file goes untracked — fail-closed at reboot (the content is never lost, merely left
  unreferenced, since nothing else writes to it either — but it is also never swept, surviving
  indefinitely as an unreferenced, undiscoverable file).

### Manager's ruling

A divert union keeps the RAISER's own identity for the raiser's own tokens — never fold one identity's
tokens into a record keyed to a different identity. If both must persist, each identity gets its own
record, even when that means two files. `clearMergeQuarantineByToken` additionally sweeps a token from
EVERY record that holds it, whatever that record's own identity: tokens are unique `randomUUID`s, so a
token match IS an exact identity of its own holder — a token-held-by-another-identity record is clearable
by its own owner regardless.

### The fix

1. **Identity-preserving divert** (`consumeMatchedPendingsIntoArmedEntry`'s raise-divert branch). Instead
   of unioning every matched entry into one blob, `matched` is partitioned by `directPathIdentity`: the
   RAISER's own group (`extra`'s identity, plus every matched entry sharing it — a legitimate same-identity
   merge) is unioned and diverted via `divertRaiseEntry` under the raiser's own identity; every OTHER,
   genuinely foreign identity's own matched entries are unioned ONLY within that identity (never across)
   and either re-inserted into `pendingUnresolvedQuarantines` unchanged (a single matched entry — content
   genuinely didn't change) or durably rewritten at the oldest one's own `sourceFile` (more than one
   matched entry for that foreign identity). A foreign identity is never consumed into, or written through,
   `divertRaiseEntry` at all — it was never the raiser's write to make.
2. **(b) Unconditional fold.** The raiser's own group's `ownSourceFiles` are folded into the diverted
   record's `orphanLatchFiles` UNCONDITIONALLY — no more comparing against the assumed
   `pendingDivertFilenameFor` target. A self-reference (the file about to be written IS one of the folded
   sourceFiles) is the same established, legitimate shape `survivingSharedClaimRepoPaths` already
   recognizes elsewhere in this module.
3. **(a) General, OWNERSHIP-GATED orphan-rewrite on partial clear.** `rewriteOrphanLatchFilesAfterPartialClear(updated,
   skip)` — generalizes the `ae79d492` dual-tracked-twin rewrite to EVERY file `updated.orphanLatchFiles`
   names (skipping whatever the caller's own write loop already wrote, and whatever no longer exists on
   disk), but ONLY once `orphanRewriteOwnershipConfirmed` POSITIVELY confirms the file is genuinely this
   same entity's own — a `keptUnreadableLatchFiles`-marked basename, a `physicalOwnerRepoPaths`/
   `survivingSharedClaimRepoPaths` credit to a DIFFERENT identity, or a read/parse failure, each fail
   closed (the file is left stale, UNTOUCHED, rather than written). Round 1 shipped this gate missing —
   see Round 2, B1, below for the regression and the fix. Wired at the end of both
   `clearActiveEntryTokenAtKey` and the shared pending-clear body (below) — every partial by-token clear
   keeps every CONFIRMED-OWN folded orphan file in sync with the reduced token set, never leaving one
   stale for a later boot to re-arm from — and never touches one it cannot confirm.
4. **Universal by-token sweep.** `clearMergeQuarantineByToken` no longer stops at `repoPath`'s own
   identity/key: `clearPendingEntryByToken`'s per-index body is factored into a shared
   `clearTokenFromPendingIndices(indices, token)`, and the top-level function now (a) sweeps every
   NON-TWIN pending entry — of ANY identity — still holding `token`, FIRST, then (b) sweeps every active
   entry still holding `token`. A genuine `883e29bc` dual-tracked TWIN (a pending entry that is the SAME
   object reference as an active one) is deliberately EXCLUDED from step (a) — it stays
   `clearActiveEntryTokenAtKey`'s own job, in its own established `ae79d492` order (write the armed key's
   final first, then decide whether the twin needs its own rewrite); running the universal pending sweep
   on a twin BEFORE that order got a chance to run regressed two pre-existing `merge-quarantine-degraded-
   occupant-guard.mjs` scenarios (`dual-same-file-shape-preserves-provenance-tracked`,
   `dual-pass1b-tmp-shape-does-not-resurrect-swept-tmp`) during this card's own development — caught only
   by re-running the full corpus, not by this card's own new scenarios.

   **Why pending-before-active, for the non-twin case specifically:** a pending write
   (`writePendingDivertFile`) never re-reads or unions on-disk bytes — it just writes `updated` directly.
   An active write (`writeMergeQuarantineLatch`) DOES, via its own marked-basename chokepoint. If the
   active side clears first while a SEPARATE (non-twin) pending copy of the same token still exists,
   `tombstoneIfNotSurviving`'s own scan (called from inside the active clear) finds that pending copy
   still "surviving" and skips tombstoning — so the active write's own chokepoint union, reading a
   STALE, never-updated physical final, re-absorbs the token it was supposed to drop. Clearing every
   non-twin pending copy first means the tombstone fires correctly before any active write that could
   re-absorb a stale on-disk token ever runs.

### Tests

`merge-quarantine-raise-protect-failure.mjs`:
- **`6c04633d-z1`** — Z1, ported directly (R raises three times, the third absorbing the now-resolvable
  sibling S via the sibling-absorb branch). Asserts no record keyed to S's own identity ever holds any of
  R's own tokens, that `clearMergeQuarantineByToken` lifts each of R's own tokens in-process AND on disk
  (measured by scanning every file in `MERGE_QUARANTINE_DIR`, never just `listActiveMergeQuarantines`),
  that R is fully lifted once every one of its own tokens is released, and that none of R's tokens (nor
  the sibling's own, separately released) resurrect after a fresh-import reboot.
- **`6c04633d-a`** — finding (a). D has a pre-existing, legacy-named pending entry (never
  `pendingDivertFilenameFor(d)`) holding its own token; a later raise's own sibling-absorb (reaching the
  `existing` branch, since D is armed via a `resolvedKey`-carrying boot-time latch) folds it into the
  raiser's OWN record (same identity, per the 6c04633d identity rule), making the legacy file a genuine,
  non-self-referencing orphan. A PARTIAL clear releasing the exact token that orphan file itself
  originally carried (other tokens remain outstanding) must rewrite that file's own bytes too — asserted
  directly against the file's own on-disk content, and that the released token does not resurrect after a
  fresh-import reboot while the still-outstanding token does survive it.
- **`round4-x`** (pre-existing, this round's own regression-shape update) — S is a genuinely different
  identity than the raiser D, so under the 6c04633d identity rule it is no longer folded into D's own
  divert record at all; it is pushed back untouched, under its own identity. The scenario's own check is
  widened to accept this as a third valid state (live and correct, never an orphan, never gone) alongside
  the pre-existing two (gone, or named in some entry's own `orphanLatchFiles`) — the underlying invariant
  the check protects (the sibling's own content is never silently lost) is unchanged; only which of three
  valid shapes satisfies it differs now.

`6c04633d-z1` and `6c04633d-a` proven RED on `HEAD` (pre-fix) and GREEN after, via
`scripts/negative-control.mjs`. All 33 `merge-quarantine*.mjs` files re-verified individually, each exit 0
(including `merge-quarantine-degraded-occupant-guard.mjs`, which the FIRST version of this card's own
universal-sweep fix broke — see the pending-before-active note above — and which now passes clean again).
All static guards (`pnpm --filter @loom/daemon guards`) re-verified green (30/30). Line endings
re-verified CR==LF via the `tr -dc` recipe; the scratch probe file was deleted, never committed.

### Do not (6c04633d)

- Do not rewrite an orphan-referenced file inside `rewriteOrphanLatchFilesAfterPartialClear` without first
  proving, via `orphanRewriteOwnershipConfirmed`, that it is this SAME entity's own current physical
  content — `existsSync` alone is never enough. A stale `orphanLatchFiles` reference can name a file that
  is now a wholly DIFFERENT, live entity's own latch (`9cabd143`'s bug class); Round 1 of this card shipped
  exactly this blind-write regression — see Round 2, B1, below.

## Round 2 (Code Review `e8c78d98` of commit `b49ab498`) — one Critical regression in Round 1's own new
code, plus three Majors/nitpicks

Round 1 shipped NOT SHIP. CR found a real, reproduced Critical fail-open regression in the orphan-rewrite
fix (B1), plus three correctness/hygiene findings (M2-M4) in Round 1's own new code.

### B1 CRITICAL — `rewriteOrphanLatchFilesAfterPartialClear` blind-wrote by filename alone, never by
ownership, reopening `9cabd143`'s bug class as a WRITE instead of a wrongful unlink

Round 1's own fix checked only `existsSync` before calling `writePendingDivertFile(orphanFile, updated)` —
`writePendingDivertFile`'s own doc states it is safe ONLY for "this SAME entity's own existing file, never
a different one." `9cabd143` already records that an `orphanLatchFiles` reference can name a file that is
now a DIFFERENT, live entity's own latch (PASS 2's own defensive "unmatched orphan broadcast onto every
registered repo" mechanism, `9a55fb90`/`882d6cff`-era) — Round 1 never checked for this on the write side.

**Repro (the reviewer's own, reproduced directly):**
1. A corrupt `<hashB>.json` exists; boot with `[A]` registered — the corrupt, unmatched latch forces A
   fail-closed quarantined, and PASS 2 folds the orphan reference into A's own `orphanLatchFiles` (mirrors
   `95ea8d3f-r3-orphanref`'s own established setup).
2. B raises for real — the corrupt content is "nothing usable," so B's own write proceeds and durably
   overwrites `<hashB>.json` with B's own real latch.
3. A raises AGAIN (its own identity — reachable in production via a GitWriter op, which lacks
   `assertRepoNotQuarantined`), adding a second token.
4. `clearMergeQuarantineByToken(A, tA)` — a PARTIAL clear (A's own fail-closed token remains outstanding)
   reaches `rewriteOrphanLatchFilesAfterPartialClear`, which (pre-fix) blind-writes A's own record into
   `<hashB>.json`, destroying B's real content. After a fresh-process reboot, B is NOT quarantined.

On the true pre-card parent (`1dbb558a`), this exact code path (`rewriteOrphanLatchFilesAfterPartialClear`)
does not exist at all — the regression is specific to Round 1's own new commit (`b49ab498`), reproduced
there via `negative-control.mjs --ref b49ab498`.

### Manager's ruling

Gate EVERY orphan rewrite on ownership, fail-closed. Skip (never write) a file that
`physicalOwnerRepoPaths`/`survivingSharedClaimRepoPaths` credits to a different entity, or whose ownership
cannot be determined, or that is in `keptUnreadableLatchFiles` (its unreadable-second-shape mark must be
respected — never bypass `writeMergeQuarantineLatch`'s own marked-basename reconcile chokepoint, which
would contradict Round 1's own "every write goes through the chokepoint" and `63e49ee2`). A skipped,
left-stale orphan file is an accepted fail-CLOSED residual: a stale record keeps its OWN repo quarantined
and can never un-quarantine anyone else as a side effect.

### The fix

`orphanRewriteOwnershipConfirmed(orphanFile, updated)` — `false` (skip, leave stale) if: `orphanFile`'s
basename is `keptUnreadableLatchFiles`-marked; OR `physicalOwnerRepoPaths(orphanFile)`/
`survivingSharedClaimRepoPaths(orphanFile)` names ANY repoPath whose `directPathIdentity` differs from
`updated`'s own; OR a fresh `quarantineFileRepoPathIdentity` read of the file's own on-disk content returns
`undefined` (ENOENT/EISDIR/corrupt/no `repoPath` field) or an identity different from `updated`'s own.
Returns `true` (safe to write) ONLY when the structural checks name nobody but `updated`'s own identity
AND the content check positively confirms the same identity — belt-and-suspenders, not either check alone.
`rewriteOrphanLatchFilesAfterPartialClear` calls this immediately before every `writePendingDivertFile`
call and logs-and-skips (never throws) on a `false`.

### Tests

`merge-quarantine-raise-protect-failure.mjs`:
- **`6c04633d-b1`** — the reviewer's own repro, ported directly. Asserts `<hashB>.json` is NEVER
  overwritten with A's own record (B's real content survives byte-for-byte, checked via both `bToken`'s
  presence and `A`'s own basename's ABSENCE in the file), that A's own `tA` is correctly lifted in-process
  despite the skip, and that B stays quarantined after a fresh-process reboot (never silently un-quarantined
  as a side effect of A's own, unrelated clear).
- **`6c04633d-b1-kept`** — the keptUnreadable variant: the same A/B/corrupt-boot setup, but `<hashB>.json`'s
  own basename is ALSO `keptUnreadableLatchFiles`-marked (via a throwaway raise on an unresolvable subdir
  of B, which degrades to B's own canonical key and hits a transient read failure) at the moment A's
  partial clear runs. Named honestly: this does NOT isolate the `keptUnreadableLatchFiles` check from the
  cross-identity content check (B's real content also differs from A's identity here, so either check
  alone would skip this write) — it is a combined regression guard for the overall fail-closed outcome,
  not a unit proof of which specific check fired.

Both proven RED on `b49ab498` (Round 1's own commit) and GREEN after, via `scripts/negative-control.mjs
--ref b49ab498`. All 33 `merge-quarantine*.mjs` files re-verified individually, each exit 0. All static
guards (`pnpm --filter @loom/daemon guards`) re-verified green (30/30).

**Card `a9174861`:** neither the `keptUnreadableLatchFiles.has(orphanFile)` skip above NOR the M2 stamp
below (see that section) had a test isolating it from its own other layers — `merge-quarantine-round2-pins.mjs`
adds both, each proven RED by a single-line mutation of the exact fixed line and GREEN after restore.

### M2 — the raiser's own divert record silently lost its pre-existing field set

Round 1's `raiserUnion` (built from `extra` + `ownGroup`) carried no `resolvedKey`, no `armedKeys` entry
for `key`, and no `provenanceTracked`, unlike the PRE-Round-1 `armed` object this function always diverted
(which stamped all three — `500e307a`'s own documented, deliberate invariant: "`consumeMatchedPendingsIntoArmedEntry`'s
own `armed` result" is one of only two true runtime origin points for a `resolvedKey`-bearing entry, and
the lazy-graduation/query tier matches a still-unresolvable entry by its own trusted `resolvedKey`).
Checked first, per the manager's own instruction: neither `500e307a`'s own record nor `8db913e2`'s own
text states a raise-divert must NOT carry `resolvedKey` — no conflict found. **Ruling: preserve the field
set** — this card is about identity partition, never about what a divert record carries. `raiserUnion` now
also gets `resolvedKey: key`, `armedKeys` unioned with `key`, and `provenanceTracked: true`, stamped
immediately after the union, mirroring the pre-Round-1 `armed` object exactly (for the raiser's own group
only — a genuinely foreign identity's own record never gets these, since it was never armed at `key` at
all).

### M3 — `round4-x`'s own third disjunct didn't tie the entry to `sibFile` itself, and read it at the wrong time

The disjunct compared `listActiveMergeQuarantines()`'s own `repoPath`/`tokens` fields, never `sibFile`
itself — a check that could pass even if some OTHER mechanism had moved the sibling's content to a
different physical file. Fixed to read `sibFile`'s own on-disk bytes directly, asserting they still name
S and `sibToken` verbatim. Caught in the process (not by the CR, by re-running the suite after fixing the
label): the read must happen at the SAME pre-query snapshot as `filesAfterRaise`/`referencedOrphansX`
(captured right after the raise) — `activeMergeQuarantineFor(d)`, called by the very next check, is a
QUERY whose own lazy-graduation tail can ITSELF trigger a pre-existing, unchanged, out-of-this-card's-scope
successful consolidation of D+S once reads succeed again (the SAME "oldest identity wins" shape Z1
complains about, but on the SUCCESS path, which this card deliberately never touches) — deleting `sibFile`
out from under a content read taken any later than that.

### M4 — `clearPendingEntryByToken` was dead code; `clearMergeQuarantineByToken`'s `repoPath` param is now unused

Deleted `clearPendingEntryByToken` (no remaining callers once the universal sweep replaced its one call
site) and fixed every jsdoc `{@link clearPendingEntryByToken}` reference plus every LIVE test comment
describing it as still-called (`merge-quarantine-runtime-provenance-stamp.mjs`,
`merge-quarantine-unverified-raise-divert.mjs`, `merge-quarantine-raise-protect-failure.mjs`,
`merge-quarantine-degraded-occupant-guard.mjs`) to name `clearTokenFromPendingIndices` (or describe the
universal sweep) instead. Historical decision records documenting `clearPendingEntryByToken`'s own
introduction/history are left untouched — out of this card's scope, and rewriting another card's own
historical narrative is not what this finding asked for. `clearMergeQuarantineByToken`'s own `repoPath`
parameter is renamed `_repoPath` (kept for call-site/signature stability; genuinely unused now that the
clear is process-wide by token alone) and its own doc comment states this plainly.
