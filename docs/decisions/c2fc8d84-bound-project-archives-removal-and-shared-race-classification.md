# c2fc8d84 — bound `deleteProjectArchives`'s sync removal; share the timeout/rejection race classification

## Narrative

From `8e32605d`'s own Code Review (reviewer `bda6418e`, gen 427): `sessions/transcript.ts`'s
`deleteProjectArchives` ran a SYNCHRONOUS `fs.rmSync(LOOM_HOME/archives/<id>, {recursive:true})` on the
same human-only `DELETE /api/projects/:id/permanent` route, immediately before `deleteProjectWorkDir`
(which `8e32605d` had just bounded). A wedged Windows directory handle there blocks the EVENT LOOP
itself — worse than the libuv-threadpool-slot hazard `bd9fc808` fixed, since it stalls every other
request the daemon is serving, not just one call's own promise.

The same review's Minor 1 noted a second, separate defect: `removeWorktree` (`git/worktrees.ts`),
`sweepUnresumableScratchDirs` (`sessions/scratch-gc.ts`), and both `removeRunSnapshot`/
`sweepAllRunSnapshots` (`runs/snapshot.ts`) each wrapped their own `killableRemoveDir` call in
`withTimeout(...).catch((): RemoveDirResult => ({removed:false, killed:true}))` — collapsing a genuine
TIMEOUT and a `removeDir` promise REJECTION (reachable only if `killableRemoveDir`'s own `spawnChild`
throws synchronously inside its Promise executor — a removal that never even started) into identical
"genuinely wedged" wording. `8e32605d` round 2 had already fixed this exact defect, but only locally, in
`deleteProjectWorkDir`, via a structural race (`raceRemoval`/`RemovalRaceOutcome`) that discriminates by
WHICH branch settled rather than by sniffing an error message. The four sites above still had the bug.

## The fix

**`raceRemoval`/`RemovalRaceOutcome` moved from `projects/work-dir.ts` into `git/worktrees.ts`**, exported
beside `killableRemoveDir`/`RemoveDirResult` (the natural home — every consumer already imports from
there). All four collapsing-`.catch` sites now use it directly, keeping their OWN existing retry
semantics (`removeWorktree`'s `abortIfClaimed` + clean-retry loop; the three sweep sites' single-attempt,
"leave it for the next boot sweep" shape) and only swapping the classification, with each site's own warn
wording extended to a THIRD case ("removal failed to start: `<message>`") alongside its existing
"genuinely wedged" / "clean failure" wording. No circular-import risk: `git/worktrees.ts`'s own import
graph has no existing reference back to `sessions/transcript.ts` or any of its real importers, and
`sessions/scratch-gc.ts` already imports `git/worktrees.ts` safely today — the same precedent
`sessions/transcript.ts` now follows.

**A second, higher-level helper — `removeDirWithCleanRetry`** — was ALSO extracted from
`deleteProjectWorkDir`'s own retry loop (not just the race discriminator), since `sessions/transcript.ts`'s
new bounded `deleteProjectArchives` needed the identical "one-off delete, clean-retry up to N times,
NEVER retry a killed/rejected outcome" shape. This is the load-bearing invariant card `8e32605d` wrote
once; keeping it in two near-identical loops would let them drift (lesson 155). It deliberately does NOT
own the final warn/log line — each caller keeps its own wording (naming its own id/path/role) — and is
NOT used by the four sweep/removeWorktree sites above, which are a structurally different shape (their own
retry/abort semantics, not a one-off delete) and must not be forced onto this helper's budget contract.

