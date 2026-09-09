# f48ee77d — Vault auto-commit is commit-only by design; it never pushes

## Narrative

`VaultVersioner` auto-commits a project's vault so doc rewrites are never truly lost. It debounces writes and commits at idle, resolving the vault to its GOVERNING repo root (`resolveVaultRepoContext`) and watching + committing THERE — so a vault that is a subfolder of a plain repo gets per-edit history at the repo root, while a vault folder that is its own repo root (or has no repo) is watched/committed in place. It backs off ONLY for an Obsidian-Git-managed repo (a real external auto-committer already owns its history).

**Commit-only by design — this never pushes, and that is intentional, not a gap.** Investigated under task f48ee77d: a vault was observed with 172 `loom: auto-commit` commits ahead of `origin/main`. Pushing a repo is a HUMAN-only trust-boundary action in Loom (see `git/writer.ts`'s `GitWriter.push()` + the human-only git-write REST surface) — this versioner runs unattended in the daemon, triggered by any filesystem event (including an ordinary agent's doc rewrite), so it must never perform outbound network git operations itself; doing so would silently widen that boundary. For a vault whose governing repo DOES have a configured upstream, the resulting backlog is made VISIBLE instead of silent via `checkVaultPushStatus` / `VaultPushStatusWatcher` (read-only `rev-list --count`, no writes) — push stays a manual action the human takes through the existing git-write surface.

## Do not

- Do not add a push call anywhere in this versioner — that would silently widen the human-only push trust boundary described above.
- Do not treat an unpushed backlog as itself a bug — surface it via `checkVaultPushStatus`/`VaultPushStatusWatcher`, never by pushing automatically.
