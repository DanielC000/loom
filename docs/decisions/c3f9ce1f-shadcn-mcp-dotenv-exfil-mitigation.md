# c3f9ce1f — shadcn MCP's own `.env*` dotenv loading is closed with a `node --import` redirect, not a refusal

## The finding

Card `5b1c19c0` (Research Analyst, 2026-11-02) measured that `shadcn mcp` receives claude's whole
inherited process env on a stdio mount, and that shadcn's own registry client expands `${VAR}` from its
process env into registry URLs/headers named by a repo-controlled `components.json`. Card `fafae623`
closed the INHERITANCE leg (every Loom-built stdio mount now launches through `env-isolated-launch.mjs`,
which rebuilds the child env from a fixed base allowlist plus a per-mount `--allow` list; the shadcn row's
own list is empty).

That left one thing unmeasured: whether `shadcn mcp` *also* reads `.env*` files directly off its own disk
— a vector no env-allowlist can bound, since it is the child reading its own filesystem, not inheriting
anything. Measured here (card `c3f9ce1f`, static read of the installed `shadcn@4.23.0`/`@shadcn/registry@0.2.1`
bundle plus an empirical loopback probe): **yes**. The `mcp` command's own action handler
(`shadcn/dist/index.js`) calls `await loadEnvFiles(e.cwd)` (cwd defaulting to `process.cwd()`) BEFORE
`serveStdio(...)` starts the MCP server. `loadEnvFiles` (`@shadcn/registry/internal/env-loader`) dynamically
imports `@dotenvx/dotenvx` and, for each of `.env.local`/`.env.development.local`/`.env.development`/`.env`
found in that directory, calls `config({ path, overload: false, quiet: true, processEnv: process.env })` —
mutating the REAL `process.env` object directly, not a copy. Every registered MCP tool wraps its call in
`withRegistryContext(fn, { onGitHubAuthNotice })` with no `env` key, so `getRegistryEnvFromContext`'s
`${VAR}` lookup falls through to `process.env[t]` — the exact object `loadEnvFiles` just mutated.

Empirically: a scratch fixture dir (never a repo) holding a `components.json` with registry
`@probe → http://127.0.0.1:<port>/r/{name}.json` and header `X-Probe: ${PROBE_DOTENV_TOKEN}`, plus a
`.env` file setting `PROBE_DOTENV_TOKEN=<sentinel>` (never present in any process env), spawned through
the REAL `env-isolated-launch.mjs` with the shadcn row's real empty allow-list: one `view_items_in_registries`
call sent the sentinel to the local listener's `X-Probe` header. `.env.local` reproduced identically. A
negative control (no `.env*` file at all) returned zero hits and shadcn's own `MISSING_ENV_VARS` error.

## The mitigation: REDIRECT, not refuse

A `node --import` preload (`packages/daemon/assets/shadcn-no-dotenv-preload.mjs`), self-registering via
`register(import.meta.url, import.meta.url)`, intercepts resolution of `@dotenvx/dotenvx` (and any
subpath) and REDIRECTS it — via the module customization hook's `{ url, shortCircuit: true }` return
shape — to a Loom-owned no-op stub (`shadcn-no-dotenv-stub.mjs`) whose `config()` matches the real
library's destructured named export and return shape (`{ parsed: {} }`) but loads nothing and mutates
nothing. `registry.ts`'s `resolveCapabilityServer` (the `"npm-pinned"` branch) prepends
`["--import", pathToFileURL(SHADCN_NO_DOTENV_PRELOAD_SCRIPT).href]` to the shadcn row's own resolved args
when `provision.package === "shadcn"`. The launcher needs no change — it already forwards whatever argv
a mount hands it.

