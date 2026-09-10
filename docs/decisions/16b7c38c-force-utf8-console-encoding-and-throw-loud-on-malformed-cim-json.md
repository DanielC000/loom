# sha:16b7c38c — Force UTF-8 console encoding for the CIM query; throw loud on malformed JSON

## Narrative

`parseWin32CimStdout` (`pty/host.ts`) parses `enumerateProcessesWin32`'s raw PowerShell stdout (a
`ConvertTo-Json -Compress` array). Pure and exported so a test can drive it directly with a crafted
payload instead of spawning a real `powershell.exe` — see `test/worktree-process-reap.mjs`'s
deterministic enumeration-failure regression guard; `classifyWin32EnumerationClose` (`sha:266afe3f`)
mirrors this same testability shape. It THROWS on a malformed payload — never silently drops to an empty
array. This is the fix for a real P1: a live self-hosting daemon host had `[Console]::OutputEncoding`
defaulting to a single-byte, non-UTF8 codepage (IBM850/CP850, confirmed via `[Console]::OutputEncoding` +
`chcp`), so any character in ANY live process's `CommandLine` that codepage's best-fit encoder couldn't
cleanly round-trip could corrupt the ALREADY-CORRECTLY-ESCAPED JSON `ConvertTo-Json` had produced,
breaking `JSON.parse` for the WHOLE array, not just the one affected process.

`enumerateProcessesWin32` now forces `[Console]::OutputEncoding` to UTF8 inside the same `-Command`
string — verified live: the same query against 465 real processes on that host threw a JSON parse error
without it, and parsed cleanly with it. But the NEXT surprise in that payload must not go silent either,
so `parseWin32CimStdout` throws with the JSON position plus a short excerpt around it, and the caller
(`enumerateProcessesWin32`) turns that into a rejection instead of a bare `[]`. That silent-collapse was
itself the reason a total enumeration failure went undetected before this fix: `reapProcessesRootedInWorktree`
runs from SEVEN call sites in `sessions/service.ts` (merge-confirm pre-gate reap, post-merge
`gcWorktreeDir`, worker-stop cleanup, boot/GC sweeps), all of which would silently do nothing on this
failure with no observable difference from "nothing needed killing".

`ConvertTo-Json` can also leave a raw, UN-ESCAPED control character inside a `CommandLine` string
(observed live against real running processes on that host) — a JSON structural character is never below
0x20, so blanking those out (via `CONTROL_CHAR_RE`) is always safe. A leading BOM is stripped defensively
too: forcing `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8` is documented as BOM-emitting for
some .NET writer shapes, though verified empirically NOT to appear for this exact assignment + query
shape — a BOM would otherwise break `JSON.parse` at character 0.

## Do not

- Do not let `parseWin32CimStdout` fall back to an empty array on a parse failure — that is
  indistinguishable, at all seven `reapProcessesRootedInWorktree` call sites, from "no matching process
  exists", which is exactly the silent-collapse this fix closes.
- Do not remove the forced `[Console]::OutputEncoding = UTF8` — a non-UTF8 console codepage can corrupt
  the CIM query's own already-escaped JSON for reasons unrelated to the worktree being searched for.

## Source

Inline doc comment above `parseWin32CimStdout` in `packages/daemon/src/pty/host.ts`, introduced by commit
`16b7c38c29` ("fix(pty): force UTF-8 and fail loudly in win32 process enumeration"), as of main `afce859a`.
