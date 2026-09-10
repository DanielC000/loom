# 610abe29 — `worker_set_mode` is the only way a worker's permission mode changes, and fails closed

## Narrative

Card `610abe29`: `worker_set_mode` is a manager-driven ABSOLUTE permission-mode override — the manual
recovery affordance for a worker landed in (or pushed into) a bad mode. A worker can never change its own
mode: Shift+Tab is a human TUI keystroke, and `ExitPlanMode`/`EnterPlanMode` are disallowed for a worker
(see `disallowedToolsForRole`) — so mode changes must be daemon-driven. Parent-scoped exactly like
`stopWorker`/`messageWorker`/`redirectWorker` (mirrors their "not your worker" gate).

SECURITY BOUNDARY — fails closed: `mode` must be one of `WORKER_SETTABLE_MODES` (acceptEdits|auto|plan)
or this throws before touching the pty. In particular `bypassPermissions` must NEVER reach
`pty.setPermissionMode` — it disables the acceptEdits+allowlist sandbox a worker is spawned into, and an
agent (a manager calling this tool) must never be able to escalate a worker out of that sandbox.
`default`/`unknown`/any other string is rejected the same way.

Drives the footer via `pty.setPermissionMode`, which reuses the SAME feedback-verified `cycleToMode`
primitive the spawn/resume convergence uses (press Shift+Tab, wait for the footer to actually change) —
pure keystroke injection, bypassing the busy/turn queue (~0 worker tokens). Returns the
FEEDBACK-VERIFIED landed mode, which may differ from `mode` if the cycle gave up early (the caller sees
the truth, not an assumed success).

## Do not

- Do not let `bypassPermissions` (or any string outside `acceptEdits|auto|plan`) reach
  `pty.setPermissionMode` — that would let an agent escalate a worker out of its acceptEdits+allowlist
  sandbox.
- Do not assume the landed mode always equals the requested `mode` — `pty.setPermissionMode` returns the
  feedback-verified truth, which can differ if the Shift+Tab cycle gave up early.

## Related

- `docs/decisions/9c03f5a6-auto-mode-entry-warning-suppressed-via-reverse-engineered-flag.md` — a second,
  unrelated decision under the same card id, rejecting `plan` mode outright for a role that cannot
  self-exit it (see that record's "unrelated decision" section).

## Source

Inline comment in `packages/daemon/src/sessions/service.ts`, above `setWorkerMode`: lines 6904-6916 and
6929-6934 (the SECOND BOUNDARY paragraph, lines 6917-6928, is a separate decision under card `9c03f5a6` —
see Related), as of main `fbb3555c`. Relocated by card `1acde858` (tranche 17); wrapped source lines
joined into a flowing paragraph, wording otherwise unchanged.
