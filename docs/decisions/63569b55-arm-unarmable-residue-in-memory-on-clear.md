# 63569b55 — a clear arms a content-kept UNARMABLE tmp residue in memory, salvaging the file's own tokens

From the Code Review of `0f58a09a` (finding S2). Sibling of `0f58a09a`, `f8e11853` and `1dd00dca`.

## The bug (run RED before the fix)

A tmp residue that names repo X but lacks `branch`/`reason` (so it can never be armed as a real record) was
fail-closed on a REBOOT (`0f58a09a` places a placeholder at key(X)), but a clear that content-kept it
(`f8e11853`'s cross-hash path, or the same-hash loop) left X OPEN until the next reboot: an in-process / reboot
split, exactly what `f8e11853`'s governing invariant forbids. Repro: X a ghost subdir of Y, X's branchless tmp
misfiled at an innocent R's hash, `clear(y)`: in-process `assertRepoNotQuarantined(X).ok === true`; a snapshot
reboot gives `false` (and re-blocks Y via key(Y)). The `unarm-neg` scenario in
`merge-quarantine-f8e11853-freed-key-cross-hash-residue.mjs` pinned that split; this card flips it.

## The fix

`orphanSweepSafeToDelete` additively returns `unarmablePlaceholder` when the record is unarmable, still unsafe
(a surviving token), and names a non-empty ABSOLUTE `repoPath`: a `placeholder:true` entry
(`PLACEHOLDER_BRANCH_CORRUPT`) carrying the file's SURVIVING tokens. Both unarmable sites of
`sweepTmpResidueForHashIfUnreferenced` (same-hash and cross-hash loops) feed `armable ?? unarmablePlaceholder`
into the EXISTING `armableByIdentity` bucket, so the arm goes through `armForeignOrphanContentInMemoryIfUnenforced`
only: an enforced identity or occupied key is a plain skip (never a union), the clearer's own identity
(`excludeIdentities`) is never offered, and the disposition then flows through `classifyKeptRepoPath`, so X is
reported as a `stillBlockedCoOccupant` instead of content-kept. In-memory only; no new unlink site; nothing is
written to disk by the arm.

## Why in-process SALVAGES tokens while boot mints a fresh one (the key ruling)

Boot (`0f58a09a`) arms a placeholder with a FRESH token, durably writes it, and THEN unlinks the tmp, so the
tmp's own token never has to be covered. In-process the tmp stays on disk (no durable write in the clear sweep,
per `1dd00dca`). A fresh-token placeholder cannot cover the kept file's token, so
`orphanSweepSafeToDelete` never deletes it: a later `clear(y)` lifts nothing, `clear(x)` reports X open with the
tmp still there, and a reboot re-blocks BOTH X and Y: cleared in-process, blocked after reboot, the same split
reversed. Salvaging the file's own tokens makes the placeholder clearable against the tmp: a second `clear(y)`
or `clear(x)` lifts X (and Y, which shares the key), the existing sweep deletes the tmp, and a reboot stays
clear. Verified RED/GREEN on a scratch prototype before the fix.

## Intended behaviour: the ghost-subdir case

X a ghost subdir of Y shares key(Y). `clear(y)` lifts Y's own raise, but X's placeholder re-blocks the key, so Y
reads blocked right after the first clear: the same verdict a reboot gives, and `stillBlockedCoOccupants` names
X. Un-stick it with one more `clear(y)` or `clear(x)`; both lift X and Y and delete the tmp.

## Residual

A residue with no salvageable token holds nothing to enforce (`onDiskTokens.every` over an empty set is `safe`),
so the existing sweep deletes it, unchanged. A relative/empty `repoPath` is never an identity (`0f58a09a`), so it
is never armed. The orphan `.json` twin (`orphanLatchFileSweepDecision`) and the PASS 1 final-read /
safety-tmp siblings `0f58a09a` lists are not touched; `unarmablePlaceholder` is only read by the tmp sweep.

**Mixed-bucket residual (named, accepted).** When X has BOTH an armable and an unarmable tmp, the in-process
union carries the salvaged placeholder tokens too, while boot folds the placeholder into X's real record with
X's real tokens unchanged. So a token-scoped clear of X's real token leaves X blocked in-process but lifted
after a reboot. That is the safe direction (more conservative in-process), and an identity-wide clear of X
fixes it. Today's composition is not asserted by a dedicated test.

**Unresolvable X** (its ghost dir absent) is armed into the PENDING tier from the kept tmp, the tmp stays on
disk, and a reboot agrees (scenario G). The same-hash arm site is pinned separately from the cross-hash one
(scenario F); reverting only that site turns F RED.

## Do not

- Do not give the in-process placeholder a fresh token: it cannot cover the kept tmp, so the identity can never
  be cleared in-process durably (it comes back after a reboot).
- Do not write or unlink anything in the arm. The tmp is deleted only by the existing clear sweep once its
  tokens are covered, or by boot after the placeholder is durable.
- Do not arm the clearer's own identity (`excludeIdentities`), a relative `repoPath`, or an already-enforced
  identity/occupied key (plain skip, never a union).
