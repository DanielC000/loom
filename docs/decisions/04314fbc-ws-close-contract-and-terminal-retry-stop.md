# 04314fbc — the WS close-reason contract lives in @loom/shared, and a terminal close stops every retry loop

Card `04314fbc`, discovered from `f8d2684d` (Code Review `30569f68`). Anchored at `packages/shared/src/protocol.ts`, `packages/web/src/lib/socketReconnect.ts`, `packages/web/src/components/FleetSocketProvider.tsx` and `packages/web/src/components/CompanionChat.tsx`.

Read `docs/decisions/f8d2684d-web-socket-1008-stops-reconnecting.md` first — it owns the 1008 policy itself (what is terminal, why the reason and not the code separates the two producers, and where the banner lives). This record covers only what `04314fbc` changed on top of it.

## Do not

- **Do not write a WebSocket close reason as a literal at a send site, or as a pattern at a read site.** Build it with `gatewayTokenCloseReason` and read it back with `parseGatewayTokenCloseReason`, both in `@loom/shared`. A reason string is a cross-process contract; two private copies drift with nothing failing.
- **Do not call `onSocketClose` from a socket client.** Call `handleSocketClose(event, {retry, tokenDead, refused})`. `onSocketClose` returns a verdict and leaves the decision with the caller, which is exactly how the two terminal kinds got collapsed into one.
- **Do not treat an unrecognised or per-socket 1008 as a dead credential.** Only a `gateway-token` close may say the credential is dead, because only that one has a banner to re-enter it with. A `policy` close is terminal for that socket and nothing else.
- **Do not let a retry loop outlive a terminal close.** Anything a socket re-arms on failure — not just its reconnect — must stop when the close was terminal. A loop whose failure cause is "the credential is dead" will fail identically forever.
- **Do not re-arm a retry on a bare fixed-interval `setTimeout`.** Use `createRetryLoop`, which rides the shared capped ladder and can be stopped.
- **Do not stop the fleet provider's disconnected fallback poll on a terminal close.** That one is deliberate: its own 401 is what holds the gateway banner up. The distinction is rate, not principle — see below.

## What was wrong

Three findings from the review of `f8d2684d`, all in code that card had just shipped.

**(1) Unbounded seed retries survived a terminal close.** `FleetSocketProvider`'s two seed fetches re-armed on failure with `setTimeout(…, SOCKET_RECONNECT_MIN_MS)` — a flat 1s, no backoff, no bound — and the 1008 branch returned without clearing either timer. A revoke landing while a seed was in flight left two loops retrying a guaranteed 401 at ~1 Hz each, ~120 requests/min, for as long as the page stayed open. On the trusted-proxy listener those 401s drain ONE shared failed-auth bucket (`PROXY_FAILED_AUTH_PER_MIN`), so an unrelated remote caller starts getting 429s because somebody else's tab holds a dead token.

**(2) The close-reason contract existed in two unconnected copies.** The daemon held four literals; the browser held its own anchored regex. The failure mode is quiet: rename on either side and the browser still declines to retry (correct — the code is what makes it terminal), but the reason no longer parses, so the verdict silently degrades from `gateway-token` to `policy`. The user then sees the generic "this address needs a gateway token" instead of the revoke-specific copy, and nothing fails anywhere.

**(3) `CompanionChat` collapsed both 1008 kinds into "token revoked".** `if (!onSocketClose(e).retry) { setConn("revoked"); return; }` — so a per-socket policy refusal, or any future 1008 reason the classifier does not recognise, rendered a "token revoked" pill and pointed the user at a banner to re-paste a credential that was never the problem. `Terminal.tsx` had the same verdict available and did branch on `kind`; the two call sites had already drifted.

## The shape that shipped

**`@loom/shared` (`protocol.ts`) now owns the close contract** — read it there for the current members. `parseGatewayTokenCloseReason` is an EXACT inverse of the builder on purpose: a loose match would claim a dead credential on a reason the contract does not define. All four daemon send sites build from it; `socketReconnect.ts` parses with it and re-exports the code so a client needs one import. Web's `GatewayTokenChange` is now an alias of `GatewayTokenCloseChange`, so there is one definition of what the four are and every existing import still resolves.

**`handleSocketClose(event, actions, note?)`** is the schedule-or-stop decision. All three branches (`retry`, `tokenDead`, `refused`) are REQUIRED, so a call site cannot express finding (3) by accident. Exactly one runs per close. All three clients route through it; none calls `onSocketClose` any more.

**`createRetryLoop()`** is a stoppable retry loop on the shared capped ladder — `schedule` replaces rather than stacks, `reset()` on success, `stop()` is permanent, and `stopped()` lets a fetch that rejects AFTER the close give up instead of re-arming. The fleet provider holds one per seed and stops both in its terminal path and in its effect cleanup.

**What a terminal close does NOT stop** is the 10s disconnected fallback poll. That is `f8d2684d`'s existing decision and it stands — the poll's own 401 is what keeps the banner raised. It is not the same trade as the seed loops: the fallback is one bounded request per 10s per feed (~12/min, on a timer that cannot compound), where the seed loops together ran at ~120/min and re-armed off their own failures.

**`CompanionChat`** gained a fifth `ChatConnState`, `refused` — terminal like `revoked` (so `canSend` still gates Send off) but amber, worded "refused", with no credential claim and no banner.

## Verified

Each test's own header carries its instrument and its stated limits; this lists only what each covers and its control.

- **`web/test/socket-reconnect.mjs`** — behavioural, real module: one named branch per close shape; `createRetryLoop` walks the real ladder (a flat 1s retry reads `[1000, 1000, …]`) and a stopped loop arms nothing across 50 further `schedule()` calls. CONTROL: an un-stopped loop proven to keep re-arming, without which "nothing was armed" passes for a loop that never arms anything.
- **`web/test/socket-close-wiring.mjs`** — the half no unit test can see: `packages/web` has no React test harness, so these components cannot be rendered and their `onclose` handlers cannot be invoked. Reads the wiring off real source text, with check 0 as an instrument control that passes on pre-fix source too. RED against the genuine pre-fix clients on **7 of 7** behavioural checks, each naming its own defect rather than aborting on the first.
- **`daemon/test/ws-close-reason-contract.mjs`** — the daemon's side, real `buildServer` + real REST routes. A recording registry pins each writer's exact `(code, reason)` — the right instrument for an ARGUMENT, since `closeAll` calls `terminate()` one line after `close()` — and a real remote `injectWS` reads the shell refusal off the wire. Polarity controls: a name-only edit and an activation close nothing; a remote AGENT terminal is affirmatively proven still served.
- **Drift control, measured:** emitting `gateway-token ${change}` (one hyphen) from the shared builder turns the daemon test RED on all four wire-reason pins AND the web classifier RED on its literal-string check. Both pin the literal text as well as deriving from the builder — that is what makes a rename inside `@loom/shared` visible instead of self-consistent.
- **`web/e2e/gateway-token-revoked.spec.ts`** now records each socket's `CloseEvent` and asserts `1008` + `gateway token revoked`. Its comment already claimed this while checking only `readyState === CLOSED` — equally true of a bare `terminate()` (1006, empty reason), which would stop the retries while losing every revoke-specific behaviour. Its CONTROL asserts the recorder reports `4001`/`"control"` for a close it was actually given.
- **`web/e2e/companion-chat-close-kind.spec.ts`** — both terminal states rendered in a real browser. Against the genuine pre-fix `CompanionChat.tsx` (reverted, bundle rebuilt — the e2e serves `dist`) the refused test FAILS while its revoked CONTROL still PASSES, so it discriminates this defect rather than merely detecting change.