**An earlier, simpler design — REFUSE the import (throw from the `resolve` hook) — was tried first and
rejected.** It also fully blocks the `.env*` load (confirmed: `loadEnvFiles`'s own `try/catch` swallows
the rejection and returns `process.env` untouched, never throwing out of the `mcp` action). But shadcn's
own catch block logs the failure via `a.warn(...)`, whose implementation
(`@shadcn/registry/internal`'s logger chunk) is `warn(...o){ console.log(a.warn(o.join(" "))); }` —
**`console.log`, not `console.error`** — so a refusal puts one stray non-JSON line on the MCP server's
own stdout, before `serveStdio` ever starts, before any JSON-RPC traffic. Measured against the REAL
reference `@modelcontextprotocol/sdk` (v1.32.2) client: its `StdioClientTransport.processReadBuffer()`
wraps each `readMessage()` call in its own `try/catch` *inside* the read loop, so a parse failure on that
one line fires `onerror` once and the loop keeps going — `tools/list` and a real tool call both still
succeeded in that configuration. So the refusal shape was not actually broken. It was still rejected,
because the redirect is strictly better and costs nothing: with the stub in place, `loadEnvFiles` runs
its ordinary code path against a `config()` that loads nothing and logs nothing, so stdout is
byte-identical to the no-mitigation-at-all case (measured: same byte length, zero non-JSON lines) for
every client, not just one already proven tolerant of a malformed line.

## Do not

- Do not revert to the refusal shape (throwing from the preload's `resolve` hook) without re-deriving why
  it was rejected here — it is not "broken," it is strictly worse (a stray stdout line every reader must
  independently tolerate, for no behavioral gain over the redirect).
- Do not key the `--import` injection on `row.slug` or `row.name` — both are owner-collidable (delete the
  seeded row, recreate one with the same slug/name), per decision `fafae623`'s identical rule for the
  proxy-entitlement case. Key it on `provision.package === "shadcn"` (checked in `registry.ts`'s
  `"npm-pinned"` branch) — safe because `"npm-pinned"` is itself a SEED-ONLY `CapabilityProvisionKind`
  (never accepted from an owner by `validateCapabilityDefInput`) and no PATCH route touches
  `provisionJson` at all (the only capabilities PATCH route, `gateway/server.ts`, edits `passEnv` only) —
  so `provision.package` can never be owner-forged for this row.
- Do not widen this to every `"npm-pinned"` row — `image-gen` (the only sibling) must stay byte-identical
  (no `--import`, no change to its mount shape); the `provision.package === "shadcn"` check is what keeps
  it that way.
- Do not assume the stub's `config()` return value is unused forever — the ONE call site inside
  `loadEnvFiles` today ignores it (`existsSync(n) && e({...})` — a void-context call), but the stub still
  returns `{ parsed: {} }` to match the real library's actual shape on a load-nothing call, in case a
  future shadcn version reads the return value somewhere this mitigation doesn't re-verify.
- Do not treat the reference-SDK-level proof (onerror fires, connection survives) as a substitute for
  choosing the redirect — it was supporting evidence for why the refusal shape *would also have worked*,
  not a reason to prefer it. The redirect remains the shipped mechanism.
- Do not assume this mitigation is version-proof. It depends on shadcn's bundle still dynamically
  importing the literal specifier `@dotenvx/dotenvx` from its `loadEnvFiles` function. A future shadcn
  release could change the package, inline the logic, or read `.env*` some other way entirely — nothing
  here would catch that automatically. **Bumping `SHADCN_VERSION` (`capabilities/seed.ts`) requires
  re-running `test/shadcn-dotenv-exfil-real-spawn.mjs` by hand first** (opt-in only,
  `LOOM_NETWORK_SMOKE=1` — the same gate `npm-pinned-real-spawn.mjs` already established for exactly this
  shape of test; deliberately excluded from `guards`/the ordinary gate per lesson 296's `*-real-spawn.mjs`
  convention, since it installs the real npm package over the network) — a green run there is what
  actually re-verifies the mechanism against the NEW version's real bundle; the hermetic
  tests (`test/shadcn-no-dotenv-preload.mjs`, `test/shadcn-capability.mjs`) only prove the WIRING and the
  preload/stub mechanism in isolation, never shadcn's own current import shape.
