# c02784b5 — relocating a pending occupant keeps its `placeholder` flag

From a50faa55's second Code Review. PRE-EXISTING. Shape: a50faa55's (placeholder) fixture, but clear every
teamA and W token while placeholder Y survives. Y's content is relocated from Kw's final to its own
`pending-<hash>.json` by `protectOccupantContentBeforeDelete`.

## Finding 1 — dropped `placeholder:true` (FIXED)

`protectOccupantContentBeforeDelete` builds `toPersist` from an explicit field whitelist that omitted
`placeholder`, so the relocated record had no flag on disk and `listActiveMergeQuarantines()` reported
`undefined` in-process. Consequence was cosmetic: every live reader of the flag was inert for this record,
and a reboot re-derived it from the on-disk branch text (`isPlaceholderEntryShape`). Fix: carry
`placeholder: isPlaceholderEntryShape(parsed) ? true : undefined`, reusing the shared predicate.

The carry is needed at TWO sites, both found by repro: the `toPersist` whitelist, and `readPendingDivertFileAt`
(the on-disk reader), which also omitted the flag. The relocation runs `protectOccupantContentBeforeDelete`
twice for Y (via `deleteMergeQuarantineLatchByKey` and `protectUnincorporatedOccupantBeforeDelete`); the second
write unions against the first's on-disk copy, and `unionQuarantineEntries` spreads the older side, so a
flagless reader result wiped the flag again. Fixing only `toPersist` left the final file flagless.

Test: scenario `(placeholder-relocate)` in `merge-quarantine-a50faa55-raiser-selfheal-strands-occupant-clear.mjs`,
four variants. Each site is pinned on its own, proven by `negative-control --mutant` (all BEHAVIOURAL):

- **Site (2), the reader** — pinned by the double-write variants (Y's mint rename-failed at raise time, so the
  relocation writes twice and the second union reads the first's on-disk copy). A both-sites mutant goes RED
  there (2 assertions, my own run); the Code Review reported the same for a site-(2)-only mutant (not re-run by
  me).
- **Site (1), `toPersist`** — NOT pinned by the double-write shape: the fixed reader re-supplies the flag, so a
  site-(1)-only mutant goes red=NONE there. It IS pinned by the single-write variants (no injection: one protect
  write straight from `toPersist`, nothing on disk to union with). A site-(1)-only mutant goes RED (4 failing
  assertions, single-write variants only).
- **Predicate, not a hand copy** — the legacy variants relocate a record with `branch:"(unknown — corrupt boot-time latch)"`
  and NO `placeholder` key. A mutant swapping `isPlaceholderEntryShape(parsed)` for `parsed.placeholder === true`
  at both sites goes RED (4 failing assertions, legacy variants only).

## Finding 2 — two stray `pending-*.json.tmp-<pid>-*` files (NOT CHANGED, working as designed)

They are the strays from the two rename-failed protect calls at raise time, kept on purpose (`59e758e5`),
tracked in the relocated record's `orphanLatchFiles` (`8d80b736`, `da7bf48e` rounds 3-5), and swept at Y's
full lift. After the relocation and after a reboot Y stays a single entry (not re-armed as a duplicate); the
debris only accumulates while Y stays blocked.

## Named residuals

- **UNREADABLE-variant placeholder, SITE (1) only — "unreachable by reading", not proven by repro.** The flag
  readers gated on branch text (`isUnreadablePlaceholderEntry`) need `PLACEHOLDER_BRANCH_UNREADABLE`, minted in
  memory only for an unreadable file, which `protectOccupantContentBeforeDelete` cannot read to relocate.
  **Site (2) is wider**: `readPendingDivertFileAt` feeds every pending-divert union, so it can flag an
  UNREADABLE-branch record if one is ever persisted to a pending/collision file (e.g. `writePendingDivertFile`'s
  still-unreadable divert). That is fail-closed (the flagged record gets the stricter unreadable-placeholder
  handling: re-ingest and a restart-first clear refusal), never a fail-open. Not exercised by a test.
- **`survivingSharedClaimRepoPaths` placeholder half — "theoretical", SITE (1) only.** A relocated record's
  `sourceFile` is its own pending file no other entry references; no counter-case was constructed. Site (2) can
  flag any record read from a pending/collision file, so the same scoping applies: reach is wider, effect is
  fail-closed (an extra surviving shared claim keeps a file), and no counter-case was constructed.
- **Still unpinned by any test:** the UNRESOLVED and UNREADABLE branch-text variants (only the CORRUPT text is
  exercised), and the collision-file and `rebaseOntoRealDiskRecord` reader paths (the reader site is exercised
  only through `reconcilePendingDivertTarget`'s primary-file union).

## Do not

- Do not hand-copy the placeholder condition; reuse `isPlaceholderEntryShape`.
- Do not eagerly sweep the strays at relocation time without a per-stray content-coverage proof (see `8d80b736`'s
  "tracking, not matching" rule).
