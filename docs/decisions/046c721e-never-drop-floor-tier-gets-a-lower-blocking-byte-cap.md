# 046c721e — never-drop floor notes get a LOWER, blocking byte cap

## Narrative

Card 046c721e implements the `5469ec08` investigation's DoD-3/4 proposal (see `docs/investigations/5469ec08-memory-digest-starvation/findings.md`): a dedicated `MAX_NEVER_DROP_TEXT_BYTES` (2000 bytes, ≈500 est-tok) for a note that is (effectively, post-write) `pinned && never-drop` — LOWER than the general `MAX_TEXT_BYTES` (4000 bytes, ≈1000 est-tok) because such a note rides EVERY future kickoff unconditionally: its byte cost is fixed overhead every session pays, not just a cost to the note's own author. The investigation measured the floor tier consuming ~91% of an 8000-tok digest budget with all 7 floor notes sized right up against `MAX_TEXT_BYTES`; halving the per-note allowance recovers roughly that much headroom for the pinned-REST and RELATED tiers going forward.

Enforced as a REJECTING write-time precondition, never an advisory: the pre-existing `neverDropStatus` signal (`computeNeverDropStatus`) is computed strictly AFTER the write already succeeds, so it could inform but never prevent this exact problem — and this project's own `shipping-a-detector-is-not-someone-reading-it` memory note found blocking preconditions acted on 2-for-2, against advisories acted on 0-for-many. This is the same evidence the investigation's DoD-3/4 proposal cited to justify a rejection over a notice.

An EXISTING floor note already over this cap is rejected on its very next update, never grandfathered — a cap that only bit brand-new notes would never converge the existing floor tier down.

**Unit trap for a future reader:** `4000` appears at both `MAX_TEXT_BYTES` here (a BYTES cap, write side) and `memory.budgetTokens`'s 4000 default (`packages/shared/src/config.ts`, a TOKENS budget, read side) — the same number, two different units, roughly 4× apart in what they mean (`estimateTokens` is ~4 bytes/token). Four notes maxed against `MAX_TEXT_BYTES` alone can exhaust an entire default read budget before anything else gets a byte; see `config.ts`'s own `memory.budgetTokens` doc comment for the arithmetic from the read side.

## Do not

- Do not treat `neverDropStatus` as a way to prevent an over-cap floor write — it is computed strictly after the write already succeeded and can never turn it into a rejection.
- Do not grandfather an existing over-cap floor note — the cap re-checks on every future touch of that key, even a metadata-only one that only changes `title`/`tags`.
- Do not fire this cap for a `never-drop`-tagged note that isn't ALSO pinned — the floor tier the packer builds is `pinned && never-drop`, and an unpinned tagged note is inert in it.

## Source

JSDoc comment above `MAX_NEVER_DROP_TEXT_BYTES` in `packages/daemon/src/mcp/memory.ts`, lines 33-49 as of commit `1cbc0d74`. Extracted by card `2329ac06` (tranche 1 on this file).
