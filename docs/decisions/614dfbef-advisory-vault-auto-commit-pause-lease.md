# 614dfbef — Advisory pause lease for vault auto-commit (origin finding 4ae8a3c9)

## Narrative

`pauseVaultAutoCommit` creates a short-lived lease telling a repo root's `VaultVersioner` to skip its commits — for an agent doing SANCTIONED git surgery on a vault repo (untracking files, rewriting `.gitignore`, mid-sequence state) that would otherwise race the background auto-committer. Purely advisory: a plain file the versioner checks before it commits, not an OS-level lock — nothing else is blocked from touching the repo. `durationMs` is clamped to `[0, MAX_VAULT_PAUSE_MS]`. Best-effort: never throws (a failed write just means "not paused").

## `GitWriter`'s wrapper (`git/writer.ts`)

`withVaultPauseLease` holds this lease for the duration of one checkout/commit/push op on
`this.repoPath`. Harmless when `repoPath` isn't a watched vault root — the lease is just an unused file
under its own `.git/` that nothing reads. Always resumes in `finally`, so a lease is never left held
past the call even if the wrapped op throws (the lease's own TTL is a self-healing backstop regardless).

`push()` also durably records its outcome via `recordGitPushOutcome` — the ONE chokepoint every real
pusher (this class, the REST git-write surface, the Platform MCP, and the companion `git-push`
capability) routes through, so a rejecting remote (e.g. GitHub's >100MB blob hard-limit) is durably
known instead of only discoverable by an agent doing forensics after the fact — this is the origin
finding (4ae8a3c9) this card exists to close. A vault's periodic push-status log
(`logVaultPushStatus`/`VaultPushStatusWatcher`) surfaces a recorded failure the next time it ticks.

## Do not

- Do not treat this as a real lock — it only stops `VaultVersioner`'s own commit tick; nothing else is blocked from touching the repo.
- Do not let a caller request an unbounded pause — clamp to `MAX_VAULT_PAUSE_MS` so a mistaken huge duration can't silence auto-commit for good.
- Do not skip `recordGitPushOutcome` on a push failure — surfacing a rejected remote durably is the origin finding this card closes.
