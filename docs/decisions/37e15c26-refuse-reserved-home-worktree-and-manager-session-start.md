# 37e15c26 — refuse a worktree cut against a reserved-home repo, and refuse a fresh manager session start there

Follow-up to `f9360c84` (GitWriter's `refuseIfOperationalHome`). That card closed the trust-boundary gap
for every write that goes through `GitWriter` — but `git/worktrees.ts`'s `createWorktree`/`mergeBranch`
never went through `GitWriter` at all: a manager session (or its workers) bound to a reserved home
(Platform / Setup, whose `repoPath === vaultPath === LOOM_HOME`) could `git worktree add` against, and
squash-merge commits onto, `LOOM_HOME/.git` directly. Separately, nothing refused starting a fresh
MANAGER session against a reserved home in the first place.

Three independent guards close this, at three different trust boundaries:

1. **`createWorktree`** (`git/worktrees.ts`) — mirrors `GitWriter.refuseIfOperationalHome` exactly: checks
   the raw `repoPath` via `isLoomHomeOrAncestor`, then probes `git rev-parse --show-toplevel` and checks
   that too, fail-closed on any probe failure other than an affirmative "not a git repository". Placed
   before every mutating git call in the function (including the read-only HEAD rev-parse, so no git call
   in this function ever runs against an operational home).
2. **The resolved-role chokepoint, `refuseManagerIntoReservedHome(role, project)`** — refuses whenever a
   FRESH session's ACTUAL RESOLVED role is `"manager"` against a reserved home (`project.repoPath`
   resolving to `LOOM_HOME` or an ancestor, via the SAME raw-path-only `isLoomHomeOrAncestor` predicate; no
   toplevel probe at session-start time — at that point we're only about to set a PTY `cwd`, no git call
   has happened yet, so the probe belongs at the actual git chokepoints, (1) and (3)). Called from both
   `SessionService.startManager` (role is always explicitly `"manager"` there) and from `startNew`'s
   resolved-role path: `startNew` can ALSO resolve a fresh session's role to `"manager"` (a Profile confers
   it — `resolveAgentSpawn`'s `explicitRole ?? profileRole`), and `startNew` is reachable from REST with no
   explicit role, from event-trigger/poll dispatch, and from webhook ingress — none of which goes through
   `startManager`'s own call path. The check runs against the ACTUAL resolved role in both callers, never
   an assumption about which caller is calling.
3. **`confirmWorkerMerge`** (`sessions/service.ts`) — re-resolves `repoPath` LIVE on EVERY call
   (`resolveRepoByKey(project, worker.repoKey)`), not just once at worktree-cut time, so guard (1) alone
   does not cover it. The gap: a merge is rejected (worktree/branch retained, worker stopped) → the
   project's repo is REBOUND to a `LOOM_HOME`-shaped git repo (`checkRepoRebind` only blocks a LIVE
   worktree session, never a stopped worker whose worktree/branch is merely retained) → a re-confirm then
   runs the squash/commit/update-ref against it. Before this guard, that route was saved only by the branch
   happening to be absent there. Closed by the SAME `isLoomHomeOrAncestor` raw-path check plus the
   identical fail-closed toplevel probe, placed directly inside `confirmWorkerMerge` immediately after its
   live `resolveRepoByKey` call and before anything that touches `repoPath` (the quarantine check, the
   union-merge, and the eventual `pauseVaultAutoCommit`/lock inside `mergeBranchLocked`) — deliberately
   inside `service.ts`'s `confirmWorkerMerge` itself, not inside `git/worktrees.ts`'s `mergeBranch`/
   `mergeBranchLocked` (a concurrent card was editing those at the time). `mergeBatchTracked` (the batch
   path) is covered separately and needed no new guard: it re-resolves `finalRepoPath` and re-cuts through
   the already-guarded `createWorktree` on every batch, so it never reaches a stale rebind this way.

