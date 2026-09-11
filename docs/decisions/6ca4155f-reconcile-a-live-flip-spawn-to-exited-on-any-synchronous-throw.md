# 6ca4155f — reconcile a live-flip spawn to `exited` on ANY synchronous throw before `pty.spawn` succeeds

## Narrative

A worker (or manager/lead) row is flipped `processState:"live"` BEFORE the pty is actually started (M5
ordering: "flip to live BEFORE wiring the pty so a fast-failing spawn's `onExit` always wins"). Anything
that runs between that flip and a successful `pty.spawn` — the pre-pty steps (project-memory
retrieval/digest, codescape status; see [[fa1b77c1-widen-spawnworkers-try-to-cover-the-pre-pty-steps]]) or
`createPty` itself (node-pty's own spawn, e.g. a Windows `CreateProcess` `error code: 206` from an
oversized command line; see
[[bc91e86c-a-synchronous-createpty-throw-is-not-only-a-pre-pty-step-failure]]) — can throw SYNCHRONOUSLY,
before any Live entry is ever registered.

Without a catch around that whole window, the row stamped `'live'` NEVER gets reconciled: the pty's own
`onExit` chokepoint (which normally flips a dead session back to `'exited'`) can only fire for a process
that actually started, so a catch here is the ONLY way such a failure is ever observed. Left uncaught, the
row is a phantom — `engineSessionId` stays null, `turnSeq` stays 0 — that holds `liveSessionIdForTask`'s
per-task mutex forever (that guard keys on `process_state` alone) and that `pty.stop()` can't touch (it
no-ops on a session with no Live entry — see `PtyHost.stop`), so a stale `{stopped:true}` from
`worker_stop` would report success without having stopped anything.

Reconciling to `'exited'` at the catch — the one place that knows the spawn never produced an engine —
releases the mutex immediately and lets a re-spawn (or `worker_recycle`, which reuses the same
worktree/branch and never checks `processState`) proceed normally. The Code Reviewer measured the gap
directly: ~12 OTHER `setProcessState(id, "live")` → `pty.spawn` sites in this file had NO catch at all
before this card — `recycleWorker` mattered most (a phantom-live recycled worker counts toward the
manager's cap AND holds the per-task mutex), with the same shape on `resume()`, `startNew`,
`startManager`, `startPlatformLead`, `startAuditor`, `startWorkspaceAuditor`, `startSetup`,
`startOperator`, `fork`, `startRun`, `recycleManager`, and `recyclePlatformLead` (smaller impact for
non-worker roles — no cap, no task mutex — but still a lie on the fleet view).

Card `8b194419` later folded the fix onto one shared helper (`reconcileFailedSpawn`) rather than leaving
each site's own copy to drift — see
[[8b194419-fold-every-live-flip-catch-onto-the-shared-reconcilefailedspawn-helper]].

## Do not

- Do not release the `16637a9e` cap-claim anywhere but the live flip itself when adding or widening a
  catch here — a shared helper must not move it (`docs/decisions/16637a9e-worker-spawn-cap-claim-released-on-live-not-finally.md`).
- Do not assume a caught throw here is always a pre-pty step — `createPty` itself can throw synchronously
  too (the Windows `CreateProcess error code: 206` class).
- Do not leave a live-flip → spawn site uncaught on the theory that its role has no cap/task-mutex impact
  — a phantom-live manager/lead row is still a lie on the fleet view.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`spawnWorker`'s catch around the live-flip →
`pty.spawn` window, ~line 6291 as of this tranche's HEAD) and the `reconcileFailedSpawn` helper's own
short header comment (~line 6373). Board card `6ca4155f` (merged `37e87a6`, verification: content).
