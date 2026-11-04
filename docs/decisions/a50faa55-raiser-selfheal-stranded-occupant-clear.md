# a50faa55 — a raiser self-heal strands a protected occupant's clear

Found by `da7bf48e`'s Code Review probe — a different mechanism (which fixed
`protectOccupantContentBeforeDelete`'s stranded-tmp tracking on the raise path): this is
`physicalOwnerRepoPaths` crediting an in-memory arm never durably written.

## The bug

`teamA` (a subdirectory of `W` absent at boot) collapses onto X's own key `Kw` once created. After `W`
raises with a persistent double fault on X's own pending-divert (X stays self-owned at `Kw`'s final, per
`8d80b736`/`da7bf48e`), `assertRepoNotQuarantined(w)` — a self-healing read on the RAISER, never X — strands
X's later full clear:

`activeMergeQuarantineFor(w)`'s graduation branch arms `activeQuarantines.set(Kw, armed)`
UNCONDITIONALLY, in memory, BEFORE the durable write (`d4b25feb`: enforcement can't wait on disk I/O).
That write is then correctly REFUSED by `wouldOverwriteDifferentUnresolvableOccupant` (X's content still
exclusively occupies the file) — so `teamA`/`W` sits armed at `Kw` with NO physical backing.
`physicalOwnerRepoPaths(filename)` (via `sweepOwnLatchFileUnlessOwnedElsewhere`, consulted by X's later
full-lift clear) credited ANY entry armed at a matching key — or whose fresh key maps there
(`isFreshWriteTarget`) — with no check content was ever actually written. `teamA`/`W` satisfied both
despite its refused write, so the sweep kept X's stale file untouched; reboot's PASS 1b re-read it and
re-armed X. Repro'd hermetically (`6d221bae`, pre-fix).

Exactly ONE vulnerable mechanism: `enterMergeQuarantine`'s raise-branch sites pass
`skipDegradedOccupantGuard:true` but are safe — their preceding `protect*OccupantBeforeDelete`/
`resolveRaiseOverwrite` check already diverted on a colliding write. `assertRepoNotQuarantined` is called
from essentially every canonical git op. `activeMergeQuarantineForPeek` is not vulnerable.

## The fix

Gate `physicalOwnerRepoPaths`'s credit — both branches — on the file's CURRENT content not belonging to a
different, still-unresolvable occupant: reuse `differentUnresolvableOccupantRepoPathAt` (same helper the
write-side guard uses). Only `state === "occupant"` excludes the claim; `"none"`/`"unknown"` leave the
pre-existing credit unchanged.

**Round 2 — the placeholder occupant is now covered too.** The first cut (`058f73db`) excluded ANY
content-confirmed different occupant; `88ff2e1e` added a placeholder EXEMPTION (`isPlaceholderContentAt`)
after that regressed `migrate-source-owner-durable.mjs`'s own X-newer scenario. CR `c00c15d0` found the
exemption re-opened this card's own resurrection: when the occupant was a placeholder, it kept crediting
the unwritten arm, leaving the placeholder's own stale, already-cleared bookkeeping on disk instead of
swept — resurrecting it on reboot (the (placeholder) scenario: clearing Y's last token left the final
still holding Y with it; a reboot re-armed Y). **The exemption is dropped.** No surviving entry's own
protection depends on it — both parity scenarios still stay correctly blocked, in-process and after a
reboot, under the no-exemption code; `clearResult.latchKept` is no longer set, not load-bearing.
Enforcement for the OWNING process comes from `activeQuarantines` (`d4b25feb`), never this credit.

The fix sits at the owner-CREDIT site, never the arm itself: un-arming `teamA`/`W` would re-open a MORE
severe fail-open — `d4b25feb`'s design keeps its real outstanding token enforced even when its write is
refused.

## Why narrowing is safe

Strict narrowing: only ever removes a claim, never adds one, only when content provably contradicts it —
a genuine claim always reads back `"none"`, never `"occupant"`.

5 direct callers + 7 of `sweepOwnLatchFileUnlessOwnedElsewhere` (only removes a claim proven false by
content). `deleteSourceLatchIfSuperseded`: corrupt sources never parse ⇒ `"none"` ⇒ no-op; clean
superseded sources have no true claimant left. `orphanRewriteOwnershipConfirmed` still requires
`anotherLiveEntryOwnsFile` + `quarantineFileRepoPathIdentity` + `orphanFileTokensAccountedForByUpdate`.
`orphanLatchFileSweepDecision`/`sweepOrphanLatchFilesUnioned` fall through to content-based
`orphanSweepSafeToDelete`. `blockedCoOccupantForReferencer` is reporting only.

Confirmed: `W`'s later clear unaffected; a third raise at the freed key succeeds; `"unknown"` never
excludes.

## Tests

`merge-quarantine-a50faa55-raiser-selfheal-strands-occupant-clear.mjs`: (selfheal) original repro, RED
pre-fix/GREEN after, `W` stays blocked w/ pending source surviving; (reverse) `W` cleared first then X,
both unblocked; (placeholder) placeholder occupant Y at the same key — `teamA`/`W` survives Y's clear AND
Y is never resurrected after a reboot, RED under a mutant re-adding the dropped exemption. `da7bf48e`'s
V1/V6 re-run green. `migrate-source-owner-durable.mjs`'s X-newer scenario is retargeted off
`clearResult.latchKept` onto `sub` surviving a reboot; a second guard now pins X to never resurrect
too, RED under the same mutant.

## Do not

- Do not un-arm `teamA`/`W` from `activeQuarantines` — reopens a worse fail-open
  (`d4b25feb`'s unconditional-arm design).
- Do not widen the exclusion to `"unknown"` — only `"occupant"` excludes a claim.
- Do not hand-roll a second content-identity check — reuse the existing helper.
- **Do not re-add a placeholder exemption to this exclusion** — tried (`88ff2e1e`), found (CR `c00c15d0`)
  to re-open this card's resurrection for a placeholder occupant; no surviving entry depends on it.
- **Do not credit an unwritten in-memory arm as physical ownership of a DIFFERENT occupant's file** — the
  bug itself (see "The bug").
- Do not assume this fix covers other `clearTokenFromPendingIndices` write-failure branches, or any site
  named safe-or-open by `8d80b736`/`da7bf48e`/`5332762e`/`e1572b69` — scoped to owner-credit alone.
