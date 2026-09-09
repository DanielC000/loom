# 78e4b3f2 — the possible-duplicate tag marks only a redelivery, never a first-time directive

## Narrative

Card 78e4b3f2 — the RECIPIENT-side half of duplicate legibility (the sender-side half, card 417cea0a, is the `[loom:redelivery-parked]`/`[loom:redelivery-confirmed]` notices). Duplicate-over-loss (`bc0774c4`) stays exactly as it is — this does not reduce or gate a single re-delivery — it only marks one so the recipient can tell it apart from genuine new direction, per that card's own recommended direction.

Applied to a re-delivery of a message whose FIRST write was never confirmed, via TWO distinct triggers: an in-session requeue (`requeueGiveUpOrigin` stamps `giveUpGen` on the kept entry; the actual call to `joinSubmittedText` happens later, at the moment of physical re-write, shared by `drainPending`'s real write and `requeueGiveUpOrigin`'s own signature-seed) or a cross-remint (`handleGiveUpExhausted`, `sessions/service.ts`, `chainDepth > 0` — applied immediately at message CREATION, before it's ever enqueued). The ORIGINAL, first-ever write of a logical message never triggers either path — see each site's own doc — so a genuine first-time directive is never marked (marking it would train recipients to discount real direction, exactly the outcome card 78e4b3f2 rules out).

`rootMsgId` is `QueuedMessage.logicalId` — stable across every requeue/re-mint (card 4a0af485) — so every re-delivery of the SAME logical message carries the SAME tag; no new identifier is minted.

## Do not

- Do not apply this tag to a genuine first-time directive — it must stay reserved for a re-delivery, or recipients would learn to discount real direction.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (`POSSIBLE_DUPLICATE_TAG_RE`/`HEX8_RE`'s top-of-const doc). Relocated by card a4818d7a (tranche 1 on `pty/host.ts`); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
