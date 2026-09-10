# c17291c3 — Platform-Lead message delivery: normalize the frame tag, then dedupe by content within a short TTL

## Narrative

`messageSessionAsPlatform` (`sessions/service.ts`) had no delivered-once guard, and that single root gap
showed up as two distinct symptoms in the wild: (a) a retried/duplicated call for the SAME directive
landing as two full duplicate turns, and (b) the directive text itself already carrying a leading
`[loom:from-platform]` line (e.g. copied from a prior framed message), so this method's own wrap doubled
it.

Both are closed here, BEFORE the shared `deliverSessionMessage` ever sees the text:

1. `stripLeadingPlatformTag` normalizes away any leading `[loom:from-platform]` line(s) already present
   in `text`, so the frame this method applies is always the only one present, however the caller wrote
   it.
2. The normalized `(recipient, text)` pair is hashed into a short-TTL dedupe key
   (`platformMessageDedupe`); a resend of the SAME directive within the window returns the ORIGINAL
   delivery result (marked `duplicate:true`) with no new enqueue — deliver-once. A genuinely different
   directive (different text, or a different recipient) always gets a fresh key and delivers normally.

## Do not

- Do not deliver a Platform-Lead `session_message` without first normalizing a leading
  `[loom:from-platform]` tag out of the caller's text — otherwise a copied prior message doubles the
  frame.
- Do not skip the short-TTL content-hash dedupe — a retried/duplicated call for the same directive must
  return the original delivery result (`duplicate:true`), not enqueue a second turn.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`messageSessionAsPlatform`'s own JSDoc), as
of `main` `598130999a62058bb22362decdf17de62f412dae`. Extracted by card `d42c8f40` (tranche 27 on
`sessions/service.ts`).
