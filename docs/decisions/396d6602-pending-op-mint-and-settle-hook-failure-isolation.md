# 396d6602 — a throwing `onOpMinted`/`onSettle` must never corrupt `PendingOpRegistry`'s own bookkeeping

`PendingOpRegistry.attach()` lets a caller hook two points in an op's lifecycle: `onOpMinted` (fires
synchronously right after a fresh entry is registered, strictly before `run()` is invoked) and `onSettle`
(fires inside the op's own terminal settle callback, right after `state`/`result`/`error` are written).
Both production call sites (`sessions/service.ts`'s merge path and worker-gate path) use these hooks to
write/update a durable `pending_gate_ops` tombstone row — a real I/O operation (`db.insertPendingGateOp`/
`db.settlePendingGateOp`) that can throw (`SQLITE_BUSY`, a full disk, a constraint violation).

Before this card, neither hook was isolated from the registry's own control flow:

- **`onOpMinted` throwing** left the just-minted entry permanently registered under `key` with
  `state: "running"` and `settle: Promise.resolve()` (an already-resolved promise, since the real
  `run()` call that would reassign `fresh.settle` is never reached — it sits after the `onOpMinted`
  call). Every later `attach()`/`peek()` call under that `key` would see a `"running"` entry whose
  `settle` immediately "wins" any race against `waitMs`, yet whose `state` never leaves `"running"` —
  a permanently pending op that can only be cleared by `evictDeadOwner()` (which the `gate:` key kind
  never uses at all — see the class doc).
- **`onSettle` throwing** propagated out of the `.then`/`.catch` handler that assigns `fresh.settle`,
  turning that promise into a REJECTED one even though `fresh.state`/`fresh.result`/`fresh.error` had
  already been written with the real, successful outcome one line above. Every awaiter racing
  `fresh.settle` (the fast path inside this same `attach()` call, a concurrent `waitBriefly()` caller, a
  concurrent poller's own `Promise.race`) would then see an unhandled rejection for an op that actually
  completed successfully — and `onSettledAfterPending` (the ONLY delivery path for a caller that was
  already told "pending") would never fire at all, since it sits after the throwing call in the same
  callback.

## Do not

- Do not let a throwing `onOpMinted` leave its entry registered — catch it, delete the entry from
  `this.entries` (identity-guarded against `fresh`, mirroring the eviction guard elsewhere in `attach()`),
  and rethrow so the caller sees the failure and a later `attach()` under the same key mints a genuinely
  fresh entry instead of attaching to a zombie.
- Do not let a throwing `onSettle` reject `fresh.settle` or skip `onSettledAfterPending` — catch it and
  log loudly (`console.error`) instead. The op's own verdict (`state`/`result`/`error`, already written
  before `onSettle` runs) must stand unchanged, and `onSettledAfterPending` must still fire for a caller
  that was told "pending" and has no other way to learn the outcome.
- Do not conflate the two hooks' failure handling — `onOpMinted` throwing means the op never really
  started (safe to roll back and let the caller retry), while `onSettle` throwing means the op already
  finished for real (unsafe to pretend it didn't; the verdict must survive regardless of the hook).
- Do not isolate only `onSettle` inside `attach()` and leave `onSettledAfterPending` unguarded right next
  to it — the SAME throw-must-not-reject-`fresh.settle` reasoning applies to it (it fires from the
  identical callback), and it is the ONLY delivery path for a caller already told "pending".
- Do not let a throwing verdict-derive/`db.settlePendingGateOp(opId, verdict)` inside a PRODUCTION
  `onSettle` (the merge/gate hooks in `sessions/service.ts`) leave the durable `pending_gate_ops` row at
  `state:'pending'` forever — the next boot's `reconcileOrphanedGateOps` would then nudge "no verdict was
  ever reached" for an op that actually merged or passed. Each hook must fall back to a verdict-less
  `settlePendingGateOp(opId)` (or a minimal error verdict) on that throw, so the row always leaves
  `'pending'`.
