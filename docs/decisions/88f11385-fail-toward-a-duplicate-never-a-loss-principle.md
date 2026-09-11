# 88f11385 — "fail toward a duplicate, never a loss" principle (commit, not a card)

## ⚠️ Namespace note

This id resolves as a git commit (`88f11385c2c863db682b8e0d37c9a5f0118b0d17`, `fix(pty): hold a give-up requeue and stop the purge misattributing it`, 2026-07-29), not a board card. Every `pty/host.ts` inline citation of it is bare (`principle (88f11385)`), never labelled "card" — the shape `docs/extraction-program.md`'s Step 0 warns about (a card id and a commit sha look identical) shows up instead in `docs/decisions/ccb407eb-session-message-gave-up-event-kind-and-confirmed-after-park.md`, which labels it "card 88f11385" in error (that record is a documented stop — `ccb407eb` is never to be created/extended — so leave the mislabel as-is rather than editing it). Any anchor for this id MUST use the `sha:` sigil (`@decision sha:88f11385`); a bare `@decision 88f11385` would incorrectly resolve it as a board card.

## Narrative

A recurring design principle cited at multiple sites in `pty/host.ts`'s give-up/requeue machinery: when a choice is between silently DROPPING a message and risking a DUPLICATE delivery, always fail toward the duplicate. A `hasAmbiguousMatch` content match spanning more than one distinct `batchId` (card `2b73179b`) resolves to `null` rather than guessing, and a `purgeConfirmedGiveUpRequeue` match under the same condition (card `bc0774c4`) purges nothing rather than guessing — both accept a possible extra duplicate delivery over a possible silent loss.

## Do not

- Do not resolve an ambiguous multi-`batchId` match by guessing (an age-based or first-match tie-break) to avoid a possible duplicate — a wrongly-resolved guess can silently drop or misattribute a real, undelivered message, which is strictly worse than an extra duplicate.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (`hasAmbiguousMatch`'s function doc), as of commit `aa03708339742275d878084c25a14d0392f20568`. Relocated by card `a0dc995a` (tranche 42 on `pty/host.ts`). Condensed, not verbatim.
