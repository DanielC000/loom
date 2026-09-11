# bc0774c4 — `batchId` discriminates genuinely distinct dispatches that share byte-identical text

## Narrative

Card `4a0af485`'s `ambiguousDispatches` map originally claimed a signature collision (or a non-byte-identical engine echo) could only ever be a FALSE-NEGATIVE MISS, never a false-positive purge: a miss just falls through to the existing FIFO-position fallback, no worse than before that card existed.

CORRECTION (card `bc0774c4`): that "never a false-positive purge" claim was ALSO wrong, on a separate axis — two GENUINELY DISTINCT dispatches that happen to carry byte-identical text (no hash collision needed, P=1 once two such entries coexist — see `textSignature`'s own doc) produce two entries here with the SAME `{len,hash}` but DIFFERENT `batchId`s, and were, before this card, indistinguishable from one coalesced batch's members: one confirming hook purged BOTH. This closes the residual the card's own body originally documented as accepted: that genuinely-distinct-but-same-text is indistinguishable from coalesced-together by signature alone.

`batchId` is what closes it — `purgeConfirmedGiveUpRequeue` now purges a content match only when every matched entry shares ONE `batchId`; a match spanning more than one is left untouched entirely rather than guessed at, restoring the "never a false-positive purge" property for real. Guessing (even an age-based tie-break) was evaluated and rejected in favor of resolving nothing — an unresolved match falls back to the existing FIFO-position logic, which is no worse than before either card existed.

## Do not

- Do not purge a content match in `ambiguousDispatches` across entries whose `batchId`s differ — that reintroduces the false-positive purge this card fixed (two distinct dispatches sharing byte-identical text wrongly treated as one coalesced batch).
- Do not resolve an ambiguous multi-`batchId` match with an age-based or other tie-break heuristic — that tradeoff was considered and rejected; leave it unresolved and let the FIFO-position fallback handle it.

## The concrete trace that refutes an age-based tie-break

The rejected heuristic: purge whichever matched `batchId` is numerically smallest, i.e. the oldest give-up. This is refutable by a concrete trace, not merely "usually right":

Consider batch A (older) and batch B (younger), both genuinely ambiguous and held, sharing a signature. If B's own held entry redrains on its normal hold-expiry path — an ordinary, unremarkable event this class already handles (`isGiveUpHeld`/`GIVE_UP_HOLD_MS`) — it resubmits under a brand-new `submitGeneration`, and when that resubmission's own hook confirms normally, the confirming hook's content still matches BOTH A's and B's stored signatures (B's stale `ambiguousDispatches` entry is not cleared by a plain successful resubmission — only an explicit purge clears it). An age-based tie-break (purging the numerically-smaller, older `batchId`) would purge A here — a message that was NEVER actually confirmed — while leaving B's own (truly resolved) entry to linger unpurged. That is loss through a narrower door than the one this card was originally carded for, not a fix.

When a content match spans more than one `batchId`, `purgeConfirmedGiveUpRequeue` purges NONE of the matched entries — each is left exactly as it was, to be resolved later once the competing batch has separately resolved (making a future same-content hook a single-`batchId` match again) or via its own bounded give-up hold. It still returns `true` rather than falling through to the FIFO-position fallback: that fallback is content-blind (purges by queue position alone) and running it here could purge a `live.pending` entry whose text doesn't even match `reportedPrompt` (the confirming hook's own reported prompt) — strictly worse than resolving nothing.

Per this project's own "fail toward a duplicate, never a loss" principle (`sha:88f11385`): resolving nothing here is the unconditional-safe choice over a heuristic that is right most of the time — worst case, both batches eventually redrain on their own bounded holds and one becomes a genuine duplicate delivery, never a silently resolved-and-dropped row.

## Do not (2)

- Do not fall through to the FIFO-position fallback when a content match spans more than one `batchId` — that fallback is content-blind and could purge an entry whose text doesn't match the confirming hook at all.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (the `Live.ambiguousDispatches` field doc), as of commit 41336cdba9e3c80849be6c64c84a8d52c3c06dce. Relocated by card a2604faf (tranche 4 on `pty/host.ts`); no wording changed beyond joining wrapped source lines into a flowing paragraph and stripping `//` comment markers.

## Source (2)

Inline JSDoc in `packages/daemon/src/pty/host.ts` (`purgeConfirmedGiveUpRequeueCore`'s own method doc, the "CARD bc0774c4 — BATCH-PROVENANCE DISCRIMINATION" paragraph), as of commit e17a8c2af20b2da570967744ef4e5f7f5f020fa0. Extracted by card 47021afd (tranche 44 on `pty/host.ts`); condensed and reworded, not verbatim.
