# 6dd3a17c — the marker UNION SCAN excludes a rules file's own §ROTATION-GATE section

## Narrative

`rotation-gate.mjs`'s marker check (and its TypeScript port, `rotation-check.ts`'s `checkMarkers`/`checkMarkersUnion`) is an exact-substring UNION over `--active` and every `--rules` file. `Operations/Orchestrator Rules.md` is always the first `--rules` file in real use, and its own `§ROTATION-GATE` section contains a fenced block ENUMERATING all 12 marker tokens — it must, because `--audit-vault`'s drift detector locates that exact section and compares its text against the script's `MARKERS` array.

That collision means the marker union scan was satisfying every marker from the enumeration alone, whether or not the rule each token protects had a real home anywhere. Measured against main `5871b88c` (card `6dd3a17c`, filed by lead `gen 337`): a 2-line scratch doc with no markers and no `--rules` correctly reports `missing 12/12`; the same doc with `--rules` limited to ONLY the fenced enumeration block (`Orchestrator Rules.md` lines 966–977) reports zero missing markers.

## Rejected alternative: exclude only the fenced code block

A narrower fix — stripping just the fenced enumeration block rather than the whole `§ROTATION-GATE` section — was tested and found insufficient. With the fence removed but the surrounding discussion prose of `§ROTATION-GATE` (lines 927–965 and 978–1104) left in the rules-scan text, 6 of 12 markers still resolved (`Orchestrator Rules`, `LIVE COMMITMENTS`, `OWNER-GATED`, `NO-CLEARANCE-FROM-SILENCE`, `QUIET-LANE`, `MGR122-FLOOR`) — the section's own narrative repeatedly names these tokens outside the fence (e.g. lines 981–998 discuss `QUIET-LANE`/`MGR122-FLOOR`/`PRAISE-IS-THE-LEAST-AUDITED-INPUT`/`PRE-MERGE-PAIR` at length as prose, not just inside the list). Excluding only the fence would have left the defect largely intact. The whole-section exclusion is therefore required, not merely tidier.

A second alternative — a per-hit "is this line an enumeration" predicate — was also rejected: it would be a second, independently-derived notion of "what counts as the enumeration," able to drift from what `auditVaultSource` considers the section's bounds. Reusing the exact same `findHeadingLine`/`findSectionBoundary` helpers `auditVaultSource` already trusts means the exclusion and the drift-audit can never disagree about where `§ROTATION-GATE` begins and ends.

## Scope of the fix, and why it's safe

The exclusion applies ONLY to the text handed to the marker union scan (`checkMarkers`/`checkMarkersUnion`), for `--rules` sources only. `--active` scanning, `countLiveCommitments`'s rules-text input (the LIVE COMMITMENTS floor check), and `--audit-vault`'s own independent read of the vault section are all untouched — `§ROTATION-GATE` contains no `## LIVE COMMITMENTS`-matching heading line today, so excluding it from the floor check would currently be a no-op, but the fix stays scoped to exactly what the card's DoD asked for (marker union scan only) rather than a broader exclusion nothing requires yet.

Verified against the real vault (2026-09-15, post the `d9eb7916` doctrine landing that rotated `Orchestrator Log.md` and moved `§LIVE COMMITMENTS`/`NO-CLEARANCE-FROM-SILENCE`/`MGR122-FLOOR` out of the active doc): of the 12 markers, 5 (`Orchestrator Rules`, `OWNER-GATED`, `ROTATE AT 40 KB`, `THE SAFE-WRITE`, `MULTI-HARNESS EPIC`) resolve via `--active` directly and are unaffected by any rules-file exclusion. The remaining 7 all have a genuine home in `Orchestrator Rules.md` or `Merge Doctrine.md` OUTSIDE the excluded `927–1104` range: `THE FOUR-LEG VERIFY` (heading, line 226), `PRAISE-IS-THE-LEAST-AUDITED-INPUT` (heading, line 36), `PRE-MERGE-PAIR` (heading, line 207), `QUIET-LANE` (`Merge Doctrine.md:25`), and `LIVE COMMITMENTS`/`NO-CLEARANCE-FROM-SILENCE`/`MGR122-FLOOR` (the `§LIVE COMMITMENTS` must-carry block, heading at line 3202, items 2 and 14). None of the 12 markers' real homes fall inside the excluded section, so this fix does not red the gate on the real doc set.

## Do not

- Do not exclude only the fenced enumeration block instead of the whole `§ROTATION-GATE` section — measured insufficient above (6/12 markers still leak via the section's surrounding prose).
- Do not apply this exclusion to `--active`, to `countLiveCommitments`'s rules-text input, or to `--audit-vault`'s own read — the card's DoD scopes this to the marker union scan only, and widening it is a different, unrequested change.
- Do not re-implement the section-boundary search independently of `findHeadingLine`/`findSectionBoundary` — reusing them is what keeps this exclusion and `auditVaultSource`'s drift check unable to disagree about where the section is.
