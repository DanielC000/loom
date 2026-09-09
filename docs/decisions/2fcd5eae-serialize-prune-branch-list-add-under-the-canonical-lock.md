# 2fcd5eae — Serialize `prune` → `branch --list` → `add` per canonical repo under the canonical index lock

## Narrative

Card `2fcd5eae`: `prune` → `branch --list` → `add` is a multi-step read-modify-write against the SHARED `.git/worktrees/` admin state — serialize ONLY this sequence per canonical repo path, via the SAME lock `mergeBranch`/`GitWriter` already use (`withCanonicalIndexLock`, `repo-lock.ts`). Verified no re-entrancy: `createWorktree`'s one call site (`sessions/service.ts`'s `spawnWorker`) is never reached while this lock is already held — `mergeBranch` (the lock's other acquirer) always fully returns (releasing the lock) before its caller goes anywhere near a spawn, and the cap-queue drain that can follow a merge's finalize is fire-and-forget, never nested inside the lock's callback. This deliberately does NOT wrap `provisionWorktreeDeps` (a package-manager install, potentially minutes) — that would serialize every worker spawn on the daemon behind each other's install.

Card `8e75ee20`: unlike every OTHER bounded call in this file, the three calls inside this lock run WHILE holding it — releasing the lock on a bare `withTimeout` race (which settles independent of the child) would let the NEXT queued caller start while THIS call's `git worktree add` may still be alive and still mutating `.git/worktrees/`, reopening the exact race the lock exists to close. So the REAL git path (no injected `gitDeps.gitFactory`) uses `withTimeoutKillingChild`, which kills the child on expiry and only settles once that child is confirmed dead. A test's `gitFactory` fake can't be killed (it ignores the abort signal entirely — there's no real child behind it), so that path keeps the plain `withTimeout` race, unchanged from before.

## Do not

- Do not wrap `provisionWorktreeDeps` inside `withCanonicalIndexLock` — a package install can take minutes and would serialize every worker spawn on the daemon behind each other's install.
- Do not release `withCanonicalIndexLock` on a bare `withTimeout` race for the three lock-scoped calls — use `withTimeoutKillingChild` so the lock is only released once the child is confirmed dead, never while it may still be mutating `.git/worktrees/`.

## Source

Inline comment in `packages/daemon/src/git/worktrees.ts`, ahead of the `boundedLockedRaw` helper inside `createWorktree` (~line 1043), as of commit `f8d18a2cbc315a3020b962ac7e85cf2194ca09ba`. Relocated by card `5b001dde`; wrapped source lines joined into flowing paragraphs, `//` comment markers stripped, no wording changed.