**`deleteProjectArchives`** (`sessions/transcript.ts`) is now `async`, routed through
`removeDirWithCleanRetry`, with its own `DELETE_PROJECT_ARCHIVES_TIMEOUT_MS` (600,000 — 10 minutes),
`DELETE_PROJECT_ARCHIVES_CLEAN_RETRY_ATTEMPTS` (3), `DELETE_PROJECT_ARCHIVES_CLEAN_RETRY_DELAY_MS` (500)
constants — same values, same reasoning as `deleteProjectWorkDir`'s own (a disposable child process pins
no daemon resource while it waits, so a long budget costs only the human-only response settling later in
the pathological case; this reasoning is independent of how large the archives dir actually is). Its
call site (`gateway/server.ts`'s `DELETE /api/projects/:id/permanent` route) now `await`s it, SEQUENTIALLY
before `await deleteProjectWorkDir(id)` — kept sequential, deliberately, not parallelized: the irreversible
DB cascade (`deps.db.deleteProject(id)`) has already committed by this point, the response shape is
unchanged either way, and parallelizing buys a human-only DELETE nothing. The route's combined worst-case
response time is now the SUM of both functions' own worst cases, each stated the same way: `ATTEMPTS ×
timeoutMs + (ATTEMPTS − 1) × delayMs`, once for `DELETE_PROJECT_ARCHIVES_*` and once for
`DELETE_PROJECT_WORK_DIR_*` — never a single constant, since either constant changing independently
changes this sum.

**Out of scope (filed separately by the manager):** `reclaimNodeModulesDir`/`reclaimStaleAsideWorktreeDir`
(`git/worktrees.ts`) call `removeDir(...)` directly with no `withTimeout`/`.catch` wrapper at all — a
synchronous rejection there propagates as an unhandled rejection out of an async function, a different
(arguably worse) shape of the same class of bug. Not touched by this card.

## Do not

- Do not re-collapse a `removeDir`/`killableRemoveDir` call's timeout and rejection outcomes back into
  one message-string-free `{removed:false, killed:true}` via a bare `.catch` at ANY call site — use
  `raceRemoval` (or, for a one-off delete with a clean-retry budget, `removeDirWithCleanRetry`) instead.
- Do not force `removeWorktree`/`sweepUnresumableScratchDirs`/`removeRunSnapshot`/`sweepAllRunSnapshots`
  onto `removeDirWithCleanRetry` — they keep their own retry/abort semantics (claim-checking,
  "leave it for the next boot sweep") and must only swap their `.catch` for `raceRemoval` directly.
- Do not let `removeDirWithCleanRetry` own a caller's warn/log line — each caller's wording (naming its
  own id/path/role) stays with the caller; the helper returns only the structural classification.
- Do not parallelize `deleteProjectArchives`/`deleteProjectWorkDir` at the `DELETE /api/projects/:id/
  permanent` route "for speed" — kept sequential deliberately (see Narrative above); if this is revisited,
  update this record and the route's own comment together.
- Do not shorten `DELETE_PROJECT_ARCHIVES_TIMEOUT_MS` back toward a short git-op-style convention — this
  call site has no later sweep, same reasoning as `DELETE_PROJECT_WORK_DIR_TIMEOUT_MS`.
- Do not touch `reclaimNodeModulesDir`/`reclaimStaleAsideWorktreeDir` as part of this card — they are a
  separate, already-filed follow-up.

## Consequences

`deleteProjectArchives` no longer blocks the daemon's event loop on a wedged Windows directory handle; a
wedged removal there now bounds the SAME human-only route's response time, via a disposable killable
child process, exactly like `deleteProjectWorkDir` already did. A `removeDir` call that rejects
(never-started) rather than times out is now logged distinctly — "removal failed to start: `<message>`"
— at every site that routes through `killableRemoveDir`, never mislabeled "genuinely wedged". The
one-off-delete retry shape (`8e32605d`'s own invariant) now lives in exactly one function
(`removeDirWithCleanRetry`), shared by `deleteProjectWorkDir` and `deleteProjectArchives`, rather than
two near-identical loops that could drift independently.

## Source

`packages/daemon/src/git/worktrees.ts` (`raceRemoval`, `removeDirWithCleanRetry`),
`packages/daemon/src/sessions/transcript.ts` (`deleteProjectArchives`),
`packages/daemon/src/projects/work-dir.ts` (`deleteProjectWorkDir`, updated to use the shared helper),
`packages/daemon/src/sessions/scratch-gc.ts`, `packages/daemon/src/runs/snapshot.ts`,
`packages/daemon/src/gateway/server.ts` — card `c2fc8d84`, discovered from card `8e32605d`.
