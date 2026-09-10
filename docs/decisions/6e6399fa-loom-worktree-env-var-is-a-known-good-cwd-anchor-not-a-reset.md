# sha:6e6399fa — `LOOM_WORKTREE` is a known-good cwd anchor, not a cwd reset

## Narrative

`buildSpawnEnv` carries `LOOM_WORKTREE=spawnCwd` — a stable anchor an agent's OWN Bash calls can
reference (e.g. `cd "$LOOM_WORKTREE" && …`) to make a cwd-dependent command deterministic regardless of
what an earlier call's `cd` left behind. Loom cannot reset the Bash tool's cwd itself — that shell state
is internal to the upstream Claude Code CLI process, invisible past its pty — so this is the strongest
reachable mitigation: a known-good absolute anchor, not a reset. Uniform across every session kind — for
a worker `spawnCwd` is the worktree root; for a manager/companion/plain session it's just that session's
own cwd (repo/project root). Set before the `sessionEnv` merge, like the git-safety vars (see
`sha:28985a08`), so a deliberate override still wins.

## Do not

- Do not assume Loom can reset a session's shell cwd directly — it cannot; `LOOM_WORKTREE` is a pointer
  the agent must consult itself, not an enforced reset.
- Do not set `LOOM_WORKTREE` after the `sessionEnv` merge — a deliberate override must still win.

## Source

Inline doc comment above `buildSpawnEnv` in `packages/daemon/src/pty/host.ts` (the `LOOM_WORKTREE`
paragraph), introduced by commit `6e6399fa54` ("fix(pty): reset each worker Bash call cwd to the
worktree root (or surface cwd in the result header)"), as of main `afce859a`.
