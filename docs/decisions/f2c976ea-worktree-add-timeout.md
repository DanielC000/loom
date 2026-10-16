# f2c976ea — `worktree add` gets its own 60s wall-clock budget, separate from the 15s ref-op ceiling

## Narrative

Two independent production failures on 2026-10-16, both `"git worktree add exceeded 15000ms (git child killed): Abort signal received"` from `createWorktree`'s locked prune/branch-list/add sequence (`git/worktrees.ts`): a taskless Code Reviewer review spawn at 06:25:21Z (confirmed-killed after 15071ms) and the dist-importer check's own isolated-worktree cut at 07:49:19Z (confirmed-killed after 16266ms). Both lines exist in `daemon-output.log` (`[git] canonical git call confirmed-killed after <N>ms in <repoPath>: git worktree <5 args redacted>`) — they just report the real elapsed ms rather than the literal configured bound, which is why an initial grep for "15000ms" missed them.

`GIT_OP_TIMEOUT_MS` (15s, `@decision 44c28799`) is a pure wall-clock bound (`killableCanonicalRaw` → `withTimeoutKillingChild`, `git/bounded.ts`), not idle-based — it does not reset on child output. It was applied uniformly to every call in the locked sequence: `worktree prune`, `branch --list`, and `worktree add` alike. `worktree add` is categorically different from the other two: it's a bulk filesystem checkout (writes every tracked file), not a ref-only read/update — the exact class `NODE_MODULES_RECLAIM_TIMEOUT_MS` (120s, `git/worktrees.ts`) already got its own dedicated budget for, documented there as "15s, sized for a git ref op, not a bulk filesystem delete."

Both incidents were measured to overlap, exactly, with a DIFFERENT project's full merge gate (`pnpm build && pnpm --filter @loom/daemon test:daemon`) actively admitted on the same host:
- Incident 1 (06:25:21Z): a `codescape` gate (opId `45d616ab`) was admitted 06:23:25.743Z, released (beginSquash) 06:40:48.326Z. Also, 06:25:16-06:25:20Z (seconds before), three separate worktree-directory removals failed as "genuinely wedged" (filesystem-level `killableRemoveDir` timeouts) for three different dirs.
- Incident 2 (07:49:19Z): a `klokk` gate (opId `f073c10d`) was admitted 07:44:20.801Z, released 07:58:11.617Z (ran ~14 minutes).

Contrast case, measured directly (throwaway clone, same repo HEAD, same host): one `git worktree add` with a real checkout of this repo's 3957 tracked files took 3.63s uncontended; three concurrent `worktree add` calls took 4.69s/5.47s/5.48s each. So worktree-add-vs-worktree-add contention alone does not reach 15s, let alone explain the incidents — the foreign gate's own build+test CPU/disk load was the dominant extra factor stacked on top.

`removeWorktree` is deliberately UNLOCKED (`@decision c6a6f405`, same file) — it never takes `withCanonicalIndexLock` — so the wedged-dir sweep cannot be blocking the JS-level mutex itself; the contention is OS-level (concurrent git child processes + the gate's own heavy build/test processes competing for CPU/disk on one host), not a lock deadlock.

## The trade, verified

`worktree add` runs inside `withCanonicalIndexLock` (`git/repo-lock.ts`). That lock has NO acquisition timeout of its own by design — `@decision 44c28799` in that file: "no timeout HERE, deliberately: every wrapped caller bounds its OWN git calls, so a wedged holder fails only its own op, never the whole queue." `@decision 6b8822d2` (same file) makes the FIFO consequence explicit: "a caller queued behind N holders waits their SUM, not one holder's ceiling, and there is no acquisition timeout at all." Every other acquirer — `mergeBranchLocked`'s squash, `confirmWorkerMerge`'s admission-time staged-dirt/overlap preflight probes, `GitWriter.checkout`/`createBranch`/`commit`, `fastForwardCanonicalMain`'s ff-only, `vault/versioner.ts`'s `commitVault` — just waits in FIFO order for the lock, however long the current holder takes. So raising `worktree add`'s own internal budget from 15s to 60s introduces no new failure mode: nothing "times out waiting for the lock," because nothing has a deadline on that wait. The only real effect is that a merge/squash/vault-commit queued behind an in-flight `worktree add` can now wait up to 60s longer (worst case) than it used to, before its own turn starts.

## Do not

- Do not lower `WORKTREE_ADD_TIMEOUT_MS` back toward `GIT_OP_TIMEOUT_MS` — the checkout is a bulk filesystem write, not a ref op, and 15s already confirmed-killed two real adds under ordinary (not pathological) foreign-gate host load.
- Do not raise it further without re-measuring the canonical-lock hold-time cost this creates for every other `withCanonicalIndexLock` caller — the 60s figure was chosen to match `NODE_MODULES_RECLAIM_TIMEOUT_MS`'s order of magnitude for a comparable bulk-filesystem op while staying well short of it, not re-derived from a fresh load test.
- Do not widen `prune`/`branch --list`'s own timeout to match — they are genuine ref ops and should keep failing a wedged attempt fast, unchanged.
- Do not assume a shorter deadline exists anywhere else on `withCanonicalIndexLock`'s queue — it was verified (not assumed) that no acquirer has one; a future change adding one must re-derive this trade-off's safety.
- Do not attribute the slowdown to `.git/worktrees` admin-lock contention from the wedged-dir sweep — `removeWorktree` is deliberately unlocked (`@decision c6a6f405`) and never contends on `withCanonicalIndexLock`; the measured contention is OS-level CPU/disk load, not a JS mutex race.

## Consequences

`createWorktree`'s own `worktree add` call tolerates realistic host contention (a concurrent foreign merge gate's build+test run) without being confirmed-killed, while `prune`/`branch --list` keep failing a genuinely wedged op within the original 15s. A merge/squash/vault-commit queued behind an in-flight `worktree add` may now wait up to 60s (worst case) rather than 15s before its own turn starts — an accepted, bounded cost, not a new refusal.

## Source

Investigation: board card `f2c976ea`. Log evidence: `daemon-output.log` lines (2026-10-16, around 06:25:21Z and 07:49:19Z) and the gate-admission lines for opIds `45d616ab`/`f073c10d`. Contrast measurements: a throwaway clone in the investigating worker's own scratch directory, 2026-10-16, cleaned up after.
