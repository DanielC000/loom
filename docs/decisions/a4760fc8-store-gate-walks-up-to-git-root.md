# a4760fc8 — the decision-record store-existence gate walks up to the nearest .git before checking, mirroring the runtime resolver

Before this card, `anyDecisionRecordStoreExists` (`packages/daemon/src/pty/claude-settings.ts`) checked
`docs/<kind>` directly under the PASSED `cwd`, with no walk-up at all — disagreeing with
`decision-records.mjs`'s own runtime resolution, which DOES walk up via `findRepoRoot`. That mismatch was
silent and one-directional: a session whose cwd sits BELOW the real git root (a project bound to a
SUBFOLDER of a larger repo — e.g. several Loom projects sharing one Obsidian vault, each bound to its own
subfolder within it, with the vault's `.git` and its `docs/decisions` store both at the shared ROOT) would
never see a store under its own subfolder, the gate would report `false`, and the Read hook would never be
wired — decision-record injection silently inert for that project, forever, with no error anywhere.

A worker's own worktree (whose `.git` sits directly at its own root) and a plain code-repo project (`cwd`
already IS the repo root) were both unaffected either way; the bug was specific to a `cwd` genuinely below
the resolvable root.

The fix: `anyDecisionRecordStoreExists` now calls `findGitRootUpward` (same file) first — a duplicate of
`decision-records.mjs`'s own `findRepoRoot` — and checks the record stores at the RESOLVED root, falling
back to `cwd` itself only when no `.git` is found anywhere above it (e.g. a freshly `project_init`'d
vault-only folder the vault auto-committer hasn't `git init`'d yet).

## Do not

- Do not revert to a bare `fs.existsSync(path.join(cwd, "docs", kind))` check — that reintroduces exactly
  this gap for any future project whose bound path is a subfolder of its own repo.
- Do not assume `findGitRootUpward` needs to distinguish a `.git` directory from a `.git` FILE (a git
  worktree's marker) — `fs.existsSync` already treats either as present, and that is the correct behavior;
  do not add type-checking logic that would only risk rejecting the worktree case.
- Do not let this walk-up diverge from `decision-records.mjs`'s own `findRepoRoot` — the two must keep
  resolving the SAME root for the SAME cwd, or the gate and the runtime injector disagree again in some
  new way.
