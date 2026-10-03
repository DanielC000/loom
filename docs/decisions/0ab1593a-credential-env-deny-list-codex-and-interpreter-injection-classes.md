# 0ab1593a — credential env-var deny-list widening: codex harness, package managers, interpreter/shell injection, config roots

From Code Review `b8dabffc` of `f44cc187` (2026-10-03), traced at source and approved by the owner
2026-10-03. Widens `keys/credentialSessionEnv.ts`'s `RESERVED_ENV_VAR_EXACT`/`RESERVED_ENV_VAR_PREFIXES`
across five unrelated classes, then (round 2, Code Review `98ff4f22`) adds a small exact-name allow list
carved out of two of those prefix denies. Each specific claim below is labeled by its evidence kind, not
asserted uniformly: **(measured)** a reproduced effect on the investigating host; **(documented)** a claim
sourced from the tool's own docs/source without local reproduction; **(string-present)** a name confirmed
present as a literal string in a scanned binary, without confirming the described behavior. See the
worker's `worker_report` history on this card for the full per-name evidence trail; this record carries
only the conclusion and the "do not" list.

## The classes

- **Codex harness (`CODEX_`/`OPENAI_` prefixes).** Credentials ARE delivered to codex spawns
  (`pty/host.ts`'s `buildSpawnEnv({...credentialEnv, ...})`, same merge claude spawns use — documented,
  confirmed by reading that call site). `CODEX_HOME` (documented, `pty/codex-doctrine.ts`'s own doc
  comment): a credential stored under this name moves only the CHILD codex process's own auth/config
  root — it does not move the DAEMON's own `realCodexHome()`, so the effect is a desync between the two,
  not that function's root relocating. `CODEX_API_KEY`/`CODEX_ACCESS_TOKEN`/`CODEX_CONNECTORS_TOKEN`
  (string-present: confirmed as literal strings in the real installed `codex.exe` v0.153.4; the "bypasses
  auth directly" framing is not independently measured against a real auth flow) and
  `CODEX_SANDBOX`/`CODEX_SANDBOX_NETWORK_DISABLED` (string-present, same binary) override the sandbox/
  approval policy. `OPENAI_API_KEY` (documented: OpenAI's own SDK/CLI auth convention; also string-present
  in the same binary) is a direct auth bypass; `OPENAI_BASE_URL` (documented) redirects all API traffic.
- **Package managers (`YARN_`/`UV_`/`BUN_CONFIG_` prefixes).** Same class as the already-denied
  `NPM_CONFIG_`/`PIP_`: registry redirection and auth-token injection. `YARN_NPM_REGISTRY_SERVER` and
  `BUN_CONFIG_REGISTRY` are each **(measured)** — reproduced, redirecting that tool's real registry
  resolution to an attacker host. `uv`'s `UV_INDEX_URL`/`UV_INSECURE_HOST` are **(documented only)** —
  `uv --help` documents both directly; neither was reproduced on this host. `BUN_CONFIG_` is a prefix (not
  just the originally-proposed exact `BUN_CONFIG_REGISTRY`) because the same binary also reads
  `BUN_CONFIG_NO_VERIFY` **(string-present)**. `BUN_CONFIG_TOKEN` (registry auth) is the one name in this
  prefix now carved OUT of the deny by the round-2 allow list below — see "Round 2" and "Do not".
- **TLS/shell/interpreter injection (exact names + `OPENSSL_` prefix).** `SSLKEYLOGFILE` **(measured)** —
  reproduced: caused Python's `ssl` module to write real decryptable TLS session secrets to a file mid a
  real handshake. `OPENSSL_CONF` **(measured)** — confirmed READ by the locally-installed OpenSSL (a
  malformed file produced a config-parse error naming that path); `OPENSSL_MODULES` **(documented)** — the
  engine/provider-load code-exec escalation is documented OpenSSL behavior, not independently reproduced.
  `BASH_ENV` **(measured)** — reproduced: a plain non-interactive `bash script.sh` auto-sourced the named
  file first. `ENV` **(measured, negative result)** — measured NOT to fire for this host's standalone
  POSIX `sh` in a non-interactive script; added anyway at the same "cost of a low-confidence addition is
  effectively zero" tradeoff already used for APPDATA/LOCALAPPDATA (`docs/decisions/f44cc187-*.md`).
  `ZDOTDIR` **(documented)** — documented zsh behavior (macOS's default login shell since Catalina); not
  reproducible on this Windows host. `JAVA_TOOL_OPTIONS`/`_JAVA_OPTIONS`/`JDK_JAVA_OPTIONS`
  **(documented)** — documented JVM startup-options injection (same class as the already-denied
  `NODE_OPTIONS`); no JVM on this host to reproduce against. `PERL5OPT`/`PERL5LIB` **(measured)** —
  reproduced the FULL chain: `PERL5OPT=-MAutoProbe` with `PERL5LIB` pointed at a directory ran that
  module's code before the main script. `RUBYOPT`/`RUBYLIB` **(documented)** — documented analogue of the
  just-reproduced Perl chain; no ruby on this host.
- **Config root (`XDG_CONFIG_HOME`).** **(documented)** — confirmed against the real installed Git for
  Windows docs: git reads `$XDG_CONFIG_HOME/git/config` as a global config file; `core.sshCommand` and
  `core.fsmonitor` (both settable there) run arbitrary commands. Not reproduced as a live exploit.
- **Windows (`PATHEXT`/`WINDIR`).** `PATHEXT` **(documented via a direct in-repo consumer)** —
  `pty/resolve-bin.ts` reads `process.env.PATHEXT` to pick/order extensions when resolving the absolute
  claude/codex binary path for node-pty, confirmed by reading that source; its live EFFECT on resolution
  was not separately measured. `WINDIR` **(documented, low confidence)** — no direct Loom/Node-core
  consumer found by repo-wide grep; added anyway as a legacy duplicate of the already-denied
  `SYSTEMROOT`, same zero-cost tradeoff as `ENV` above.
- **Two CA-bundle names surfaced by the codex binary scan but not previously denied:** `CARGO_HTTP_CAINFO`,
  `BUNDLE_SSL_CA_CERT` (Ruby Bundler) — **(string-present)**, added by documented analogy to the
  already-denied `SSL_CERT_FILE`/`REQUESTS_CA_BUNDLE`/`CURL_CA_BUNDLE` class, not independently reproduced.
  (`GIT_SSL_CAINFO` and `PIP_CERT`, also surfaced by the same scan, needed no new entry — already covered
  by the existing `GIT_`/`PIP_` prefixes.)

## Round 2 — exact-name allow list (Code Review `98ff4f22`)

`RESERVED_ENV_VAR_ALLOW_EXACT` (`keys/credentialSessionEnv.ts`) carves five exact names back out of the
prefix denies above, checked after the exact-deny set and before the prefix-deny list — mirroring why
`NODE_AUTH_TOKEN` already stays an accepted exact name rather than being folded into a `NODE_` prefix: a
stored auth TOKEN is the secret a human typed on purpose, not a hijack vector, and the redirect/config
names in the same family stay denied regardless: `YARN_NPM_AUTH_TOKEN`, `UV_PUBLISH_TOKEN`,
`UV_PUBLISH_PASSWORD`, `BUN_CONFIG_TOKEN`, `CODEX_GITHUB_PERSONAL_ACCESS_TOKEN`. The allow list is
exact-name only — never a pattern: `UV_INDEX_<NAME>_PASSWORD` (a per-index credential name uv itself
documents) stays denied under the `UV_` prefix, because it is a per-index auth override, not the one known
publish-token name. An exact deny always wins over the allow list by construction (checked first in
`isValidCredentialEnvVarName`); no current name happens to overlap both sets.

## Do not

- Do not fold the existing exact `NODE_*` names (or the new `NODE_REPL_EXTERNAL_MODULE`) into a `NODE_`
  prefix — owner ruling: `NODE_AUTH_TOKEN` is a legitimate, widely-used credential name (setup-node /
  `.npmrc`'s `${NODE_AUTH_TOKEN}`) that a prefix would silently block. Add new `NODE_*` vectors
  individually, as exact names, the way `NODE_REPL_EXTERNAL_MODULE` was added by this card.
- Do not deny `AWS_*`/`AZURE_*`/`GOOGLE_APPLICATION_CREDENTIALS` — owner ruling: these are legitimate
  credentials users store on purpose, not hijack vectors, even though the same codex binary scan that
  found this card's additions also reads them (codex's own cloud-identity-federation probe).
- `CODEX_GITHUB_PERSONAL_ACCESS_TOKEN` is on the round-2 exact-name ALLOW list above, not denied — do not
  re-deny it by folding it back under the `CODEX_` prefix, and do not widen the allow list itself into a
  pattern (see "Round 2" above for why it must stay exact-name-only).
- Do not treat `OPENAI_` as cost-free the way most of this list is: it blocks a user's legitimate
  `OPENAI_API_KEY` for their OWN app, the same tradeoff `ANTHROPIC_` already made (owner ruling) — the
  CHANGELOG entry must say so, with the re-ask-under-a-project-specific-name remedy (e.g.
  `MYAPP_OPENAI_KEY`), not just restate the generic widening boilerplate.
- Do not treat this list as exhaustive — see the module's own "HONEST LIMIT" comment: the denylist is a
  best-effort enumeration, always one unenumerated var behind.
