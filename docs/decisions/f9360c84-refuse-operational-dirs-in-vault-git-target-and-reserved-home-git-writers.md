# f9360c84 — refuse operational dirs in the shared vault git target resolver and reserved-home git writers

## Narrative

Follow-up from the Code Review of `68cc29db` (reviewer `74590101`) — read that record first; its own
"Do not" section explicitly scoped `resolveVaultGitTarget` out ("boarded separately"). That card fixed
`commitVault`/`vault/writer.ts` so a vault WRITE can never `git init`/stage/commit an operational
(`LOOM_HOME`-rooted) dir. It left four other chokepoints unguarded, each reaching a reserved home's
`repoPath`/`vaultPath` — both of which equal `LOOM_HOME` exactly (`platform/seed.ts`'s
`PLATFORM_HOME_PATH`, `setup/seed.ts`'s `SETUP_HOME_PATH`):

1. `resolveVaultGitTarget` (`vault/versioner.ts`) — the companion `git-push` capability's `"vault"`-target
   resolver. Only refused on `"no-repo"`/`"externally-managed"`; never checked `isOperationalVaultDir`.
2. `resolveGitPushTarget`'s `"repo"`-target branch (`companion/capabilities.ts`) — returned
   `project.repoPath` verbatim with NO check at all (not even `checkIsRepo`), bypassing (1) entirely.
3. The Platform Lead's `git_checkout`/`git_create_branch`/`git_commit`/`git_push` (`mcp/platform.ts`,
   shared `resolveGitWriter`) — resolved `repoPath` via `resolveRepoByKey` straight into `GitWriter`.
4. The human REST `/api/projects/:id/git/{checkout,branch,commit,push}` (`gateway/server.ts`) — same
   shape as (3), one `new GitWriter(p.repoPath, …)` per route, no shared resolver at all.

Investigate-first confirmed all four reachable: nothing in grant scoping, `resolveRepoByKey`, or either
project's `reserved`/`vaultOnly` flags stops a companion grant, the Lead, or a human REST call from
targeting the Platform or Setup project. `p.reserved` is checked only by `project_archive`/rebind/delete —
never by any git-write path. The precondition (an existing `.git` at `LOOM_HOME`) is not hypothetical: the
owner's real `~/.loom` already has one, left over from before `68cc29db` closed the write-time hole.

## Decision

**Refuse, reusing the SAME `isOperationalVaultDir` predicate everywhere — no second copy, no redirect.**
Two shapes, because the four chokepoints split into two families:

