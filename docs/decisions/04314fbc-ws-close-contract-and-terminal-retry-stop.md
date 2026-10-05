# 04314fbc — the WS close-reason contract lives in @loom/shared, and a terminal close stops every retry loop

Card `04314fbc`, discovered from `f8d2684d` (Code Review `30569f68`). Anchored at `packages/shared/src/protocol.ts`, `packages/web/src/lib/socketReconnect.ts`, `packages/web/src/components/FleetSocketProvider.tsx` and `packages/web/src/components/CompanionChat.tsx`.

Read `docs/decisions/f8d2684d-web-socket-1008-stops-reconnecting.md` first — it owns the 1008 policy itself. This record covers only what `04314fbc` changed on top of it.

## Do not

- **Do not write a WebSocket close reason as a literal at a send site, or as a pattern at a read site.** Build it with `gatewayTokenCloseReason` and read it back with `parseGatewayTokenCloseReason`, both in `@loom/shared`. A reason string is a cross-process contract; two private copies drift with nothing failing.
- **Do not call `onSocketClose` from a socket client.** Call `handleSocketClose(event, {retry, tokenDead, refused})`. `onSocketClose` returns a verdict and leaves the decision with the caller, which is exactly how the two terminal kinds got collapsed into one.
- **Do not treat an unrecognised or per-socket 1008 as a dead credential.** Only a `gateway-token` close may say the credential is dead, because only that one has a banner to re-enter it with. A `policy` close is terminal for that socket and nothing else.
- **Do not let a retry loop outlive a terminal close.** Anything a socket re-arms on failure — not just its reconnect — must stop when the close was terminal. A loop whose failure cause is "the credential is dead" will fail identically forever.
- **Do not re-arm a retry on a bare fixed-interval `setTimeout`.** Use `createRetryLoop`, which rides the shared capped ladder and can be stopped.
- **Do not stop the fleet provider's disconnected fallback poll on a terminal close.** Deliberate: its own 401 holds the gateway banner up. The distinction is rate, not principle — see below.
- **Do not `stop()` a retry loop just to clear a stale pending attempt on reconnect.** Use `disarm()` (round 2) — `onopen` re-seeds directly, and a retry armed by a pre-drop failure must not fire later onto a second, concurrent seed. `stop()` would also permanently refuse every future retry.

## What was wrong

Three findings from the review of `f8d2684d`, all in code that card had just shipped.

**(1) Unbounded seed retries survived a terminal close.** `FleetSocketProvider`'s two seed fetches re-armed on failure with `setTimeout(…, SOCKET_RECONNECT_MIN_MS)` — a flat 1s, no backoff, no bound — and the 1008 branch never cleared either timer. A revoke while a seed was in flight left both retrying a guaranteed 401 at ~1 Hz, ~120 req/min, draining the trusted proxy's ONE shared failed-auth bucket (`PROXY_FAILED_AUTH_PER_MIN`) and 429ing unrelated remote callers.

**(2) The close-reason contract existed in two unconnected copies.** The daemon held four literals; the browser its own anchored regex. A rename on either side still declined to retry (correct — the code makes it terminal), but the reason silently stopped parsing, so the verdict degraded from `gateway-token` to `policy` with nothing failing anywhere.

**(3) `CompanionChat` collapsed both 1008 kinds into "token revoked".** `if (!onSocketClose(e).retry) { setConn("revoked"); return; }` — a per-socket policy refusal (or any unrecognised 1008) rendered "token revoked" and pointed the user at a banner to re-paste a credential that was never the problem. `Terminal.tsx` already branched on `kind`; the two call sites had drifted.

## The shape that shipped

**`@loom/shared` (`protocol.ts`) now owns the close contract** — read it there for the current members. `parseGatewayTokenCloseReason` is an EXACT inverse of the builder: a loose match would claim a dead credential on a reason the contract doesn't define. All four daemon send sites build from it; `socketReconnect.ts` parses with it and re-exports the code, so a client needs one import. Web's `GatewayTokenChange` is now an alias of `GatewayTokenCloseChange`.

**`handleSocketClose(event, actions, note?)`** is the schedule-or-stop decision. All three branches (`retry`, `tokenDead`, `refused`) are REQUIRED, so a call site cannot express finding (3) by accident. Exactly one runs per close; none of the three clients calls `onSocketClose` any more.

**`createRetryLoop()`** is a stoppable retry loop on the shared capped ladder — `schedule` replaces rather than stacks, `reset()` on success, `stop()` is permanent, `stopped()` lets a late-rejecting fetch give up instead of re-arming, and `disarm()` (round 2) cancels only the pending attempt, non-permanently. The fleet provider holds one per seed: both `stop()` on a terminal close/cleanup, and both `disarm()` on `onopen` so a stale pre-drop retry can't race the fresh re-seed.

**What a terminal close does NOT stop** is the 10s disconnected fallback poll — `f8d2684d`'s existing decision stands: its own 401 keeps the banner raised, at ~12 req/min (bounded, non-compounding) versus the seed loops' ~120/min above.

**`CompanionChat`** gained a fifth `ChatConnState`, `refused` — terminal like `revoked` (so `canSend` still gates Send off) but amber, worded "refused", with no credential claim and no banner.

## Verified

Each test's own header carries its instrument, limits, and control; read there for detail.

- `web/test/socket-reconnect.mjs` — the ladder, `stop()`, and `disarm()`'s non-permanent cancel, against the real module.
- `web/test/socket-close-wiring.mjs` — the wiring; RED pre-fix on checks (1)-(7) by SYMBOL ABSENCE only, not by exercising the defects (see that file's own header).
- `daemon/test/ws-close-reason-contract.mjs` — the daemon side, real server + routes.
- `web/e2e/gateway-token-revoked.spec.ts` / `companion-chat-close-kind.spec.ts` — both terminal states, in a real browser.
