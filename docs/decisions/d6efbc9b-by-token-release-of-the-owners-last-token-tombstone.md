# d6efbc9b — a by-token release of the owner's LAST token could leave it un-tombstoned

_Split out of the former single `8db913e2` record by card `3608937e` so each record's injected Do-not extract fits the per-record cap; every section below is verbatim from it (pinned blob `2f1a55286d01`). The core record keeps the card's own rounds 1 and 3 and holds the index of every split-out record (rounds 2 and 4 of the card are in `sha:d529d42d`, record `d529d42d-raise-divert-rounds-2-and-4-chokepoint-union-and-in-memory-repoint.md`): `8db913e2-raise-diverts-instead-of-overwriting-a-kept-occupant.md`._

## Follow-up d6efbc9b (CR4 of this card, finding 1) — a by-token release of the owner's LAST token could leave it un-tombstoned

CR4 found that `clearActiveEntryTokenAtKey`'s last-token branch (the owner releases its only remaining
token) hands off ENTIRELY to `clearMergeQuarantineByKey`, whose own `tombstoneIfNotSurviving` call is
gated by condition (b) on `touchedFinalBasenames` for the PHYSICAL FINAL it's deciding whether to
destroy. If that final's read fails during this exact clear, (b) correctly keeps the final (fail-closed —
`63e49ee2`'s own accepted residual) and returns early WITHOUT tombstoning — but the token the owner just
RELEASED is a separate fact from the final's own fate, and it was never tombstoned either.

Repro (CR4's own scratch probe Z3, commit `cb461f56`, ported as `d6efbc9b-z3` in
`merge-quarantine-raise-protect-failure.mjs`):
1. `t1 = enterMergeQuarantine(R)` — R's only token.
2. Fail read #1 of R's own `final`; `clearMergeQuarantineByToken(R, t1)` — R is lifted IN-PROCESS (the
   last-token branch's own in-memory removal), but `final` is kept-and-marked, still physically holding
   `[t1]`, and `t1` is never tombstoned.
3. `t2 = enterMergeQuarantine(R)`, no injection — the fold-in reads `final`'s still-kept, still-`[t1]`
   bytes and re-unions the released `t1` back in, both in-process and on disk.
4. `clearMergeQuarantineByToken(R, t2)` — R stays quarantined by `t1`, which nobody holds, until a human
   clears it by hand.

### The fix

After `clearMergeQuarantineByKey(key, entry.repoPath)` returns in `clearActiveEntryTokenAtKey`'s
last-token branch, call `tombstoneIfNotSurviving([token])` unconditionally (no touched list) — matching
`clearPendingEntryByToken`'s own last-token branch (which already does this directly). This is not a
second, special-cased rule: it is `tombstoneIfNotSurviving`'s one invariant, applied a second time to a
second question. `clearMergeQuarantineByKey`'s own call answers "is the physical final destroyed, and if
not, why" (gated by (b) on the final's own kept-marked state); this call answers "is the owner's own
`token` gone" (tokens are process-unique UUIDs, so (a)'s surviving-record scan is sufficient on its own —
the final's fate is irrelevant to whether `token` itself survives anywhere). Both corrected doc comments
(`tombstoneIfNotSurviving`'s own jsdoc, and this record's own round-4 "Do not" bullet below) previously
claimed every by-token clear site passes no `touchedFinalBasenames` and never special-cases — true of
`clearPendingEntryByToken` and of the non-last-token branches, but not of this one delegated call.

### Tests

`d6efbc9b-z3` in `merge-quarantine-raise-protect-failure.mjs` — asserts R is lifted in-process after the
read-failure-gated release, that a fresh same-identity re-raise does NOT resurrect the released token
in-process, that releasing the second token fully lifts R in-process, and that neither token is
resurrected after a reboot through a fresh module import (never `assertRepoNotQuarantined`). Proven RED
on `d529d42d` (this card's own rounds 1-4, squashed) and GREEN after, via `scripts/negative-control.mjs`. CR3's own
`round4-y` scenario (a clear that successfully protect-copies a FOREIGN occupant aside must never
tombstone it) re-verified green, unaffected by this change — it exercises `clearMergeQuarantineByKey`'s
own full-clear path directly, never the by-token last-token branch this follow-up touches. All 33
`merge-quarantine*.mjs` files re-verified individually, each exit 0. All static guards
(`pnpm --filter @loom/daemon guards`) re-verified green.

## Do not

- **(Round 4; CORRECTED by Follow-up `d6efbc9b`)** The original text of this bullet said neither by-token
  route ever needs a second, unconditional `tombstoneIfNotSurviving` call, since each already calls the
  shared helper right after its own in-memory token-removal. That is still true of
  `clearPendingEntryByToken`'s own last-token branch — but FALSE of `clearActiveEntryTokenAtKey`'s own
  last-token branch, which hands off entirely to `clearMergeQuarantineByKey` and never calls the helper
  itself at all; that delegated call's own `touchedFinalBasenames`-gated tombstone can leave the
  owner-released token un-tombstoned (see "Follow-up d6efbc9b" above). Do not remove that branch's own
  SECOND, unconditional call (no touched list) on the theory that it duplicates the shared helper's
  single invariant — it is the same invariant, correctly applied twice, to two different questions.