- **(1) already resolves to a target repoPath through its own function** — add the check directly inside
  `resolveVaultGitTarget`, against both the raw `vaultPath` (so a reserved home's EXACT `vaultPath` never
  reaches a git call at all) and the resolved `ctx.commitPath` (the subfolder-of-a-bigger-repo case,
  mirroring `startVaultVersioners`'s own dual check). Added `"operational-dir"` to `VaultGitTargetResult`.
- **(2), (3), (4) hand a project's `repoPath` straight to `GitWriter` with no resolution step of their
  own** — one new shared wrapper, `refuseOperationalRepoPath` (`vault/versioner.ts`, next to the
  predicate it wraps), returning `{ok:false,error}` or `null`. Each of the three call sites calls it
  BEFORE constructing/invoking `GitWriter`, so no `git status`/`add -A` ever runs against `LOOM_HOME`.

`isOperationalVaultDir` itself was not changed — it already resolves both sides through
`fs.realpathSync` (junction/symlink-safe) and normalizes case on `win32`, so a non-canonical spelling of
`LOOM_HOME` (mixed case, trailing slash, a junction alias) is caught without any new logic.

## ROUND 2 (Code Review `2e017ba8` of the round-1 branch) — moved INTO `GitWriter`, CRITICAL bypass fixed

Round 1 (above) put the refusal at each CALLER — a new shared wrapper, `refuseOperationalRepoPath`,
invoked before constructing a `GitWriter` at (2)/(3)/(4). A second Code Review reproduced a CRITICAL
bypass in that shape: the wrapper only ever checked the CALLER's raw `repoPath`, never the git TOPLEVEL
`GitWriter` actually writes to. A non-git **descendant** of `LOOM_HOME` (e.g. a `project_init
kind:"vault"` home nested under it, `LOOM_HOME/workspaces/<name>`) passes the raw-path check cleanly,
while git itself walks UP from that descendant, finds `LOOM_HOME/.git`, and `add -A` stages `loom.db`
alongside whatever the caller actually meant to commit. The review also found a MAJOR gap the round-1
sweep missed entirely: `mcp/operator.ts`'s bounded Elevated Operator `git_checkout`/`git_create_branch`/
`git_commit`/`git_push` had NO operational-dir check of any kind — round 1's four-chokepoint survey never
named it.

**Fix:** own the invariant INSIDE `GitWriter` itself (`git/writer.ts`), not at each caller. Every mutating
write method (`checkout`/`createBranch`/`commit`/`push`) now calls a private `refuseIfOperationalHome()`
guard, BEFORE any mutating git call, which refuses when EITHER:
- the raw `this.repoPath` is `LOOM_HOME` or an ancestor of it, OR
- the git-resolved TOPLEVEL (`git rev-parse --show-toplevel`, via the writer's own bounded git runner) is
  `LOOM_HOME` or an ancestor of it — this is what catches the non-git-descendant bypass above, since it
  resolves to the SAME toplevel git itself would use.

A toplevel-resolution FAILURE (no repo yet, or the bounded call errors) is never itself a refusal — it
falls through and lets the real op fail on its own terms; only an AFFIRMATIVE match refuses. The raw-path
check, by contrast, always runs regardless.

Since the refusal now lives in `GitWriter`, it covers **every** write surface for free — human REST,
Platform Lead, AND the bounded Operator (the MAJOR gap above) — with nothing left for any individual
caller to remember. The round-1 per-caller wrapper (`refuseOperationalRepoPath`) and its four call sites
((2)/(3)/(4) above) were removed as subsumed; `resolveVaultGitTarget`'s own early check (1) was KEPT
as-is (the companion reason map still reads its `"operational-dir"` result).

**Over-refusal ruling:** the `GitWriter` guard uses PATH RELATION ONLY — a new shared helper,
`isLoomHomeOrAncestor(dir)` (`vault/versioner.ts`), extracted from `isOperationalVaultDir`'s own
equality/ancestor check — never `isOperationalVaultDir`'s CONTENT sniff (a top-level `loom.db`/
`worktrees/` dir). Content-sniffing an ordinary code repo that happens to have its own top-level
`worktrees/` folder would wrongly refuse it. `isOperationalVaultDir` itself now calls
`isLoomHomeOrAncestor` for its own path-relation half, so there is still exactly ONE path-relation
implementation, shared by both. That helper resolves via `fs.realpathSync.native` (not plain
`fs.realpathSync`) so an 8.3 short-name alias on Windows can't defeat it either, on top of the existing
junction/symlink safety.

## ROUND 3 (delta review `a9657427`) — narrowed the companion `"repo"`-branch check to path-relation only; fail-closed on a probe failure; realpath.native coverage

The round-2 shape left ONE two-path asymmetry: `resolveGitPushTarget`'s `"repo"` branch
(`companion/capabilities.ts`) still ran its OWN `isOperationalVaultDir(project.repoPath)` check — the
round-1 per-caller check, never removed from this one site. Unlike `GitWriter`'s guard, that check is
CONTENT-sniffing (via `isOperationalVaultDir`, not `isLoomHomeOrAncestor`), so it over-refused an ordinary
repo with its own top-level `worktrees/` folder on the companion `"repo"` target — a refusal REST/Lead/
Operator never produced for the identical repo shape, since they all go through `GitWriter`'s path-relation-
only guard. **Fix: swapped the predicate, not the check.** `resolveGitPushTarget`'s `"repo"` branch now
calls `isLoomHomeOrAncestor(project.repoPath)` directly — the SAME shared, path-relation-only predicate
`GitWriter`'s own guard uses, imported from `vault/versioner.ts`, never a second implementation — and
returns the SAME shared `OPERATIONAL_HOME_GIT_WRITE_ERROR` text on a match. This removes the over-refusal
(a top-level `worktrees/` folder no longer matters) while keeping the early, pre-propose refusal — without
it, a reserved-home `repoPath` would sail past this cheap check and only fail once `GitWriter` is
actually invoked at CONFIRM time (after the companion has already asked the owner to approve a write that
can never land). `GitWriter.refuseIfOperationalHome` still runs as defense-in-depth at the point this
branch's resolved `repoPath` is actually written to (same posture as `resolveVaultGitTarget`'s own kept
check for the `"vault"` target) — it is what additionally catches a non-git DESCENDANT of a reserved home
that this shallow raw-path check cannot see (the round-2 critical bypass's own shape).

Two more fixes from the same review:

- **`refuseIfOperationalHome`'s toplevel-probe failure is now FAIL-CLOSED, not fail-open.** Previously ANY
  probe failure (timeout, killed child, unexpected git error) fell through exactly like a clean "not a git
  repository yet" — treating a probe that could not determine the toplevel as if it had proven there wasn't
  one. Now only an AFFIRMATIVE "not a git repository" failure falls through to let the real op fail on its
  own terms; every other probe failure (a timeout under host load, especially) refuses with a clear
  "could not verify this repo's location; refusing to write" error instead. A retryable refusal beats a
  write that might land in `LOOM_HOME` because the probe happened to be slow.
- **`isLoomHomeOrAncestor`'s `fs.realpathSync.native` resolution now has a dedicated test** (a win32
  directory junction aliasing `LOOM_HOME`'s parent). Measured on this host: the junction case does NOT
  actually discriminate `.native` from plain `fs.realpathSync` — both resolve a junction fine, confirmed by
  reverting `.native` to plain `fs.realpathSync` and seeing the test stay green either way; an 8.3
  short-name alias was the next candidate (plain `fs.realpathSync` is documented not to normalize one) but
  was not pursued to a working test on this host, so that discrimination remains unverified — kept as a
  known gap rather than claimed closed.

## Do not

- Do not re-introduce a per-caller refusal based on `isOperationalVaultDir`'s CONTENT sniff (human REST /
  Platform Lead / Operator / any future git-write surface) — the invariant lives INSIDE `GitWriter`,
  checked once, before every mutating call. A new caller that constructs a `GitWriter` inherits the guard
  automatically; it needs no check of its own. The ONE deliberate exception is the companion `git-push`
  capability's `"repo"` branch (round 3): it keeps a SHALLOW pre-propose check so the companion never asks
  the owner to confirm a write that's certain to fail, but that check is `isLoomHomeOrAncestor` — the SAME
  shared path-relation predicate `GitWriter` itself uses, not a second/content-sniffing implementation —
  and `GitWriter`'s own guard still runs regardless at the point the resolved `repoPath` is actually
  written to.
