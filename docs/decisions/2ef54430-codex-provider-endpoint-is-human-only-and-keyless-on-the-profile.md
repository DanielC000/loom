# 2ef54430 — a Profile's codex model-provider endpoint is human-only, and the key is a stored Connection, never on the Profile

The owner approved building this (decision `11fab3e8`). It lets a `harness:"codex"` Profile point codex at any Responses-API endpoint (a local `ollama`/`lmstudio`, or a custom https endpoint) through codex's own `model_providers` config, with no proxy and no new host process. It is a SPEND surface: it bills the key stored in the referenced Connection.

## Shape

- `Profile.codexProvider?: {id, baseUrl?, connectionId?} | null` (null = clear), pinned onto `sessions.codex_provider` at spawn so resume/recycle keep the endpoint.
- A codex built-in id (`ollama`, `lmstudio`) takes no URL and no key. A custom id needs both `baseUrl` and `connectionId`. `openai` is reserved and not selectable.
- argv: `-c model_provider="<id>"`, then for a custom id `model_providers.<id>.{name,base_url,env_key,wire_api}`. `env_key` is always the fixed Loom-owned `LOOM_CODEX_PROVIDER_KEY`; the secret rides ONLY the codex child's env (assigned after `buildSpawnEnv`, so a project `sessionEnv` can never win).
- Validation: https, or http to a loopback host only; no userinfo/query/fragment; TOML-unsafe characters rejected; the URL host must equal the Connection's host (both normalised through `endpointHostname`, port ignored), so a key can only go to the host it was stored for.

## Do not

- Do not remove `codexProvider` from `AGENT_FORBIDDEN_PROFILE_KEYS`, and do not add a write path for it to any agent MCP tool (setup, platform, manager, worker). It is human REST/UI only.
- Do not put the key, or any derived credential, on the Profile, in an argv element, or in a log line. The only thing logged on a failure is the connection id.
- Do not let an unresolvable connection fall back to codex's default provider. The spawn fails closed: falling back would send the work to a different, billed provider than the one configured.
- Do not widen the URL rule (plain http to a non-loopback host, embedded credentials) or drop the host-equality check.
- Do not make the env var name user-chosen. `LOOM_` is denylisted for stored credentials, so a fixed Loom-owned name cannot collide with one.
- Do not apply a pinned provider to a claude spawn. When the final harness is not codex it is dropped loudly: a durable `codex_provider_dropped` event plus a log line naming the connection id. The event is filed once per spawn on EVERY path that ends non-codex (role force, default-harness skip, unset/claude harness), via `recordCodexProviderDropped` at each call site that consumes `resolveAgentSpawn`'s `codexProviderDropped`; never tie it back to the role-force record alone, and never put the URL or key in it. A worker revive and an ordinary resume (which read the pinned row) file none.
- Do not claim real codex accepts these `-c` args from the argv tests alone. Only a separate, authorised real-codex smoke proves that.
- Do not drop the `-c shell_environment_policy.exclude=["LOOM_CODEX_PROVIDER_KEY"]` pin that `buildCodexProviderArgs` appends for a custom provider. The key rides codex's own env; without the pin a model-run `env`/`printenv` could print a billed key into the rollout transcript. (Codex's default excludes already match the `*KEY*` name today; the pin makes it deterministic. It replaces any user-config `exclude` list for that session, which is accepted.)
- Do not let a malformed stored `sessions.codex_provider` read back as "no pin": it reads back as an always-invalid sentinel so the spawn throws instead of falling to codex's default billed provider.
- Do not skip the spawn-time binding re-check (`codexProviderBindingError`, URL host == Connection host) in `applyCodexProvider`: the Connection can be edited or deleted after the profile was saved.

- Do not allow `%` or `^` in the base URL. codex is spawned via its Windows `.cmd` shim, where cmd.exe expands `%VAR%` inside arguments, so a `%LOOM_CODEX_PROVIDER_KEY%` path segment could send the key to the provider host. This also rejects legitimately percent-encoded paths, which is accepted (the error says so). `applyCodexProvider` re-validates shape, so a stored value that bypassed the validator is refused at spawn too.

## Product rulings (Lead-ruled, intended behaviour)

- The provider's Connection is bound by the HUMAN-only profile field and is deliberately NOT gated by afe1bc90's agent-level grant allowlist. Every agent on that profile, in a project where the Connection is in scope, spends through it; the human who chose that profile binding is the authorization.

- A worker recycle of a codex row with NO pin picks up the profile's CURRENT provider. A pin set after the original spawn applies on the next recycle.
- Once the bound Connection is deleted, any save of that profile returns 400 until the provider is fixed or cleared (fail closed). The 400 text says so.

## Named residuals (vendor behaviour Loom cannot enforce)

- Stdio MCP children that codex launches may inherit codex's own env, including the key var; whether codex's `shell_environment_policy` applies to MCP server launches is codex's behaviour, not something Loom can pin from argv.
- If the provider endpoint answers with a redirect to another host, whether codex forwards the `Authorization` header across that redirect is codex's HTTP-client behaviour. Loom only guarantees the configured URL host equals the Connection host at save time and at spawn time.
