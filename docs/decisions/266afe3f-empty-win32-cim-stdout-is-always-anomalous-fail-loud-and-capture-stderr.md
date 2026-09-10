# sha:266afe3f — Empty win32 CIM stdout is ALWAYS anomalous; fail loud and capture stderr

## Narrative

`classifyWin32EnumerationClose` (`pty/host.ts`) classifies `enumerateProcessesWin32`'s outcome once the
CIM query's `powershell.exe` has CLOSED CLEANLY — i.e. neither the self-timeout nor a spawn error fired.
It is the direct follow-up to the failure class `sha:16b7c38c` fixed: the residual gap was that a
`powershell.exe` closing FAST and CLEANLY with EMPTY stdout (an execution-policy refusal, a CIM/WMI
service problem, a host/profile issue — never surfaced because stderr used to be discarded) sailed
through `parseWin32CimStdout`'s `sanitized || "[]"` fallback and came back as a silent, valid-looking
`[]` — indistinguishable, at every one of `reapProcessesRootedInWorktree`'s seven call sites, from "no
matching process exists".

`@(Get-CimInstance Win32_Process | …)` enumerates EVERY live process on the host, and the querying
`powershell.exe` is itself always in that result set — so empty stdout on a clean close is ALWAYS
anomalous, never a legitimate "nothing running" answer, which is what makes failing on it safe rather
than a guess. Treated as the `empty-output` failure kind, same severity as a parse error.

`stderrTail` — a bounded (~4KB) capture of the child's own stderr, previously discarded via
`stdio: "ignore"` — is folded into whichever failure fires, since a genuine PowerShell error message is
exactly the diagnostic this path used to throw away.

## Do not

- Do not treat empty stdout on a clean `powershell.exe` close as "nothing running" — the querying process
  is always in its own result set, so empty output is always a failure, never a legitimate empty answer.
- Do not discard the child's stderr via `stdio: "ignore"` — capture and fold it into the classified
  failure; it is often the only diagnostic for why the query failed.

## Source

Inline doc comment above `classifyWin32EnumerationClose` in `packages/daemon/src/pty/host.ts`, introduced
by commit `266afe3f4f` ("fix(pty): fail loudly on empty win32 enumeration output, capture stderr"), as of
main `afce859a`.
