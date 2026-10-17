# d5432aff — redirect PowerShell's module-analysis cache out of cwd under a sandboxed USERPROFILE

Observed by lead gen 420, 2026-10-16: during a full merge gate, an untracked
`packages/daemon/Microsoft/Windows/PowerShell/ModuleAnalysisCache` appeared inside a worker's worktree,
flagging the gate verdict as "worktree changed while the gate ran" (voiding its cache) and risking a trip
of the dirty-tree checks.

## Root cause

When a test sandboxes `USERPROFILE`/`HOME` to a bare temp dir (the near-universal pattern across this
suite, ~300 files), `[Environment]::GetFolderPath("LocalApplicationData")` silently resolves to `""`.
This is a folder-**EXISTENCE** check against `%USERPROFILE%\AppData\Local`, not an env-var-presence one —
`$env:LOCALAPPDATA` itself stays correct the whole time, and a plain `mkdir
<sandbox>\AppData\Local` makes the resolution succeed again. PowerShell's own module-analysis-cache
feature then falls back to a path relative to the process's **cwd**, which (for the whole test suite) is
`packages/daemon` — producing the exact residue path reported above. The real cache WRITE itself could
not be reproduced deterministically, by either worker d598dab0's prior investigation or this card's own
(same sandbox, same real `WIN32_SWEEP_PS_COMMAND` enumeration, several variations) — it appears
conditional on some staleness check in the engine that neither investigation could pin down. The fix
below removes the HAZARD (the broken resolution landing on cwd) regardless of whether any individual run
happens to trigger a write.

## What ships

`PSModuleAnalysisCachePath` — a documented PowerShell environment variable that overrides the cache's
resolved location outright, verified to be honored even when its target directory doesn't exist (the
real command's output/exit code are unaffected). Set in exactly two places, both win32-only and both only
when the variable isn't already ambient-set (never clobbering an already-set value, from a human's own
shell or elsewhere):

1. **`packages/daemon/test/_guard.mjs`** — at module-load time, to a pid-scoped path under
   `os.tmpdir()`. Covers a direct `node test/x.mjs` run (no harness), which is the default verification
   path the `/worker` doctrine recommends. Best-effort removed on process exit via the SAME existing
   exit hook that already cleans up this file's `WORKTREES_DIR` leak (card `de7abf0b`) — no new exit
   handler.
2. **`packages/daemon/scripts/test-daemon.mjs`** — `runOne`'s per-child `env` object, scoped to a subdir
   of that child's own `home` tmpdir (already tracked in `tmpRoots` and removed at the end of the run, so
   this needs no separate cleanup). Closes the gap `_guard.mjs` alone cannot: that file's own header
   states ~14% of this suite's test files don't import it at all (measured 2026-08-07), and those files
   are exactly as exposed to the hazard as any other — but they ALL run under this harness.

Both sites independently satisfy the same contract (set once, win32-only, never overwrite an ambient
value) — a test run under the harness gets the runner's own per-child value; a standalone run gets
`_guard.mjs`'s fallback. Neither one is a substitute for the other.

**The 10 real production `powershell.exe` spawn sites (`pty/host.ts`, `pty/win32-root-creation.ts`,
`graceful-teardown.ts`, `orchestration/restart.ts`, `codescape/supervisor.ts`,
`capabilities/github-binary.ts`) are untouched.** None of them pass an explicit `env` to their
spawn/execFile call, so all of them inherit `process.env` — including this variable, whichever of the
two call sites set it — automatically, with zero changes to any of them. They were never independently
in scope anyway: production never sandboxes `USERPROFILE`, so the hazard this card closes cannot occur
there.

**Test**: `packages/daemon/test/ps-module-analysis-cache-cwd-guard.mjs`. Since the real write was never
forced deterministically (see above), this does NOT assert "no `Microsoft/` dir appears" — that would be
a fixed-wait-shaped unfalsifiable negative, passing whether or not the fix works. Instead it proves the
mechanism: (A) the broken-resolution precondition reproduces under exactly the sandbox shape described
above, with an ambient positive control; (B) a real spawned child that only imports `_guard.mjs` sees the
variable set outside cwd; (C) a static, comment-stripped text scan confirms `test-daemon.mjs` carries the
same wiring independently, with its own synthetic RED/GREEN specimens.

## Do not

- **Do not clobber an ambient or runner-injected value.** Both call sites check
  `!process.env.PSModuleAnalysisCachePath` before setting it — a human's own shell, CI, or the harness's
  per-child injection must always win over either fallback.
- **Do not drop the `test-daemon.mjs` runner injection in favour of `_guard.mjs` alone.** `_guard.mjs` is
  imported by ~86% of this suite's files, not all of them, and the harness is the one chokepoint that
  reaches every child it spawns regardless of what that child itself imports.
- **Do not add a `.gitignore` entry for `packages/daemon/Microsoft/` as a substitute for this.** The
  card's own direction was explicit: prevent the write, don't hide its evidence if it still happens.
- **Do not widen either `!process.env.PSModuleAnalysisCachePath` check into an unconditional overwrite**
  to "simplify" the code — that check is what keeps a human's own debugging session (where they may have
  deliberately pointed this at a real location) intact under this suite.
