# 9eea3901 — `ConfirmMergeResult.notified` lets the tracked wrapper skip a redundant generic echo

## Narrative

`notified` (card 9eea3901, widened by 187f5b76): true iff a `[loom:merge-*]` nudge was ALREADY pushed directly to the manager during this call — on a rejection (`merged:false`) that's `!suppressed` from the return's own `rejectNotify` call (the rich `[loom:merge-rejected]`); on an ALREADY_MERGED success (`merged:true`, via `finishAlreadyMerged`) it's unconditionally `true` — that path OWNS the `[loom:already-merged]` announcement for its outcome, whether or not this particular call actually fired it (see finishAlreadyMerged's own stale-redelivery guard). `confirmWorkerMergeTracked`'s completion callback reads it to skip the redundant generic `[loom:merge-done]`/`[loom:merge-failed]` echo when the manager was already told. Left `undefined` only on the plain GREEN merge return — that path sends no direct nudge of its own, so the tracked wrapper's generic echo is the sole signal.

## Do not

- Do not have `confirmWorkerMergeTracked`'s completion callback fire its generic `[loom:merge-done]`/`[loom:merge-failed]` echo unconditionally — check `notified` first, or a manager already told via the rich `[loom:merge-rejected]`/`[loom:already-merged]` path gets a redundant duplicate.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`ConfirmMergeResult.notified`): part of the lines-397-426 block, as of commit `f9caa77e30d5c1a6dd994b6203261968c0dbf94f`. Relocated by card `8f4c8a8f`; no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
