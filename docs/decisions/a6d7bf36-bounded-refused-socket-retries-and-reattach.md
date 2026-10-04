# Bounding a guaranteed-401 socket ladder, and the re-attach that makes it safe

Card `a6d7bf36`, from card `04314fbc` item 5 (investigated there, deliberately not built).

## The defect

A browser on a REMOTE (proxied) origin reloads with a gateway token since revoked, paused, rotated or deleted. The WebSocket upgrade 401s, so **no socket ever opens** — so the daemon's own 1008 close contract (`gatewayTokenCloseReason`, card `f8d2684d`) never applies: there was no socket for it to close. The browser reports a bare **1006**, empty reason.

Three mechanisms then agree, each individually correct, on the wrong outcome:

- `classifySocketClose` says `retry` — 1006 is not 1008, and treating it as terminal would make every daemon restart permanent.
- `noteRemoteSocketRefusal` returns `false` — a token IS held, so a refused handshake is not evidence of a *missing* one.
- both socket clients therefore fall into their "the daemon is down or restarting" branch and keep retrying, forever, at the 10s backoff cap.

Not just noise: a rejected WS upgrade spends the trusted proxy's ONE shared `PROXY_FAILED_AUTH_PER_MIN = 30` bucket (`gateway/remote-rate-limit.ts`), keyed by nothing — so a few mounted panes 429 **unrelated remote callers**.

## Why the obvious fix was wrong

Two ways, both named by `04314fbc`'s investigation.

**1. Drive the stop off `verifyGatewayTokenAgainstDaemon` read as a boolean.** It returns `false` for a dropped request as well as a rejected token, so a page would lock itself every time the daemon merely restarted — the exact case the unbounded ladder exists to heal. The stop is driven off the THREE-state classifier (`credentialVerify.ts`, card `a1ec70a6`) instead, and only `"invalid"` stops anything.

