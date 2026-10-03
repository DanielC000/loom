# f44cc187 — credential env-var deny-list widening (TLS/proxy-bypass + load-bearing-clobber class)

From Code Review `22cd69fc` of `08f2c7ce` (APPROVE, 2026-10-02). Widens `keys/credentialSessionEnv.ts`'s
`RESERVED_ENV_VAR_EXACT`/`RESERVED_ENV_VAR_PREFIXES` in two unrelated directions.

## TLS/CA/proxy-bypass names

Each one bypasses the SAME interception class `08f2c7ce` already denied via `HTTP(S)_PROXY`/
`NODE_EXTRA_CA_CERTS`, just through a different tool's own env-driven config:
`SSL_CERT_FILE`/`SSL_CERT_DIR` (OpenSSL-consuming tools), `REQUESTS_CA_BUNDLE` (Python requests),
`CURL_CA_BUNDLE` (curl), `NODE_TLS_REJECT_UNAUTHORIZED`/`NODE_USE_ENV_PROXY` (Node itself), and the
`NPM_CONFIG_`/`PIP_` prefixes — `npm_config_https_proxy`/`registry`/`cafile`/`strict_ssl` and pip's own
proxy/index-url/cert vars each directly bypass the `HTTP(S)_PROXY` deny via that tool's own config layer.

## The load-bearing-clobber class (siblings of HOME/USERPROFILE)

A session's own inherited host env (`buildSpawnEnv`, `pty/host.ts`) is exactly what `credentialEnv`
clobbers (`Object.assign(env, sessionEnv)` over a full `process.env` copy) — so each name below is
load-bearing for something that env reaches, not merely plausible-looking.

- **SHELL** — direct, grep-confirmed: `pty/host.ts:4059`'s POSIX default-shell resolver reads
  `process.env.SHELL` for a shell-kind pty spawned from this same session. A clobbered value redirects
  which binary a later shell-pty spawn from that session resolves to.
- **COMSPEC** — Node core behavior, not in-repo: `child_process.spawn(cmd, {shell:true})` on win32
  resolves the shell via `process.env.ComSpec` (case-insensitive) when no explicit shell string is given.
  Loom's own daemon code uses `shell:true` at `git/worktrees.ts:392,423` (worktree dep installs),
  `orchestration/gate-runner.ts:600` (the gate/test command), and `orchestration/restart.ts:648,700`
  (deploy build steps) — those run daemon-side, outside credential-fed env, but the SAME Node behavior
  applies to anything a worker runs inside its OWN pty with `shell:true`/a `.bat`/`.cmd` file, and that
  session's env is exactly what `credentialEnv` feeds. Same host-launch class already used to justify the
  existing `LD_`/`DYLD_` prefixes.
- **SYSTEMROOT** — lowest-confidence-but-one, OS-level rather than grep-verified in this repo: documented
  Windows requirement for core Win32 APIs (Winsock/DNS resolution, crypto providers) to function; without
  it, networking/TLS can silently break for the WHOLE process tree, including the session's own
  claude/codex API calls. Same severity class as the already-denied `PATH`/`HOME`.
- **TEMP/TMP/TMPDIR** — Node stdlib: `os.tmpdir()` reads `TEMP`/`TMP` (win32) or `TMPDIR` (POSIX); used
  broadly by node tooling/npm/pip the session may invoke. Distinct from Loom's own `LOOM_SCRATCH_DIR`
  (card `5d8888b6`), which exists specifically so Loom-owned scratch never depends on OS temp — that
  doesn't protect other tools' temp-dir use.
- **APPDATA/LOCALAPPDATA** — weakest evidence of this group: no single in-repo or Node-core consumer
  found, but the same host-root class as `HOME`/`USERPROFILE` and relied on by common Windows CLI tooling
  (npm's default global config/cache, pip's cache) the session may invoke.

## Do not

- Do not remove APPDATA/LOCALAPPDATA for having weaker evidence than their siblings — denying a name only
  blocks a credential being STORED under it; the cost of a low-confidence addition here is effectively
  zero, which is why they were kept despite the weaker evidence (owner/manager-approved tradeoff).
- Do not re-derive COMSPEC's rationale as "Loom's own code reads it directly" — it doesn't; the reliance
  is via Node's `child_process` core behavior on `shell:true`, both in Loom's own daemon-side spawns and
  in anything a session itself runs with `shell:true`/`.bat`/`.cmd`.
- Do not treat this list as exhaustive — see the module's own "HONEST LIMIT" comment immediately above
  this anchor: the denylist is a best-effort enumeration, always one unenumerated var behind.
