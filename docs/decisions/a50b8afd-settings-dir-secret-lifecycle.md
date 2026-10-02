# a50b8afd — SETTINGS_DIR secrets get an env-var placeholder (mcpToken) and a full delete lifecycle (settings.json)

## Background

Card 7955458e's investigation found that a codex session gets no `SETTINGS_DIR_READ_DENY_RULE` at all
(`createCodexPty` never reads `opts.permission`), and codex's `-s workspace-write` sandbox restricts
WRITES only — reads are unrestricted. So any codex session (today: the owner's one explicit
`harness:"codex"` worker profile) can `cat` every other live session's `<LOOM_HOME>/tmp/settings/*` file.

This card's own investigation (`a50b8afd`, read-only pass, reported to the manager 2026-10-02) found the
blast radius larger than the kickoff described:

- **`<sid>.json` (the `--settings` file, hook token) was NEVER deleted by any code path** — confirmed by
  grepping the whole daemon source for an unlink of this filename; `pty/mcp-config-gc.ts`'s boot sweep
  scoped explicitly to `.mcp-config.json[.tmp]` only. It persisted forever: through a session's full
  lifetime, past archive, across daemon restarts.
- **`<sid>.mcp-config.json` now carries a per-session `mcpToken` on effectively every real spawn**, not
  just capability-secret-bearing ones — card 280b1e44 added it as an `Authorization` header on all 8
  first-party HTTP mounts, and `collectMcpEnvSecrets` sweeps `headers` too, so `mcpConfigHasSecret` is
  true today for essentially every spawn (`host.ts:6332`'s own comment already said so). That token
  authenticates against `gateway/server.ts`'s `/mcp*` routes with the TARGET session's own role-scoped
  tool surface (role gating lives in each router's `resolveRole`, keyed off sessionId, not the token) — so
  reading it is full impersonation of that session's MCP tool surface, not merely "a connection secret."

Manager-approved direction (2026-10-02): build (b1) — stop writing the real mcpToken value into
mcp-config.json at all — and (b2) — give `<sid>.json` the same delete lifecycle `<sid>.mcp-config.json`
already has (ed0757d6). Explicitly NOT pursuing: (a) OS-ACL-isolated per-session directories (all Loom
sessions run as the same OS user; no per-process ACL primitive exists at that layer) or (c) codex's beta
`[permissions.<name>]` filesystem read-deny (independently verified, below, as mutually exclusive with the
`-s` sandbox flag Loom's codex boot recipe depends on).

## (c) ruled out — codex's beta permission-profile read-deny is incompatible with `-s`

Verified via two independent fetches of the current official Codex CLI config-reference docs (not just
trusting 7955458e's kickoff restatement): the `default_permissions`/named `[permissions.<name>]` profile
mechanism is documented **"Don't combine with `sandbox_mode` or `[sandbox_workspace_write]`"** — i.e.
mutually exclusive with `-s workspace-write`, the flag `createCodexPty` (host.ts:5090) depends on for its
already-proven, probe-validated unattended boot recipe (`d7657543`). Adopting profiles would mean
abandoning that recipe and re-deriving equivalent write-approval behavior from scratch under a beta,
version-fragile mechanism — not pursued.

## V1 — LIVE-VERIFIED: `${VAR}` expansion works in a `--mcp-config <path>`-loaded file's `headers`

Measured 2026-10-02 against the real installed `claude 2.1.287`, in a throwaway scratch dir (own cwd, no
daemon involved — this exercises the vendor CLI's own config parser, not Loom's spawn machinery), with a
tiny local HTTP server logging the `Authorization` header of every request it received:

- `--mcp-config` file: `{"mcpServers":{"probe":{"type":"http","url":"http://127.0.0.1:48729/mcp","headers":{"Authorization":"Bearer ${LOOM_PROBE_TOKEN}"}}}}`
- **Negative control** (env var unset): the server received the LITERAL string `Bearer ${LOOM_PROBE_TOKEN}` — unexpanded, confirming the baseline (no accidental substitution).
- **Positive run** (`LOOM_PROBE_TOKEN=sentinel-secret-9f3a7c21` set on the spawned claude process's own
  env): the server received `Bearer sentinel-secret-9f3a7c21` — the real value, substituted from the
  process's own environment, exactly as community docs describe for `.mcp.json`.

This confirms the mechanism works for a `--mcp-config <path>`-loaded file specifically (not just an
auto-discovered `.mcp.json`), on the CLI version actually installed on this host.

## V2 — LIVE-VERIFIED: a real claude process does NOT need `--settings` on disk past SessionStart

Measured 2026-10-02 against the same installed `claude 2.1.287`: a `--settings` file whose `SessionStart`
hook command is a test relay script that **synchronously deletes the settings file itself**, before
posting, then exits; `UserPromptSubmit`/`Stop` hooks point at the same relay (no delete). Single `claude
-p "Reply with exactly: OK" --settings <file> ...` invocation (deliberately NOT using `--resume` — a
second process launch would need `--settings` to exist again at ITS OWN bootstrap, which proves nothing
about re-reading mid-process; the whole point is to stay inside ONE continuously-running process across
multiple hook firings).

Observed, in order:
1. `SessionStart` fired, token correct, file deleted (marker timestamped before the POST).
2. File confirmed absent from disk.
3. `UserPromptSubmit` fired ~560ms later — still with the correct, embedded token.
4. `Stop` fired ~2.6s later — still with the correct, embedded token.

This is a direct, live analogue of `ed0757d6`'s own mcp-config test (which proved the SAME claim for
`--mcp-config`) — proving the CLI parses `--settings` once, early, into an in-memory hook-command table and
never needs the file again to keep firing hooks for the rest of that process's life. (Scope: this exercises
the SAME-process, no-crash-no-resume case specifically — see "Residual ceiling" below for what's untested.)

## (b1) — PLATFORM-SPLIT: the mcpToken header is a placeholder on win32, unchanged (literal) on POSIX

**Revision note:** the FIRST build of (b1) made this change unconditionally, on every platform — the same
day's Code Review found a Major: on POSIX this *traded* `ed0757d6`'s short pre-markReady FILE-read window
for a WHOLE-SESSION ENV-read exposure. A same-UID shell reads another process's env with ordinary tools —
`/proc/<pid>/environ` (Linux) or `ps eww` (macOS) — and codex's sandbox does not block this read either.
That is strictly worse than the pre-card exposure, not better. RULED: platform-split, never worse than
before on any OS. The description below is the CORRECTED, final state — not the first build.

`mcpTokenRidesEnv(platform: NodeJS.Platform = process.platform): boolean` (`claude-settings.ts`) is the
ONE helper that decides this — `platform === "win32"` — and it is platform-injectable (the optional param)
so a test can force either branch on any host, independent of what OS the test actually runs on.
`createPty` calls it ONCE per spawn and threads the SAME resolved boolean into both places that need to
agree: `buildMcpServers`'s `mcpTokenRidesEnv` option (decides the header VALUE) and its own
`env[MCP_TOKEN_ENV_VAR] = mcpToken` line (decides whether the real value is set on the process at all) —
a single computation shared both ways, so the two can never disagree.

- **win32** (`mcpTokenRidesEnv()` true): `buildMcpServers` emits `Authorization: "Bearer ${LOOM_MCP_TOKEN}"`
  literally — a placeholder, never the real value — and `createPty` sets the real value directly on the
  spawned claude process's own env. Reading another process's env here needs a deliberate PEB read; this
  is a genuine improvement over the pre-card literal-value-in-file exposure.
- **POSIX**: `buildMcpServers` emits the LITERAL mcpToken value in the header — exactly as it did before
  this card — and `createPty` never sets `env[MCP_TOKEN_ENV_VAR]` for claude. The token's only exposure is
  the mcp-config.json FILE, cleared at `markReady` exactly as `ed0757d6` already established. Never worse
  than before this card, on this platform, by construction.
- **codex, either platform**: UNCHANGED, out of this card's scope. `createCodexPty`'s own
  `env[MCP_TOKEN_ENV_VAR] = mcpToken` line stays unconditional — codex's config loader rejects a literal
  `bearer_token` value outright (card 280b1e44), so codex has no alternative to putting it in env, and this
  predates `a50b8afd`. **This means codex's own pattern has the SAME whole-session POSIX env-read exposure
  this card's Major was about — just not introduced by this card, and not fixed by it.** See
  `docs/decisions/2e7373ab-codex-mcp-token-posix-env-residual.md` for the full investigation and accepted
  residual.
  `mcpServersToCodexArgs` only checks the header matches `/^Bearer\s+\S/i` to decide whether to emit its
  own `-c mcp_servers.<id>.bearer_token_env_var=` pointer — it never reads the string's actual content, so
  neither platform branch above changes anything for codex's own translation path.

The mcp-config.json file-vs-inline-argv decision (`createPty`) stays EXPLICIT on both platforms:
`(capabilitySecrets.length > 0 || !!mcpToken)` forces file mode whenever a real mcpToken exists,
independent of whether `collectMcpEnvSecrets` happens to still treat the header text as "secret-shaped."
(On POSIX the literal value obviously still reads as secret-shaped; on win32 the placeholder currently
still does too, since the sweep is non-empty-string-based — but that coincidence must never become the
ONLY reason file mode is chosen, on either platform.)

**win32 env inheritance, noted and accepted:** `LOOM_MCP_TOKEN`, once set on the spawned claude process's
own env, is inherited by every child THAT process spawns — its own Bash tool invocations, the hook-relay
script, any stdio MCP server it launches. This is acceptable: it is that SAME session's own short-lived
token, already fully available to that session via its own MCP tool calls: a child inheriting it grants no
access the session didn't already have through its own, sanctioned channel.

## (b2) — `<sid>.json` gets the SAME delete lifecycle `<sid>.mcp-config.json` already has

`claude-settings.ts` gains `sessionSettingsPath`/`unlinkSessionSettings`, called from `createPty`'s
throw-after-write catch, `markReady` (ONLY when `live.sessionStartObserved` is true — see "Code Review
round 2" below for why that guard exists), and the pty `onExit` handler (unconditional crash backstop) —
the same three shapes `ed0757d6` established for mcp-config.json, minus the `createPty`-stale-cleanup case
(settings.json is unconditionally rewritten at the SAME path on every spawn, so there is no "prior spawn
left a file this one doesn't need" case to clean up). `pty/mcp-config-gc.ts`'s boot sweep is widened
(`sweepOrphanedSettingsDirSecrets`, renamed from `sweepOrphanedMcpConfigs`) to also classify and reap
orphaned `<sid>.json`/`<sid>.json.tmp` files under the SAME liveness rule — ordering matters:
`.mcp-config.json[.tmp]` is checked before the plain `.json[.tmp]` suffixes, since the former is a strict
suffix-superset of the latter.

## Code Review round 2 — three more fixes, same day

1. **`createPty`'s throw-cleanup try block opened too late.** It used to open AFTER the mcp-config write
   (`writeSessionMcpConfig`, inside the `mcpConfigPath` ternary) — so a throw from THAT call (e.g. a
   Windows `renameSync` EPERM, a real documented footgun) happened OUTSIDE the try, and the catch's
   `unlinkSessionMcpConfig`/`unlinkSessionSettings` cleanup never ran, stranding the just-written
   settings.json (and possibly a stray mcp-config `.tmp`) until the next boot sweep. Fixed: the try now
   opens immediately after `writeSessionSettings`, before the mcp-config write, so a throw anywhere in that
   whole region is caught.
2. **`markReady` can be reached with SessionStart never having fired.** The spawn-armed readiness-fallback
   timer (`READY_FALLBACK_MS`) calls `markReady` if the session still isn't `ready` after a grace period —
   by its own doc, this firing specifically means the hook never showed up (if it had, SessionStart's own
   handler would already have cancelled this timer and re-armed a different one). Unconditionally deleting
   `--settings` there, on a genuinely slow cold start, risks the CLI not having parsed it yet — a FATAL
   error ("Settings file not found"), not a graceful degradation. Fixed: `Live.sessionStartObserved`
   (set true as the FIRST statement inside deliverHook's `SessionStart` case, never inferred from
   `engineSessionId`/`startupCyclesDone` — both can already be populated at spawn time for a resume/fork,
   before THIS attempt's own SessionStart has fired) gates the settings-file unlink in `markReady`: only
   unlink when it's true. **On the fallback path (no SessionStart yet), the file is correctly left in
   place** — picked up later by whichever of the following actually happens: the real SessionStart finally
   arriving (see round 3, item below, for why that ALSO needed a fix), `onExit` (unconditional backstop),
   the next respawn (which rewrites the file fresh before its own next `ready`), or the boot sweep.
   **Open question, not fixed here:** the SAME readiness-fallback path ALSO unconditionally calls
   `unlinkSessionMcpConfig` — a pre-existing `ed0757d6` behavior, not something this card introduced.
   Whether that call has the identical hazard (the CLI not having parsed `--mcp-config` yet either) was not
   investigated as part of this card; flagged here rather than silently left unmentioned.
3. **An inherited `LOOM_MCP_TOKEN` is now scrubbed in `buildSpawnEnv`**, mirroring the existing
   `CLAUDECODE`/`CLAUDE_CODE_*` scrub — the only legitimate source of this value is the explicit,
   per-spawn mint-and-assign line in `createPty`/`createCodexPty`, which runs AFTER `buildSpawnEnv`
   returns. Without this, a stray value inherited from the DAEMON's own process env would flow straight
   through on any path that mint-and-assign line doesn't reach — e.g. POSIX claude, where
   `tokenRidesEnv` is false and the line never fires at all.

A regression test (`mcp-token-env-override.mjs`) proves a project's `sessionEnv`/`credentialEnv` can never
override the minted token on **win32 claude and codex (either platform)** — the explicit mint-and-assign
line in `createPty`/`createCodexPty` runs AFTER `buildSpawnEnv` has already merged `sessionEnv`, so it is
always the LAST write to that key wherever it fires. **This claim does NOT extend to POSIX claude: there is
nothing to "override" there, because `applyMcpTokenEnv` never fires at all when `ridesEnv` is false.** A
`sessionEnv`-provided `LOOM_MCP_TOKEN` on POSIX claude passes straight through `buildSpawnEnv`'s merge
unmodified and UNCHALLENGED — but it is INERT: claude's own mcp-config.json header on POSIX is the literal
token value, never a `${LOOM_MCP_TOKEN}`-referencing placeholder, so claude never reads this env var to use
it as a bearer token there. The value just sits in that process's env, unused.

## Code Review round 3 — the call-site gap, the late-SessionStart linger, and four smaller fixes

1. **BLOCKING: the POSIX env gate (`createPty`'s `if (mcpToken && tokenRidesEnv) env[...] = mcpToken`,
   round 2's own fix) had NO test that could fail if it regressed to unconditional.** Every header test
   was platform-injected (`buildMcpServers`'s own `mcpTokenRidesEnv` option), but the real-spawn env tests
   only ever ran on THIS host's real platform (win32), where `true` was already the correct answer either
   way — reverting the gate back to unconditional (last round's exact Major) would have stayed green on
   every existing test. Fixed two ways: (a) the env decision is now a named, pure, exported function,
   `applyMcpTokenEnv(env, mcpToken, ridesEnv)` — `createPty` calls it rather than inlining the conditional,
   so a future revert is a visible, reviewable diff against a single-purpose function, not a buried
   one-liner; (b) `PtyHost.resolveMcpTokenRidesEnv()` is a NEW protected seam (defaults to the real
   `mcpTokenRidesEnv()`) that a test subclasses to FORCE either branch through a REAL spawn, on this host,
   regardless of its actual OS — closing the gap directly, since it exercises the real call site rather than
   just the extracted helper in isolation. **RED-proven**: reverting `applyMcpTokenEnv` to the old
   unconditional form, and separately reverting the call site to bypass it, both reproduced the exact
   regression (confirmed via the forced-POSIX real-spawn test going red, env carrying the token it shouldn't
   have) before the fix was restored.
2. **The late-SessionStart linger.** Round 2's own `sessionStartObserved` gate correctly protects against
   deleting `--settings` too early (before SessionStart) — but it created a NEW gap: if the readiness
   fallback marks the session ready FIRST (SessionStart genuinely slow), `markReady`'s own `live.ready`
   early-return guard means markReady NEVER runs again for that session. The later arrival of the real
   SessionStart would, under round 2's code, set `sessionStartObserved = true` and otherwise do nothing
   about the settings file — which then lingers for the ENTIRE REST OF THE SESSION, not just briefly. Fixed:
   the `SessionStart` case now checks `live.ready` itself — if `markReady` already ran, SessionStart unlinks
   the file directly (safe: we're inside the SessionStart handler, so the CLI has definitely parsed
   `--settings` by now). **RED-proven**: temporarily removing this one line reproduced the linger exactly
   (the settings file survived a `markReady()` → `deliverHook("SessionStart")` sequence) before the fix was
   restored.
3. **`createShellPty` was missing the `LOOM_MCP_TOKEN` scrub** entirely — it builds its own env copy
   inline, bypassing `buildSpawnEnv` (and its CLAUDECODE/CLAUDE_CODE_*/`LOOM_MCP_TOKEN` scrub) altogether,
   by design (a plain shell inherits the daemon's env "wholesale"). Fixed: the one exception carved out —
   `LOOM_MCP_TOKEN` is scrubbed there too, same rationale as `buildSpawnEnv`'s own scrub.
4. **Stale `@decision a50b8afd` guard comments** in `codex-host.ts` (around `MCP_TOKEN_ENV_VAR` and
   `mcpServersToCodexArgs`) claimed "never put the real mcpToken value into the headers/mcp-config JSON for
   either harness" — false on POSIX claude BY DESIGN since the platform split. Rewritten to point at
   `mcpTokenRidesEnv` for which platform+harness combination actually uses the placeholder.

## Residual ceiling — NOT closed by this card, stated plainly, PER PLATFORM

Per the DoD's own instruction to say so plainly: this does not achieve full isolation on EITHER platform.

**Both platforms, unconditionally:**
- **The pre-markReady boot window still exists for every spawn.** A codex session (or any same-user,
  unrestricted-Bash session) that catches a target session between its spawn and its own `markReady` can
  still read a live secret from either file. This is NOT a new or widened window: it is the SAME window
  `ed0757d6` already accepted for the mcp-config file before this card — this card does not make that
  window longer or shorter on either platform, only changes WHAT is readable inside it (nothing, on win32;
  the literal value, unchanged, on POSIX). **This claim depends on the Code Review round 3 fix for the
  late-SessionStart linger (above) — without it, a slow-boot settings-file window could extend to the
  session's ENTIRE remaining lifetime, not stay bounded to "pre-markReady." With that fix in place, the
  window is bounded exactly as stated here.**
- **V2's own scope**: it proves the no-crash, no-resume, single-continuous-process case, for claude
  **2.1.287 specifically** — a vendor-CLI internal behavior, not a Loom-enforced contract; re-verify after a
  CLI upgrade. A stdio MCP server crash-relaunch or an `/mcp` reconnect occurring AFTER the settings file
  (or mcp-config file, per `ed0757d6`) is deleted remains UNTESTED live, for the same reason `ed0757d6`
  flagged it — rests on aggregated third-party evidence only (an open upstream "no mid-session hook config
  reload" feature request, `anthropics/claude-code#55867`, corroborates the absence of a reload path but is
  not a direct Loom-side observation of THAT specific scenario).
- **Third-party capability secrets in a stdio mount's `env`** (not the mcpToken) still ride as literal
  values in mcp-config.json on BOTH platforms — scoped OUT of this card (card `2be634f2`) since Loom
  doesn't control those binaries' own config-reading behavior the way it controls `buildMcpServers`' own
  output.

**win32 only:**
- Once the mcpToken lives only in the claude process's own env block, a same-OS-user caller can still
  extract it via a DELIBERATE PEB read (there is no built-in Windows CLI/PowerShell one-liner for this the
  way `/proc/<pid>/environ` is on Linux — it requires a purpose-written program using `OpenProcess` +
  `ReadProcessMemory` against the target's PEB) — not reachable via `Read`/`Glob`/ordinary `Bash`
  (`cat`/`type`) alone. This is a materially higher bar than the pre-card file-read exposure, but it is NOT
  a structural guarantee — closing it for real needs per-session OS identity (AppContainer or
  restricted-token process isolation) — out of proportion to this card.

**POSIX only:**
- The mcpToken's exposure is UNCHANGED from before this card: the literal value in mcp-config.json, for
  the same short pre-markReady window `ed0757d6` already established. **Corrected claim (this record's own
  first draft overstated this): the pre-card exposure was NOT "effectively unbounded" in DURATION** —
  `ed0757d6` already deleted the mcp-config file at `markReady`, before this card existed. What WIDENED
  with card `280b1e44` was the POPULATION (every real spawn, not just capability-secret-bearing ones), not
  the per-spawn exposure WINDOW. This card changes neither, on POSIX.
- **Do NOT claim this is "not reachable via ordinary Bash" on POSIX — it is.** `/proc/<pid>/environ`
  (Linux) and `ps eww` (macOS) both read another same-UID process's env with tools already in common,
  unprivileged use — no deliberate memory-inspection program needed, unlike win32. This is the exact
  reasoning behind the platform split above: putting the token in env would have made it MORE reachable on
  POSIX, not less.
- **Codex's own pre-existing mcpToken-in-env pattern (card 280b1e44, `createCodexPty`) has this SAME POSIX
  exposure today, unconditionally, on every platform codex runs on — predating and unaffected by this
  card.** It was not introduced by `a50b8afd` and is not fixed by it; see
  `docs/decisions/2e7373ab-codex-mcp-token-posix-env-residual.md` for the full investigation and accepted
  residual.

## Follow-up filed (scope cut from this card)

Generalizing (b1)'s placeholder-plus-env-var pattern to third-party capability secrets in a stdio mount's
own `env` (not just the mcpToken header) — card `2be634f2`, `discoveredFrom a50b8afd`, p2.

## V2 addendum — Code Review's read-only bundle evidence that PERMISSION RULES also survive deletion

V2 above (this record) only proved hooks keep firing after `--settings` is deleted — it used `claude -p`
and never exercised the permission system at all. The Code Reviewer separately inspected the installed
claude **2.1.287** CLI's own bundle (read-only — no spawn, no behavioral test) and found two internal
mechanisms that extend the claim to permission rules (the `allow`/`deny` lists) specifically:
- `flagSettings` (the in-process representation of the `--settings`-loaded file) is explicitly SKIPPED by
  the CLI's own file-watcher — it is not a path the watcher ever re-reads on change, unlike project-level
  `.claude/settings.json`/`.claude/settings.local.json`, which genuinely are watched.
- The `--settings` file's content is PINNED at startup into a variable the bundle names
  `flagSettingsFilePinnedContent`, and permission checks re-read FROM that pinned string (via an internal
  function the bundle names `h3`), never from the file on disk again.
Together these are stronger, structural evidence (not just a live behavioral proxy) for the same
conclusion V2 reached empirically: once parsed, `--settings` content — hooks AND permission rules alike —
lives entirely in memory, with no code path that would need the file to still exist. **This is
INTERNAL-NAME evidence from one specific CLI build (2.1.287) — version-dependent by nature; a future
release could rename or restructure this without any public API change, so re-verify against bundle
internals (or re-run V2's own live test) after any claude CLI upgrade, not just trust this snapshot.**

## Do not

- Do not let `mcpConfigHasSecret`'s file-vs-inline decision depend SOLELY on whether a value happens to
  "look like a secret" — a real `mcpToken` must force file mode explicitly (`|| !!mcpToken`), independent
  of what `collectMcpEnvSecrets` sweeps.
- Do not read the `${LOOM_MCP_TOKEN}` placeholder's presence in mcp-config.json as a regression — on win32
  it is the intended, inert replacement for the literal value; on POSIX it should NOT appear at all — the
  literal value belongs there instead (see the platform-split (b1) section above).
- Do not re-add a `createPty`-stale-cleanup call site for `<sid>.json` — settings.json is unconditionally
  rewritten at the same path on every spawn, so there is no stale-prior-spawn case the way mcp-config.json
  (conditionally written) has.
- Do not claim this closes cross-session reads for codex — it narrows the exposed window and population,
  stated above; it does not achieve isolation under the same-OS-user, no-sandbox architecture.
- Do not assume V2's finding extends to a stdio-server crash-relaunch or `/mcp` reconnect after deletion —
  that scenario is still unverified live, for both the settings file and (per `ed0757d6`) the mcp-config
  file.
- Do not set `env[MCP_TOKEN_ENV_VAR]` for claude unconditionally (the way `createCodexPty` does for
  codex) — always gate on `mcpTokenRidesEnv()` (or the SAME resolved boolean threaded through), or POSIX
  regresses to a whole-session env exposure worse than doing nothing.
- Do not unlink `<sid>.json` in `markReady` without checking `live.sessionStartObserved` first — the
  spawn-armed readiness-fallback timer can reach `markReady` with SessionStart never having fired, and
  deleting the file there risks a CLI that hasn't parsed it yet.
- Do not infer `sessionStartObserved` from `engineSessionId` or `startupCyclesDone` — both can already be
  populated at spawn time for a resume/fork, before THIS attempt's own SessionStart has actually fired.
- Do not inline the `mcpToken && ridesEnv` conditional at the `createPty` call site again — use
  `applyMcpTokenEnv` (the named, pure, exported function). This exact inlining regressed to unconditional
  TWICE in this card's own history before being extracted; a named function makes a future revert a
  visible, reviewable diff.
- Do not assume `sessionStartObserved` alone is sufficient to decide when the settings file is safe to
  unlink — ALSO check `live.ready` in the `SessionStart` case itself (the late-SessionStart linger): if
  `markReady` already ran via the fallback, it will never run again, so SessionStart must unlink the file
  itself or it lingers for the rest of the session.
- Do not assume `createShellPty`'s "inherits the daemon's env wholesale" doc is complete — `LOOM_MCP_TOKEN`
  is the one exception, scrubbed there too.
