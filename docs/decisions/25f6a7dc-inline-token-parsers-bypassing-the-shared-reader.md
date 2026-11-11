# 25f6a7dc — three inline token parsers still bypassed the shared reader; one FAILS OPEN

_Split out of the former single `8db913e2` record by card `3608937e` so each record's injected Do-not extract fits the per-record cap; every section below is verbatim from it (pinned blob `2f1a55286d01`). The core record keeps the card's own rounds 1 and 3 and holds the index of every split-out record (rounds 2 and 4 of the card are in `sha:d529d42d`, record `d529d42d-raise-divert-rounds-2-and-4-chokepoint-union-and-in-memory-repoint.md`): `8db913e2-raise-diverts-instead-of-overwriting-a-kept-occupant.md`._

## Follow-up 25f6a7dc (Code Review of 5b55149b) — three inline token parsers still bypassed the shared reader; one FAILS OPEN

Pre-existing, not introduced by `578b6d5a`. Reachability was roughly nil (no current writer emits
`tokens: []`), but one of the three fails open. Three inline token parsers re-derived the SAME
`tokens`/`token` parse `readSurvivingOnDiskTokens` already centralizes, and so never got `5b55149b`'s own
`length > 0` legacy-fallback fix — each lacked both halves of the shared reader's contract: the legacy
fallback AND the `clearedTokens` subtraction.

- **`markedFinalFullyCoveredByClear` (~L1309), FAIL-OPEN.** `[].every(...)` is vacuously `true`. A marked
  `final` holding a legacy token X (`{tokens:[], token:X}`) not in `candidateTokens` read as "fully
  covered" — its callers (`deleteMergeQuarantineLatchByKey`, `sweepOwnLatchFileUnlessOwnedElsewhere`) then
  unlinked a file boot recovery would have re-armed with X.
- **`unincorporatedOccupantRepoPathAt` (~L734) and `resolveRaiseOverwrite`'s own "already incorporated"
  check (~L1833), FAIL-CLOSED.** The same missing legacy fallback meant a legacy-shaped `final` whose
  token was ALREADY part of the clearer/raiser's own in-memory tokens never matched the "already
  incorporated" token-overlap exemption — falling through to `{state:"occupant"}` and minting a redundant
  protect copy-aside for a token that needed none.

### The open question, and the ruling

