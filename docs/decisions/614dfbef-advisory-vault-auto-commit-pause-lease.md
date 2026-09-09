# 614dfbef — Advisory pause lease for vault auto-commit (origin finding 4ae8a3c9)

## Narrative

`pauseVaultAutoCommit` creates a short-lived lease telling a repo root's `VaultVersioner` to skip its commits — for an agent doing SANCTIONED git surgery on a vault repo (untracking files, rewriting `.gitignore`, mid-sequence state) that would otherwise race the background auto-committer. Purely advisory: a plain file the versioner checks before it commits, not an OS-level lock — nothing else is blocked from touching the repo. `durationMs` is clamped to `[0, MAX_VAULT_PAUSE_MS]`. Best-effort: never throws (a failed write just means "not paused").

## Do not

- Do not treat this as a real lock — it only stops `VaultVersioner`'s own commit tick; nothing else is blocked from touching the repo.
- Do not let a caller request an unbounded pause — clamp to `MAX_VAULT_PAUSE_MS` so a mistaken huge duration can't silence auto-commit for good.
