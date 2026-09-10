# sha:459e9dab — win32 worktree-process CIM query: field choice + self-bounded timeout

## Narrative

`enumerateProcessesWin32` (`pty/host.ts`) queries `Get-CimInstance Win32_Process` for every live
process's `ExecutablePath` + `CommandLine` (win32 exposes no per-process cwd via CIM, so `cwd` is always
null here). Path + CommandLine is what the live-evidence investigation found sufficient: the esbuild
service's OWN executable runs FROM inside the worktree, and vite's global `node.exe` carries the
worktree path in its CommandLine instead — this pair of fields covers both shapes of dangler that
motivated `reapProcessesRootedInWorktree` (see the original commit's own title: "the true dangler root
cause — esbuild service + vite lock the dir"). `@(...)` forces array context so `ConvertTo-Json` returns
a JSON ARRAY even for 0 or 1 processes (a bare `ConvertTo-Json` on a single object would otherwise emit a
bare object, not `[obj]`), which the parser (`parseWin32CimStdout`, see `sha:16b7c38c`) depends on.

SELF-BOUNDED: unlike the outer `withReapTimeout` race (which only stops the CALLER waiting — the same
limitation `withTimeout` in `git/worktrees.ts` documents for its own callers), this function arms its OWN
timer and force-kills the `powershell.exe` child it spawned if the query hasn't closed by `timeoutMs` —
so a wedged/slow CIM query (WMI contention, a loaded host) can never leave an orphaned helper process
behind, the same leak class this whole feature exists to prevent.

## Do not

- Do not rely solely on an outer caller's timeout race to bound this query's own child process — that
  only stops the CALLER waiting, it doesn't kill the still-running `powershell.exe`. The self-timer here
  is what actually prevents the orphan.
- Do not drop the `@(...)` array-context wrapper — without it a single-process result breaks the JSON
  array contract the parser depends on.

## Source

Inline doc comment above `enumerateProcessesWin32` in `packages/daemon/src/pty/host.ts` (the CIM-query
field choice and SELF-BOUNDED paragraphs), introduced by commit `459e9dab56` ("fix(pty): reap escaped
build/dev-server processes rooted in a worktree BEFORE removal — the true dangler root cause (esbuild
service + vite lock the dir)"), as of main `afce859a`.
