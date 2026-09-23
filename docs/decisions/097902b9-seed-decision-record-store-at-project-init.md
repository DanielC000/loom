# 097902b9 — seed a decision-record store when `project_init` creates a project

## Narrative

Child F of epic `f69cabc7` ("all projects, from now on"). `pty/claude-settings.ts`'s
`writeSessionSettings` wires the decision-records `Read` hook only when `anyDecisionRecordStoreExists`
finds one of three stores (`docs/adr`, `docs/decisions`, `docs/investigations`) under the session's own
repo root (card `5244adc2`, kept unchanged by this card). A project created by hand eventually earns a
store once someone writes a record; a project created via `project_init` (the setup operator's only
host-write — `setup/bootstrap.ts`'s `bootstrapProjectDir`, called from `mcp/setup.ts`, `mcp/platform.ts`,
and the human REST route) had no store at all, so its very first session never got the hook wired.

`bootstrapProjectDir` now seeds `docs/decisions/README.md` (a real file, not a bare directory — git does
not track an empty directory, so a bare `mkdir` would vanish the instant anything needed it to survive a
commit/checkout round-trip, e.g. a worker's own worktree cut from a commit) at the single chokepoint every
`project_init`-equivalent caller already shares, right after the directory is successfully created (and,
for a code project, after `git init` succeeds — never seeded if that fails and the half-bootstrapped
directory is rolled back). The README text is deliberately GENERIC: it ships into an end user's own
project repo, so it names no Loom-specific path or card id, and it does not assume a source-code comment
syntax for the anchor — it just says "a short anchor comment," which reads correctly whether the anchor is
a `//`-prefixed code comment or a markdown `<!-- -->` one. It points at the shipped `/worker` doctrine
("Extracting a decision record") for the actual writing/anchoring rules rather than restating them.

Both `kind:"git"` and `kind:"vault"` are seeded, unconditionally, the same way. A `kind:"vault"` project's
created folder is bound as BOTH `repoPath` and `vaultPath` (see `mcp/setup.ts`/`mcp/platform.ts`'s
`project_init` handlers — `repoPath: boot.dir, vaultPath: isGit ? "" : boot.dir`), and
`vault/versioner.ts`'s `resolveVaultRepoContext` resolves a vault folder with no pre-existing repo
anywhere above it to itself ("No repo → we own it") — the versioner then lazily `git init`s that same
folder the first time it starts. A freshly `project_init`-created vault folder therefore IS its own
eventual git root already; there is no separate "does the vault share a root with other projects"
resolution to defer here, because nothing pre-exists yet for it to share. That question (an EXISTING
vault project's store discovery, and the markdown anchor grammar itself) is child C's own scope (card
`a4760fc8`) — this card only had to confirm the freshly-created case doesn't need to wait on it, which the
`project_init` code path above proves directly.

A worker session's own worktree (cut via `git worktree add` from a commit, unlike a manager/platform/
setup/auditor/workspace-auditor/operator session, which runs directly in the project's main checkout) will
NOT see this seed until something commits it — `bootstrapProjectDir` deliberately does not commit on
behalf of the caller (committing would need a resolvable git identity, and `checkCommitIdentity`'s
existing posture treats that as a non-blocking advisory, not a precondition project_init enforces). This
is not a regression: a genuinely commitless `project_init`'d repo already cannot have a worker spawned
onto it at all today (`git/worktrees.ts`'s `createWorktree` calls `git rev-parse HEAD` unconditionally,
which throws on an unborn HEAD) — see project memory key `decision-store-seed-worktree-gap` on this
project.

## Do not

- Do not gate the vault (`kind:"vault"`) seed behind child C's ruling — a `project_init`-created vault
  folder has no pre-existing repo above it, so it is already its own eventual git root; there is nothing
  to defer.
- Do not seed a bare `mkdir` with no file inside it — git does not track an empty directory, and a
  worker's own worktree (cut from a commit) would never see it.
- Do not write Loom-specific paths, card ids, or product names into the seeded README — it ships into an
  end user's own project repo.
- Do not have `bootstrapProjectDir` commit the seeded file — that would require a resolvable git identity,
  which `checkCommitIdentity`'s existing non-blocking posture does not guarantee at `project_init` time.

## Source

`packages/daemon/src/setup/bootstrap.ts`'s `seedDecisionRecordStore`/`DECISION_RECORD_README`, worker
report on card `097902b9`.
