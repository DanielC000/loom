# c9a21e8f — a deploy restart pre-empts ADVISORY dist-importer checks (and only those), re-fires one, and `gate_queue` reports `restartSafe`

## Narrative

The automatic dist-importer check (card `cee17efe`) is an advisory run that occupies a real `GateSemaphore` slot at the LOW tier. Back to back they kept `gate_queue` non-empty for hours, so no manager could fire `daemon_restart` under a "queue drained" grant and a batch of landings sat undeployed; one manual cancel of a running advisory also came back "kill unverified".

`daemon_restart` has no code-level queue precondition — "drained" was only the owner grant plus doctrine. This card makes the advisory the thing that yields: `requestDaemonRestart` calls `preemptAdvisoryDistImporterChecks` AFTER the green build and BEFORE the restart intent is written. It (1) pauses new starts and the follow-up drain, (2) captures one refire entry per (project, repo) — the running run's touched modules unioned with the folded follow-up's, (3) cancels queued advisories (zero process risk) and signals running ones, (4) waits up to a bounded 30s for each to leave the registry, (5) for one STILL unsettled, reaps strays rooted in THAT run's own derived worktree path via `reapWorktreeUnlessClaimed` — the same path-scoped matcher `worker_reap` uses, never an image name or port. Reason for (5): a daemon exit does not kill a Windows child tree (no Job Object on a gate child), and the boot sweep `sweepOrphanedDistImporterCheckWorktrees` only removes the directory and branch, it reaps no process. An unverified kill proceeds with an `advisoryCancelUnverified` warning on the result rather than blocking the deploy.

The refire rides `RestartIntent.distImporterRefire` (additive; an older intent simply has none) and boot calls `refireDistImporterChecks` once, after the dist-importer worktree sweep, cutting at the CURRENT mainline HEAD. The persisted touched-module list is capped per entry (`DIST_IMPORTER_REFIRE_MAX_PATHS`); the overflow count rides `droppedPathCount` and boot tells the manager the re-check is partial. A restart refused after the pre-empt (supervisor gone at the recheck, or any throw) re-fires in-process, since nothing will exit.

A landing confirmed WHILE the pause is on (the window spans the verify wait, reap, backup, intent write and the merge-danger grace) is folded into the pending refire set (union of paths, newest sha) rather than dropped; the intent is rewritten if it grew after the first write, and the list is sealed right after the final supervisor check. An arrival after the seal cannot be carried, so its manager is nudged naming the uncovered sha. A throw after the intent was written clears the intent, so a later crash-boot cannot re-fire a second time.

`gate_queue` gains `restartSafe`: true iff every live entry — running, queued, repo-guard-only, squashing, waiting-on-self-check — is an advisory AND no merge or gate op is live in the pending-op registry (a merge confirm does inert-diff / emit-compare / reunion prep before it ever reaches the semaphore). It is daemon-global, not caller-scoped.

`gate_cancel` on a RUNNING advisory not confirmed gone within the verify window now returns the distinct outcome `cancel_signalled` ("cancel signalled; the run exits at its next phase boundary") instead of `not_cancelled`. The abort WAS delivered; the worktree cut and the build only observe it between phases. Making the cut/build themselves cancellation-aware was deliberately NOT done here.

## Do not

- Do not widen the pre-empt beyond `distImporterCheckOnly` entries. A merge, deploy, worker self-check or landing-check is real work; `24642c3d` forbids pre-empting a running gate and nothing here relaxes it. Cancelling an advisory is allowed because it is advisory, worker-tier and already cancellable by a manager.
- Do not let the follow-up drain run after the pre-empt — it would start the very check just cancelled; the loop checks `distImporterPaused` before draining.
- Do not rely on the boot sweep or the daemon exit to kill an advisory's child tree; reap by the run's own derived worktree path (never by image name, port or command-line pattern).
- Do not drop touched modules silently past the persisted cap — keep the count in `droppedPathCount` and surface it.
- Do not read `restartSafe` as "the host is idle" — like every `gate_queue` field it is blind to hand-run tests.
- Do not add a `restartSafe`-style fact to an agent-writable surface that can SET it; it is read-only.

## Source

`SessionService.preemptAdvisoryDistImporterChecks` / `refireDistImporterChecks` / `gateQueueForManager` / `cancelGateOp` in `packages/daemon/src/sessions/service.ts`, `RestartIntent.distImporterRefire` in `packages/daemon/src/orchestration/restart.ts`, boot wiring in `packages/daemon/src/index.ts`. Proven by `packages/daemon/test/dist-importer-restart-preempt.mjs`.
