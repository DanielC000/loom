# 74716cfb — `DeferredUntilEvent` is a structured field because prose-scanning `deferredReason` was proven unsound

## Narrative

Card 74716cfb added `Task.deferredUntilEvent` — a structured annotation naming the exact event (`kind`/`key`) a deferred card is waiting on, so a gate-outcome nudge (`sessions/service.ts`'s `[loom:merge-rejected]`/`[loom:gate-failed]` composition) can point a reader at it the moment that event fires.

The field exists as a separate, agent-set structure rather than being derived by scanning `deferredReason`'s free-text prose for a matching name, because that approach was tried and proven unsound on this board's own data: a `deferredReason` can NAME a file or event it already swept with a NEGATIVE result (e.g. "checked X, not the cause"), which a prose scanner would misattribute as the thing being waited on.

## The join-key appendix rides both gate-outcome nudges via one shared variable

`deferredTriggerNotice` (`orchestration/deferred-trigger-notice.ts`) builds the `[loom:deferred-trigger]`
notice appendix — its own doc states a binding constraint: it must be wired at BOTH gate-outcome nudge
composition sites in `sessions/service.ts` (the merge-confirm `[loom:merge-rejected]` and the worker
self-check `[loom:gate-failed]`), since a partial rollout to only one of the two sibling nudges is the
exact failure this mechanism exists to prevent.

At the merge-confirm rejection site, the appendix is appended into `detailText` itself — not tacked onto
the `rejectNotify` call as a separate string — so it rides BOTH downstream consumers of that one variable:
the rich `[loom:merge-rejected]` notify AND the generic `[loom:merge-failed]` completion echo (see
`522cf573`'s own record for why those two already share `detailText`). It is byte-identical (an empty
string) whenever no task's own `deferredUntilEvent` names one of the settled op's failed files.

## Why `deferredTriggerNotice` reads `db.listTasks` instead of a bespoke query

It reads `db.listTasks` (the plain project-scoped read every other board tool already uses) rather than
a bespoke query — this only ever runs on a gate FAILURE, never a hot path, and a project's
`deferredUntilEvent`-carrying cards are expected to be a small minority of its board.

## Do not

- Do not derive `deferredUntilEvent` (or anything like it) by scanning `deferredReason` prose for a matching name — a reason can name something it already ruled out, and a scanner cannot tell the difference.
- Do not wire the `[loom:deferred-trigger]` appendix at only one of the two gate-outcome nudge composition sites — a partial rollout is the exact failure this mechanism exists to prevent.
- Do not tack the appendix onto the rejection notify as a separate string at the merge-confirm site — append it into the shared `detailText` variable so both of that variable's consumers carry it.
- Do not give `deferredTriggerNotice` a bespoke query for its own performance — reuse `db.listTasks`; it only ever runs on a gate failure, never a hot path.

## The same card also made `runWorkerGate`'s settle callback async, to await the join-key read (separate decision, same card id, `sessions/service.ts` async-conversion)

Card 74716cfb also converted `runWorkerGate`'s `onSettledAfterPending` callback from sync to async, to
`await readFailedNamesForOp(opId)` before composing the `[loom:gate-failed]` nudge's deferred-trigger
appendix above. Safe for the CALLER as originally reasoned: `PendingOpRegistry.attach` invokes it
fire-and-forget with no `await` of its own, and its `=> void` declared type is one TypeScript accepts from
an async function like every other void-typed callback here already does (e.g. the analogous merge-settle
callback's own `enqueueDurableMessage` calls never await anything either) — so going async changes nothing
about the CALLER's own ordering or error handling.

⚠️ That "changes nothing" claim was later corrected: see
[[c4b70fe8-async-callback-safe-for-caller-not-for-observers]] for why it is true about the caller and false
about every OBSERVER of this op's settle state, plus the dependency it creates on `worker-run-gate.mjs`'s
scenario (K).

## Do not (2)

- Do not read this site's original "changes nothing about ordering" claim as covering observers of the op's
  settle state — see the linked `c4b70fe8` record for the corrected scope.

Source (this section only): inline comment in `packages/daemon/src/sessions/service.ts`, `runWorkerGate`'s
`onSettledAfterPending` callback declaration, commits `691a2184` (original) and `ab325cc8` (the `c4b70fe8`
wording correction). Not the same decision as the join-key-appendix narrative above — shared card id only.

## Source

JSDoc comment in `packages/shared/src/types.ts` (`DeferredUntilEvent`'s own doc). Extracted by card 04705438 (tranche 2 on `packages/shared/src/types.ts`); reworded into flowing prose (the connecting sentence was restructured), but the concrete specimen — the "NAME a file it swept with a NEGATIVE result" example — is carried verbatim.

The join-key-appendix section above: inline comment in `packages/daemon/src/sessions/service.ts`,
`confirmWorkerMerge`'s gate-rejection return (~line 13298), as of this tranche's HEAD, plus the doc
comment in `packages/daemon/src/orchestration/deferred-trigger-notice.ts` (read for the "both sites"
binding constraint). Condensed and reworded, not verbatim.

The "Why `deferredTriggerNotice` reads `db.listTasks`" section above: doc comment above
`deferredTriggerNotice` in `packages/daemon/src/orchestration/deferred-trigger-notice.ts`, originally
lines 19-21, as of this tranche's HEAD. No wording changed. The rest of that file's doc comment (the
`readFailedNamesForOp` join-key description, the return-value contract, the WIRE-AT-BOTH-SITES guard)
is Class C/A and stays inline, verbatim, at that file.
