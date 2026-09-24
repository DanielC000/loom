# 093981dd — the "writes are locked" credential state in the web UI

## The problem this state exists for

The loopback write guard (`gateway/server.ts`) requires `Authorization: Bearer <secret>` on every non-GET `/api/*` plus the `/ws/term` and `/ws/companion` upgrades, for any caller on the **loopback interface**. `loom open` embeds that secret as `?token=` in the URL it opens **on the host**; `captureTokenFromUrl` is the only thing that puts it into localStorage.

A browser reaching the daemon through an `ssh -L` **tunnel** presents a loopback socket while having its own origin storage, so it holds no token: reads render, every write 401s, both WebSocket panes fail their upgrade. Two things made that worse than a plain permission error — the guard's 401 says "see `loom open`", which that browser cannot run because the daemon is elsewhere; and `Terminal.tsx`/`CompanionChat.tsx` had no `onerror`/`onclose`, so a rejected upgrade was a permanently blank pane.

The asymmetry: a **genuinely remote** socket skips this guard (`if (!LOOPBACK.has(ip)) return;`) and uses a gateway token instead. Only a tunnel both looks loopback *and* cannot obtain the secret.

Scope, measured here: a **reverse-proxied** origin (Tailscale Serve) is refused EARLIER by the CSRF/Host hook — `Host: x.ts.net` 403s every route including the SPA, and a browser `Origin` 403s every write even with a valid credential. This state cannot help that case, and stays silent for it (a 403 carries no pointer).

## Do not prompt for the credential unprompted, or print the secret

The banner is reachable **only** from an observed refusal. Do not render the paste field merely *because* a browser holds no token — a healthy host browser is never asked, because nothing refused it.

Easy to over-tighten: a browser can hold a **wrong or stale** credential (two daemons with different `LOOM_HOME`s on one port; a rotated secret) and must still get the field, since pasting the right one is the recovery. Do not gate it on `getLoopbackToken() === null` — the gate is the refusal, not the absence of a token. Only the *wording* varies.

Do not print or embed the secret value in the copy. The banner names the *file path* to read on the host, never the value — the reasoning `bin/loom.mjs` documents for keeping `urlWithToken` out of `console.log` (service managers capture stdout into durable, broadly-readable logs).

## Do not verify a pasted credential with a read

Clearing the lock requires a **guarded** round-trip. `invalidateQueries()` cannot serve as the check: the guard exempts GET/HEAD, so reads succeed without a credential — a wrong paste would clear the banner silently, with the UI claiming it was fixed. An earlier revision shipped exactly that comment, and that bug.

The probe is `POST /api/agents/<fresh uuid>` with an empty patch. Three layers make it inert, all checked live: an **update-by-id** route, so no create path exists even if validation loosens; a fresh v4 uuid cannot name a real agent, so the 404 is structural; and an empty patch is a verified no-op even against a real id (200, zero fields changed). 401 ⇒ rejected. **403** ⇒ the CSRF/Host hook refused us before the guard ran, so the credential is *unverified*. Neither clears the lock.

## Why the matcher is coupled to the daemon's 401 text

`isCredentialGuardFailure` keys off the literal substring `loom open` in the 401 body. That coupling is deliberate and load-bearing, because the server already draws exactly the distinction the UI needs:

- loopback guard, Bearer + WS branches → ``unauthorized — see `loom open` …`` ⇒ **a credential helps**.
- loopback guard, undeterminable peer → `unauthorized — peer address undeterminable`. Its own comment says the pointer is omitted *because* no credential rescues it.
- trust-tier wall, genuinely remote → bare `unauthorized`. That caller needs a gateway token.

So the pointer selects precisely the helpable cases, by the server's own distinction rather than by coincidence. A machine-readable discriminator on the 401 body would be sturdier; that is a **daemon** change, out of this card's web-only scope. If one lands, switch to it and delete the matcher.

## Do not widen the matcher to a bare status check

Do not reduce `isCredentialGuardFailure` to `status === 401`. That re-introduces misdirection for remote and undeterminable-peer callers, for whom this secret is the wrong credential or no help at all — the bug this card was filed to remove. `test/loopback-credential.mjs` pins all three message shapes and goes red on exactly this widening.

## Why a failed socket is a weaker signal than a failed write

A browser cannot read an upgrade's HTTP status: a guard 401 and a dead daemon both look like an abnormal close. `isCredentialSocketFailure` infers the lock from the two facts it holds — the handshake never reached `open`, and this browser has no token. Two limits, opposite directions:

- **False positive.** The guard is optional-dep-gated, so a daemon running **without** it needs no token and a genuine connection failure there also has `token === null`. Hence the conditional copy ("if you reached this daemon through a tunnel").
- **False negative.** A browser holding a **wrong/stale** token fails the upgrade for a real credential reason, but `token === null` is false, so no banner appears — just "could not connect to this session". Deliberate: guessing "credential" on every failed attach would show the field to everyone whose daemon merely stopped. Recovery: any *write* from that browser 401s and arms the banner properly.

## Do not let an inferred lock overwrite an observed one

`noteCredentialLock` refuses a `write` → `socket` downgrade on purpose: the refused write is observed, the refused socket inferred (see the limits above). Once the strong signal exists, its wording stays.
