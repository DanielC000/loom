# bc0774c4 — `batchId` discriminates genuinely distinct dispatches that share byte-identical text

## Narrative

Card `4a0af485`'s `ambiguousDispatches` map originally claimed a signature collision (or a non-byte-identical engine echo) could only ever be a FALSE-NEGATIVE MISS, never a false-positive purge: a miss just falls through to the existing FIFO-position fallback, no worse than before that card existed.

CORRECTION (card `bc0774c4`): that "never a false-positive purge" claim was ALSO wrong, on a separate axis — two GENUINELY DISTINCT dispatches that happen to carry byte-identical text produce two entries here with the SAME `{len,hash}` but DIFFERENT `batchId`s, and were, before this card, indistinguishable from one coalesced batch's members: one confirming hook purged BOTH.

`batchId` is what closes it — `purgeConfirmedGiveUpRequeue` now purges a content match only when every matched entry shares ONE `batchId`; a match spanning more than one is left untouched entirely rather than guessed at, restoring the "never a false-positive purge" property for real. Guessing (even an age-based tie-break) was evaluated and rejected in favor of resolving nothing — an unresolved match falls back to the existing FIFO-position logic, which is no worse than before either card existed.

## Do not

- Do not purge a content match in `ambiguousDispatches` across entries whose `batchId`s differ — that reintroduces the false-positive purge this card fixed (two distinct dispatches sharing byte-identical text wrongly treated as one coalesced batch).
- Do not resolve an ambiguous multi-`batchId` match with an age-based or other tie-break heuristic — that tradeoff was considered and rejected; leave it unresolved and let the FIFO-position fallback handle it.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (the `Live.ambiguousDispatches` field doc), as of commit 41336cdba9e3c80849be6c64c84a8d52c3c06dce. Relocated by card a2604faf (tranche 4 on `pty/host.ts`); no wording changed beyond joining wrapped source lines into a flowing paragraph and stripping `//` comment markers.
