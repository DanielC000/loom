# sha:28985a08 — Git-safety env vars close the unattended pty pager/auth-prompt wedge

## Narrative

`buildSpawnEnv` (`pty/host.ts`) sets three git-safety vars, in the INHERITED env of every `claude`
worker pty, that close the "git wedges the UNATTENDED worker pty" class:

- `GIT_PAGER=cat` / `PAGER=cat` — git (and other pager-using tools) can never launch `less` and block
  forever on `q`. Without this a worker's post-commit `git diff`/`git log` could page and never return,
  freezing the turn at busy — a FALSE `[loom:worker-stuck]` trip plus its `worker_report` queued
  undelivered. This is the specific bug the commit fixes.
- `GIT_TERMINAL_PROMPT=0` — git FAILS FAST on an auth/credential prompt instead of hanging on it (mirrors
  `git/writer.ts`; same unattended-wedge class as the pager).

All three are set BEFORE the `sessionEnv` merge, so a project that deliberately overrides any of them via
`config.sessionEnv` still wins (no capability regression). Every other byte of the env is unchanged from
before this commit. Exported so the hermetic spawn-env test asserts the vars, the scrub, and the override.

## Do not

- Do not set these vars AFTER the `sessionEnv` merge — a project's deliberate override must still win.
- Do not assume a worker's own git commands are safe to run without these — an unattended session has no
  human to answer a pager or credential prompt, so either one wedges the turn indefinitely.

## Source

Inline doc comment above `buildSpawnEnv` in `packages/daemon/src/pty/host.ts` (the git-safety-vars
paragraph), introduced by commit `28985a08f2` ("fix(pty): workers wedge in post-commit cleanup → false
worker-stuck + queued report"), as of main `afce859a`.
