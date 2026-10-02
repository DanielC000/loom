# 2be634f2 — generalizing the mcpToken env-placeholder pattern to capability secrets: CONSIDERED AND REJECTED

## Background

Card `a50b8afd` closed the mcp-config.json literal-value exposure for the per-session `mcpToken` header
specifically, on win32 only (POSIX keeps the literal value — see that record's own platform-split
section). It explicitly scoped OUT third-party capability connection secrets (a `requiresConnection`
capability's secret, injected into a stdio mount's own `env` block by `resolveCapabilityServer`,
`capabilities/registry.ts`) — those still ride as literal plaintext in mcp-config.json on BOTH platforms,
UNCHANGED by this card. This card investigated generalizing `a50b8afd`'s win32 placeholder-plus-env
pattern to those secrets too, built it, and then — on Code Review — **rejected it and reverted it**. This
record is the "considered and rejected" writeup; `a50b8afd`'s own record carries the pointer to it.

## V1/V2 — LIVE-VERIFIED (claude 2.1.287, same installed build `a50b8afd` used) — the mechanism itself works

This part of the investigation is NOT what got rejected — the `${VAR}` expansion mechanism genuinely works
for a stdio mount's `env` field, same as it does for `headers`. Measured against the real installed CLI,
in a throwaway cwd + `LOOM_HOME`, with a tiny stdio probe MCP server (`node probe.mjs <logfile>`) mounted
via `--mcp-config <file> --strict-mcp-config`, whose `env` entry was
`{"LOOM_CAP_SECRET_1": "${LOOM_CAP_SECRET_1}"}`. The probe captures its OWN `process.env` value
synchronously at startup, before any protocol work.

- **Negative control** (var unset on the spawned claude process's env): the probe's own env held the
  literal, unexpanded string `${LOOM_CAP_SECRET_1}` — confirms no accidental substitution, and confirms the
  stdio child actually launched/connected.
- **Positive run** (`LOOM_CAP_SECRET_1=sentinel-cap-secret-7e4b1f90` set on the spawned claude process's
  env): the probe's own env held `sentinel-cap-secret-7e4b1f90` — the real value.
- The on-disk mcp-config file in the positive run contained **zero** occurrences of the sentinel and
  exactly one occurrence of the var **name** — the real value never touched disk.

**V1**: `${VAR}` expansion works in a `--mcp-config`-loaded file's `env` field, not just `headers` (the only
field `a50b8afd`'s own V1 tested). **V2**: the SPAWNED STDIO SERVER itself — a separate OS process from
claude — receives the expanded real value in its own env; this is claude's host process substituting
before `CreateProcess`, not something the child does itself.

## The design that was built, then rejected

The build mirrored `a50b8afd`'s platform split exactly: on win32, each resolved capability grant with a
`requiresConnection` secret got a `${LOOM_CAP_SECRET_<n>}` placeholder minted and pushed, as `{name,
value}`, into an injected output collector; `createPty` applied the collected pairs onto the claude
process's own spawn env. POSIX was left unchanged (literal value, nothing added to claude's env). Code
Review caught the flaw before merge; the build was fully reverted (host.ts/registry.ts restored to their
pre-card state; the test file's assertions rewritten to PIN the rejected shape instead — see
`test/mcp-config-secret-lifecycle.mjs`).

## The finding that killed it: claude's own process env is INHERITED by everything it spawns

`a50b8afd`'s own record already discloses this for the mcpToken case ("win32 env inheritance, noted and
accepted"): once a value is set on the `claude` process's own env block, EVERY child that process spawns —
its own Bash/PowerShell tool invocations, the hook-relay script, any other stdio MCP server it
launches — inherits it. On win32, reading another process's env cross-process needs a deliberate PEB read
(no `/proc/<pid>/environ` equivalent); but the agent's OWN shell is not a cross-process reader — it's a
CHILD of the claude process, so it inherits the var directly, and the Code Reviewer confirmed this
concretely: **`LOOM_MCP_TOKEN` is visible from a Loom session's own Bash** (`echo $env:LOOM_MCP_TOKEN`),
no PEB read, no privilege, nothing special at all.

