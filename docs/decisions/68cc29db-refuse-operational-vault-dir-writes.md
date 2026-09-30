# 68cc29db — refuse (never redirect) a vault write to an operational home dir

## Narrative

`vault/versioner.ts`'s `commitVault` ran `git init` on a non-repo vault path and then staged everything
(`git add .`) unconditionally. The only existing operational-dir guard, `isOperationalVaultDir` (detects
a `LOOM_HOME`-rooted dir by content — a `loom.db` file or a `worktrees/` dir — or by exact `LOOM_HOME`
equality), was wired into only one caller: `startVaultVersioners`'s boot loop, which skips constructing a
`VaultVersioner` for such a dir. It was never checked on the WRITE path: `vault/writer.ts`'s
`writeVaultFile`/`createVaultFile`/`deleteVaultFile` call `commitVault` directly, with no versioner in
between.

Both reserved homes bind `vaultPath` to `LOOM_HOME` (`platform/seed.ts`'s `PLATFORM_HOME_PATH`,
`setup/seed.ts`'s `SETUP_HOME_PATH` — the latter ships to every end user). So any vault write reaching
one of those two homes — the human REST `PUT`/`POST`/`DELETE /api/projects/:id/vault/file`, the
`LOOM_DEV`-gated Platform Lead's `vault_write`, or the ungated Setup/"Platform" operator's `vault_write`
(when granted; see `CLAUDE.md`'s "Setup Assistant → Platform operator" section) — would `git init` +
`git add .` in `LOOM_HOME` itself, staging the live `loom.db` + its `-wal`/`-shm`, `backups/`, `logs/`,
worker `worktrees/` (with their own `node_modules`), the shared Python venv, and any secrets-bearing
file living there. The owner's own host was never bitten only because `~/.loom` happens to carry a
hand-added `.gitignore`; a fresh end-user machine has none.

## Decision

**Refuse the write outright — never redirect it to a subdir.** A silent redirect (e.g. writing into
`LOOM_HOME/vault-fallback/` instead) would still let an operational home's `vaultPath` misconfiguration
go unnoticed, and it adds a second, undocumented location nothing else in the system expects to find
vault content in. A hard refusal is simpler, matches the trust posture of every other host-write guard in
this codebase (fail closed, name the cause), and gives the caller (REST client, MCP tool result) a clear
signal to fix the actual misconfiguration rather than silently keep working against the wrong target.

Two guards, not one, both reusing the SAME `isOperationalVaultDir` predicate (now exported from
`vault/versioner.ts` — no second copy):

1. **`commitVault` itself** (`vault/versioner.ts`) — the chokepoint every caller reaches (the
   auto-committer's own debounced tick AND every `vault/writer.ts` write). Refuses to `git init`/stage/
   commit and returns `false`, with a `console.warn`, before touching git at all.
2. **`vault/writer.ts`'s three write functions** — refuse BEFORE any `fs` mutation, returning a new
   `VaultWriteOutcome` reason, `"operational-dir"`, so files are never written into `LOOM_HOME` in the
   first place (guard 1 alone would still have let the file land on disk, uncommitted, before
   `commitVault` refused).

The REST route (`gateway/server.ts`'s `writeReply`) maps `"operational-dir"` to `403`. Every MCP tool
description that surfaces `VaultWriteOutcome.reason` (`mcp/server.ts`'s core-surface `vault_write`,
`mcp/platform.ts`'s Platform Lead `vault_write`, `mcp/operator.ts`'s operator `vault_write`) documents
the new reason.

## Do not

- Do not redirect an operational-home vault write to a fallback subdir — refuse it; see "Decision" above.
- Do not write a second `isOperationalVaultDir`-equivalent predicate anywhere else — import the one
  exported from `vault/versioner.ts`.
- Do not guard only `commitVault` and skip `vault/writer.ts` (or vice versa) — a `commitVault`-only guard
  still lets a file land on disk inside `LOOM_HOME` uncommitted; a writer-only guard leaves the
  auto-committer's own tick (and any future direct `commitVault` caller) unprotected.
- Do not check only exact equality against `LOOM_HOME` — see "Addendum: ancestor dirs" below.

## Addendum: ancestor dirs (Code Review follow-up)

The first pass of `isOperationalVaultDir` only matched a `vaultPath` that IS `LOOM_HOME`, or that directly
CONTAINS a `loom.db` file or a `worktrees/` dir. Code Review on commit `06f05522` found this incomplete: a
`vaultPath` that is an ANCESTOR of `LOOM_HOME` — e.g. the user's home directory itself, bound by mistake
via manager `project_update` or the setup operator's `project_create` — still reaches every one of those
same three writers/`startVaultVersioners`, and `git add .` from that ancestor would sweep in `loom.db`,
every secret file living in `LOOM_HOME`, AND the sibling `WORKTREES_DIR` (`<LOOM_HOME>-worktrees`, e.g.
`~/.loom-worktrees` — a real user's home dir is the parent of BOTH by construction, see `paths.ts`).

**Decision:** extend `isOperationalVaultDir` itself (not a caller) to also refuse when `LOOM_HOME` or
`WORKTREES_DIR` is INSIDE `dir` (i.e. `dir` is an ancestor of either) — every caller, including the boot
versioner (`startVaultVersioners`), inherits this for free since they all reuse the one predicate. The
comparison resolves both sides through `fs.realpathSync` (falling back to a lexical `path.resolve` when a
side doesn't exist yet) so a symlink/junction alias can't hide the relationship, and normalizes
case-insensitively on `win32` — the same posture the exact-equality check already had.

## Do not (ancestor addendum)

- Do not compare `dir` against `LOOM_HOME`/`WORKTREES_DIR` lexically only — resolve both through
  `fs.realpathSync` (with a lexical fallback for a not-yet-existing path) so a junction/symlink alias
  can't defeat the ancestor check.
- Do not add the ancestor check as a SEPARATE guard at a caller — it belongs inside
  `isOperationalVaultDir` itself, so `startVaultVersioners`'s boot loop inherits it automatically.
- Do not touch `resolveVaultGitTarget` (the companion `git-push` capability's target resolver) for this —
  out of scope for this card; boarded separately.

## Source

Card `68cc29db`, discovered from full review lane 5 (card `67179c22`), origin finding via lead `gen 380`.
Ancestor-dir addendum: Code Review of commit `06f05522`.
`packages/daemon/src/vault/versioner.ts` (`commitVault`, `isOperationalVaultDir`), `packages/daemon/src/vault/writer.ts`.