`startPlatformLead`/`startSetup` are DELIBERATELY NOT guarded — both reserved homes' `repoPath` IS
`LOOM_HOME` BY DESIGN, and both legitimately boot with `cwd: project.repoPath === LOOM_HOME`. Verified at
source (2026-10-02): neither reserved home seeds a `manager`-role agent (Platform home seeds only
"Platform Lead"/platform and "Platform Auditor"/auditor; the Setup home seeds only "Platform"/setup,
"Workspace Auditor", "Elevated Operator"/operator, and "Companion"/assistant) — so guard (2) above has no
legitimate session to wrongly refuse.

**Known gap, out of scope here, carded separately:** the Platform Lead's `agent_create` (`mcp/platform.ts`)
has no reserved-project check at all (`createAgentCore`, `agents/clone-core.ts`) — unlike the Setup
surface's own `agent_create`, which explicitly refuses a reserved project (`mcp/setup.ts`). This means the
Platform Lead can still `agent_create` a manager-role agent into its own reserved home and then
`session_spawn` it there — guard (2) above refuses that spawn, but the dangling agent row itself is left
mintable. Not fixed here; see the follow-up card.

## Do not

- Do not widen `createWorktree`'s guard to `isOperationalVaultDir`'s content sniff (`loom.db`/`worktrees/`
  presence) — path relation only, or an ordinary repo with its own top-level `worktrees/` folder gets
  wrongly refused (same reasoning as `f9360c84`).
- Do not assume `createWorktree`'s cut-time guard (1) alone covers every merge path — `confirmWorkerMerge`
  re-resolves `repoPath` LIVE on every call and can observe a repo rebind that happened AFTER the cut, so
  it carries its own guard (3, above). The two are separate checks at separate times; neither one covering
  the other was the actual gap round 2 closed.
- Do not put the `confirmWorkerMerge` guard (3) inside `git/worktrees.ts`'s `mergeBranch`/
  `mergeBranchLocked` — keep it in `service.ts`'s `confirmWorkerMerge` itself, so it doesn't collide with
  concurrent edits to those functions elsewhere.
- Do not add the manager-role refusal back as an inline check inside `startManager` alone — it must run at
  the shared resolved-role chokepoint (`refuseManagerIntoReservedHome`), called from every path that can
  resolve a fresh session's role to `"manager"`, including `startNew`.
- Do not add this check to `startPlatformLead` or `startSetup` — both legitimately run with
  `cwd === LOOM_HOME`; a blanket check there refuses the Platform Lead / Setup Assistant themselves. If a
  future change ever seeds a `manager`-role agent into a reserved home, re-derive this reasoning before
  assuming it still holds.
- Do not add a second `isLoomHomeOrAncestor`/`isNotAGitRepositoryError`-equivalent implementation anywhere
  — `createWorktree` imports `isLoomHomeOrAncestor` from `vault/versioner.ts` and `isNotAGitRepositoryError`
  from `git/bounded.ts` (its home since card `306dd105`; it is no longer defined in or re-exported from
  `git/writer.ts`); never re-derive either.
- Do not skip the toplevel probe in `createWorktree`/`confirmWorkerMerge` and rely on the raw-path check
  alone — a non-git DESCENDANT of `LOOM_HOME` (no own `.git`) would pass the raw check while `git worktree
  add` itself walks up and mutates `LOOM_HOME/.git`; this is the exact CRITICAL bypass `f9360c84` round 2
  fixed for `GitWriter`, and the same shape applies here.
- Do not treat a `project_init`-created project nested under the workspace root inside `LOOM_HOME` as
  refused — its own `git init` gives it its OWN toplevel (the project dir, not `LOOM_HOME`), so it is NOT
  an ancestor-or-equal match and must pass the guard. Test this pass case explicitly, not just the refusal.
- Do not touch or delete any real `~/.loom/.git` while testing this — every test uses a temp `LOOM_HOME`
  (`useOwnLoomHome` + `requireHermeticEnv`).
- Do not assert the session-start regression test's pass case via `liveSessions()` — it filters to
  `processState: "live"` and misses a row stuck at `"starting"` (the exact state a refused spawn
  reconciles to via `reconcileFailedSpawn`); assert `db.listSessions(agentId).length === 0` instead.