The card asked whether `markedFinalFullyCoveredByClear`'s own coverage proof should test `raw` or
`surviving` (does a cleared-but-still-on-disk token count as covered?). **Ruling: test the RAW on-disk
tokens, minus nothing** — a raw token is covered only if it is in `candidateTokens` (being cleared by THIS
clear) OR already in `clearedTokens` (deliberately released earlier this process). This is numerically
identical to `surviving.every(candidateTokens.includes)` (every raw token is either tombstoned, and so
absent from `surviving`, or present in `surviving` and must then satisfy `candidateTokens`) — the explicit
raw-plus-OR form is preferred because it states the "or already cleared" reasoning at the call site instead
of hiding it inside a pre-filtered array a future reader could mistake for "nothing subtracted." Empty raw
tokens with no legacy token (`{tokens:[]}` / `{}`) still read as vacuously covered under this rule — this
is NOT a regression: nothing is lost (there is no token to lose), and the `crnit2` fixture (Follow-up
`0dc514dc`, Round 3) already established that a `{}`-content placeholder's own structural dependents are
protected separately, by `survivingSharedClaimRepoPaths`'s own `sourceFile` check, which `deleteMergeQuarantineLatchByKey`
runs UNCONDITIONALLY after `provenCoverage` and which a vacuous content-coverage result never overrides.
**This disjunct is also an intentional fix, not merely a side effect, for an ORDINARY non-empty marked
`final` whose on-disk array mixes a still-owed token with one already tombstoned** — without it, the stale
tombstoned entry alone kept the file on disk fail-closed, and BOTH tokens resurrected from its own stale
bytes after a reboot (Code Review `6dac0fe9`'s own probe A). It is sound under the tombstone invariant:
`tombstoneIfNotSurviving` only ever tombstones a token once no surviving record — active or pending —
holds it, so `clearedTokens.has(t)` being true is itself the proof that nothing still needs `t` protected.

### The fix

All three sites now call `readSurvivingOnDiskTokens` instead of re-deriving the parse:
- `unincorporatedOccupantRepoPathAt` and `resolveRaiseOverwrite`'s "already incorporated" check both use
  `.raw` — an overlap/containment check that already excludes by identity (or, for `resolveRaiseOverwrite`,
  compares against `ownTokens`) has no further use for the `clearedTokens` subtraction; `.raw` is what a
  legacy-shaped file's own real on-disk content actually is.
- `markedFinalFullyCoveredByClear` uses `.raw` too, per the ruling above, with the `candidateTokens.includes(t)
  || clearedTokens.has(t)` OR explicit at the call site rather than relying on `.surviving`'s own silent
  subtraction.

### Tests

`merge-quarantine-raise-protect-failure.mjs`:
- **`25f6a7dc-l1318`** — the FAIL-OPEN repro: same shape as `95ea8d3f-adversarial`, but the still-owed
  extra token rides the LEGACY singular `token` field behind an empty `tokens` array rather than the array
  form. Asserts `final` is KEPT (coverage not proven), byte-for-byte unchanged, and the legacy token
  survives a fresh-import reboot.
- **`25f6a7dc-l751`** / **`25f6a7dc-l1856`** — the FAIL-CLOSED repro, once for each site: a resolvable
  subdirectory `d` raises first (takes the existing-branch identity), then `final` is hand-rewritten to a
  stale leftover naming a DIFFERENT, unresolvable identity `z` (sharing the same degraded key) but still
  holding `d`'s own real token in legacy singular form. `l751` reaches `unincorporatedOccupantRepoPathAt`
  directly (no injected failure); `l1856` forces past `resolveRaiseOverwrite`'s own fast path via an
  UNRELATED transient read failure on only the FIRST read of `final` (classified `"unknown"` by the
  existing-branch's own `protectUnincorporatedOccupantBeforeDelete` call), so its OWN direct re-read — not
  that first, already-failed one — is what reaches the "already incorporated" check. Both assert NO
  pending-divert record is ever minted for `z` (`pendingDivertFilenameFor(z)` never exists on disk), and
  that the token does not resurrect under `z`'s own bogus identity after a reboot.
- **`25f6a7dc-tombstoned`** — `{tokens:[], token:X}` with X already tombstoned (released via a wholly
  unrelated scratch raise+clear). A PIN, not a discriminator: `protectOccupantContentBeforeDelete`'s own
  pre-existing (`7a7e041b`) skip-when-fully-tombstoned logic already handles this correctly downstream of
  either site, with or without this card's fix — reachable through the SAME existing-branch shape as
  `l751`/`l1856`. Asserts no pending record survives for the stale identity and X is never resurrected.
- **`25f6a7dc-no-token`** — `{tokens:[]}` with NO legacy token at all. Another PIN: `readSurvivingOnDiskTokens`'s
  own `raw` stays genuinely empty either way (nothing to recover), so `protectOccupantContentBeforeDelete`'s
  pre-existing random-token fallback (`survivingTokens.length > 0 ? survivingTokens : [randomUUID()]`)
  still fires, unchanged. Asserts a pending record IS minted (the stale identity's own `repoPath`/`branch`/
  `reason` are genuine content worth protecting) carrying a freshly-minted token, never an empty array.
- **`25f6a7dc-probeA`** (Code Review `6dac0fe9`'s own probe A) — proves the disjunct ALSO matters for an
  ORDINARY non-empty array, not just the empty-array legacy shape. A resolvable identity `dA` raises first
  (existing-branch); a second raiser unions into it while `final`'s read fails transiently (marking the
  basename, same shape as `l751`/`l1856`); `final`'s own stale bytes are then hand-rewritten to mix the
  still-owed token (`A-d`) with a token (`T`) already tombstoned via a wholly unrelated scratch raise+clear.
  Asserts `final` is UNLINKED (not kept) once cleared, and that neither `A-d` nor `T` resurrects after a
  fresh-import reboot. The raiser's own merged token is NOT a discriminator here — it diverted to its own
  separate pending-divert file (the same shape `l751`/`l1856` exercise) and is swept through that mechanism
  regardless of this disjunct, so its own reboot check passes on both sides, as expected, and is kept as a
  control rather than removed.

`25f6a7dc-l1318`'s three discriminating assertions, `25f6a7dc-l751`/`25f6a7dc-l1856`'s two discriminating
assertions each, and `25f6a7dc-probeA`'s three discriminating assertions (ten total) proven RED on `HEAD`
(pre-fix; `25f6a7dc-probeA` proven RED on `HEAD~1`, since it postdates the initial commit — see below) and
GREEN after, via `scripts/negative-control.mjs` — the RED phase fails exactly those ten assertions with the
build succeeding on both sides, so the RED is behavioral, not a build failure. `25f6a7dc-tombstoned` and
`25f6a7dc-no-token` pass on both sides, as expected for a pin, not a discriminator. All 33
`merge-quarantine*.mjs` files re-verified individually, each exit 0. All static guards
(`pnpm --filter @loom/daemon guards`) re-verified green (30/30). Line endings re-verified CR==LF (no
`sed -i` used; every edit was an in-place `Edit` call, which preserves existing endings).
