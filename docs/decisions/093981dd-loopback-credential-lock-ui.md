# 093981dd — the "writes are locked" credential state in the web UI

Anchors: `packages/web/src/lib/loopbackCredential.ts`, `packages/web/src/components/CredentialBanner.tsx`.

## The problem this state exists for

The daemon's loopback write guard (`gateway/server.ts`) requires `Authorization: Bearer <secret>` on every non-GET `/api/*`, plus the `/ws/term` and `/ws/companion` upgrades, for any caller arriving on the **loopback interface**. `loom open` (`bin/loom.mjs`, `urlWithToken`) embeds that secret as `?token=` in the URL it opens **on the host**, and `captureTokenFromUrl` is the only thing that ever puts it into localStorage.

A browser that reached the daemon through a **tunnel** — `ssh -L`, or any host-local reverse proxy, which is the path `site/remote-access.html` recommends — presents a loopback socket to the daemon while having its own separate origin storage. So it holds no token. The result, traced at source on this card: reads render fine, every write 401s, and both WebSocket panes fail their upgrade. Two things made that worse than a plain permission error:

- The guard's own 401 text says "see `loom open`" — but that browser **cannot** run `loom open`, because the daemon isn't on that machine. The one piece of guidance the user got pointed at the one thing that could not help.
- `Terminal.tsx` and `CompanionChat.tsx` had no `onerror`/`onclose` handler at all, so a rejected upgrade rendered as a permanently blank pane with no message anywhere.

Note the asymmetry that makes tunnelling the uniquely trapped case: a **genuinely remote** socket skips the loopback guard entirely (`if (!LOOPBACK.has(ip)) return;`) and is authorized by a gateway token instead. Only a tunnel both looks loopback *and* has no way to obtain the loopback secret.

## Do not prompt for the credential unprompted, or print the secret

The banner is reachable **only** from an observed refusal — a guard 401, or a rejected upgrade on a browser holding no token at all. Do not render the paste field on a browser that already holds a token: a healthy host browser captured one from `loom open`'s URL and must never be asked for it.

Do not print or embed the secret value anywhere in the instruction copy. The banner names the *file path* to read it from on the host, never the value — the same reasoning `bin/loom.mjs` documents for keeping `urlWithToken` out of `console.log` (a service manager captures a foregrounded service's stdout into a durable, broadly-readable log).

## Why the matcher is coupled to the daemon's 401 text

`isCredentialGuardFailure` keys off the literal substring `loom open` in the 401 body. That coupling is deliberate and load-bearing, because the server already draws exactly the distinction the UI needs:

| 401 source | message | does a credential help? |
| --- | --- | --- |
| loopback guard (Bearer branch and WS branch) | ``unauthorized — see `loom open` for how to obtain the local access credential`` | **yes** |
| loopback guard, undeterminable peer address | `unauthorized — peer address undeterminable` | no — and its own comment says the `loom open` pointer is omitted *because* no credential rescues it |
| trust-tier wall (a genuinely remote socket) | bare `unauthorized` | no — that caller skips this guard and needs a gateway token |

So matching the `loom open` pointer selects precisely the cases where pasting a credential fixes the problem, by the server's own deliberate distinction rather than by coincidence.

A machine-readable discriminator on the 401 body would be sturdier than a substring match. That is a **daemon** change and this card was scoped web-only; if one is ever added, switch to it and delete the matcher.

## Do not widen the matcher to a bare status check

Do not reduce `isCredentialGuardFailure` to `status === 401`. That re-introduces misdirection for remote and undeterminable-peer callers, for whom this secret is the wrong credential or no help at all — the same class of bug this card was filed to remove. `packages/web/test/loopback-credential.mjs` pins all three message shapes and goes red on exactly this widening.

## Why a failed socket is a weaker signal than a failed write

A browser cannot read an upgrade's HTTP status: a guard 401 and a dead daemon both surface as an abnormal close. `isCredentialSocketFailure` therefore infers the lock from the two facts the client does hold — the socket never reached `open` (so the handshake itself was rejected, not a mid-session drop), and this browser holds no token at all.

That inference has a stated false-positive: the guard is optional-dep-gated, so a daemon running **without** it needs no token, and a genuine connection failure there also has `token === null`. The socket-sourced copy is written conditionally ("if you reached this daemon through a tunnel") for exactly that reason.

## Do not let an inferred lock overwrite an observed one

`noteCredentialLock` refuses a `write` → `socket` downgrade on purpose. The refused write is a direct observation; the refused socket is inferred, with the false-positive above. Once the strong signal exists, its wording is what stays on screen.
