# ed0757d6 — the per-session `--mcp-config` secret file gets a lifecycle, and SETTINGS_DIR gets a read deny

## Background

`writeSessionMcpConfig` (`pty/claude-settings.ts`) writes a DECRYPTED capability connection secret in
plaintext to `<LOOM_HOME>/tmp/settings/<sid>.mcp-config.json` for a spawn whose assembled `mcpServers` map
carries at least one capability-injected env value (`mcpConfigHasSecret`, `host.ts`). Before this card,
nothing ever unlinked that file: it survived secret rotation, connection deletion, capability removal, and
session exit/archive indefinitely. The `0o600` mode written alongside it is a no-op on Windows, so on the
owner's self-hosting host it bought nothing at all.

Every capability that can carry `requiresConnection`/`secretEnvVar` resolves to a **stdio** MCP server
(`capabilities/registry.ts`'s `resolveCapabilityServer` hardcodes `type: "stdio"` on every mounted entry;
an "http" row's own such fields would be silently inert). So the entire population of secret-bearing
mcp-config files is stdio-mounted.

## Unlink lifecycle (DoD 1–3)

Three call sites, all routed through the single `unlinkSessionMcpConfig`/`sessionMcpConfigPath` pair so the
write side and every delete side agree on the filename:

1. **`createPty` (host.ts), stale-file cleanup.** When the CURRENT spawn's `capabilitySecrets` is empty,
   unlink any file a PRIOR spawn of this same sessionId left behind (rotation, connection deletion,
   capability removal all land here — the next spawn simply carries no secret any more).
2. **`markReady` (host.ts), earliest-safe deletion for the current spawn's own file.** Evidence for
   "claude reads `--mcp-config` only at startup, never re-reads it later": (a) `--mcp-config <path>` and
   `--settings <path>` are both plain argv flags, parsed together at the CLI's own early bootstrap — before
   hooks can run at all, since hook wiring itself comes from the `--settings` file. SessionStart firing is
   therefore evidence the mcp-config file has already been parsed into memory. (b) `Live.mcpSeen`'s own doc
   (host.ts) already establishes that the actual MCP *connection handshake* can lag behind SessionStart
   ("ready... says nothing about whether the CLI's own async MCP-client handshake... has finished") — but
   that lag is about establishing the JSON-RPC session over an already-resolved transport (an already-
   parsed stdio command + env, or an already-open HTTP client), not about re-opening the config file from
   disk. (c) No code anywhere in this daemon (grepped) implements or expects a live MCP-config reload/
   reconnect-from-file mechanism; every respawn (fresh/resume/fork/recycle) goes through `createPty`, which
   rewrites the file fresh BEFORE that new process starts — the architecture already assumes "one file
   read, once, at process start" as the whole contract. Given (a)–(c), `markReady` is the earliest point a
   respawn's own file is unlinked.
3. **pty `onExit` handler (host.ts), unconditional backstop.** Covers a session that crashes before ever
   reaching `ready`. Also covers "stop" and "archive": both route through the same exit path (archiving is
   automatic-on-pty-exit — see `sessions/service.ts`'s own doc on the Archive surface), so there is no
   separate archive-time hook needed.
4. **Boot sweep (`pty/mcp-config-gc.ts`), the final backstop.** A hard daemon crash skips all three of the
   above (nothing is running to fire them). The boot sweep reaps any `*.mcp-config.json` under SETTINGS_DIR
   whose session row is absent or not `live`/`starting`. Unlike `sessions/scratch-gc.ts`'s own boot sweep,
   there is no "still resumable, keep it" predicate here — this file is pure per-spawn secret material,
   ALWAYS rewritten fresh at a session's own next spawn, never read across a respawn boundary — so
   resumability is irrelevant to whether deleting it is safe.

## Does `claude` ever RE-READ `--mcp-config` mid-session? (asked during review, 2026-09-30)

In-repo evidence alone was inconclusive: nothing in this daemon's own source or decision records documents
the real CLI's internal handling of a crashed stdio MCP server, an `/mcp` reconnect, or a model/permission-
mode switch — `Live.mcpSeen`/`markMcpSeen` (host.ts) only observes the daemon's own HTTP-mounted
`loom-orchestration` route noticing an inbound request; it says nothing about disk re-reads and isn't even
reachable for a stdio server. So the "startup-only-read" claim above rests on architectural inference
(argv parsed once, early), not a direct observation of this exact question.

Checked externally (aggregated from `anthropics/claude-code` GitHub issues — anonymized quotes, not
Anthropic's own docs, but multiple independently-reported specimens converging on the same shape):
"MCP servers are only loaded at session startup, and if you run `claude mcp add` during an active session
or edit the config file directly, the new server is written to the config file but the running process
doesn't pick it up" / "Currently, the only way to use a newly added MCP is to exit the session and relaunch
Claude Code" / an OPEN feature request for a `/mcp reload`-style command (confirms no such live-reload
ships today) / for a crashed local (stdio) server: "they won't reconnect by themselves... marked as failed
with no auto-recovery." The `/mcp` dialog's manual restart toggle can restart a stdio server, but since a
mid-session file edit is reported NOT picked up by the running process, that restart must relaunch from the
already-loaded in-memory server list, not a fresh disk read. No evidence, or even a plausible mechanism,
connects a model/permission-mode switch to any MCP config re-read — unrelated subsystems.

**Verdict: externally-sourced evidence (not just inference) that `--mcp-config` is read once at startup and
never re-read from disk, for all three scenarios — a crashed stdio server, `/mcp` reconnect, and a
model/mode switch — as of the currently shipped CLI.** This is a THIRD-PARTY-observed behavior of a vendor
binary Loom does not control, not a contract Loom itself enforces — if the CLI ever adds a live-reload
mechanism (the open feature request above), this section goes stale and `unlinkSessionMcpConfig`'s
`markReady` call site would need re-verifying against the new version before trusting it again.

**What Code Review actually verified LIVE (claude 2.1.285), and what it did not.** Confirmed live: the
config is parsed into memory before SessionStart (the capability's MCP tool still returned the secret after
a SessionStart hook had already deleted the file — direct proof of the "read once, early" claim for the
ordinary boot path), and the SETTINGS_DIR deny is honoured for `Read` and for `Bash(cat)`. **NOT exercised
live: a stdio-server crash-relaunch or an `/mcp` reconnect performed AFTER the file was deleted** — the
reviewer's own A/B relaunch attempt was inconclusive. That specific scenario rests on the upstream-issue
evidence above ONLY, not a live Loom-side observation — treat it accordingly if this ever needs re-proving.

## SETTINGS_DIR read deny (DoD 4)

SETTINGS_DIR holds every session's hook token (`<sid>.json`) and, for a secret-bearing spawn, the
plaintext connection secret (`<sid>.mcp-config.json`). Neither the blanket transcript-root deny
(`TRANSCRIPT_ROOT_DENY_ROLES`) nor the worker-scoped one ever covered it — a co-resident session with plain
`Read`/`Glob` could read ANY other session's settings/secret file, including one belonging to a different
project, with no gate at all (the SUSPECTED gap this card's kickoff named — live-verified by Code Review
against real claude 2.1.285: honoured for `Read` AND for `Bash(cat)`). **Closed for `Read`/`Glob` and direct
`Bash` file reads specifically — NOT a boundary against arbitrary `Bash` CODE** (e.g. `node -e "require('fs')
.readFileSync(...)"`, or any other program a `Bash` session can invoke that opens the file itself) — the
CLI's `permissions.deny` glob only governs its OWN tool dispatch, never what an executed shell command goes
on to do. Same posture as the transcript-root deny it sits beside (`31613c1e`'s own "best-effort DENY-LIST,
never a structural guarantee").

`withSettingsDirDenyForSpawn` unions `SETTINGS_DIR_READ_DENY_RULE` into every spawn's `permission.deny`,
**unconditionally, independent of role** — unlike the transcript-root deny, which is role-scoped because
some roles have a genuine reason to read a transcript (a worker's own project, a `run` session's arbitrary
task input as data). No role has ANY legitimate reason to Read daemon-owned spawn plumbing under
SETTINGS_DIR, so there is no equivalent carve-out to reason about here.

## The ~1702 "never reaching the claude process" comment (host.ts, `buildMcpServers`'s own doc)

That comment claimed a capability secret, injected only into a mounted server's own `env` block, is "never
a CLI argument, never reaching the `claude` process." That overclaims for the stdio case, which — per the
registry finding above — is the ONLY case that ever actually happens today: for a stdio-mounted capability
server, `claude` itself must read the secret out of the (now file-diverted) `--mcp-config` payload in order
to spawn that server's subprocess WITH the secret set in its env. The secret therefore genuinely passes
through the `claude` process's own memory and its own child-spawn `env` construction — it just never rides
on `claude`'s OWN argv (which is the actual, narrower claim `writeSessionMcpConfig`'s doc already states
correctly: kept off `/proc/PID/cmdline`/`ps`/Windows WMI CommandLine). The comment is corrected in place to
state the narrower, accurate claim.

## Do not

- Do not delete a session's mcp-config file synchronously inside `createPty` for the spawn that JUST wrote
  it — the CLI process for that spawn hasn't started yet at that point in the function; only `markReady`
  (after SessionStart) or `onExit` are safe deletion points for the CURRENT spawn's own file.
- Do not read `Live.mcpSeen` as evidence that the mcp-config FILE itself might still be read after
  SessionStart — it tracks the MCP connection HANDSHAKE lag, not a file re-read; see the evidence above.
- Do not scope `withSettingsDirDenyForSpawn` by role — there is no legitimate per-role exception the way
  there is for the transcript-root deny.
- Do not widen the corrected `buildMcpServers` comment to claim the secret is visible to the MODEL/agent
  itself — it isn't; the claim being corrected is specifically about the `claude` HOST PROCESS's own
  memory/argv, not the agent's own tool-visible surface.
- Do not treat "the CLI never re-reads `--mcp-config` mid-session" as a Loom-enforced invariant — it is an
  externally-observed vendor-CLI behavior (see the section above), not something this daemon controls or
  can verify against a future CLI version. Re-check it against a new `claude` release before relying on it
  further, rather than assuming it still holds.
