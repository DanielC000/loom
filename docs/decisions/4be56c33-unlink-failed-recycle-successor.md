# 4be56c33 — unlink a failed recycle successor's `recycled_from`, at each recycle catch, never in the shared `reconcileFailedSpawn` helper

## Narrative

Code Reviewer finding on card `6ca4155f`'s branch: `db.ts`'s `hasSuccessor(sessionId)` is a bare
`SELECT 1 FROM sessions WHERE recycled_from = ?`, blind to whether that successor ever actually went
live. Card `6ca4155f` made a synchronous pre-spawn throw in `recycleWorker`/`recycleManager`/
`recyclePlatformLead` honestly reconcile the fresh successor row to `exited` (via `reconcileFailedSpawn`)
instead of leaving it phantom-`live` — but the successor's `recycled_from`, pointing back at the
predecessor, was never cleared. So the predecessor stayed permanently `hasSuccessor()===true`, even
though its "successor" never ran a turn. Consequences: (a) a RETRIED recycle of the same predecessor is
refused `"...its successor is live"` — provably false once the successor is honestly `exited`; (b)
crash-recovery (`recordUnexpectedExit` / `isCrashRecoveryEligible` / the watcher tick) skips the
predecessor forever, believing a successor "owns" it.

**First attempt (commit `a11525fe`, superseded below):** unlink `recycled_from` unconditionally inside
`reconcileFailedSpawn` itself — reasoning that its only three `recycledFrom`-setting callers
(`recycleWorker`/`recycleManager`/`recyclePlatformLead`) all route their pre-spawn failure through that
one shared helper, so a single change point would cover all three.

**Why that was wrong, verified by the reviewer with a hermetic probe:** `reconcileFailedSpawn` is ALSO
called from `resume()` (service.ts) on a pre-spawn throw resuming an EXISTING row — often a genuine
`gen>=1` recycle successor, not a fresh one. Nulling `Y.recycledFrom` there, after a failed `resume(Y)`
of a real successor `Y`, flipped `hasSuccessor(X)` (the real predecessor `X`) to `false` and allowed an
automatic `resume(X)` — lifting every zombie/double-recycle guard for `X`, forking a Platform Lead's
resume-doc lineage (`lineageRootId` feeds `resolvePlatformLeadResumeDocPath`), irreversibly. The original
helper comment's claim that "every other caller is a plain fresh spawn, never a recycle" was false for
`resume()`.

**Rejected alternative:** widen `hasSuccessor` to require the successor to have ever captured an
`engineSessionId` (genuinely started, not merely inserted). Rejected because `engine_session_id` is only
populated asynchronously, once the SessionStart hook fires — AFTER `pty.spawn()` returns. A `hasSuccessor`
check made in the window between a SUCCESSFUL recycle's `pty.spawn()` returning and its SessionStart hook
landing (observed up to several seconds under production boot-mode timing) would read `false` for a real,
live successor — a new race in the ordinary success path, not just the rare pre-spawn-failure path this
fix targets.

**The actual fix:** move the unlink OUT of `reconcileFailedSpawn` and into each of the three recycle
methods' own catch block, alongside their existing `reconcileFailedSpawn(fresh.id, e)` call. Each catch is
the ONLY code that could ever have observed the just-inserted fresh row — `insertSession`'d
synchronously, `setProcessState(fresh.id, "live")`, every step through `pty.spawn()` with NO `await`
between (verified per path). The unlink can never race a caller that already read the old, linked value.
`resume()`'s own `reconcileFailedSpawn` call is untouched — it never touches `recycled_from`, so a failed
resume of a real `gen>=1` successor keeps its lineage link as before.

**recycleWorker's own behaviour consequence:** it hard-kills the predecessor's pty BEFORE the fresh spawn
attempt, so after a failed retry the predecessor is genuinely dead — but onExit→archiveOnExit
unconditionally archives a `worker` role on exit while keeping its captured `engineSessionId`. Unlinking
it (`hasSuccessor()` flips back to `false`) makes it `resume()`-eligible again — the predecessor becomes
resumable, not just delinked. `recycleManager`'s predecessor is untouched by a pre-spawn failure (never
flipped off `live` before the attempt; only `recyclePlatformLead`'s catch restores `old` to `live`,
pre-existing from card `6ca4155f`) — this fix changes only its `hasSuccessor` link, not its process state.

## Do not

- Do not move this unlink back into `reconcileFailedSpawn`. That helper is shared with `resume()` on a
  row that is frequently a genuine, already-linked `gen>=1` recycle successor — unlinking there silently
  forks the lineage and re-enables resuming a predecessor whose real successor is still alive.
- Do not add a new `Db.setOrchestration({ recycledFrom })` production caller without re-reading
  `sessions/lineage.ts`'s own INVARIANT comment first — every seed-accepting lineage helper there assumes
  `recycledFrom` is immutable post-insert except for this one narrow, synchronous, never-observed-before
  exception.
- Do not assume `hasSuccessor`'s semantics changed for a SUCCESSFUL recycle. This fix touches only the
  pre-spawn-failure catch paths; a genuine recycle's successor keeps its `recycled_from` link exactly as
  before, with no new race window (unlike the rejected engine-id-liveness alternative would have caused).

## Source

`packages/daemon/src/sessions/service.ts`: the three recycle catch blocks (`recycleWorker`,
`recycleManager`, `recyclePlatformLead`), each anchored `@decision 4be56c33` at its own
`this.db.setOrchestration(fresh.id, { recycledFrom: null })` call, plus `reconcileFailedSpawn`'s own
`@decision 4be56c33` guard explaining why the unlink is deliberately NOT there. Second citing site:
`packages/daemon/src/sessions/lineage.ts`'s module-doc INVARIANT comment, as of this tranche's HEAD.
