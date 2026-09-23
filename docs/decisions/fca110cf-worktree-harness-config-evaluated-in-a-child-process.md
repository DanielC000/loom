# fca110cf — the worktree's harness config is evaluated in a killable child process, never an in-process import()

## Narrative

`loadExcludedTestDirNames` / `loadNotHermeticNames` (`git/worktrees.ts`) need the BRANCH's own `scripts/test-daemon.mjs` sets, because the reduced gate must classify with the branch's own harness (see [[815b4b30-excluded-dir-test-shaped-path-reuses-the-real-excluded-set]]). They used to `import()` that file into the daemon process. A Code Reviewer reproduced the hazards on sibling card `9d0c004e`: `import()` has no time limit (a never-settling top-level await hangs the caller), a synchronous loop in the module body freezes the daemon event loop for every project, the ESM cache is keyed per URL for the process lifetime (re-gating the SAME worktree after an edit read the OLD copy, contradicting the old doc claim that edits are "seen immediately"), and each gated worktree leaked a module graph.

Unlike `9d0c004e` (fixed by importing the daemon's own packaged copy), these legitimately need the branch's copy, so the fix is process isolation: `loadHarnessSetExport` spawns `node --input-type=module -e <probe> <file-url> <exportName>` (async spawn, stdout JSON `{ok,values}`, force-exit after printing), bounded by `HARNESS_CONFIG_LOAD_TIMEOUT_MS` and killed on exceed. Both exports are `Set<string>` of names, so JSON-serializable. Every failure mode (spawn error, timeout, non-zero exit incl. node's own exit on an unsettled top-level await, bad JSON, non-`Set` export) resolves to `null`, the same fail-closed value the callers already handle.

## Do not

- Do not go back to an in-process `import()` of a worktree file — no timeout, event-loop freeze, stale per-URL cache, unbounded module-graph growth. Proven by `test/harness-config-child-load.mjs` (RED against an in-process import: stale value on same-worktree edit, caller hung on a never-settling copy).
- Do not use `spawnSync` for this — it blocks the daemon event loop for the child's whole lifetime, the same freeze this fixes.
- Do not resolve a child failure/timeout to an empty-but-truthy Set — `null`, so the caller fails the whole diff closed.
- Do not cache the result per worktree path — an edited copy on the same worktree must be re-evaluated on the next call.
