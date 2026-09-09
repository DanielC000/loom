# 0050a17e — Deliver the kickoff/startup prompt post-ready via submit(), never on spawn argv

## Status

accepted

## Context

The kickoff prompt used to ride positional argv behind a `--` end-of-options separator, for every role.
Windows `CreateProcess` has a hard **32766-character** command-line ceiling
(`WINDOWS_COMMAND_LINE_LIMIT`). A large agent brief + kickoff (project memory, real `CLAUDE.md`/skill
excerpts) could blow through it and refuse the spawn outright before the daemon ever produced a process —
the exact incident that forced this change.

## Decision

Every role now boots with **no trailing prompt** (identical to how a `--resume`/`--fork-session` spawn
already booted). The kickoff text is captured **synchronously** at `markReady`, read from the immutable
`live.startupPrompt` field (never `live.lastPrompt`, which a later `drainPending`/`submit()` write would
have silently overwritten with the drained message instead of the real kickoff — the bug card `25813ecc`
fixed). Delivery then happens once the session reaches `ready`, via `submit()` — the same reliable path
every later turn (and the §19c-b rate-limit replay) already uses, so this is the **primary** delivery
path now, not a fallback racing the vendor CLI's own auto-submit (that race no longer exists). Delivery is
gated on `logLandedMode`'s footer-read + role-gated plan-mode auto-heal settling first, since both read
the same ring buffer / write to the same pty.

## Do not

- Do not put the kickoff text, or any other large/variable-length payload, back on spawn argv for any
  role — that's exactly the ceiling this decision closes.
- Do not read `live.lastPrompt` at `markReady` to recover the kickoff — read `live.startupPrompt`; reading
  `lastPrompt` after `drainPending` captures the drained message instead (card `25813ecc`).
- Do not deliver the kickoff concurrently with `logLandedMode`'s footer-read/auto-heal settling — it can
  silently break plan-mode auto-heal (mode reads as `"unknown"`) or interleave pty writes.

## Consequences

- Easier: `memory.budgetTokens` (the project-memory kickoff digest) is no longer coupled to spawn headroom
  via this ceiling — a digest of any size can never again contribute to the Windows argv limit, since it
  now rides inside the same post-ready `submit()` payload as the rest of the prompt.
- Harder / accepted cost: delivery is **not next-tick**. A real latency floor of one `MODE_LOG_POLL_MS`
  poll (~500ms), up to ~4s at production defaults if the footer read never resolves, plus `cycleToMode`'s
  own time on top if the auto-heal fires — a deliberate, one-time trade of turn-1 latency for closing the
  footer-read/heal race, not something to re-optimize casually.
- `preflightWindowsCommandLine` (`pty/host.ts`) still exists as a real, exact, spawn-time guard for
  whatever *does* remain on argv (the settings path, inline `--mcp-config` JSON, `--disallowedTools`) —
  it is just far less likely to trip now that the prompt itself is gone.
- `Live.lastPrompt` is still seeded synchronously at `spawn()`, independent of this change, so a crash
  before the first `submit()` still leaves something to re-submit on resume (§19c-b) — removing that seed
  would reopen the window this decision does not touch.

## Evidence

- READ-IN-SOURCE: `CLAUDE.md`'s "Load-bearing invariants" section (current `main`, read via this
  worktree's checkout) states the ceiling, the boot change, and the accepted latency floor verbatim.
- READ-IN-SOURCE: `packages/daemon/src/pty/host.ts` — `markReady` (~line 12486) and
  `scheduleKickoffGuarantee` (~line 12527) carry the same decision in their own doc comments, citing card
  `0050a17e` and the follow-on fix `25813ecc` (read directly in this worktree, 2026-09-09; `pty/host.ts` is
  not held by another worker as of this task's kickoff, so this record also carries a `<=3`-line inline
  anchor at that site — see `markReady`'s comment block).