`a50b8afd` accepted this for the mcpToken specifically because it's that SAME session's own short-lived
token — the session already has full access to it via its own MCP tool calls, so a child inheriting it
grants no NEW access. **That reasoning does not carry over to a third-party capability secret.**
`connections/request.ts:6`'s own invariant is explicit: *"The agent NEVER sees the secret."* Before this
card, the agent had no ORDINARY path to a capability secret at all — the mcp-config.json file is unlinked
at `markReady`, before the session's first turn ever runs, so by the time the agent could act, the file is
already gone. Putting the secret on claude's OWN env instead would have handed the agent a trivial,
ordinary read of a raw third-party secret (`echo $env:LOOM_CAP_SECRET_1`) for the session's ENTIRE
lifetime — not a narrowing of the pre-card exposure, a NEW and strictly WORSE one, on every platform
(win32 included, where the mcpToken case's own improvement specifically does NOT apply to the agent's own
shell — see the correction added to `a50b8afd`'s own residual-ceiling section).

## What actually protects a capability secret today (unaffected by this card, on every OS)

- The literal secret value rides the mcp-config.json FILE's `env` block, written fresh at spawn time.
- That file gets the FULL delete lifecycle `ed0757d6` established — unlinked at `markReady`/`SessionStart`,
  the pty `onExit` backstop, and the boot-time sweep in `pty/mcp-config-gc.ts` — unconditionally, on both
  platforms. This is UNCHANGED by this card either way: whether the capability-secret investigation had
  shipped or not, the file's own on-disk lifetime was never going to differ.
- The capability's own stdio CHILD PROCESS still holds the real secret value in ITS OWN env, for its whole
  lifetime, on every OS — that was true before this card and remains true after it; the child needs the
  real value to function, and this card never touched that fact either way. On POSIX that child's own env
  is already trivially readable by any same-UID process (`/proc/<pid>/environ`, `ps eww`); on win32 it
  needs a PEB read. Neither is closed by anything here.
- The genuine residual gap (pre-existing, not introduced or widened by this investigation): a same-OS-user
  process — most concretely, a codex session, which gets no `SETTINGS_DIR_READ_DENY_RULE` at all (card
  `7955458e`) — can still read the FILE during the short pre-`markReady` window on EITHER platform. That
  window is unaffected by this card; closing it is a separate, already-tracked concern.

## Do not

- Do not move a capability secret onto claude's OWN process env, on ANY OS — it is inherited by every
  child that process spawns, including the agent's own Bash/PowerShell tool calls, so this hands the agent
  a raw third-party secret for the whole session. This is true on win32 too, even though win32's
  cross-PROCESS read bar is higher (PEB read) — the agent's own shell is not a cross-process reader.
- Do not read `a50b8afd`'s mcpToken win32 improvement as transferable to a capability secret by analogy —
  the mcpToken case is accepted specifically because it's the session's OWN credential, already fully
  available to it through sanctioned channels; a capability secret is a THIRD-PARTY credential the agent
  must never see directly (`connections/request.ts:6`), and the analogy breaks exactly there.
- Do not treat "the file is unlinked at markReady" as insufficient protection and reach for env as the
  fix — the file's short pre-markReady window is a narrower, already-accepted, already-tracked exposure
  (readable only by another same-OS-user process during a short window); env would have been WIDER (the
  session's own agent, for its entire lifetime) and WORSE (ordinary, no special tooling needed at all).
- A future fix for the pre-markReady file-read window must deliver the secret to the capability's own
  CHILD PROCESS by some path that bypasses claude's own env entirely — e.g. a daemon-fetched shim the
  child itself calls out to at its own startup, authenticated some other way — never by putting it on the
  `claude` process's env, which is the exact mechanism this card rejected.
- Do not re-attempt this exact design (collector + placeholder + `applyCapabilitySecretsEnv`) without
  first re-deriving why it was rejected here — re-read this record's "finding that killed it" section, not
  just its title.
