# 4a0af485 — `Live.ambiguousDispatches` signature purge is scoped to a single `batchId`

## Narrative

Card 4a0af485: the MINIMAL signature `Live.ambiguousDispatches` stores per still-ambiguous generation — length + the SAME cheap `fnv1a32` hash `ptyWrite`'s own log line already uses, never the full text (see that map's own doc for why).

Code review correction: an earlier draft of this comment claimed a collision is "never a false-positive purge" — WRONG, and the real vector needs no collision at all. A 32-bit hash collision between two genuinely DIFFERENT texts is ~2⁻³² and not worth carding on its own. But two GENUINELY DISTINCT messages that happen to carry byte-IDENTICAL text (P=1 if they coexist, no collision needed) land on the exact same signature too — indistinguishable from a coalesced batch's members by signature alone.

FIXED (card bc0774c4): `purgeConfirmedGiveUpRequeue` no longer purges every signature match unconditionally — every `Live.ambiguousDispatches` entry also carries a `batchId` (the `gen` every member of ONE `requeueGiveUpOrigin` call is seeded under; see that map's own doc), and a content match purges ONLY when every matched entry shares ONE `batchId`. A match spanning more than one `batchId` — the genuinely-distinct-same-text case — is left entirely untouched rather than guessed at (an age-based tie-break was considered and rejected: a batch that has already redrained under a fresh `submitGeneration` breaks the "oldest batch confirmed first" assumption — see `purgeConfirmedGiveUpRequeue`'s own doc for the concrete trace). A non-byte-identical engine echo, separately, is still only ever a false-negative MISS (a real duplicate this map could have purged is left for the FIFO-position fallback instead) — that half of the original claim holds.

## Do not

- Do not purge an `ambiguousDispatches` signature match that spans more than one `batchId` — that is the genuinely-distinct-same-text case, and purging it would drop a real, still-undelivered message.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (`textSignature`'s function doc). Relocated by card a4818d7a (tranche 1 on `pty/host.ts`); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
