# ca0957d7 — `deferredUntilEvent`'s `request-answered` kind gets a dangling-key detector; `gate-fail-naming` deliberately does not

## The defect

Loom has two ways to write a card's release condition: `deferredUntilTaskId` (blocker is a card) and
`deferredUntilEvent` (blocker is a named event). Only the first had a dangling detector —
`deferredStuck` read `true` when a named task blocker was deleted or closed with no proven merge.

`deferredUntilEvent: {kind:"request-answered", key:"<requestId>"}` had no equivalent. If that Request was
later cancelled or superseded (`question_ask({supersedes})` atomically cancels the old id and files a new
one — nothing walks the board to repoint or flag cards keyed to the cancelled id), the `request-answered`
trigger could never fire again, `deferredStuck` stayed `false`, and the card sat `deferred:true` forever
behind a condition that read live and wasn't. Found live on card `45a23c27` (2026-09-21), repaired by hand
— that repair doesn't generalize; the next supersede recreates the same hole.

## The fix

`resolveDeferredEffective` (`packages/daemon/src/mcp/tasks.ts`) now also resolves
`task.deferredUntilEvent` when its `kind` is `"request-answered"`: it looks up the named Request
(`db.getQuestion(key)`) and treats `state:"cancelled"`, or the id not resolving in this project at all, as
stuck — the SAME "dangling reference" shape the `deferredUntilTaskId` blocker case already uses.
`state:"pending"` stays not-stuck (still genuinely live); `state:"answered"`/`"consumed"` are deliberately
NOT stuck either — those states mean the event already fired, and release is a judgement call for a reader
of the card's own `deferredReason`, exactly the pre-existing "never auto-clears, this is a pointer"
contract on `Task.deferredUntilEvent`. Conflating "already fired" with "can never fire" would turn a
working, quiet queue into a wall of false alarms.

This lookup is cheap (one row read, no git/network I/O) so it runs unconditionally whenever a card is
currently `deferred:true`, independent of the caller's `includeMerged` flag — unlike the task-blocker
check, which needs a git-derived `merged` lookup and is genuinely UNMEASURED (not a determination) when
`includeMerged:false`. A blocker-less manual deferral (no `deferredUntilTaskId` at all) that only carries
a `deferredUntilEvent` — exactly the `45a23c27` specimen shape — used to short-circuit straight to
`stuck:false` before ever considering the event; it no longer does.

`deferredUntilEvent` still never gates `deferred` itself (only `deferredUntilTaskId`/manual clear do) — if
a card's task blockers all merge, `deferred` auto-clears to `false` and `stuck` resets to `false`
regardless of the event annotation's own state, matching the pre-existing invariant that `deferredStuck`
is only ever meaningful while `deferred` is `true`.

## Why `"gate-fail-naming"` gets no analogous detector

That kind's `key` is a bare test-file name/path with no backing store of its own — there is nothing for it
to transition to a cancelled/deleted state against. A renamed or deleted test file simply stops appearing
in any future gate run's `failedNames` list, which is indistinguishable from "hasn't failed again yet" —
a state that was always possible for this kind, long before this card, and isn't a dangling-reference bug.
Building a mirror detector for it would have nothing real to check.

## `deferredStuck` projection (DoD-4)

`deferredUntilEvent` itself is still not projected in `tasks_list`'s summary — no new response key was
added. `deferredStuck` already IS projected there (`TaskSummary`), and now correctly reflects this dangling
case too, so a board-wide audit no longer needs a per-card `tasks_get`: `tasks_list`'s existing
`deferredStuck` field is sufficient. Scoping the fix this way also means none of the response-key-set
guards (`worker-status-projection-guard.mjs` / `entity-row-fields-guard.mjs` /
`agent-session-full-field-guard.mjs` / `platform-config-redaction-drift.mjs`) apply — no new key exists
for them to police.

## Bounds carried from the filing card

n=1 confirmed specimen (`45a23c27`); the board was never swept for others, because `deferredUntilEvent`
wasn't projectable in `tasks_list` before this card made `deferredStuck` sufficient — the population was
genuinely unmeasured, not "clean." `supersedes` repointing the card's own key (the card's DoD-3, optional
polish once this detector lands) was not built — this record's fix makes the dangling case visible instead
of preventing it from occurring, which the filing card states is sufficient on its own.

## Do not

- Do not read a `"request-answered"` key resolving to `"answered"`/`"consumed"` as stuck — those states
  mean the event already fired; conflating "already fired" with "can never fire" turns a working queue
  into false alarms.
- Do not gate the event-stuck lookup on `includeMerged` — it is a plain DB row read, not a git-derived
  check, and skipping it under `includeMerged:false` would silently un-stick a genuinely stuck card for
  any latency-sensitive caller (the companion board) that reads that way.
- Do not let a stuck `deferredUntilEvent` override the task-blocker-driven `deferred` auto-clear — the
  event annotation still never gates `deferred`; once every named task blocker merges, `deferred` (and
  `stuck`) reset exactly as before, regardless of the event's own state.
- Do not build a dangling-key detector for `"gate-fail-naming"` — its `key` has no backing store to check
  against; there is nothing analogous to detect.

## Source

`packages/shared/src/types.ts` (`DeferredUntilEventKind`, `DeferredUntilEvent`, `Task.deferredStuck` doc
comments) and `packages/daemon/src/mcp/tasks.ts` (`resolveDeferredEffective`,
`resolveDeferredEventStuck`), as landed by this card. Regression test:
`packages/daemon/test/task-defer-stuck-event.mjs`.
