# f8d2684d — a 1008 socket close stops the web reconnect loop and names the revoked token

Card `f8d2684d`, discovered from `3c205fb5` (commit `60bb2568`). Anchored at `packages/web/src/lib/socketReconnect.ts`.

## Do not

- **Do not retry a close code 1008.** Nothing about the next attempt differs, so a retry loop is a guaranteed-failing loop that renders as a flaky network.
- **Do not attribute a 1008 to a revoked credential without matching the close REASON.** Two unrelated producers send 1008 (see below); claiming "your token was revoked" on the other one is a false alarm about the user's credential.
- **Do not add a fourth copy of the backoff ladder or the close policy.** A new socket client imports `lib/socketReconnect`; that file is the only place either lives.
- **Do not mint a second banner for the revoked state.** `GatewayTokenBanner`'s paste field already is the "sign in again" action; a parallel surface would split re-entry across two places.
- **Do not classify the close AFTER an `everOpened`-style credential inference.** A 1008 arrives on a socket that opened and streamed normally, so those branches read it as an ordinary mid-session disconnect and retry it.

## What was wrong

Card `3c205fb5` closed a gateway token's open sockets with code 1008 the moment that token was revoked, paused, rotated or deleted. All three web WebSocket clients — `Terminal.tsx`, `CompanionChat.tsx`, `FleetSocketProvider.tsx` — passed no argument to their `onclose` handler at all, so the close code was not merely ignored, it was unreachable. Each then scheduled its own capped-backoff retry (three independent copies of the same 1s→10s ladder). The user whose token had just been pulled saw `[connection lost — reconnecting]` forever and had no way to learn the real cause.

## The shape that shipped

`packages/web/src/lib/socketReconnect.ts` owns two things for every socket in the app:

- `onSocketClose(event)` returns a verdict: `{retry:true}` for any code other than 1008, and a terminal `{retry:false, …}` for 1008. It is called FIRST in each client's `onclose`, ahead of that client's own credential/`everOpened` inference.
- `createReconnectBackoff()` is the single ladder (`SOCKET_RECONNECT_MIN_MS` 1s → `SOCKET_RECONNECT_MAX_MS` 10s). Each socket holds its own position in it without owning the constants.

The 1008 verdict is split by the daemon's own close reason, because two unrelated producers use that code:

| Reason (`gateway/server.ts`) | Verdict kind | Surface |
|---|---|---|
| `gateway token revoked\|paused\|rotated\|deleted` | `gateway-token` | app-wide gateway lock + banner, headline naming the change |
| `host shell terminals are loopback-only` (card `710a34fa`) | `policy` | the refused pane only; no banner, credential is fine |
| anything else | `policy` | as above (fail toward "no false credential alarm") |

A `gateway-token` verdict calls `noteGatewayTokenRevoked(change)` in `lib/gatewayCredential.ts` — new state next to the existing gateway lock, which it also raises so the existing banner mounts. `clearGatewayLock()` clears it, so a successful paste resets everything with no caller having to remember.

Per client, only the reconnect loop changed: the terminal paints a red strip pointing at the banner, the companion chat moves to a terminal `revoked` conn state (which its existing `canSend` gate already turns Send off for), and the fleet provider stops reconnecting but KEEPS its disconnected fallback poll — that poll's own 401 is what holds the banner up.

## Verified

`close(1008, reason)` immediately followed by `terminate()` (which is what `GatewayTokenSocketRegistry.closeAll` does) still delivers code 1008 and the reason to the peer; `ws` flushes the close frame synchronously inside `close()`. A `terminate()` alone yields 1006. The premise that clients can see 1008 at all was measured, not assumed, and is re-proved end to end in a real browser by `packages/web/e2e/gateway-token-revoked.spec.ts`.
