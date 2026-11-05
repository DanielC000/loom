# 0050a17e — the startup/kickoff prompt is delivered post-ready via `submit()`, never on argv

Relocated from CLAUDE.md (docs relocation, card `e0ba98c1`). Card `0050a17e`.

## Why

The prompt used to be positional on argv, behind a `--` end-of-options separator. That put its FULL TEXT on the Windows `CreateProcess` command line, which has a hard 32766-character ceiling (`WINDOWS_COMMAND_LINE_LIMIT`). A large agent brief plus kickoff (project memory, real CLAUDE.md/skill excerpts) could exceed it and refuse the spawn outright before the daemon ever produced a process. That was the incident that forced this change.

## Mechanism

- Every role boots with NO trailing prompt (identical to how a `--resume`/`--fork-session` spawn already booted).
- The same text is delivered once the session reaches `ready` (SessionStart + mode-cycles) via `submit()`, the same path every later turn and the §19c-b rate-limit replay use (`scheduleKickoffGuarantee`). There is no vendor-CLI auto-submit left to race, so this is the PRIMARY delivery path, not a backstop.
- The kickoff text is captured SYNCHRONOUSLY at `markReady`. A later unrelated drain must never overwrite what gets replayed: `submit()` unconditionally overwrites `live.lastPrompt` with whatever IT is submitting, so capturing late would silently swap in that other text.
- DELIVERY is gated on `logLandedMode`'s footer-read plus the role-gated plan-mode auto-heal settling first. Both read the same ring buffer / write to the same pty, so delivering concurrently would pollute the mode detection (the heal would silently never fire for a role stranded in `plan` with `ExitPlanMode` disallowed) or interleave the heal's Shift+Tab writes with the kickoff's own paste.
- Consequence: delivery is NOT next-tick. It costs a real, accepted latency floor of one `MODE_LOG_POLL_MS` poll (~500ms), up to ~4s at production defaults if the footer read never resolves, plus `cycleToMode`'s own time if the auto-heal fires. A deliberate trade of turn-1 latency for closing that race, made once and not to be re-optimized.
- `Live.lastPrompt` is still seeded SYNCHRONOUSLY at `spawn()` (earlier than the capture above) so a crash before the first `submit()` still leaves something to re-submit on resume (§19c-b). It is NOT redundant with the later `submit()` write; removing it reopens that exact window.
- `preflightWindowsCommandLine` (`pty/host.ts`) remains a real, exact, spawn-time guard for whatever still rides argv (the settings path, the inline `--mcp-config` JSON, `--disallowedTools`); it is far less likely to trip now.

## `memory.budgetTokens` and the ceiling

`memory.budgetTokens` is no longer coupled to spawn headroom via this ceiling: a project memory digest of any size can never contribute to the Windows argv limit, since it rides inside the same post-ready `submit()` payload. It still competes for the engine's own context-window/turn-1 token budget, a separate concern from the command-line ceiling; do not conflate the two.

## Do not

- Do not put the kickoff text back on argv for any role.
- Do not capture the kickoff text later than `markReady`, and do not deliver it before the footer-read / plan-mode auto-heal settles.
- Do not remove the synchronous `Live.lastPrompt` seed at `spawn()`.
- Do not re-optimize the post-ready latency floor away.
