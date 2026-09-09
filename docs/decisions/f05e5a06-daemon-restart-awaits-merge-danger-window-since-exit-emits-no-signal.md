# f05e5a06 — `daemon_restart` must itself await the merge-danger-window guard; a bare `process.exit()` emits no signal

## Narrative

`requestDaemonRestart` exits via `process.exit()` directly, which emits NO signal — so `gracefulShutdown`'s own merge-danger-window guard (`index.ts`, bound only to SIGINT/SIGTERM/SIGHUP) never ran for THIS path, even though it's the one that fires in practice (a manager's routine deploy restart, not an owner's manual `loom stop`). This now awaits the SAME `waitForMergeDangerWindowsToClear` guard, with the same bounded, fail-open semantics `gracefulShutdown` uses — never a hard refusal; always resolves within the grace ceiling regardless of what the in-flight squash does.

The await happens BEFORE scheduling the exit-flush timer, not concurrently with it: the restart-intent (the fleet's resumable state) is already durably written by this point, so a still-draining squash only extends how long this call takes to return — it never races or eats into the 300ms flush window that lets the MCP response reach a caller that's about to be killed.

## Do not

- Do not exit this path via a bare `process.exit()` without first awaiting `waitForMergeDangerWindowsToClear` — a signal-based guard bound only to SIGINT/SIGTERM/SIGHUP never fires for this path otherwise.
- Do not run this await concurrently with (or after) the 300ms exit-flush timer — it must complete before that timer is scheduled, so a draining squash only extends this call's return time, never the flush window.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`requestDaemonRestart`'s top-of-function doc, the "Card f05e5a06" paragraph): originally lines 3463-3469, as of this tranche's HEAD. Relocated by card `9f4f8e5a` (tranche 7); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
