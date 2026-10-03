# 56f711bf — Redact the win32 CIM process-enumeration parse-error excerpt

## Narrative

`parseWin32CimStdout` (`pty/host.ts`) throws a diagnostic `Error` on a malformed CIM payload (see
`sha:16b7c38c`) that includes an excerpt of the raw stdout around the JSON parse failure — up to 120
chars, or a 120-char window around the reported position. That stdout is a `ConvertTo-Json`-rendered
array of live OS processes carrying each one's `CommandLine` verbatim, which can itself hold an
auth header or token passed as argv. Two call sites then log this error's `.message` straight to the
shared, multi-tenant daemon log: `reapProcessesRootedInWorktree`'s catch (`[reap] …`) and
`attributeProcessesToWorktree`'s catch (`[attribution] …`) — both via `enumerateProcessesWin32` →
`classifyWin32EnumerationClose` → `parseWin32CimStdout`, so both inherited the same unredacted excerpt.

Fixed at the one source instead of at each logger: `parseWin32CimStdout` now wraps the excerpt in
`redactedExcerpt` (the file's existing content-redaction chokepoint, card `16c93a50`) rather than
`JSON.stringify`ing it directly. With `LOOM_LOG_MESSAGE_CONTENT` unset (the shipped default), both
downstream loggers now receive a `<redacted len=N hash=XXXXXXXX>` placeholder instead of the raw bytes;
with the flag on, behavior is byte-identical to before (`JSON.stringify(excerpt)`). The payload-length
and parse-position diagnostics stay unredacted — they carry no content, only shape.

## Do not

- Do not revert `parseWin32CimStdout`'s excerpt to a bare `JSON.stringify(excerpt)` — that excerpt is
  windowed real `CommandLine` text, which can carry a secret, and it reaches a shared daemon log through
  both `reapProcessesRootedInWorktree` and `attributeProcessesToWorktree`.
- Do not instead patch the two downstream `console.error` call sites individually — they share this one
  upstream source of the unredacted text, so redacting at each logger separately would leave any future
  third caller of `parseWin32CimStdout` unprotected.

## Source

Inline doc comment above `parseWin32CimStdout` in `packages/daemon/src/pty/host.ts`, card `56f711bf`.
