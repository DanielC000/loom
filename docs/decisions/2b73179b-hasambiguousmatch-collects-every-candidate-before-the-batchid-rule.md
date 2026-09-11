# 2b73179b — `hasAmbiguousMatch` collects every candidate before applying the single-`batchId` rule

## Narrative

`hasAmbiguousMatch` reads `Live.ambiguousDispatches` for the SAME hazard `purgeConfirmedGiveUpRequeue`'s own `batchId` guard (card `bc0774c4`) exists for: a content match spanning more than one GENUINELY DISTINCT give-up event (two different `batchId`s) is not attributable by content alone — no hash collision needed, P=1 once two such entries coexist.

BUG (pre-fix): this method returned the FIRST match in `Map` insertion order — silently reimplementing the exact oldest-first tie-break `purgeConfirmedGiveUpRequeue`'s own doc records as CONSIDERED AND REJECTED, refutable by a concrete trace, not merely "usually right."

FIX (commit `aa037083`, `fix(pty): fail closed in hasAmbiguousMatch on a multi-batch resend match`): collect EVERY candidate `logicalId` that matches any of the four signature shapes (`{len,hash}`/`memberSig`, each as-is and tag-marked), then apply the identical single-`batchId` rule across the WHOLE set — a match spanning more than one batch resolves to `null` (refuse to guess) instead of the first hit. A caller with no reliable target self-roots a fresh, disconnected chain rather than being silently joined to the wrong one, per this project's own "fail toward a duplicate, never a loss" principle (`sha:88f11385`) — the SAME trade `purgeConfirmedGiveUpRequeue` already makes. Multiple matches sharing ONE `batchId` (the ordinary coalesced-batch case, including every single-member batch) are unaffected: returns that shared id, same as before.

## Do not

- Do not resolve `hasAmbiguousMatch`'s candidate set by first-match/insertion order — that silently reimplements the oldest-first tie-break already considered and rejected for the sibling purge path.
- Do not guess an attribution across a multi-`batchId` match — resolve to `null` and let the caller self-root a fresh chain.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (`hasAmbiguousMatch`'s function doc), as of commit `aa03708339742275d878084c25a14d0392f20568` (`fix(pty): fail closed in hasAmbiguousMatch on a multi-batch resend match`, 2026-09-02). Relocated by card `a0dc995a` (tranche 42 on `pty/host.ts`). Condensed, not verbatim.
