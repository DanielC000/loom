# 4a0af485 — `Live.ambiguousDispatches`: signature purge scoped to one `batchId`, and its cap is a backstop not a rarity claim

## Signature purge is scoped to a single `batchId`

The MINIMAL signature `Live.ambiguousDispatches` stores per still-ambiguous generation — length + the SAME cheap `fnv1a32` hash `ptyWrite`'s own log line already uses, never the full text.

Code review correction: an earlier draft of this comment claimed a collision is "never a false-positive purge" — WRONG, and the real vector needs no collision at all. A 32-bit hash collision between two genuinely DIFFERENT texts is ~2⁻³² and not worth carding on its own. But two GENUINELY DISTINCT messages that happen to carry byte-IDENTICAL text (P=1 if they coexist, no collision needed) land on the exact same signature too — indistinguishable from a coalesced batch's members by signature alone.

FIXED (card `bc0774c4`): `purgeConfirmedGiveUpRequeue` no longer purges every signature match unconditionally — every `Live.ambiguousDispatches` entry also carries a `batchId` (the `gen` every member of ONE `requeueGiveUpOrigin` call is seeded under), and a content match purges ONLY when every matched entry shares ONE `batchId`. A match spanning more than one `batchId` — the genuinely-distinct-same-text case — is left entirely untouched rather than guessed at (an age-based tie-break was considered and rejected: a batch that has already redrained under a fresh `submitGeneration` breaks the "oldest batch confirmed first" assumption). A non-byte-identical engine echo, separately, is still only ever a false-negative MISS (a real duplicate this map could have purged is left for the FIFO-position fallback instead).

**Do not:**
- Do not purge an `ambiguousDispatches` signature match that spans more than one `batchId` — that is the genuinely-distinct-same-text case, and purging it would drop a real, still-undelivered message.

## `AMBIGUOUS_DISPATCH_CAP` bounds by count as a memory-safety backstop, not because give-ups are rare

`AMBIGUOUS_DISPATCH_CAP` bounds `Live.ambiguousDispatches` by COUNT, deliberately NOT by elapsed time — a real engine-confirmation lag has no known upper bound (232s measured, no ceiling established); this is an OBSERVATION-WINDOW bound, not a retry DEADLINE.

⚠️ CODE REVIEW CORRECTION (an earlier draft claimed this cap "almost never actually evicts" because "real ambiguity is rare" — WRONG): the map tracks EVER-given-up generations, not CURRENTLY-ambiguous ones — with no cleanup on resolution it grows MONOTONICALLY with every give-up event for the session's whole life, and give-ups were measured at 79%/~86% false-negative rates under load; 20 distinct give-ups in one long session is ordinary, not rare. The cap's actual safety net is `purgeConfirmedGiveUpRequeue`/`drainPending` DELETING an entry the MOMENT its own ambiguity resolves — cleaned up promptly like that, the map commonly WILL stay near-empty in practice, but that is a CONSEQUENCE of the cleanup discipline, not an independent claim about rarity. This cap is the memory-safety BACKSTOP for whatever outlives that cleanup — eviction only ever discards the OLDEST entry, correct precisely BECAUSE cleanup keeps the map append-only-but-current, not append-only-and-stale.

**Do not:**
- Do not justify this cap by claiming give-ups are rare — measured false-negative rates under load are 79%/~86%; the justification is the cleanup discipline plus a memory-safety ceiling.
- Do not convert this to a time-based bound — the map must keep listening as long as the session lives, since the lag has no known ceiling (232s measured, none established).

## Source

- `packages/daemon/src/pty/host.ts` (`textSignature`'s function doc). Relocated by card `a4818d7a` (tranche 1 on `pty/host.ts`).
- `packages/daemon/src/pty/host.ts` (`AMBIGUOUS_DISPATCH_CAP`'s top-of-const doc), as of commit `1974444dc94618d380f474192e22edff20215ec5`. Relocated by card `de94a415` (tranche 2 on `pty/host.ts`). Folded into this pre-existing `4a0af485` record (rather than a second file) after tranche 2 created a same-id collision the injector's one-record-per-id resolution can't serve.

## `logicalId` unifies two previously-separate id spaces so a late confirmation can find a duplicate across a remint

Card 4a0af485 (follow-up): `logicalId` (QueuedMessage field) is the STABLE identity of the logical content
an entry carries, unifying two id spaces that used to be separate — PtyHost's own per-enqueue `id`
(regenerated on every enqueue, including a remint) and `sessions/service.ts`'s cross-remint `rootMsgId`
(which already survives a remint, but PtyHost never saw it). `enqueueStdin` defaults `logicalId` to the
entry's own freshly-minted `id` when a caller doesn't supply one, so every caller that never plumbs one
still gets a valid, unique value — fully additive.

`enqueueDurableMessage` supplies its OWN `rootMsgId` here instead, so a value surviving a re-mint OR an
auto-joined manual resend (`hasAmbiguousMatch`) matches what PtyHost tracks in `Live.ambiguousDispatches`
— letting a late confirmation purge a duplicate from a different dispatch (a remint or resend), not just
a same-generation retry.

## Do not (2)

- Do not let `logicalId` drift from `sessions/service.ts`'s `rootMsgId` for a durable message — a mismatch
  breaks the late-confirmation purge's ability to recognize a duplicate that arrived via a different
  dispatch (a remint or a manual resend) rather than a same-generation retry.

## Source (2)

Inline comment in `packages/daemon/src/pty/host.ts` (the `logicalId` field doc on `QueuedMessage`), as of
commit `44aca27866f2409cddec99b270e5dd27a139e61c` (`fix(pty): attribute a late engine confirmation by
logical content id so a re-send cannot duplicate`). Relocated by card `3f45b7d8` (tranche 6 on
`pty/host.ts`).
