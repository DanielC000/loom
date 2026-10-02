# 2e7373ab — codex's MCP bearer token has no POSIX alternative to long-lived env; residual accepted

## Background

Card `a50b8afd` found that `createCodexPty`'s `env[MCP_TOKEN_ENV_VAR] = mcpToken` line (card `280b1e44`) lets a same-UID process on Linux read a live codex session's MCP bearer token for its whole lifetime via `/proc/<pid>/environ` (gated by `PTRACE_MODE_READ`, which a same-UID caller passes) — predating `a50b8afd`, unaffected by it. macOS readability (e.g. via `ps eww`, same same-UID logic) is expected but was NOT independently measured. This card investigated whether codex has any mechanism avoiding that, before any code change was authorized.

## What was checked

Against the pinned, installed `codex-cli 0.153.4` (win32-x64 binary on this host; config/validation logic is the same Rust codebase cross-compiled per platform, generalizing the same way `a50b8afd`'s own win32-measured claims already do): the official config reference (`developers.openai.com/codex/config-reference`, redirecting to `learn.chatgpt.com/docs/config-file/config-reference`); the installed `codex.exe`'s own extracted strings, confirming the full `RawMcpServerConfig` schema (~28 fields, incl. `command`, `env`, `http_headers`, `env_http_headers`, `url`, `bearer_token`, `bearer_token_env_var`, `http_headers_helper`, `auth`, `oauth`); and `codex mcp add --help`/`codex mcp get` against a throwaway `CODEX_HOME`.

For a `streamable_http`/`url` mount — what Loom's own first-party MCP gateway mount always is, never stdio:

- `bearer_token` (literal) — schema-valid but rejected at connect time (`a50b8afd`'s finding); no `--bearer-token` CLI flag exists, only `--bearer-token-env-var`.
- `bearer_token_env_var` — Loom's current mechanism. Env-based, whole-process-lifetime exposure.
- `env_http_headers` — generalizes `bearer_token_env_var` to arbitrary headers. Same exposure, no improvement.
- `http_headers_helper` ("local command that prints a JSON object of header names and values") — the one field that looked promising. **Ruled out for this mount type**: the binary's own strings contain `"http_headers_helper is only supported for local MCP servers"`, and the CLI's `--bearer-token-env-var` flag is explicitly "Only valid with streamable HTTP servers" with no equivalent for the helper. "Local" = a codex-launched stdio server, never a `url`-based remote mount.
- `auth` (`oauth`|`chatgpt`) — a fallback for a server with no bearer token/headers at all; not usable for a Loom-minted token.
- No token-file, one-shot-read, or stdin-handoff field exists anywhere in the schema or CLI.
- Binary strings also searched for `zeroize`/`secrecy`/`wipe`/`secure_erase`/`clear_env`/`remove_var`/`set_var` — zero hits; no evidence codex can scrub an env var after reading it.

## Why rotation (mint-and-invalidate after boot) is not pursued

1. **Whether codex would tolerate it is unverified.** MCP "Streamable HTTP" has no persistent authenticated channel — every request is an independent HTTP call — and codex's docs describe `bearer_token_env_var` as "sourcing" the token ongoingly, never as a one-time read: inference, not a live measurement. A probe for this (a real node-pty `codex` spawn mirroring `createCodexPty`, pointed at a local fake streamable-HTTP server logging `Authorization` headers) never reached MCP setup — codex blocked on its sign-in gate, and a fabricated-but-correctly-shaped `auth.json` was rejected (matches `docs/design/multi-harness-parity-matrix.md`'s "`CODEX_HOME` — empirically ruled out" finding). Getting past that needs either the owner's live credentials (not touched without authorization) or deliberate owner-approved API spend (`702f2197`'s posture) — not pursued here, per direction.
2. **Even if tolerated, rotation likely wouldn't lower the POSIX exposure anyway.** `/proc/<pid>/environ` on Linux reflects the environment as captured at `execve()` time, not live runtime state — `setenv`/`unsetenv` mutate a process's libc-level copy, not that original memory region. So even if codex "forgot" the old value internally, the stale value would likely still be readable there, absent explicit memory-scrubbing (no evidence of any). **This claim is cited OS/kernel behavior, not something measured live in this investigation** — no Linux/macOS host was available, and it was not independently re-verified on this exact platform/kernel.

## Residual, per OS

- **Linux:** unchanged from `a50b8afd`'s own finding — mechanism per Background above. Full reach of that session's MCP tool surface.
- **macOS:** expected same exposure (same same-UID logic), but NOT independently measured.
- **Windows:** unaffected by this card; needs a deliberate PEB read, a materially higher bar.

## Mitigation available today

No technical fix exists. **Don't run codex-harness sessions on a shared-OS-user POSIX host** if the exposed MCP surface matters; **a human can pin a profile's `harness` back to `claude`** (human-only) where this is unacceptable — claude has no equivalent whole-session POSIX exposure for its own mcpToken (`mcpTokenRidesEnv`, `claude-settings.ts`).

## Do not

- Do not claim the codex MCP token is protected on Linux (measured) or macOS (expected, unmeasured) — neither is protected.
- Do not re-investigate without either a new codex CLI mechanism (a documented one-shot-read/file/stdin credential path for a `streamable_http` mount) or a materially newer codex version — re-check the schema and the `http_headers_helper` restriction after any codex CLI upgrade; this record is tied to `codex-cli 0.153.4` specifically.
- Do not assume the `/proc/<pid>/environ`-at-exec-time claim here is a verified measurement — it is cited OS behavior, not measured live on a POSIX host.
- Do not spend real codex account/API access chasing "does codex resend the header per request" without explicit, deliberate owner authorization first (same posture as `702f2197`).
