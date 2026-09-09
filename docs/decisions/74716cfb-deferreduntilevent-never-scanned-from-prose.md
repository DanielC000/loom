# 74716cfb — `DeferredUntilEvent` is a structured field because prose-scanning `deferredReason` was proven unsound

## Narrative

Card 74716cfb added `Task.deferredUntilEvent` — a structured annotation naming the exact event (`kind`/`key`) a deferred card is waiting on, so a gate-outcome nudge (`sessions/service.ts`'s `[loom:merge-rejected]`/`[loom:gate-failed]` composition) can point a reader at it the moment that event fires.

The field exists as a separate, agent-set structure rather than being derived by scanning `deferredReason`'s free-text prose for a matching name, because that approach was tried and proven unsound on this board's own data: a `deferredReason` can NAME a file or event it already swept with a NEGATIVE result (e.g. "checked X, not the cause"), which a prose scanner would misattribute as the thing being waited on.

## Do not

- Do not derive `deferredUntilEvent` (or anything like it) by scanning `deferredReason` prose for a matching name — a reason can name something it already ruled out, and a scanner cannot tell the difference.

## Source

JSDoc comment in `packages/shared/src/types.ts` (`DeferredUntilEvent`'s own doc). Extracted by card 04705438 (tranche 2 on `packages/shared/src/types.ts`); reworded into flowing prose (the connecting sentence was restructured), but the concrete specimen — the "NAME a file it swept with a NEGATIVE result" example — is carried verbatim.