**2. Cap the loop without adding a recovery path.** That ladder was the ONLY way a pane could come back: nothing in the app subscribed to the gateway lock except the banner that raises it (`Terminal.tsx`'s own nonce watched the LOOPBACK lock). Capping it alone converts "noisy but self-healing" into "silently dead until the user reloads" — strictly worse than the loop it removes.

## What shipped

- **`probeHeldGatewayToken`** (`web/src/lib/gatewayCredential.ts`) asks over HTTP what the close event cannot answer. Three-state. On `"invalid"` it raises the plain gateway LOCK and deliberately NOT `noteGatewayTokenRevoked`: that state names WHICH of the four happened, and a 401 to a probe does not say which. The banner's existing non-revoked copy ("the daemon refused the token this browser holds") is already accurate.
- **`createRefusalEpisode`** (`web/src/lib/socketReconnect.ts`) is the bound: one probe per run of never-opened failures, at most one in flight, reset when a socket opens. An `"unknown"` may re-ask, since nothing was learned — but only `REFUSAL_EPISODE_MAX_UNKNOWN` times, an unbounded re-ask being the same loop in a different costume on the same budget. Past the cap the episode gives up on learning and the socket keeps its pre-existing unbounded retry.
- **`useCredentialReattachNonce`** (`web/src/lib/useCredentialReattach.ts`) watches BOTH credential locks and increments on the CLEARING edge. All THREE socket clients hold it in their attach effect's deps, so an unlock rebuilds the socket in place. This also fixed Code Review `5bdc8891`'s separate finding: after a TERMINAL 1008 close the fleet socket had no path back at all, even once a valid token was pasted.
- **`GatewayTokenBanner`** no longer calls `window.location.reload()` on a successful re-entry. Clearing the lock IS the reconnect now. A deliberate widening of the card's scope, **ACCEPTED as a ruling** on review: re-attaching in place is what the DoD asks for, a reload is a remount rather than a re-attach, and leaving it in would mask whether the nonce path works at all — the page comes back either way.

## What a re-attach actually keeps — and what it does not

Round 1 of this record, and the banner comment beside the code, both claimed re-entry "keeps every pane's scrollback and the whole react-query cache". The second half is true; **the first half is false**, and it was false in the same commit that asserted it. Corrected here rather than quietly softened, because the overstatement is exactly the kind a later reader would rely on:

- **Kept:** the react-query cache (no remount, so no refetch storm) and every piece of component state OUTSIDE the effects the nonce keys — the route, scroll positions, which panels are open, an unsent composer draft.
- **NOT kept — a terminal pane's scrollback.** `reattachNonce` sits in the deps of the effect that *constructs* the XTerm (`Terminal.tsx`), so a bump runs that effect's cleanup, which calls `term.dispose()`. What repaints the pane is the daemon's bounded attach replay (`PtyHost.subscribe`), not retained scrollback. Narrowing the nonce to an inner socket-only effect would keep it, and was NOT done: the attach effect is also where `socketAuth` reads the credential, so splitting it to save scrollback is a separate change with its own risk.
- **NOT kept — the companion panel's live-only rows.** A media push and an STT transcript echo are never persisted, so a rebuild loses them; the durable transcript is re-seeded by the same effect (see below).
- **Still reloads:** the banner's own "Retry the link's token" (`retryPendingGatewayToken`) and a `?gwtoken=` capture (`captureGatewayTokenFromUrl`), both of which reload on a `"stored"` outcome. Only the banner's PASTE path re-attaches in place. Those two are not oversights — each resolves while requests are already in flight with no credential — but a reader must not generalise "the banner stopped reloading" to all three entry points.

## Round 2 (Code Review of the first pass)

- **`CompanionChat` was the third socket client and had been left out.** Its effect deps were `[sessionId]`, so a terminal 1008 left it in `conn:"revoked"` for good — the reload this card removed was what used to revive it. It now holds the nonce, which also RE-SEEDS its durable history (that seed is the same effect's own body, not a separate mount-only effect), and bounds its ladder through the shared episode. Its probe-refused stop gets its OWN `conn` state, `"token-refused"`: the `"revoked"` pill reads "token revoked", which is one of the four NAMED changes a probe's 401 cannot establish.
- **`test/socket-close-wiring.mjs` now DERIVES its client list** from every `socketAuth(` caller under `src/` instead of a hand-written array. A hand-written list cannot catch the defect above: a fourth socket client, or a client quietly removed from the array, opts itself out of checks (8)–(10) silently. Check (9) is also pinned to the deps of the effect that *constructs the WebSocket*, not to any effect in the file.
- **`createRefusalEpisode` holds a GENERATION counter.** `reset()` cannot cancel a probe already in flight, so a probe issued before a successful open used to land on the NEW episode: an `"invalid"` from the dead credential would stop a ladder that had just worked. Each `check` captures the generation it asked under and a superseded result is dropped on arrival.
- **`useVaultAsset` re-fetches on the nonce** (`VaultAsset.tsx`). A remote image whose fetch 401'd stayed in `"error"` for the life of the component: it is a react-query-free resource, so the banner's `invalidateQueries` never reached it and — with the reload gone — nothing re-ran its effect.

## Do not

- **Do not stop a retry ladder on anything but `"invalid"`.** `"unknown"` is an observation nobody made; locking a page on it is the fabricated refusal the three-state split exists to prevent.
- **Do not claim a named token-status change for a probe's 401.** Only a close REASON the daemon authored may set `noteGatewayTokenRevoked`.
- **Do not bound a socket client's ladder without also putting `useCredentialReattachNonce` in that client's attach-effect deps.** A nonce nothing depends on is inert, and a bounded ladder with an inert nonce is a permanently dead pane. `test/socket-close-wiring.mjs` (8)–(10) enforce the pairing over every `socketAuth(` caller it discovers under `src/`.
- **Do not re-narrow that discovery to a hand-written list of clients.** A new socket client, or one quietly dropped from the array, would opt itself out of the pairing check in silence — which is how `CompanionChat` was missed in round 1.
- **Do not say a re-attach keeps a pane's scrollback.** It does not: the nonce keys the effect that constructs the XTerm. See "What a re-attach actually keeps" above before writing any comment or copy about this.
- **Do not make the banner's paste path reload the page again.** It would mask whether the re-attach path works at all, since the page comes back either way. (The "Retry the link's token" and `?gwtoken=` paths DO still reload, deliberately — do not read this prohibition as covering them.)
- **Do not re-arm the probe per retry.** It rides the same shared failed-auth budget it exists to protect.
- **Do not stop the fleet provider's 10s fallback poll on this path.** Its own 401 is what holds the gateway banner up — the trade card `04314fbc` already settled.

## Measured

Verdict-defeat control (the probe returns `"unknown"` where it should return `"invalid"`, every symbol the fix adds left in place), `e2e/gateway-dead-token-bound.spec.ts` against a real daemon behind a real reverse proxy in Chromium:

| | `/ws/fleet` opens in a 14s window |
|---|---|
| verdict defeated (pre-fix behaviour) | **4** — the 1s/2s/4s/8s ladder |
| as shipped | **1** — the initial attempt, then nothing |

Chosen over a full revert deliberately: a revert reddens at "symbol missing" before the mechanism is exercised, proving only that the new code is absent. No full-revert run was performed. Two further predicate-defeat controls ran against the unit suites — treating `"unknown"` as a refusal reddens `test/socket-reconnect.mjs` on the polarity assertion, and stripping `reattachNonce` from the fleet provider's effect deps (keeping every symbol) reddens `test/socket-close-wiring.mjs` check (9) alone.
