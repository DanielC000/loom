# 8e32605d — `deleteProjectWorkDir` routed through `killableRemoveDir`, moved out of `paths.ts`

## Narrative

`deleteProjectWorkDir` (introduced by card `5eace211`) originally issued one unbounded
`await fs.promises.rm(dir, {recursive:true, force:true, maxRetries:2, retryDelay:250})`. The
`maxRetries`/`retryDelay` options only retry a fast-settling, already-rejected attempt (a transient
Windows EBUSY) — they do nothing for an attempt that never settles at all. A genuinely wedged Windows
directory handle just hangs that one `await` forever, permanently occupying one of the daemon's 4 libuv
threadpool threads (the `bd9fc808` hazard class — see that record) and, in turn, hanging the human-only
`DELETE /api/projects/:id/permanent` response that awaits it.

The fix routes the removal through `killableRemoveDir` (`git/worktrees.ts`) instead — a real, disposable
OS child process (`rmdir /s /q` on win32, `rm -rf` on posix), force-killed on timeout, never the
threadpool. This mirrors the identical pattern already used by `sessions/scratch-gc.ts` and
`runs/snapshot.ts`: an injectable `deps: {removeDir?, timeoutMs?}` seam defaulting to
`(p,ms)=>killableRemoveDir(p,ms)`.

Because this is a ONE-OFF, human-triggered, irreversible delete with no later sweep ever revisiting the
dir (unlike the scratch-gc/run-snapshot sweeps, which get another pass next boot), a short bounded retry
was added for a CLEAN (non-killed) failure only — up to `DELETE_PROJECT_WORK_DIR_CLEAN_RETRY_ATTEMPTS`
(3) attempts, `DELETE_PROJECT_WORK_DIR_CLEAN_RETRY_DELAY_MS` (~500ms) apart, mirroring `removeWorktree`'s
own `REMOVE_DIR_CLEAN_RETRY_ATTEMPTS`/`REMOVE_DIR_CLEAN_RETRY_DELAY_MS` minus its worktree-specific
`abortIfClaimed` check. A KILLED (wedged) result is never retried, by the same `bd9fc808` reasoning:
retrying a wedge in-process just leaks another resource per attempt. The real worst-case wait before this
function gives up and warns is therefore `DELETE_PROJECT_WORK_DIR_CLEAN_RETRY_ATTEMPTS × timeoutMs +
(DELETE_PROJECT_WORK_DIR_CLEAN_RETRY_ATTEMPTS − 1) × DELETE_PROJECT_WORK_DIR_CLEAN_RETRY_DELAY_MS` — stated
in terms of the constants, not a baked-in number, so this sentence never goes stale if either changes.

The function also MOVED out of `paths.ts` into `projects/work-dir.ts`. `paths.ts` is a near-leaf module
(imported by roughly half the daemon) that had, until this card, zero imports from anything under `git/*`.
`git/worktrees.ts` (home of `killableRemoveDir`) already imports FROM `paths.ts` (`WORKTREES_DIR`), so
importing it back into `paths.ts` would create the first circular-import edge on either side. A throwaway
two-module Node ESM reproduction (never touching real source) confirmed this exact cycle shape — each
side's cross-reference used only inside a function body / default-parameter expression, never at module
top level — resolves cleanly in both possible load orders today. The manager's call, taken here: a cycle
that is safe only because nothing currently dereferences it at module top level is a landmine for whoever
adds such a top-level use later (a TDZ crash at boot, with no local signal pointing at the real cause) —
so the function moved instead. `projects/` already imports from `git/*` safely elsewhere (`rebind.ts`,
`repos.ts`), so this is the established-safe direction; `ensureProjectWorkDir`/`projectWorkDirEnv`/
`projectWorkDir`/`PROJECTS_WORK_ROOT` stayed in `paths.ts` (moving them is non-trivial — many importers —
and they need no `git/*` import themselves). Round 2 below dropped the `git/bounded.ts` import entirely
(see that section), so this function now avoids exactly ONE circular-import edge, not two.

## Round 2 (manager code-review follow-ups)

**Timeout raised to 10 minutes (`DELETE_PROJECT_WORK_DIR_TIMEOUT_MS = 600_000`), named and justified in
its own comment:** the 15s `GIT_OP_TIMEOUT_MS`/`SCRATCH_GC_REMOVE_TIMEOUT_MS`/`RUN_SNAPSHOT_TIMEOUT_MS`
convention comes from call sites that get ANOTHER PASS at the next sweep/boot if a removal is merely
slow, not wedged — this call site never does (see above). Treating a genuinely SLOW (not wedged) removal
as a timeout after only 15s would classify and abandon it as "wedged" when it may simply be a large
build/cache tree. And because `killableRemoveDir` runs a disposable CHILD PROCESS rather than the libuv
threadpool, a long budget here pins no daemon resource while it waits — the only cost of raising it is
the human-only `DELETE /api/projects/:id/permanent` response taking longer to settle in the genuinely
pathological (actually wedged) case, never a threadpool slot, never another daemon operation. One-off
human delete of a potentially very large build/cache tree, no later sweep, so the budget is sized for a
slow removal, not a wedge.

