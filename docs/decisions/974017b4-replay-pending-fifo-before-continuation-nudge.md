# sha:974017b4 — replay a resumed session's pre-restart pending FIFO in order, ahead of the continuation nudge

## Narrative

`resumeFleetOnBoot` replays a session's pre-restart pending inbound FIFO (snapshotted into
`RestartIntent`) onto the freshly-resumed pty, IN ORDER and BEFORE its own continuation nudge. These
replayed entries predate the restart, so FIFO order puts them ahead of the boot note rather than after
it. `enqueueStdin` is ready-gated (see `pty/host.ts`), so the replayed entries queue harmlessly until the
resumed TUI actually boots, then drain cleanly in the order they were captured.

## Do not

- Do not enqueue a resumed session's continuation/boot nudge before replaying its captured pending FIFO
  — the pending entries predate the restart and must land first, in order, ahead of the nudge.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts`, above `resumeFleetOnBoot`'s
`replayPending`: lines 4416-4419, introduced by commit `974017b4` (`fix(daemon): daemon_restart must
capture & resume the WHOLE live fleet, not just the requester (P1 17df54c5)`); verified via
`git cat-file -t 974017b4` ⇒ `commit`. No board card exists for this decision — sourced from `git blame`
at extraction time (tranche 12).
