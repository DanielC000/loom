# d005f55b — `fnv1a32Continue` extends a hash without needing the prefix's own bytes

## Narrative

Card d005f55b DoD-2: extends a fnv1a32 hash already computed over some prefix string A with additional trailing text B, producing exactly `fnv1a32(A + B)` — WITHOUT ever needing A's own bytes, only its already-computed hash. Valid because fnv1a32's accumulator `h` is folded purely via `^=`/`Math.imul`, both bitwise ops JS evaluates via ToInt32 regardless of whether the operand is held as a signed int32 or the `>>> 0`-formatted unsigned representation `fnv1a32` returns — so parsing the returned hex string back to a 32-bit int and continuing the SAME fold on B yields the identical bit pattern `fnv1a32(A + B)` would compute directly (verified: `fnv1a32Continue(fnv1a32(A), B) === fnv1a32(A + B)` for every sampled A/B pair, including the card's own gen=10/gen=11 fixture lengths).

This is what lets `Live.recentReportedTurns` retain only each generation's REPORTED length+hash — never its full text, matching `Live.ambiguousDispatches`'s existing minimal-signature discipline (see that field's own doc) — while still supporting an exact-hash "reported(prior) + written(current)" candidate in `detectComposerAccumulationOverDivergedPrior`.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (`fnv1a32Continue`'s function doc). Relocated by card a4818d7a (tranche 1 on `pty/host.ts`); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
