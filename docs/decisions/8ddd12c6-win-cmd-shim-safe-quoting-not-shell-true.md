# 8ddd12c6 — a resolved npm `.cmd` shim is parsed and spawned as node + its real entry script, never routed through `cmd.exe`

Card `8ddd12c6`: the codescape supervisor spawns a host-tool binary that `resolveHostToolBin` can resolve
to a `.cmd` shim (e.g. an npm-global `codescape` install on Windows). Node (18.20.2/20.12.2/22.x, the
CVE-2024-27980 mitigation) throws a synchronous `EINVAL` when `spawn()`/`spawnSync()` is given a
`.cmd`/`.bat` `command` with no `shell:true` — Windows' `CreateProcess` implicitly hands a batch file to
`cmd.exe` regardless of the caller's shell option, so Node now refuses rather than risk an unescaped
argument reaching that implicit shell. Every codescape spawn call site already wrapped `spawn()` in its
own try/catch, so this threw-and-was-caught silently: `ingest()` logged a bare `failed (exit null)` with
an empty output tail, and the real `EINVAL` cause never surfaced.

## Round 1 (superseded) — routing through `cmd.exe /d /s /c`

The first fix built a quoted `cmd.exe /d /s /c "<command line>"` invocation itself (each argv element
individually quoted per the `CommandLineToArgvW` rules, then caret-escaped for cmd.exe's own
metacharacters — the `cross-spawn` two-pass algorithm). Code Review `3b69bdea` reproduced four real
defects in that approach, all on this host with real spawns:

1. **CRITICAL — the escaping was only single-level.** An npm `.cmd` shim's own body re-parses `%*`, so an
   argument like `x"&echo INJECTED2>marker2` created a marker file: a real command-injection round-trip
   through the shim's own re-expansion, which `cross-spawn`'s double-escape would have caught and this
   single-escape did not.
2. **MAJOR — an unquoted shim path containing a space failed outright** (e.g.
   `C:\Users\John Smith\AppData\Roaming\npm\x.cmd`): the command itself wasn't quoted and the metacharacter
   set was incomplete.
3. **MAJOR — every spawned child became `cmd.exe` itself**, so `child.kill()` only ever killed the
   wrapper; the real node process underneath (e.g. `codescape serve`/`ingest`) was ORPHANED — reproduced
   directly: a surviving grandchild process after `kill()`, confirmed by exact pid. These accumulate
   across supervisor restarts.
4. **MAJOR — the test's own quoting case didn't discriminate** (the injection character landed before the
   first quote) and its fixture path had no space, so it could pass against broken escaping.

## Round 2 (current) — parse the shim, spawn node on its real entry directly

No `cmd.exe` at all. An npm `cmd-shim`-generated `.cmd` file has one fixed, recognisable shape (verified
against this host's real `codex.cmd`/`corepack.cmd`/`pnpm.cmd`, byte-identical): it defines `dp0` as its
own directory, prefers a sibling `node.exe` when present (`IF EXIST "%dp0%\node.exe"`), and its one real
invocation line is `"%_prog%"  "%dp0%\<relative-entry>.js" %*`. `parseNpmCmdShim` (`pty/resolve-bin.ts`)
reads that text (never executes it), confirms both markers are present, and extracts the entry's absolute
path plus which node binary the shim itself would prefer. `winCmdShimSpawnTarget` then returns
`{command: nodeBin, args: [entry, ...args]}` — spawned directly, no shell, no quoting layer to get wrong,
and `kill()` terminates the real process because there is no wrapper process to begin with.

If the `.cmd`/`.bat` file doesn't match that recognisable shape (a hand-authored shim, arbitrary shell
logic), `parseNpmCmdShim` throws naming the path, and every call site's existing try/catch surfaces that
as a spawn failure — never falls back to a shell.

## Do not

- Do not reintroduce `cmd.exe` (`shell:true`, or a hand-built quoted command line) to work around a
  parse failure "just this once" — a shell layer either reopens the CVE-2024-27980 escaping gap, or, even
  perfectly escaped, orphans the real child on `kill()` by making every spawned process `cmd.exe` itself
  (round 1's defect 3, reproduced).
- Do not widen `NPM_CMD_SHIM_DP0_MARKER`/`NPM_CMD_SHIM_ENTRY_RE` to "lenient-match" a `.cmd`/`.bat` that
  isn't a real npm cmd-shim — refuse and surface the error instead; guessing at an unrecognised shape is
  how the injection and quoting defects above got in to begin with.
- Do not add a dependency on `cross-spawn` (or any equivalent shell-escaping package) — round 1 already
  rejected that, and round 2 removes the need for shell escaping entirely rather than doing it better.