**MINOR 1 — a rejected (never-started) removal must never be logged as "wedged":** the original `.catch`
around the outer timeout race collapsed EVERY non-success into "genuinely wedged — killed the removal
child," including a case where `removeDir` itself REJECTS (e.g. `killableRemoveDir`'s own `spawnChild`
throwing synchronously inside its Promise executor — a removal that never even started). The fix replaces
the generic `git/bounded.ts` `withTimeout` race with a LOCAL, structurally-classified race (`raceRemoval`,
`projects/work-dir.ts`) that resolves to a discriminated `{kind:"timeout"}` / `{kind:"rejected",message}`
/ `{kind:"result",result}` — never a message-string classification (the same anti-pattern
`git/bounded.ts`'s own `treeDeathUnconfirmed` doc warns against for a structurally different reason: a
message string is an implementation detail of whatever threw it, not a stable classification key). A
`"timeout"` keeps the "genuinely wedged" wording; a `"rejected"` outcome logs `removal failed to start:
<message>` instead. BOTH stay non-retried (the removeDir seam's own public `{removed,killed}` shape is
reused as `killed:true` for the retry-skip decision in both cases — that boolean is purely an INTERNAL
signal here, never read by any caller outside this function, so reusing it to also mean "or rejected,
don't retry" is safe; only the final warn's wording discriminates the two cases, via a separate
`rejectionMessage` local). Scope: fixed HERE only — the identical shape in `removeWorktree`/
`sessions/scratch-gc.ts`/`runs/snapshot.ts` is a separate follow-up card (manager-filed), not fixed by
this round.

**MINOR 2 — the worst-case bound, stated in constants, not a hardcoded number:** see the narrative
section above and `gateway/server.ts`'s own comment at the `deleteProjectWorkDir` call site — both now
state the real worst case as `DELETE_PROJECT_WORK_DIR_CLEAN_RETRY_ATTEMPTS × timeoutMs +
(DELETE_PROJECT_WORK_DIR_CLEAN_RETRY_ATTEMPTS − 1) × DELETE_PROJECT_WORK_DIR_CLEAN_RETRY_DELAY_MS`, never
a number that would silently go stale if either constant changes.

## Do not

- Do not route this back through `fs.promises.rm`/the libuv threadpool, even as a bounded race around it
  — that only stops the CALLER waiting; the detached threadpool task keeps occupying its slot forever
  (the exact `bd9fc808` hazard). Use `killableRemoveDir`, which bounds the OS process itself.
- Do not retry a KILLED (wedged) OR a REJECTED (never-started) `removeDir` outcome, in this function or
  any caller of it — only a clean, settled, non-killed failure gets the short bounded retry. Retrying a
  wedge in-process reintroduces the `bd9fc808` leak class, one attempt at a time; retrying a removal that
  never started is just as pointless if the underlying cause (e.g. a broken `spawn()`) is persistent.
- Do not classify a timeout vs. a genuine rejection by sniffing an error MESSAGE STRING — use a
  structural race (`raceRemoval`) that discriminates by WHICH branch settled, never by what the rejection
  happened to say. A message string is an implementation detail of whatever threw it.
- Do not shorten `DELETE_PROJECT_WORK_DIR_TIMEOUT_MS` back toward the 15s git-op convention — this call
  site has no later sweep, and a long budget here pins no daemon resource (a disposable child process,
  not the threadpool) while it waits.
- Do not move `deleteProjectWorkDir` back into `paths.ts` without first removing its dependency on
  `killableRemoveDir` (or otherwise closing the circular-import risk this card moved it to avoid) — the
  risk is latent (safe today, a TDZ crash waiting on a future top-level use), not provably absent.
- Do not move `ensureProjectWorkDir`/`projectWorkDirEnv`/`projectWorkDir`/`PROJECTS_WORK_ROOT` out of
  `paths.ts` as a "tidiness" follow-up to this card — they need no `git/*` import and have many existing
  importers; leaving them in place kept this diff focused.

## Consequences

A wedged Windows directory handle during a permanent project delete now blocks only a disposable child
process, force-killed on timeout — never one of the daemon's 4 libuv threadpool threads — so the
`DELETE /api/projects/:id/permanent` response always settles within the removal timeout instead of
hanging indefinitely. That timeout is now 10 minutes by default (sized for a slow removal, not a wedge,
since this call site has no later sweep), with a worst-case total wait of
`DELETE_PROJECT_WORK_DIR_CLEAN_RETRY_ATTEMPTS × timeoutMs + (DELETE_PROJECT_WORK_DIR_CLEAN_RETRY_ATTEMPTS
− 1) × DELETE_PROJECT_WORK_DIR_CLEAN_RETRY_DELAY_MS` before the function gives up and warns. A removal
that never started (a rejected `removeDir`) is now logged distinctly from a genuine timeout, by structural
classification rather than message sniffing. `deleteProjectWorkDir` now lives in `projects/work-dir.ts`,
not `paths.ts`, and depends only on `git/worktrees.ts` (no longer also `git/bounded.ts`).

## Source

`packages/daemon/src/projects/work-dir.ts`, `deleteProjectWorkDir`'s own doc comment, card `8e32605d`.