- Do not check only the RAW `repoPath` for a `GitWriter`-level guard — also resolve and check the
  git-resolved TOPLEVEL (`git rev-parse --show-toplevel`). A raw-path-only check is exactly the CRITICAL
  bypass round 2 fixed: a non-git descendant of `LOOM_HOME` passes it while git itself walks up into
  `LOOM_HOME/.git`.
- Do not fold `isOperationalVaultDir`'s CONTENT sniff (`loom.db`/`worktrees/` presence) into the
  `GitWriter` guard, or into ANY per-caller check that sits in front of it (round 3's own fix) — PATH
  RELATION ONLY (`isLoomHomeOrAncestor`), or an ordinary repo with its own top-level `worktrees/` folder
  gets wrongly refused.
- Do not write a second `isLoomHomeOrAncestor`-equivalent path-relation check anywhere — import it from
  `vault/versioner.ts`; both it and `isOperationalVaultDir` must stay the ONE shared implementation.
- Do not treat a `refuseIfOperationalHome` toplevel-probe FAILURE (timeout, killed child, any error other
  than an affirmative "not a git repository") as "no repo here, fall through" — round 3's fix. Only an
  affirmative "not a git repository" result may fall through; anything else refuses.
- Do not run `resolveVaultRepoContext`'s discovery read (`checkIsRepo`/`rev-parse --show-toplevel`)
  before checking the RAW `vaultPath` for operational-dir in `resolveVaultGitTarget` — for a reserved home
  `vaultPath === LOOM_HOME` exactly, so checking the raw path first means NO git call of any kind reaches
  `LOOM_HOME` when the simple case applies.
- Do not touch or delete any real `~/.loom/.git` found while testing this — report it, never act on it.
  Every test fixture for this card uses a temp `LOOM_HOME` (`useOwnLoomHome` + `requireHermeticEnv`).

## Source

Card `f9360c84`, discovered from the Code Review of `68cc29db` (reviewer `74590101`); round 2 from Code
Review `2e017ba8`; round 3 from delta review `a9657427`. `packages/daemon/src/git/writer.ts`
(`GitWriter.refuseIfOperationalHome`, the current chokepoint), `packages/daemon/src/vault/versioner.ts`
(`isOperationalVaultDir`, `isLoomHomeOrAncestor`, `resolveVaultGitTarget`,
`OPERATIONAL_HOME_GIT_WRITE_ERROR`), `packages/daemon/src/companion/capabilities.ts`
(`resolveGitPushTarget` — round 3 swapped its own content-sniffing check for `isLoomHomeOrAncestor`),
`packages/daemon/src/mcp/
platform.ts` (`resolveGitWriter`), `packages/daemon/src/mcp/operator.ts` (the round-2 MAJOR gap — no code
change needed there; it inherits the fix via `GitWriter`), `packages/daemon/src/gateway/server.ts` (the
four `/api/projects/:id/git/*` routes).
