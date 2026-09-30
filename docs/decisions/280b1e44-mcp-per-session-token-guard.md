# 280b1e44 — every first-party `/mcp*` route authenticated by a per-session token, not the URL session id

## Narrative

Before this card, all 8 first-party MCP routes (`/mcp/:sessionId`, `/mcp-orch`, `/mcp-platform`, `/mcp-audit`, `/mcp-user-audit`, `/mcp-setup`, `/mcp-operator`, `/mcp-run`) treated the URL session id as their ONLY credential, and each router's own `resolveRole` checked the DB row's `role` but never liveness. The session id is PUBLIC — listable unauthenticated via `GET /api/sessions`/`GET /api/archived-sessions` (the settled open-GET policy, card 214caa53) — so any co-resident process (a worker's own Bash tool, or any process sharing this OS user) could drive ANY session's MCP surface just by reading or guessing an id, including an exited/archived row whose role still resolved. This is the zero-credential twin of what card 9ccedbee closed for `/api/*` writes.

This is NOT about trusting or not trusting a worker with git (card b0fb1e26/356538ef's accepted trade-off, deliberately not relitigated here) — it's that the credential itself was public, so the guard has to hold regardless of trust posture.

### Mechanism chosen: a2407ed4's per-session-token shape, not 9ccedbee's shared secret

The MCP caller is the spawned agent's own MCP client — high-frequency (every tool call), non-human, with no way to hold a shared secret the way a browser/CLI caller can. That is exactly the caller shape card a2407ed4 already solved for `/internal/hook` (a per-session token minted at spawn, never the shared loopback-secret bearer guard card 93249b52 deliberately excluded that route from). This card reuses that SHAPE — a sibling secret, `Live.mcpToken`/`CodexLive.mcpToken`, minted alongside `hookToken` in `spawn()`/`spawnCodexProcess` (same chokepoint, same fresh-every-respawn discipline) — but never the SAME VALUE as `hookToken`: different caller, different blast radius, no reason to let one leak compromise the other.

### Delivery: claude

`buildMcpServers` (`pty/host.ts`) adds `headers: { Authorization: "Bearer <mcpToken>" }` to every `{type:"http"}` entry it builds for the 8 first-party mounts (confirmed live in the real installed claude CLI binary: its HTTP MCP-config schema accepts exactly `["type","url","headers"]`, and its runtime reads `headers` when `type==="http"`). Because every real spawn now carries this header-borne secret, `collectMcpEnvSecrets` was widened to sweep `headers` values alongside `env` values — making `mcpConfigHasSecret` true for effectively every spawn today, which makes the EXISTING conditional file-diversion (`writeSessionMcpConfig` + `--mcp-config <path>` instead of inline JSON, built for card ed0757d6's capability-secret case) the new effective default. The conditional itself was deliberately left unchanged (still correct for a test-only `createPty` override that doesn't thread an `mcpToken`) rather than replaced with an unconditional switch — see the "Do not" for why. This means the token never rides argv, so the Windows 32766-char command-line ceiling (`preflightWindowsCommandLine`) is unaffected either way.

### Delivery: codex

Verified against the real, installed `codex` CLI binary (string search) that its config loader REJECTS a literal `mcp_servers.<id>.bearer_token` at load time with `"uses unsupported bearer_token; set bearer_token_env_var"` — codex never accepts a literal secret in its TOML/`-c` config, only a pointer to one of its own env vars. `mcpServersToCodexArgs` (`codex-host.ts`) therefore emits `-c mcp_servers.<id>.bearer_token_env_var=LOOM_MCP_TOKEN` (one shared env-var NAME for every mount — every codex-mounted first-party server on a given spawn shares the SAME per-session token, so there's no need to mint one env var per server id) whenever an entry carries `headers.Authorization` matching `/^Bearer /i`; `createCodexPty` sets `env.LOOM_MCP_TOKEN = mcpToken`. **Verified end-to-end with a real, authenticated codex spawn** (throwaway script, not committed — see the "Do not" below): a real `codex` process, given this exact `-c bearer_token_env_var=` config plus the env var, sent `Authorization: Bearer <the real minted token>` on both of its real outbound MCP HTTP requests (`/mcp/<id>` and `/mcp-orch/<id>`) — the token value matched exactly.

### Gateway verification

ONE `onRequest` hook in `gateway/server.ts`, prefix-matched (`routePattern.startsWith("/mcp")`) so a future 9th first-party route is covered automatically, registered UNCONDITIONALLY (never gated on remote-bind config — this is a co-resident-agent guard, not a remote-human guard, mirroring 9ccedbee's "must hold on the default loopback-only daemon" posture). Checks TWO independent conditions: `PtyHost.verifyMcpToken` (does the presented `Authorization: Bearer <token>` match this session's own `Live.mcpToken`/`CodexLive.mcpToken`) AND `PtyHost.isMcpReachable` (is this session actually live). The liveness check is NOT redundant with the token check: a `Live`/`CodexLive` entry is never removed from memory on exit (only flipped `alive:false` — see `Live.mcpToken`'s own doc), so an exited-but-unarchived session's stale-but-still-correct token would otherwise still verify. Role gates (`isLoomDev()` for `/mcp-platform`, the various `role===` checks for the rest) stay in each router's OWN `resolveRole` — this hook is deliberately identity + liveness ONLY.

### Test-only seam for DB-only fixtures

Several existing hermetic fixtures (`platform-scope.mjs`, `orch-scope.mjs`, `mcp-scope.mjs`, and siblings) seed a session row directly into the DB with no real `claude`/codex spawn at all, then connect a real MCP client to a real running daemon — a pattern that has no way to obtain a real `Live`-minted token. `PtyHost.registerTestMcpSession` mints one into a SEPARATE, lightweight `testMcpTokens` map (never a hand-constructed fake `Live` object, which would need dozens of unrelated required fields and drift against every future `Live` addition) — gated on `inTestMode()`, a structural no-op on a real end-user daemon. `POST /internal/test/mcp-session/:sessionId` (loopback + `inTestMode()` gated, same trust posture as the sibling `/internal/test/*` routes) exposes it over HTTP for a fixture that talks to a real spawned daemon process; `test/_mcp-auth.mjs` wraps both the minting call and the `StreamableHTTPClientTransport` `requestInit` shape. `LOOM_TEST=1` (armed by every fixture's own `_guard.mjs` import) is inherited into any daemon a fixture spawns via `env: { ...process.env, ... }` — verified against `platform-scope.mjs`'s own existing convention, not assumed.

## Update (card `9a8bc38f`) — the codex whole-session env-var exposure window, and what is/isn't established about `shell_environment_policy`

### The asymmetry

claude's delivery is FILE-based (`--mcp-config <path>`, via `writeSessionMcpConfig` — see "Delivery: claude"
above) — the token sits on disk only for the spawn→ready window this card already analyzed. codex's delivery
is ENV-based instead (`env[CODEX_MCP_TOKEN_ENV_VAR] = mcpToken` in `createCodexPty`, `pty/codex-host.ts`) —
the token stays in the live `codex` PROCESS's own environment block for the session's ENTIRE lifetime, not
just until ready. Any same-user process can read another process's environment on both platforms this repo
targets (`/proc/<pid>/environ` on POSIX; the Windows PEB via standard process-introspection APIs) — so a
co-resident worker (or any other same-OS-user process) can lift a live codex session's `LOOM_MCP_TOKEN` for
as long as that codex process is alive, a strictly wider window than claude's.

### Loom does not configure `shell_environment_policy`

`packages/daemon/src/pty/codex-host.ts` and `pty/host.ts` emit zero `-c shell_environment_policy...`
overrides anywhere in the codex `-c` argv Loom builds (confirmed: `shell_environment_policy` does not
appear as a literal in either file) — codex runs under whatever its OWN built-in default is; Loom neither
widens nor narrows it.

### What is established about codex's own default, and how (string search of the installed binary, no real spawn)

Per this card's `9a8bc38f` DoD, no real codex spawn was used — this is read off the locally-installed
`@openai/codex` npm package's real Windows binary
(`node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe`) via a raw ASCII
string scan, the same "grep the real installed binary" method this card's own "Delivery: codex" section
above already used to confirm the `bearer_token` rejection string.

- CONFIRMED: the binary embeds a `ShellEnvironmentPolicyTomlRaw` struct with exactly 7 fields — `inherit`,
  `ignore_default_excludes`, `exclude`, `set`, `include_only`, `filters`, `experimental_use_profile` — and
  a documented example `-c shell_environment_policy.inherit=all`, so `shell_environment_policy.inherit` is
  a real, user-settable config key (codex's own CLI help text cites it as an example of `-c key=value`).
- CONFIRMED (structural, not decompiled): three glob-pattern string literals — `*KEY*`, `*SECRET*`,
  `*TOKEN*` — sit immediately adjacent to each other in the binary's string table, positioned right next
  to the `ignore_default_excludes` struct's own debug info in multiple separate occurrences. This is
  consistent with being codex's built-in DEFAULT exclude-pattern set for `shell_environment_policy` (a
  field literally named `ignore_default_excludes` implies a default exclude set exists to ignore). If so,
  `LOOM_MCP_TOKEN` matches `*TOKEN*` case-sensitively-as-substring, so a codex-spawned shell CHILD process
  (the agent's own shell/exec tool calls) would not inherit it by default.
- **UNVERIFIED — do not treat as established:** whether `inherit`'s actual default value is something
  other than `"all"` (which would apply excludes) or literally `"all"` with default excludes still layered
  on top, and whether `ignore_default_excludes` itself defaults to `false` (excludes applied) vs `true`
  (excludes skipped). None of this was resolved from string search alone, and per this card's explicit
  instruction, no real codex spawn was used to observe the actual behavior. Do not cite the `*KEY*/
  *SECRET*/*TOKEN*` finding above as proof that `LOOM_MCP_TOKEN` is actually excluded from codex's own
  shell children in practice — only that the pattern exists in the binary in a position consistent with
  that role.

### Why this doesn't close the exposure window either way

Even a confirmed-exclude-by-default `shell_environment_policy` would only stop `LOOM_MCP_TOKEN` from
propagating into a shell command CODEX ITSELF spawns (an in-session `env`/`printenv` call, or a child
process' own environment) — it says nothing about a SEPARATE, co-resident OS process reading the live
`codex` process's own environment block directly (`/proc/<pid>/environ`, the Windows PEB), which is an
OS-level capability entirely outside codex's own config surface. That is the actual exposure this section
documents, and it is NOT mitigated by `shell_environment_policy` however that default resolves.

## Do not

- Do not reuse `hookToken`'s VALUE for `mcpToken`, or vice versa — different caller shape, different blast radius; a sibling secret only, minted at the same chokepoint.
- Do not add the Authorization header to codescape's HTTP mount, or any capability-catalog/playwright/markitdown mount — this card's scope is exactly the 8 first-party routes `gateway/server.ts` registers; codescape is a different service with its own security model.
- Do not emit a literal `mcp_servers.<id>.bearer_token` value into codex's `-c`/TOML config — its config loader rejects this at load time; the value must ride the process's own env, named via `bearer_token_env_var`.
- Do not let the new gateway `onRequest` hook know about role gates (`isLoomDev`, `role===`) — those stay in each router's own `resolveRole`. This hook is identity + liveness only, by design (keeps the hook simple and keeps role-gating colocated with every other role gate).
- Do not treat a token match alone as sufficient for `/mcp*` auth — a `Live`/`CodexLive` entry survives `stop()` with `alive:false`; always pair `verifyMcpToken` with `isMcpReachable`.
- Do not hand-construct a fake `Live`/`CodexLive` object for a test seam — use `registerTestMcpSession`'s separate lightweight map instead; a hand-built fake will drift against every future required field on either interface.
- Do not treat the codex real-spawn wire-behavior proof (the `Authorization: Bearer` header actually observed) as something to re-derive by reading code alone — it was verified against a REAL, authenticated codex CLI process with a throwaway, uncommitted script (not shipped — this is a third-party tool's wire behavior, not a Loom regression to guard permanently); re-verify with a fresh real spawn if codex's own MCP-client behavior is ever suspected to have changed.
- Do not widen `collectMcpEnvSecrets`'s `headers` sweep to treat it as "secrets only" — like its existing `env` sweep, it reads structurally (any string value), which is deliberate and harmless in both directions it's used for (see that function's own doc).

## Source

`packages/daemon/src/gateway/server.ts` (the onRequest hook, ~line 698 as of this card); `packages/daemon/src/pty/host.ts` (`Live.mcpToken`/`CodexLive.mcpToken`, `verifyMcpToken`, `isMcpReachable`, `registerTestMcpSession`, `buildMcpServers`'s `authHeaders`, `collectMcpEnvSecrets`); `packages/daemon/src/pty/codex-host.ts` (`CODEX_MCP_TOKEN_ENV_VAR`, `mcpServersToCodexArgs`'s `bearer_token_env_var` emission); `packages/daemon/src/mcp/platform.ts` (`resolveRole`'s `isLoomDev()` gate). Card 280b1e44, full review lane 3 (269ea64f) B1.
