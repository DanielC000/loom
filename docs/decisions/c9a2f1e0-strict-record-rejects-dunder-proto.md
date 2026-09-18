# c9a2f1e0 — `sessionEnv`'s schema rejects a raw `__proto__` key instead of silently dropping it

## Narrative

zod 4.4.3's `z.record` builds its parsed output object by plain assignment, so a raw `__proto__` key never becomes an own property of the result — it is silently dropped, not rejected. The validator reports success and the key simply isn't there. Confirmed against the installed `zod@4.4.3` (`packages/daemon/node_modules/zod/package.json`) with a positive control: 10 other prototype-family names (`constructor`, `prototype`, `hasOwnProperty`, `toString`, `valueOf`, `isPrototypeOf`, `propertyIsEnumerable`, `__defineGetter__`, `_proto_`, `PATH`) all survive as ordinary own keys through the same schema — `__proto__` is the only one dropped, so the instrument is proven capable of the other answer.

`sessionEnv`'s schema (`projectConfigOverrideSchema.sessionEnv`, `mcp/platform.ts`) is `z.record(z.string(), z.string())`, driven by the human REST `PATCH /api/projects/:id/config` and the platform `project_configure` tool (both go through `validateProjectConfigOverride`). Driven end-to-end through the real `validateProjectConfigOverride` → `mergeConfigOverride` → `unsetConfigPath` trio (card `e4e854cc`), a payload that writes `sessionEnv.__proto__` while unsetting a real key produces HTTP 200 with the old secret gone and the attempted new value never landed — silent data loss on a secrets-adjacent surface.

`__proto__` reaches validation as a genuine own property in the first place: `JSON.parse` builds objects via `CreateDataProperty`, not `[[Set]]`, so `JSON.parse('{"__proto__":"x"}')` produces an object where `Object.hasOwn(obj, "__proto__")` is `true` and the prototype chain is untouched. The loss happens entirely inside `z.record`'s own construction step, not at JSON parse time.

## Fix

`strictRecord(valueSchema)` (`mcp/platform.ts`) wraps `z.record` in a `z.preprocess` that checks the RAW input for an own `__proto__` key (`Object.hasOwn`, which reads the property descriptor directly and is unaffected by the accessor) and fails validation with a clear error instead of silently continuing. `sessionEnv` now uses `strictRecord(z.string())` in place of the bare `z.record`.

Rejection (not "build the record safely" with `Object.create(null)` + `defineProperty`) was chosen after checking `sessionEnv`'s actual consumer: `buildSpawnEnv` (`pty/host.ts`) merges it via `Object.assign(env, sessionEnv)`. `Object.assign` uses `[[Set]]` per spec, which — for a key named `__proto__` — invokes the inherited accessor on `Object.prototype` rather than creating an own property; setting a string value through that accessor is a spec-defined no-op. So even a record that genuinely carried `__proto__` as an own key post-validation would silently vanish the moment it reached the one place it's actually used (setting a process env var). A loudly-rejected key at the boundary beats one that "saves successfully" and then silently never functions three layers downstream.

Swept the rest of `packages/daemon/src` for other `z.record` uses (card `e4e854cc` DoD-1): only `mcp/server.ts`'s `authenticated_request` tool (`headers`/`body` on an outbound HTTP call) uses `z.record` elsewhere. Left unfixed — those fields are ephemeral per-call request data, never persisted, and no real HTTP API expects a header or JSON body key literally named `__proto__`; there is no stored secret to lose. `sessionEnv` is the only affected config/credential/agent-reachable persistence path.

## Do not

- Do not revert to plain `z.record` for `sessionEnv` (or any future record-shaped config/credential field an untrusted caller populates by key name) — it silently drops `__proto__` instead of erroring.
- Do not "fix" this by building the record with `Object.create(null)` so `__proto__` round-trips as an ordinary own key — check the field's real consumer first; for `sessionEnv` specifically, `Object.assign` in `buildSpawnEnv` would still silently no-op it, making a storable-but-nonfunctional key worse than a loud rejection.
- Do not assume this generalizes to every `z.record` in the codebase without checking each one's actual consumer — `authenticated_request`'s `headers`/`body` are deliberately left as plain `z.record` because they are ephemeral, not persisted, and carry no realistic `__proto__` use case.

## Source

Card `e4e854cc`, spun out by a code-reviewer session (`74a109ab`) reviewing `32b23f0f`'s fix commit `6023aa26`, 2026-09-18.
