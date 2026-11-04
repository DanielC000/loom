# fafae623 — every Loom-built stdio MCP mount launches through an env-isolating launcher

Discovered by card `5b1c19c0` (Research Analyst, 2026-11-02): a stdio MCP mounted via claude's
`--mcp-config` inherits claude's FULL process env (measured: 125 keys, `LOOM_MCP_TOKEN`, a delivered
project credential, and claude's own `CLAUDE_CODE_MESSAGING_TOKEN`). `buildMcpServers`/
`resolveCapabilityServer` only ever ADD env keys; nothing scrubbed the inherited bulk.

**Correction to that report's own "wider finding," made during this card's investigation**: the
`LOOM_MCP_TOKEN` leg was already closed by `blanksMcpToken` (card `8d26596b`) for any mount built by the
real `buildMcpServers()` — 5b1c19c0's probes hand-rolled the mcp-config JSON, bypassing that function
entirely, so they never exercised it. Verified both by a pure-function call and a real claude spawn. The
REAL, still-open exposure this card fixes is: a delivered project credential meant for a DIFFERENT mount,
and the daemon's own ambient process env, both genuinely reaching every stdio MCP's child process.

## The fix

Every stdio mount `buildMcpServers` builds (Playwright, markitdown, every owner-added/seeded catalog
capability) is rewritten (`pty/env-isolation.ts` › `wrapStdioMountWithEnvIsolation`) to launch through
`assets/env-isolated-launch.mjs` instead of the real target directly:

```
command: process.execPath
args: [env-isolated-launch.mjs, "--allow", "<csv of this mount's OWN declared env keys + passEnv>", "--", <realCommand>, ...<realArgs>]
```

The launcher rebuilds the real target's child env from ONLY a small fixed base allowlist (read from its
own inherited env) plus the named `--allow` keys (also read from its own inherited env — those values
arrived via claude's existing, measured MERGE behavior: a mount's own declared `env` always wins over the
inherited baseEnv on a key collision). Key NAMES only ever ride argv; VALUES are never logged or placed
on any intermediate argv. Everything else — `LOOM_MCP_TOKEN`, a credential delivered for a different
mount, the daemon's ambient env — is simply never copied into the built env object.

`CLAUDE_CODE_MCP_ALLOWLIST_ENV=1` was considered and rejected as the mechanism (owner decision): applied
session-wide it would strip the launcher's OWN inherited proxy/CA/npm vars before it could forward them
to a mount that needs them, and it widens claude's own spawn behavior for no gain over a Loom-owned,
per-mount launcher.

## The structural chokepoint (Code Review round 1, reviewer `b5883c03`, item 3)

The FIRST version of this fix called `wrapStdioMountWithEnvIsolation` from inside each of the three
producers (`playwrightMcpServer`, `markitdownMcpServer`, `resolveCapabilityServer`) — a shape a FOURTH,
future stdio producer could simply forget to call. Moved into `buildMcpServers`'s own final loop
instead (the SAME loop that already applies the `8d26596b` `LOOM_MCP_TOKEN` blank, right before it): every
producer now returns the RAW, unwrapped mount; the loop wraps whichever mounts are non-http
unconditionally. The allow-list is computed from that mount's own declared `env` keys — captured BEFORE
the blank is written, with an explicit filter removing `MCP_TOKEN_ENV_VAR` as defense in depth on top of
that ordering — plus a side-channel map (`passEnvByMountKey`, populated inside the SAME catalog-resolution
loop that already looks up each row) carrying a catalog row's own `passEnv`, since `passEnv` isn't part of
the mount shape itself and can't be read back off it the way a declared secret/output-dir env key can.

## `passEnv` PATCH requires the key (Code Review round 1, item 4)

