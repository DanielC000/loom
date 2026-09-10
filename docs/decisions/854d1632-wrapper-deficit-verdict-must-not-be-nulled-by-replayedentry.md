# 854d1632 — the benign-wrapper-deficit verdict must not be nulled by `replayedEntry !== undefined`

## Narrative

Card `854d1632` v5 (measured, not a guess): `confirmedWrapperDeficit` deliberately does NOT require `replayedEntry === undefined`, unlike `confirmedFusion`/`confirmedDivergedPrior`. A benign wrapper deficit IS, essentially by construction, a recognized replay — the stale, out-of-order confirmation of an EARLIER bare write naturally matches that earlier write's own recorded text byte-for-byte, so `replayedEntry` is non-null in EXACTLY the case this verdict exists to explain.

Gating on `replayedEntry === undefined` here reproduced the card's own live incident: the classifier fired (its own diagnostic log line ran) but the session-facing notice still took `lossClause`'s "ESTABLISHED loss" branch, because `replayedEntry !== undefined` nulled this verdict first. Safe to reorder past `confirmedFusion`/`confirmedDivergedPrior` without touching either's own `replayedEntry === undefined` guard: both are ALREADY always null whenever `replayedEntry !== undefined` (it's baked into their own conditions), so `!confirmedFusion && !confirmedDivergedPrior` alone still correctly defers to either when one applies — nothing here changes their own precedence.

For the underlying wrapper-deficit MECHANISM itself (why this is a stale out-of-order confirmation and not corruption or loss) see card `d005f55b`'s own record, §4 — this record covers only the precedence-ordering bug and its fix in the notice-classification chain, a separate decision from the mechanism §4 documents.

## Do not

- Do not gate `confirmedWrapperDeficit` on `replayedEntry === undefined` — a benign wrapper deficit is, by construction, almost always a recognized replay, so that guard nulls the verdict in exactly the case it exists to explain.
- Do not assume reordering this verdict ahead of `confirmedFusion`/`confirmedDivergedPrior` changes their own precedence — both already require `replayedEntry === undefined` in their own conditions, so they stay correctly deferred to.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (`deliverHook`'s `UserPromptSubmit` case, the `confirmedWrapperDeficit` local). Extracted by card `96bf8f32` (tranche 22 on `pty/host.ts`); wording condensed, content preserved.
