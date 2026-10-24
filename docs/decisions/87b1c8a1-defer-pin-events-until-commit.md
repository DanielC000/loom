# 87b1c8a1 — defer `appendEvent`'s listener notification until a real commit; test `insertProject`'s rollback

Follow-ups from the FOURTH Code Review (`f4d41cd7`, MERGEABLE-WITH-NITS) of card `4d60366b` ("fix(git): hand
a commondir trust pin to a surviving project on retire", landed gen 441). None was blocking; all failed
CLOSED. Read `docs/decisions/3a5c5d4a-canonical-git-commondir-trust.md` first, especially its round 6
section (bullet 8, M-2) — this card closes a gap that section's own transaction wrap left open.

## (1) `insertProject`'s transaction wrapper had ZERO coverage

`commondir-trust-pin-ownership.mjs`'s existing M-2 test only exercised `updateProject`'s own transaction
(injecting a throw into `unpinCommondirTrustIfOwned`, which only `updateProject`'s rebind path reaches).
`insertProject`'s own `this.db.transaction(...)` (now `runInTransaction`) — the INSERT plus the per-repoKey
`pinCommondirTrust` loop — had no test that could tell it apart from an unwrapped sequence of statements.

Added a twin: a 2-repoKey project; `Db.prototype.pinCommondirTrust` monkey-patched to throw on its SECOND
call; asserts `getProject(id)` is `undefined` (the INSERT itself rolled back) and the FIRST repoKey's
candidate path has neither a pin (`getCommondirTrustPin`) nor an index entry (`commondir-trust-pin-
index:<id>:primary`) — proving the first loop iteration's own `setMeta` calls were rolled back too, not
just the INSERT. Shown RED by reverting `insertProject` to call `this.db.transaction(...)()` directly
(bypassing `runInTransaction`'s own queuing — irrelevant to this specific assertion, which is about the SQL
rollback, not event delivery) — the exact same way a bare `this.db.transaction()` would still roll back
correctly, so RED here must come from literally removing the transaction wrapper, not from the listener
work done by bullet (2) below.

## (2) `appendEvent`'s listener fired mid-transaction, before commit — a rolled-back event could still reach the webhook

`appendEvent`'s `eventListener` (the outbound alert-webhook emitter, wired at boot in `index.ts`) used to
fire synchronously the moment its own INSERT ran — including when that INSERT was itself inside an ongoing
`this.db.transaction(...)` call (every one of `insertProject`/`updateProject`/`deleteProject`/
`archiveDeadRecycleSuccessor`/`finishHaltedRecyclePending`/`markCredentialUndeliverableAndAudit`). A LATER
statement in that SAME transaction throwing (e.g. the round-6 M-2 scenario, or the `87b1c8a1` M-2-insert
scenario above) rolled the event's own INSERT back — but the webhook had already been told, synchronously,
that the event happened. The doc comment ("Notify the listener AFTER the row is committed") was simply
false for every one of these six call sites.

**The fix, structural, not per-call-site:** `Db` gained `pendingEventNotifications: OrchestrationEvent[]`,
and the depth/flush logic was added to `Db`'s EXISTING PUBLIC `runInTransaction<T>(fn: () => T): T` (card
`ccd373cc`) — not a new private helper. That method already had (round-2 count) 8 external callers before
this card (`gateway/server.ts`'s task routes, `mcp/tasks.ts`, `setup/seed.ts`, `tasks/relations.ts`) which
all inherit the flush/drop semantics for free; none of them call `appendEvent` inside their own `fn`
(checked directly), so none observes any behavior change — this card only widens what the shared helper
already did, it doesn't introduce a second mechanism alongside it. `appendEvent` checks
`this.db.inTransaction` (a real better-sqlite3 property, true for the whole nested-savepoint duration, not
just the outermost call): outside any transaction it fires the listener immediately exactly as before
(every statement there already auto-commits); inside one it pushes onto the queue instead. Every call to
`runInTransaction` — nested or not — snapshots the queue's length on entry and truncates back to that
snapshot on ITS OWN throw; only the OUTERMOST (non-nested) call additionally flushes the queue (in order,
each wrapped in the listener's own existing try/catch) once its own `this.db.transaction(fn)()` call
returns without throwing. **Round 2 (Code Review R2) correction:** the first attempt had the nested case
neither flush nor clear, reasoning "nesting doesn't exist today" — FALSE (nesting already exists:
`mcp/setup.ts`'s `project_update` tool wraps its own `db.runInTransaction(...)` around a call to
`db.updateProject(...)`, which itself calls `this.runInTransaction(...)` internally), and the omission was a
real leak: a caller that catches a NESTED call's throw and continues (exactly `setup.ts`'s own shape, which
swallows the whole transaction's throw into `ok({error})`) let that nested call's own rolled-back
notifications survive into the OUTER commit's later flush. The snapshot-and-truncate-at-every-level fix
above closes it — see the "(5c)" test in `alert-webhook.mjs`, RED/GREEN against the pre-fix
flush-or-clear-only-at-outermost logic.

**Which transactions in `db.ts` actually reach `appendEvent` (directly or transitively), and therefore
observe this fix's behavior:** `updateProject` (via `resetMainlineBaselinesForRepoChange` →
`unpinCommondirTrustIfOwned`/its own `mainline_moved_outside_loom` event), `deleteProject` (via its own
index-walk's `unpinCommondirTrustIfOwned` calls), `archiveDeadRecycleSuccessor`, `finishHaltedRecyclePending`,
and `markCredentialUndeliverableAndAudit`. Found by enumerating every `this.appendEvent(` call site in the
file and tracing which ones sit inside a `this.db.transaction(...)` (own or an ancestor's) — not by a
filename/keyword grep. **Round 2 (Code Review R4) correction: `insertProject` does NOT belong on this
list** — its own per-repoKey loop calls `pinCommondirTrust`, which never calls `appendEvent` anywhere in
its body (verified by reading it: it only does `getMeta`/`setMeta`/`deleteMeta`). `insertProject` still
routes through `runInTransaction` (bullet 1 above needs that for its own SQL-atomicity reason, independent
of this bullet), it just never actually exercises the event-queuing mechanism this bullet is about. The
other five `appendEvent` call sites (`repinCommondirTrust`, `backfillCommondirTrustPins`,
`resetMainlineWatermark`, `repointMainlineWatermark`, `recordCompanionUnboundRouteRefused`) are never
called from inside any `db.ts` transaction (confirmed: none of their own definitions are reached by a
`this.db.transaction(...)` call anywhere in the file) — they fire immediately exactly as before, correctly.

**Round 2 (Code Review R5) — the real-world impact is narrower than "every one of these five kinds now
reaches the webhook correctly."** `AlertWebhookEmitter.resolveProject` (`alert-webhook.ts:121-124`) derives
the project from `this.db.getSession(evt.managerSessionId)` — a lookup that fails (returns `undefined`,
and `deliver()` then returns early, per `alert-webhook.ts:98`) for an empty `managerSessionId`.
`unpinCommondirTrustIfOwned`'s own `commondir_trust_pinned` events and `resetMainlineBaselinesForRepoChange`'s
own `mainline_moved_outside_loom` event both file with `managerSessionId: ""` — so for `updateProject` and
`deleteProject`, THIS FIX closes a genuine ordering bug (a rolled-back event could have fired the listener)
but the listener in question can never actually reach a configured webhook either way, before or after this
fix. The SAME is true of `markCredentialUndeliverableAndAudit`'s own sole production caller
(`keys/credentialSessionEnv.ts:156-158`), which ALSO passes `managerSessionId: ""` — contradicting this
card's own `worker_report`, which (incorrectly) named it alongside the two below as having "real
behavioural effect." **The real behavioural effect — a rolled-back event that, pre-fix, really could have
reached a human's configured webhook — is on `archiveDeadRecycleSuccessor` and `finishHaltedRecyclePending`
only:** both of THEIR real callers (`sessions/service.ts:16012`, `:16367`, `:16421`) pass a genuine session
id (`oldId`/`predecessorId`) as `managerSessionId`, which `resolveProject` can actually resolve to a real
project. Scoped as "per reading `alert-webhook.ts:121-124`" — not re-derived from this record's own prose.

**`archiveDeadRecycleSuccessor`'s own pre-existing comment** (`@decision 5a56bb0a`) used to document and
justify the listeners firing mid-transaction as deliberate and safe. That justification is now moot for
the alert-webhook half specifically (it fires post-commit like its own doc always said) — the comment is
corrected in place rather than left describing behavior this card changed.

## (3) M-2's own test widened: assert the NEW path too, not just the OLD one

The existing `updateProject` M-2 test (injected throw in `unpinCommondirTrustIfOwned`, asserting the WHOLE
rebind rolls back) asserted the old pin/repoPath were untouched, but never checked the NEW path — PASS 1
of `resetMainlineBaselinesForRepoChange` (round 6) pins the new target BEFORE pass 2 retires the old one,
so a real bug could have left the new path's pin surviving a rollback. Added: `getCommondirTrustPin(newPath)
=== null` (the pass-1 write rolled back too), and the index entry `commondir-trust-pin-index:<id>:primary`
still equals the OLD path (never advanced to the new one) after the rollback.

## (4) A typed `CommondirPinConflictError`, caught by type, not by `catch (e)`

Every REST/MCP write surface wrapping an `insertProject`/`updateProject` call (`gateway/server.ts`'s
`POST /api/projects`, `POST /api/setup/project-init`, `PATCH /api/projects/:id`; `mcp/platform.ts`'s
`project_create`/`project_init`/`project_update`; `mcp/setup.ts`'s `project_create`/`project_init` — the
same 8 sites `3a5c5d4a`'s round 6 S-2/S-3 wired the pre-flight + catch onto) used to map ANY throw from
that call to its existing 409 (`reply.code(409).send({error})`) / `ok({error})` refusal shape — including a
genuine internal fault (a disk error, a real bug) having nothing to do with a pin conflict, silently
laundered into the same "this is just a conflict" response.

`Db.assertNoCommondirPinConflicts` now throws `CommondirPinConflictError` (a plain `extends Error`,
exported from `db.ts`, same shape as `git/bounded.ts`'s `CanonicalGit*Refusal` family) instead of a bare
`Error`. Every one of the 8 call sites now narrows on `instanceof CommondirPinConflictError` before
returning the 409/`ok({error})` shape, and re-throws anything else — an uncaught throw in a fastify route
handler becomes a real 500 by fastify's own default error handling (no custom error handler is installed);
an uncaught throw in an MCP tool handler becomes a real thrown/uncaught MCP protocol error, not a graceful
`ok({error})`.

Tests: `commondir-trust-pin-rest-refusal.mjs` gained a case — `Db.prototype.insertProject` monkey-patched
to throw a plain (non-conflict) `Error`, `POST /api/projects` asserted to return 500, not 409 — proving the
narrowed catch actually lets a non-conflict throw through rather than merely trusting the type check by
inspection. The existing conflict-path cases in both `commondir-trust-pin-rest-refusal.mjs` and
`commondir-trust-pin-mcp-refusal.mjs` are unaffected (a `CommondirPinConflictError` still maps to the same
409/`ok({error})` shape they already assert). **Round 2 (Code Review R3):** the monkey-patch also sets a
`reached` flag, asserted true, so a bare `statusCode === 500` can't pass vacuously against some unrelated
500; a second, narrowed case (`PATCH /api/projects/:id` / `updateProject`) was added alongside it.

## (5) Card `18689f24` — a static guard proves no raw transaction reaches `appendEvent`, plus a cheap runtime tripwire

Follow-up: nothing EXECUTED the "Do not" rule below — it relied on a human/reviewer re-deriving, by hand,
which of the ~34-38 raw `this.db.transaction(` sites in `db.ts` could reach `appendEvent` (directly or
transitively), every time a NEW raw site was added. Converting every raw site to `runInTransaction` was
considered and rejected: the blast radius isn't uniform (several sites are on hot paths, and a bare
`this.db.transaction(fn)()` passthrough — `runInTransaction`'s OWN implementation — can never itself be
converted). Instead, `packages/daemon/test/raw-tx-appendevent-reach-guard.mjs` is a static source-text
scanner: it strips comments from `db.ts` (so comment PROSE naming `appendEvent`/`db.transaction` is never
mistaken for a real call — immune to a comment-only diff by construction, so this file is deliberately NOT
added to `CHANGED_TS_TEXT_SCANNER_REPO_PATHS` in `git/worktrees.ts`), splits the `Db` class into named
methods via brace-depth matching, builds a `this.<name>(` call graph, computes the transitive closure of
"reaches `appendEvent`", and fails if any raw `this.db.transaction(...)` callback's own direct calls
intersect that closure. Verified against the REAL call graph (not just a synthetic fixture) by splicing an
extra call to a real appendEvent-reaching method (`unpinCommondirTrustIfOwned`) into an in-memory copy of
`migrateTopicsToAgents`'s own existing, today-safe raw transaction — this must turn RED, and does; removing
the splice (the real file, untouched) is GREEN. Also added a cheap, log-only runtime tripwire (never
throws): `appendEvent` warns if the queue is non-empty while OUTSIDE a transaction, and `runInTransaction`
warns if the queue is already non-empty at a fresh OUTERMOST entry — either shape means some raw
transaction already leaked a notification nothing ever flushed or truncated.

## Do not

- Do not add a NEW raw `this.db.transaction(` call site in `db.ts` whose callback calls `appendEvent`
  (directly or transitively) — run `packages/daemon/test/raw-tx-appendevent-reach-guard.mjs` (card
  `18689f24`); it fails exactly this case, with a real-corpus-verified positive control, not just a
  synthetic one.
- Do not fire `appendEvent`'s listener notification immediately while `this.db.inTransaction` is true — a
  later statement in the SAME transaction can still roll the event's own INSERT back; queue it and flush
  only after `runInTransaction`'s own real, non-nested commit.
- Do not add a NEW `db.ts` mutator whose transaction calls `appendEvent` (directly or transitively) via a
  bare `this.db.transaction(fn)()` — route it through the existing public `runInTransaction` (card
  `ccd373cc`), or the notification fires immediately mid-transaction again, reopening this exact bug.
- Do not let only the OUTERMOST call snapshot/truncate the notification queue on its own throw — EVERY
  call (nested or not) must snapshot the queue's length on entry and truncate back to it on ITS OWN
  throw (Code Review R2); omitting this for nested calls leaks a nested, rolled-back notification into
  the outer commit's later flush the moment a caller catches the nested throw and continues (nesting
  already exists — see `mcp/setup.ts`'s `project_update`).
- Do not read `assertNoCommondirPinConflicts`'s new `CommondirPinConflictError` type as narrowing what it
  refuses — it is the SAME conflict check as before (`checkCommondirPinConflicts`), only the thrown type
  changed, so every REST/MCP catch site can tell a genuine conflict apart from an unrelated internal fault.
- Do not add a NEW `insertProject`/`updateProject`-wrapping REST/MCP write surface with a bare `catch (e)`
  that maps everything to 409/`ok({error})` — narrow on `instanceof CommondirPinConflictError` and
  re-throw anything else, matching the 8 existing sites this card fixed.
- Do not assert a non-conflict-throw test by status code alone — a bare `statusCode === 500` is also true
  for any unrelated bug; set and assert a `reached` flag on the monkey-patch too (Code Review R3).
- Do not list `insertProject` among the transactions this card's event-queuing mechanism affects —
  `pinCommondirTrust` never calls `appendEvent`, so `insertProject`'s transaction never reaches it (Code
  Review R4); it still needs `runInTransaction` for its own, unrelated SQL-atomicity reason (bullet 1).
- Do not describe `runInTransaction` as a new or private helper — it is `Db`'s existing PUBLIC method
  (card `ccd373cc`, 8 pre-existing external callers); this card only added depth/flush logic to it.
- Do not credit `markCredentialUndeliverableAndAudit` with "real behavioural effect" without checking its
  actual production caller — `keys/credentialSessionEnv.ts` passes `managerSessionId: ""`, so
  `AlertWebhookEmitter.resolveProject` (`alert-webhook.ts:121-124`) can never resolve a project for it,
  same as the two mainline/commondir event kinds (Code Review R5).
- Do not assume `insertProject`'s M-2-insert test needs the listener-queuing mechanism from bullet (2) to
  go RED — it is a plain SQL-rollback assertion; removing `runInTransaction`'s wrapping (reverting to a
  bare `this.db.transaction(...)()`) still rolls the SQL back correctly, so RED there must come from
  removing the TRANSACTION itself, not from disabling the event-queuing half of this fix.
