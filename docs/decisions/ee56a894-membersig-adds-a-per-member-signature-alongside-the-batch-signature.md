# ee56a894 — `memberSig` adds a per-member signature alongside the batch-joined `submittedSig`

## Narrative

Card `ee56a894`: `requeueGiveUpOrigin` seeds each requeued `QueuedMessage`'s `ambiguousDispatches` entry
with a SECOND signature, `memberSig` — THIS member's own text alone, transformed the SAME way
`joinSubmittedText` transforms each element before joining it (`annotatedMessageText`, not a bare
`.text`). For the common single-member origin, `memberSig` is byte-identical to the batch's own
`submittedSig` (joining one element is that element itself); it diverges only once a batch actually has
2+ members.

This is purely ADDITIVE — `submittedSig` is never replaced. `hasAmbiguousMatch` is the only consumer that
reads `memberSig` (so a manual resend can match on ITS OWN text against one member of a coalesced batch,
not just the batch's joined text). `purgeConfirmedGiveUpRequeue`'s engine-echo match still keys off
`submittedSig` alone, unchanged.

## Do not

- Do not read `memberSig` as a replacement for `submittedSig` — it is an additional, narrower-scoped
  field for one specific consumer (`hasAmbiguousMatch`), not a general substitute.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (`requeueGiveUpOrigin`'s per-member loop), as of
commit `a268b494` (`fix(pty): match a resend on per-member signature after a coalesced give-up`).
Relocated by card `aa4c131b` (tranche 41 on `pty/host.ts`). Condensed, not verbatim.
