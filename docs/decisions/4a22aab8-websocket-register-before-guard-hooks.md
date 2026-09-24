# 4a22aab8 — `@fastify/websocket` is registered BEFORE every guard `onRequest` hook

## Do not

- Do not register an `onRequest` hook that can reply (401/403/429) above the `app.register(websocket, ...)` call in `gateway/server.ts`'s `buildServer`. A rejected WebSocket upgrade then strands its raw socket and `app.close()` never settles.

## Narrative

`@fastify/websocket@11.2.0` flags an upgrade in its own `onRequest` hook (`request.ws = true`, `index.js` ~138) and destroys the upgraded raw socket in its `onResponse` hook only when that flag is set (~147). Fastify stops the `onRequest` chain the moment a hook replies, so a guard registered earlier than the plugin (CSRF/Host, trust-tier wall, loopback-secret guard) that answers a `/ws/*` upgrade with 401/403/429 means the plugin's flagging hook never runs. `onResponse` then skips the destroy and the server-side socket stays open (destroyed:false, readable:false after the client's FIN), so `server.close()` waits on it forever.

Reproduced with plain Fastify + the plugin, no Loom code: plugin registered first then a 401 hook closes fine; a 401 hook registered first then the plugin hangs. Loom hit it because the guards were registered above the plugin. Moving the register above them changes nothing else: the guards are still root-scoped hooks registered after it, and the 401/403/429 a client sees is unchanged.

Regression: `packages/daemon/test/ws-rejected-upgrade-close.mjs`.
