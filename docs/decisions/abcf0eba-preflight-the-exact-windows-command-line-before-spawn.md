# abcf0eba — Preflight the EXACT, post-escaping Windows command line before every spawn

## Narrative

`preflightWindowsCommandLine` (`pty/host.ts`) checks the exact, post-escaping, platform-aware command-line
length a spawn is about to produce, and fails ACTIONABLY instead of letting a bare Windows `CreateProcess`
`error code: 206` reach the caller with no indication of what's oversized.

`WINDOWS_COMMAND_LINE_LIMIT` (32766) is not a padded guess — it was empirically re-derived against the
REAL `node-pty` dependency this daemon spawns through, via a binary-searched `node.exe` spawn: a command
line of exactly 32766 characters (as computed by `windowsCommandLine`, see `sha:9fea4196`) spawns
successfully; 32767 fails with `Cannot create process, error code: 206`
(`ERROR_FILENAME_EXCED_RANGE`) — confirming both the constant and that `windowsCommandLine` matches
node-pty's own quoting at the real OS boundary, for the array-args inputs this daemon actually passes.

The preflight takes the REAL `bin`+`args` the spawn is about to hand `node-pty` — computed by the SAME
`buildSpawnArgs` call the real spawn uses — so there is no risk of the preflight and the actual spawn
ever disagreeing about what "the command line" is: one measurement, reused for both the check and (if it
passes) the real spawn.

Windows-only: POSIX `execve`'s argv/environ ceiling (`ARG_MAX`) is measured differently (combined
argv+environ bytes) and is typically several MB — multiple orders of magnitude above the settings path /
MCP config / disallowed-tools list this daemon actually puts on argv — so this is deliberately NOT
enforced on POSIX; the caller gates this function on `process.platform === "win32"`.

## Do not

- Do not compute the preflight's command line separately from the real spawn's — always reuse the SAME
  `buildSpawnArgs` output, so the two can never disagree about what's actually on argv.
- Do not enforce this ceiling on POSIX — `ARG_MAX` is a different, much larger measurement, and applying
  the Windows number there would be a wrong and needlessly restrictive check.
- Do not treat 32766 as an approximate/padded threshold — it is the exact, empirically-confirmed refusal
  boundary against the real spawn dependency.

## Source

Inline doc comments above `WINDOWS_COMMAND_LINE_LIMIT` and `preflightWindowsCommandLine` in
`packages/daemon/src/pty/host.ts`, as of main `afce859a`.