`PATCH /api/capabilities/:id` with a body that OMITS `passEnv` entirely (`{}`, a typo'd key name) is now a
400, via `requirePassEnvKey` (`capabilities/registry.ts`) — checked before `updateCapabilityDefPassEnv` is
ever called, so a malformed request can never silently clear the field to `[]`.

## `passEnv` — the human-only ambient-env escape hatch

An owner-added `command`/`python-venv` (or any catalog) capability that previously relied on an AMBIENT
daemon-host env var (exported by the owner, outside Loom's `secretEnvVar` delivery) silently stops seeing
it once isolated. `CapabilityDefRow.passEnv: string[]` (DB column `pass_env_json`, migrated additively)
is the fix: a human-only (never agent-writable, never set on a seed row) list of extra env KEY NAMES that
capability's launcher also forwards. Validated by `validatePassEnv`/`passEnvReservedReason`
(`capabilities/registry.ts`): a strict env-name-shape regex, a max-count bound, dedupe, and a
reserved-name denylist (`LOOM_MCP_TOKEN` exact, `CLAUDE_CODE_*`/`LOOM_*` prefix, case-insensitive) checked
ON TOP of the shape regex. Settable via `PATCH /api/capabilities/:id` (human-only loopback REST, no MCP
path — same trust posture as the existing create/delete routes); no Settings-UI edit flow exists yet
(there is no "edit" flow for any other capability field either) — carded separately.

## Measured Windows findings (none of these were assumed)

- **The win32 ~11-key OS-injected baseline is unconditional and unsuppressable**: `child_process.spawn`
  on win32 hands the child `HOMEDRIVE, HOMEPATH, LOGONSERVER, PATH, SYSTEMDRIVE, SYSTEMROOT, TEMP,
  USERDOMAIN, USERNAME, USERPROFILE, WINDIR` regardless of what `env` is passed — even `env:{}`. This is
  Node/Windows behavior, not a bug in the launcher or in Loom. None of those 11 are secrets. "Fail closed"
  on Windows means "the explicit allowlist ∪ this fixed ~11-key baseline," never a literal empty-unless-
  named guarantee. Not verified on POSIX (no POSIX host available during this card's work) — the base
  allowlist's POSIX entries (`XDG_CACHE_HOME`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TMPDIR`, `USER`, `LOGNAME`,
  `SSL_CERT_FILE`, `SSL_CERT_DIR`, `REQUESTS_CA_BUNDLE`, `ALL_PROXY`/`all_proxy`) are plausible-need
  additions, not measured ones.
- **A bare `child_process.spawn(cmdFile, args, {shell:false})` throws `EINVAL` for a real `.cmd`/`.bat`
  target on win32** — found by this card's own real-npx-through-the-launcher test failing before the fix
  (image-gen's `"npx"` provision self-heals to an absolute `npx.CMD` path on Windows). Node no longer
  silently shell-wraps a batch file the way `exec`/`execFile` do. `needsWindowsCmdHandling` gates this
  per-target (only `.cmd`/`.bat`, win32 only) so every other target (the overwhelming majority — absolute
  `.exe`/`.js`/binary paths) is spawned exactly as before, with no cmd.exe involvement at all.
- **A GENUINE npm `cmd-shim` (e.g. a globally-npm-installed CLI's own `.cmd`) is resolved past cmd.exe
  entirely** — `winCmdShimSpawnTarget`/`parseNpmCmdShim` (duplicated from `pty/resolve-bin.ts` into the
  asset, pinned identical by `test/win-cmd-shim-parity.mjs`) parse the shim and spawn `node <entry.js>`
  directly, no shell, no cmd.exe, so `kill()` always terminates the real process. Node's own BUNDLED
  `npx.cmd`/`npm.cmd` do NOT match this template (confirmed by reading a real one) — they fall to the
  cmd.exe path below.
- **BLOCKER (Code Review round 1, reviewer `b5883c03`): the FIRST cmd.exe-fallback attempt — caret-
  escaping every cmd metacharacter, including the two quotes wrapping each argument — was REAL command
  injection, not a quoting nuisance.** Node's `shell:true` does NO escaping of its own (joins argv with
  plain spaces, wraps the whole line in ONE unescaped quote pair) — the pre-round-1 code inherited that
  verbatim. Measured with real spawns against a probe `.cmd`: unquoted `x&echo>S`, `x|echo>S`, `x>S`
  executed as extra commands (never quoted at all, since the OLD quoting only fired for whitespace-
  containing args); `a" & echo q>F & "` broke an attempted fix's OWN quoting (an unescaped embedded quote
  toggles cmd's quote-tracking off early, exposing the live `&` that follows); `%USERNAME%` expanded
  regardless of quoting; `a^b` collapsed to `ab` when left unquoted. The caret-escaping fix attempt then
  ALSO measured broken: caret-escaping a quote character that is ALREADY inside an active cmd-quoted span
  does not suppress its quote-toggling (cmd.exe does not process caret-escapes at all once inside quotes —
  it takes `^` completely literally there) — so the embedded-quote case kept breaking out even after that
  "fix", and caret-escaping the two OUTER wrapping quotes additionally broke grouping for any
  command/argument containing a space (cmd's quoting is what neutralizes `&|<>()!^`, and caret-escaping
  those same two quotes removes that protection entirely).
- **The algorithm that survived every measured case (`escapeWindowsCmdArgument`)**: wrap the whole
  argument in ONE literal, NEVER-escaped pair of quotes; represent an embedded literal quote by DOUBLING
  it (`""` — cmd's own in-quote escape convention); double a run of backslashes immediately before the
  argument's own end (the probe target here is node itself, whose argv parsing follows the MSVCRT/UCRT
  backslash-doubling convention, so the literal closing quote this function appends is never swallowed
  by node's own argv parser); wrap the WHOLE joined
  `command + args` line in one MORE literal quote pair (`buildWindowsCmdInvocation`, mirroring Node's own
  `shell:true` wrapping — required so cmd's `/S`-mode "strip exactly the first char if a quote, and the
  last quote anywhere in the line" rule has only that one outermost pair to strip, leaving every quote
  `escapeWindowsCmdArgument` produced untouched); spawn `cmd.exe /d /s /c "<line>"` directly as a PLAIN
  target (`shell:false`) with `windowsVerbatimArguments:true` so Node never re-quotes the already-escaped
  line. `%` and a CR/LF have NO safe representation on this path and are REFUSED outright (never silently
  mangled) — doubling (`%%`) was measured to NOT prevent `%VAR%` expansion on this `/c`-line invocation
  shape; real expansion still occurred. `test/env-isolated-launch.mjs` carries the full real-spawn matrix
  (every reviewer-measured string, plus trailing-backslash/double-backslash/space-in-path/caret edge
  cases) RED-before-GREEN against each fix attempt.
- **Code Review round 2 (reviewer `7b1b9aa0`), BLOCKER: a backslash run immediately before an embedded
  quote was previously left untouched while only the quote itself got doubled** — under the probe
  target's (node's) own MSVCRT/UCRT argv-parsing convention, this SPLIT the target's argv instead of
  surviving as one argument (measured: `a\" b` arrived at the target as two separate args,
  `["a\"","b"]`, not one). **Fixed**:
  `escapeWindowsCmdArgument` now doubles any backslash run that immediately precedes a quote, THEN
  doubles the quote itself (`s.replace(/(\\*)"/g,(m,b)=>b+b+'""')`), on top of the pre-existing
  trailing-backslash-at-end-of-string rule — measured 8/8 byte-intact through a real cmd.exe spawn, 0
  sentinels, including a quote-breakout attempt built on this same shape (`x\" & echo pwned>F & \"`).
  This supersedes the prior "every attempted fix measured WORSE" framing for this specific shape — that
  framing described caret/backslash-escaping the QUOTE character itself (still correctly rejected, see
  "Do not" below); doubling the PRECEDING BACKSLASH RUN is a different fix, never attempted before round
  2, and it is the one that survived measurement. `/v:off` was also added to the cmd.exe invocation
  alongside `/d` (`["/d","/v:off","/s","/c",line]`) so a registry-configured DelayedExpansion default can
  never expand a `!VAR!`-shaped token inside an otherwise-quoted argument — including the isolated env's
  own forwarded secret values — regardless of this host's own ambient registry setting (never touched by
  this fix or its tests). Both fixes are RED-proved against the pre-round-3 branch tip (`e73ca8b0`) via
  `negative-control`, not just re-run GREEN.
- **Orphan check (Code Review round 1, item 6) — holds only for a DIRECT target, NOT for path B.**
  Force-terminating ONLY the launcher's own pid (no `/T`, no cascade — via both `taskkill /PID <pid> /F`
  and Node's own `child.kill()`/`TerminateProcess`) did not leave a DIRECT (non-`.cmd`/`.bat`) real
  stdio-MCP child orphaned in the original n=3 trials — the child died within ~1.5s every time.
  **Code Review round 2 (reviewer `7b1b9aa0`) measured the opposite for path B**: a `.cmd` target's node
  grandchild (reached through the launcher's own `cmd.exe`), spawned ignoring stdin, SURVIVED a
  force-kill of the launcher's pid (re-verified this round, n=3: the grandchild's own heartbeat counter
  kept advancing for seconds after the launcher pid was gone). Likely cause (stated as likely, not
  proven): libuv's job object on Windows carries `JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK`, which lets a
  descendant of a `cmd.exe`-spawned tree break away from the job rather than genuinely sharing one
  console with the launcher the way a DIRECT target does — this is an inference from the asymmetric
  measurement (direct dies, path-B survives), not something independently confirmed against libuv's own
  internals. Path B (and its orphan-on-launcher-kill residual) is reachable ONLY by an owner-typed
  bundled/command row that resolves to a non-cmd-shim `.cmd`/`.bat` (e.g. a bare `"npx"` ⇒ `npx.cmd`) —
  **no seed reaches it today**: github resolves to a direct `.exe` (`kind:"github-binary"`,
  `resolveGithubBinary`/`loomGithubMcpBin`, `registry.ts`'s `"github-binary"` branch), and image-gen
  resolves to `node <absolute .js>` directly (`kind:"npm-pinned"`, `resolveNpmPinned`, `registry.ts`'s
  `"npm-pinned"` branch) — neither goes through `cmd.exe`. Relies on the MCP server itself exiting on
  stdin EOF as its real termination mechanism, not on the launcher's own death cascading to it. **No
  containment fix is attempted in this card** — tracked as a disclosed residual for a future card, not
  this one.

## Proxy credentials (card `188d6a8c`)

The original `BASE_ALLOWLIST` carried `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` (any case) unconditionally —
a proxy URL may embed `user:pass@host:port` userinfo, which is a credential, and the base allowlist
forwards to EVERY stdio mount regardless of whether that mount can even use it. Investigated (see this
card's own `worker_report blocked` on 2026-11-03) rather than assumed:

- **Playwright** (`@playwright/mcp@0.0.75`) does not read `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` at all —
  its README documents its OWN `--proxy-server`/`PLAYWRIGHT_MCP_PROXY_SERVER` instead, neither of which is
  wired into Loom's spawn args. Forwarding the standard proxy vars to it had zero functional benefit.
- **markitdown** genuinely needs them: `markitdown/_markitdown.py` imports Python's `requests`, and its
  URL-fetching converters rely on `requests`' default `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` handling
  (including a credentialed proxy URL, which `requests` supports natively).
- The seeded **github** capability (`kind: "github-binary"`, a Loom-downloaded, checksum-verified Go
  binary) plausibly needs them via Go's `net/http` default `ProxyFromEnvironment` behavior — inferred from
  Go stdlib convention, not measured against the binary's own source (not vendored in this repo).
  **Correction (card `d2fece1f`):** an earlier draft of this record called `github-binary` "a kind no
  owner input can produce" — false. `validateCapabilityDefInput` refuses a DIRECT owner-authored
  `kind:"github-binary"` row, but an owner can still reach it indirectly: delete the seeded `"github"`
  row, POST a legacy npx row (`kind:"bundled"`, `command:"npx"`, the archived
  `@modelcontextprotocol/server-github` args), and the next boot's `migrateGithubCapabilityToBinary`
  (`capabilities/seed.ts`) rewrites that row's `kind` to `"github-binary"` in place. The real invariant
  this entitlement relies on is narrower and still holds: every `github-binary` row's executable is
  Loom's fixed, checksum-verified binary (or the human-only `LOOM_GITHUB_MCP_BIN` override) — the
  entitlement can never reach a different executable, regardless of how the row's `kind` got set.
- **codescape** mounts as `{type:"http"}`, never wrapped by this launcher at all — out of scope.
- A generic owner-added `node-package`/`bundled`/`command`/`npm-pinned` capability is tool-dependent; it
  already has the exact mechanism it needs (`passEnv`).

**Decision: scope, never strip.** `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`all_proxy` (every case) were
removed from `BASE_ALLOWLIST` entirely (`NO_PROXY`/`no_proxy` stay — they carry no credential). They are
forwarded, RAW (credentials included — stripping would break the one real, corporate-proxy use case this
exists to serve), only to Loom's own entitled, seeded, network-reaching mounts via the ONE named constant
`PROXY_ENV_KEYS` (`pty/host.ts`):

- **markitdown**: a fixed addition to its `--allow` list (hardcoded, since it's not a catalog row and has
  no `passEnv` field to opt into) — `passEnvByMountKey["markitdown"] = PROXY_ENV_KEYS`.
- **The seeded github-binary capability**: keyed on `def.kind === "github-binary"`, never on `slug` or
  `name` — both are owner-collidable once the seeded row is deleted. `validateCapabilityDefInput` refuses
  a direct owner-authored `kind:"github-binary"` row, but the kind CAN still be reached indirectly (see
  the correction above) — the entitlement holds anyway because every row of that kind is pinned to
  Loom's fixed, checksum-verified executable, never a different one.
- **Playwright**: nothing added (confirmed no need, above).
- **Every other owner-added catalog capability**: proxy keys ONLY via its own existing human-only
  `passEnv` — no code change; the mechanism already existed.

This is a user-visible behavior change: an owner-added capability that relied on the OLD unconditional
forwarding now needs `passEnv` set explicitly. No schemeless/malformed-proxy-value parser was added —
without stripping, there is nothing to parse; an entitled mount's raw value passes through exactly as it
did before this card, just scoped to who receives it.

**Disclosed, unmeasured residual (card `d2fece1f`):** Chromium, launched by Playwright's own MCP server
on headless Linux, may fall back to reading the standard `HTTP_PROXY`/`HTTPS_PROXY` env vars itself
(independent of whether `@playwright/mcp` forwards them) — not measured either way in this card. The
scoping change above is still the safe direction (it only ever REMOVES ambient proxy env from a mount
that previously received it unconditionally), but a Linux user on a mandatory corporate proxy could lose
Playwright's browser connectivity as a result, with no `passEnv`-shaped fix available today since
Playwright isn't a catalog row. Not reopened by this card — tracked here for whoever picks it up next.

## Registry credentials (card `3faaab0d`)

`BASE_ALLOWLIST` also carried `npm_config_registry` unconditionally — a registry URL may embed the SAME
`user:pass@host` userinfo shape a proxy URL can. Investigated (see this card's own `worker_report blocked`
on 2026-11-03) rather than assumed:

- **No seeded row needs it at runtime.** Both bundled capabilities (github, image-gen) migrated off
  `kind:"bundled"`/npx onto `kind:"github-binary"`/`kind:"npm-pinned"` (`capabilities/seed.ts`); the
  npm-pinned one-time install (`capabilities/npm-pinned.ts`'s `ensureNpmPinnedAsync`) builds its own env
  directly from `process.env` off the spawn hot path, never through this launcher.
- **No other npm_config_*/auth-ish key was forwarded either** — `npm_config_cache` (not secret-shaped)
  was the only sibling in `BASE_ALLOWLIST`; no `npm_config__auth`, no `//registry/:_authToken`-shaped
  name, no `NPM_TOKEN` anywhere in daemon src.
- Unlike the proxy keys, **there is no fixed/kind-keyed entitlement for registry** — neither markitdown
  nor the seeded github-binary capability needs it, so nothing parallels `PROXY_ENV_KEYS`.

**Decision: scope, never strip — same as the proxy fix, narrower application.** `npm_config_registry`
was removed from `BASE_ALLOWLIST` entirely (`npm_config_cache` stays — no credential). The ONLY path to
it is an owner-added catalog row's own existing `passEnv` mechanism — no new entitlement plumbing, no
seeded default. `test/registry-env-isolation.mjs` proves both polarities via real spawn (absent from an
unentitled mount, including a generic-sentinel check that the value doesn't leak under any OTHER key
name; present — under exactly that one key — in a mount whose own `passEnv` names it) plus that neither
fixed proxy-entitled mount (markitdown, github-binary) picks it up either.

## Do not

- Do not widen `BASE_ALLOWLIST` (`assets/env-isolated-launch.mjs`) to cover a secret-shaped name
  (`LOOM_MCP_TOKEN`, `CLAUDE_CODE_*`, any credential, a proxy var that may carry `user:pass@host:port`
  userinfo — `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`, any case — or a registry URL that may carry the same
  userinfo shape, `npm_config_registry`) — a server-specific secret belongs in that one mount's own
  `--allow` list, computed from its OWN declared `env` keys plus `PROXY_ENV_KEYS` for an entitled proxy
  mount, or a catalog row's own `passEnv` for registry (no fixed/kind-keyed registry entitlement exists),
  never the shared base every mount receives unconditionally.
- Do not invent a fixed/kind-keyed entitlement for `npm_config_registry` the way `PROXY_ENV_KEYS` exists
  for proxy — card `3faaab0d`'s own investigation found no seeded row needs it at runtime; a future seeded
  row that genuinely does needs a fresh decision, not a silent copy of the proxy shape.
- Do not key a mount's proxy entitlement on its `slug` or `name` — both are owner-collidable (delete the
  seeded row, recreate one with the same slug). Key it on `def.kind === "github-binary"` instead — not
  because an owner can never reach that kind (they can, indirectly, via the delete-and-recreate +
  boot-migration path above), but because every row of that kind, however it got there, is pinned to
  Loom's fixed, checksum-verified executable — or on the hardcoded mount key (`"markitdown"`) for a
  non-catalog mount.
- Do not add a strip/parse step for a proxy value reaching an entitled mount — the decision was to scope
  WHO receives the raw value, never to sanitize it; stripping userinfo would break the credentialed
  corporate-proxy case that is the entire reason the value is forwarded.
- Do not compute a mount's `--allow` list from its `env` object AFTER `blanksMcpToken` has run in
  `buildMcpServers`'s chokepoint loop — capture the declared keys BEFORE that same loop adds
  `LOOM_MCP_TOKEN: ""`; the loop's own `MCP_TOKEN_ENV_VAR` filter is defense in depth on top of that
  ordering, never a substitute for it.
- Do not move env-isolation wrapping back into a per-producer function (`playwrightMcpServer`/
  `markitdownMcpServer`/`resolveCapabilityServer`) — Code Review round 1 moved it OUT, into
  `buildMcpServers`'s ONE chokepoint loop, specifically so a FUTURE stdio producer can't forget it. A new
  producer needs to do nothing beyond returning `{type:"stdio", command, args, env?}` — if it has a
  `passEnv`-bearing catalog row counterpart, thread it through `passEnvByMountKey` the same way the
  existing catalog loop does.
- Do not caret-escape, or backslash-escape, a quote character in `escapeWindowsCmdArgument` — both
  measured as reopening the injection this function exists to close. Doubling (`""`) is the only form
  that survived measurement; see this record's own measured-findings section before reattempting either.
- Do not attempt to make `%` or a CR/LF safe on the cmd.exe fallback path — refuse them. Every `%`-
  escaping attempt (including the batch-file `%%` doubling convention) still measured as expanding on
  this `/c`-line invocation shape.
- Do not assume a `.cmd`/`.bat` target can be spawned the same way as every other target — check
  `needsWindowsCmdHandling` first, then try `winCmdShimSpawnTarget` (the shell-free npm-cmd-shim path)
  BEFORE falling back to the cmd.exe path; skipping either step reintroduces a measured failure.
- Do not let the asset's duplicated `needsWindowsCmdShim`/`parseNpmCmdShim`/`winCmdShimSpawnTarget` drift
  from `pty/resolve-bin.ts`'s own copy without `test/win-cmd-shim-parity.mjs` noticing — it pins both
  regexes' SOURCE TEXT byte-identical and both copies' behavior identical on the same input corpus.
- Do not accept a `passEnv` entry without running it through BOTH `ENV_KEY_NAME_RE` and
  `passEnvReservedReason` — the regex alone would still accept `LOOM_MCP_TOKEN` (it's a syntactically
  valid env-var name).
- Do not let `PATCH /api/capabilities/:id` accept a body that omits the `passEnv` key — `requirePassEnvKey`
  rejects it with a 400 before `updateCapabilityDefPassEnv` is ever called; a body missing the key must
  never be read as "clear it to `[]`".
- Do not let `passEnv` reach an agent-facing surface, now or later — capability_defs has no MCP path at
  all (same trust posture as `connections`/`gateCommand`); keep it that way.
- Do not re-litigate the `LOOM_MCP_TOKEN` leg of 5b1c19c0's finding as still open in a future report
  without first checking `blanksMcpToken` and this card's own real-spawn proof — it is closed, for every
  mount built by the real `buildMcpServers()`, on both platforms (it never rode claude's own env on POSIX
  in the first place — `mcpTokenRidesEnv()` is win32-only).
- Do not treat the DIRECT-target orphan finding as covering path B too — it does not. A DIRECT target
  dies with the launcher; a path-B `.cmd` target's node grandchild (reached through the launcher's own
  `cmd.exe`) measured as surviving a force-kill of the launcher's pid. Do not attempt a containment fix
  for the path-B case in THIS card — it is a disclosed residual for a future card. If you do pick that
  future card up, measure first (force-kill only the launcher's own pid, confirm whether the real child
  survives) rather than assuming a fix is or isn't required.
