# e7a9a884 — `resume()` files `worker_retirement_lifted` only after the spawn actually succeeds

From the `4ee527d1` delta review (reviewer `7cb3740e`, commit `02612e0c`): `resume()` used to append
`worker_retirement_lifted` as soon as it decided an `allowSuperseded` resume was overriding an active
retirement — before `getProject` (can throw "project not found"), and before `restoreSession`/
`pty.spawn` inside the try/catch (can throw synchronously, reconciled to `exited` by
`reconcileFailedSpawn`). A failed human Resume therefore left the epoch lifted anyway, re-arming every
automatic resume path (`CrashRecoveryWatcher`, `recoverCrashOrphanedWorkers`, webhook/poll/event-trigger
wakes) for a worker that never actually came back.

Fix: compute the boolean (`shouldLiftRetirement = opts.allowSuperseded && workerRetirementActive`) at the
original early site — it's still needed there to decide the refusal — but defer the `appendEvent` write
itself until just past the try/catch, next to the `resumability === "dead"` self-heal (the only other
"a successful spawn proves X" write in `resume()`). A throw anywhere in the try/catch rethrows before that
line is ever reached, so a failed resume now genuinely leaves the retirement active.

## Do not

- Do not file `worker_retirement_lifted` before the try/catch around `pty.spawn` — that's the exact bug
  this record fixes; the write must only happen once a resumed process genuinely exists.
- Do not fold the lift write into the `resumability === "dead"` self-heal's own `if` — they are
  independent conditions (`session.resumability === "dead"` vs `shouldLiftRetirement`) that can each be
  true or false independently; keep them as separate statements, just colocated.
- Do not recompute `workerRetirementActive`/`shouldLiftRetirement` after the try/catch — `isWorkerRetirementActive`
  reads live DB state and nothing between the early check and the post-spawn write is expected to change
  it; compute once, early (where the refusal check already needs it), and carry the boolean forward.
- Do not touch `@decision 819407e4`'s archive-restore-on-throw — the two are already mutually exclusive by
  construction (one lives in the catch block, the other strictly after it), so a throw always skips the
  lift and a successful fall-through never runs the archive-restore.
