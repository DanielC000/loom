# sha:1fab1dcb — the in-app transport hub persists across a Telegram-token-triggered gateway rebuild

## Narrative

The in-app channel's transport hub (`InAppChannel`, `companion/in-app.ts`) is constructed ONCE (`index.ts`) and threaded into both the gateway factory and `buildServer`, rather than being rebuilt alongside the `ChatGateway`. A Telegram token change rebuilds the `ChatGateway` (`factory.ts`) — the hub's `.adapter` is re-registered on each newly-built gateway, but the underlying hub instance, its connected-client registry, and its outbound-sink role all persist unchanged, so a token change never drops a live in-app web client.

Inbound messages from an attached web client do not flow through an adapter-constructor-installed handler the way a long-poll channel would (there is no long-poll for in-app). Instead they enter through the controller's own stable `handleInAppInbound` function — symmetric with the outbound `deliverReply` path — which resolves and targets whichever `ChatGateway` is CURRENTLY live rather than a reference captured at construction time.

## Do not

- Do not have `InAppChannel`'s inbound path call directly into a captured `ChatGateway` reference — always go through `controller.ts`'s `handleInAppInbound` indirection, or a Telegram-token-triggered gateway rebuild will silently strand inbound in-app messages against a stale, torn-down gateway.

## Source

Inline comment in `packages/daemon/src/companion/in-app.ts` (file header, the "hub (InAppChannel) is STABLE across gateway rebuilds" paragraph), lines 22-28 as of main `8a99dba9`. No board card cites this decision anywhere in the file or in its introducing commit (`1fab1dcb`, `feat(gateway): in-app companion channel adapter — default channel, no token/pairing (loopback-authenticated)`) — keyed by commit sha per docs/extraction-program.md's `sha:` grammar. Extracted by card `e04aa826` (tranche on `companion/in-app.ts`).
