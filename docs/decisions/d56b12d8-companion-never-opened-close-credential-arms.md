# What a never-opened companion socket may conclude, and from which credential

Card `d56b12d8`, the follow-ups left after card `a6d7bf36` round 2. Read that card's own record (`a6d7bf36-bounded-refused-socket-retries-and-reattach.md`) first: it establishes the refusal episode, the held-token probe and the re-attach nonce this one builds on.

A close that NEVER OPENED on a remote origin is the hardest close in the app to classify. The upgrade 401s, so there is no socket for the daemon to close with its 1008 reason contract (card `f8d2684d`) and the browser reports a bare **1006** with an empty reason. Everything the panel decides from there it decides from state it holds locally, not from anything the daemon said. Three arms share that one close, and this record is about keeping them apart.

## 1. No gateway token at all: terminal, not a ladder

`noteRemoteSocketRefusal` is true only on a remote origin holding **no** gateway token. `Terminal.tsx` has always treated that as terminal; `CompanionChat.tsx` did not — it noted the lock and then fell through to `setConn("reconnecting")` and a fresh rung of the ladder.

The in-code justification for retrying was *"if the user pastes a credential into the banner, the next attempt carries it"*. That was true when it was written and stopped being true in round 1 of `a6d7bf36`: `useCredentialReattachNonce` now rebuilds this panel's socket on the gateway lock's **clearing** edge, so the paste itself is what brings the panel back. The ladder in between gains nothing and is pure guaranteed-401 traffic on the trusted proxy's ONE shared `PROXY_FAILED_AUTH_PER_MIN` bucket — the budget whose exhaustion 429s unrelated remote callers.

It gets its own `conn` state, `"no-token"`, rather than borrowing either existing terminal one. `"revoked"` names WHICH of revoked/paused/rotated/deleted happened, which only a daemon-authored close reason can establish; `"token-refused"` says a credential was presented and the daemon rejected it. Here nothing was ever presented, so nothing was refused and nothing was revoked.

## 2. The ordering of the two credential arms is decided by the ORIGIN — and it was wrong

This is the part worth not re-deriving, because it was **measured, not reasoned**, and the symptom looked like something else entirely.

On a remote origin holding a token the daemon has since killed, the companion panel painted `"reconnecting"` and the page raised the **loopback** credential banner — "A live terminal could not connect. If you reached this daemon through a tunnel, this browser has no local access credential." The gateway token was what died; the loopback secret was never involved.

The cause is that `isCredentialSocketFailure(everOpened, token)` is `!everOpened && token === null`, and on a remote origin `getLoopbackToken()` is **trivially null**: `socketAuth` (`lib/gatewayCredential.ts`) presents only the gateway token on a remote origin and ignores the loopback argument entirely, so a remote page never captures a loopback secret and never needs one to open a socket. The predicate is therefore trivially TRUE for every never-opened close on every remote origin — and because it sat ahead of the probe in the same `else if` chain, it also **consumed the arm the probe lives in**.

The consequence is larger than one wrong banner: the held-token probe in this panel was unreachable on the only kind of origin a gateway token exists on at all. Card `a6d7bf36`'s bounded-ladder mechanism was inert here in production. It read as working because the one place it was measured end to end — `e2e/gateway-dead-token-bound.spec.ts` — measures `/ws/fleet`, and `FleetSocketProvider` asks the episode unconditionally, with no loopback arm to lose to.

So the remote arm now comes first, and the loopback inference runs only when the origin is not remote — in **both** clients that make the distinction (round 1 fixed `CompanionChat.tsx`; round 2 fixed `Terminal.tsx`, see §4 for why leaving it out was a false clearance). On a loopback origin the behaviour is unchanged: the arm that used to reach the probe there always got `"none"` back (`probeHeldGatewayToken` returns `"none"` off a remote origin), so asking was already a no-op and the reordered loopback arm simply does not ask.

## 3. A probe of a token the browser no longer holds is `unknown`, not `invalid`

`probeHeldGatewayToken` raises the app-wide gateway lock on `"invalid"`. A probe is asynchronous and the held credential can be **replaced** while one is in flight — a paste into the banner is exactly that, and it clears the lock on its way through. An unconditional raise on arrival put the banner straight back up over a freshly pasted, verified, working token.

`createRefusalEpisode`'s generation fence does not cover this, and that is the easy mistake to make when reading the two together: that fence drops a superseded `onDead`, which is the *episode's* decision to stop a ladder. This side effect fires inside the probe, before any result reaches the episode at all.

Round 1 fenced only the side effect and still answered `"invalid"`, on the reasoning that this is a true statement about the token that was *probed*. True, and still the wrong thing to return. `"invalid"` is the **one** outcome that both raises the lock and ends a ladder, so declining the raise while keeping the outcome split a single decision into two that could then disagree: the ladder stopped on a freshly pasted, working credential with no banner up to explain why the pane was dead. The outcome now moves with the side effect — a replaced token yields `"unknown"`, which is non-stopping, so the episode simply re-asks about the token actually held, inside its own bounded `REFUSAL_EPISODE_MAX_UNKNOWN` budget.

Keeping the pair coupled is also what covers two cases no per-case fence enumerated: another TAB's paste (same storage, same window of replacement), and an A→B→A swap. The A→B→A case is worth stating because it looks like a counterexample and is not: the browser once again holds the very token just refused, so `"invalid"` **plus** a raised lock is the correct answer there. The invariant is `"invalid"` ⇔ lock raised, not "a swap means no verdict". `test/gateway-credential.mjs` asserts it as an invariant over all four swap shapes rather than case by case, because a per-case assertion pair is exactly what drifted apart in round 1.

## 4. The same ordering bug in `Terminal.tsx` was a CROSS-CLIENT defect, not a cosmetic one

Round 1 left `Terminal.tsx`'s copy of this ordering bug out of scope and justified it, in this file, as *"a copy/attribution defect, not a traffic one"*. That was wrong, and wrong in a way worth preserving rather than quietly deleting, because the reasoning was locally sound and still produced a false clearance.

What was right: Terminal's own ladder really is terminal on that path, so unlike the companion panel it was never also spending the shared `PROXY_FAILED_AUTH_PER_MIN` budget. The error was scoping the consequence to the client that holds the defect. The arm Terminal wrongly took calls `noteCredentialLock("socket")`, and that lock is **module state** — it survives unmount and SPA navigation, and on a remote origin nothing can ever clear it (`CredentialBanner`'s own unlock probe needs a loopback secret such a page never holds, and `socketAuth` never presents one there, which is the very reason `isCredentialSocketFailure` is trivially true in the first place).

Round 1 then made the companion's `token-refused` state terminal, with the re-attach nonce as its **only** recovery — and that nonce bumped on the clearing edge of `loopback !== null || gateway`. A single terminal pane anywhere in the document therefore pinned that OR true forever, and a valid paste produced no bump at all: the companion stayed dead until a full reload, behind a loopback banner describing a credential the page neither had nor needed. That is precisely the "self-healing becomes silently dead" outcome `a6d7bf36`'s own `@decision` forbids, and it also blocked `FleetSocketProvider`'s re-attach. So the defect's reach was a function of the OTHER clients' recovery mechanism, not of Terminal's own traffic.

Both halves are fixed, and they are **independently sufficient for the outcome** — which is why the proof is split:

- **The reorder** (card `7a77e46b`, absorbed here): Terminal's remote arm now runs ahead of the loopback inference, as §2 already required of CompanionChat. `test/socket-close-wiring.mjs` check (13) picked Terminal up **by derivation** — the new `isRemoteOrigin(` call in its close path made it a member with no edit to the check, which is the whole reason that list is scanned rather than written.
- **The per-lock nonce**: `anyLockCleared` (`lib/useCredentialReattach.ts`) bumps on **each** lock's own clearing edge. A collapsed boolean cannot see an edge while the other lock is up, so one stuck lock disabled recovery from the other entirely.

The generalisable lesson: when a defect's consequence runs through app-wide module state, bounding the blast radius to the client that contains it is a category error. Ask what else reads that state, and whether anything can clear it on the origin where the raise happens.

## Measured

| | result |
|---|---|
| **§2, before the ordering fix** (`e2e/companion-dead-token-refused.spec.ts`, real daemon behind a real proxy in Chromium) | pill `reconnecting`; the LOOPBACK banner on screen; the "token refused" assertion fails `element(s) not found` |
| **§2, as shipped** | pill `token refused`; Send disabled with a non-empty draft; `/ws/companion` construction count FLAT across a 14s window (the 1s/2s/4s/8s ladder would have fired) |
| **§1, control** | reverting only `CompanionChat.tsx` fails `test/socket-close-wiring.mjs` check (12) BY NAME, while `Terminal.tsx` still passes it |
| **§3, control** | removing only the `getGatewayToken() === gatewayToken` fence fails `test/gateway-credential.mjs`'s replaced-mid-flight case (`actual: true, expected: false`) |
| **§4, before the reorder** (`e2e/terminal-loopback-lock-reattach.spec.ts`, real daemon behind a real proxy in Chromium, run at tip `88fb7b05`) | the terminal pane painted `[no local access credential — live terminals are disabled]` where the fix expects `access token was refused` |
| **§4, before the reorder, stranding assertion in isolation** (the copy + banner assertions temporarily disabled, so the OUTCOME claim is reached and tested on its own rather than inferred from the copy failure) | after a VALID paste the companion never returned: `locator('#companion-panel-chat').getByText('connected')` → `element(s) not found`, 30s |
| **§4, as shipped** | both, plus the LOOPBACK banner absent throughout, a NEW `/ws/companion` socket after the paste, and the page-lifetime sentinel intact (so the recovery was not a reload) |
| **§1, runtime coverage + its control** | the `no-token` pill had no runtime test at all, and check (12)'s old slice provably could not fail for it — the reviewer measured that deleting the `return` after `stopForNoToken()` still passed. Both are closed: with that `return` deleted, the rewritten check (12) fails BY NAME and `e2e/terminal-loopback-lock-reattach.spec.ts`'s first test fails on the pill (`getByText('no gateway token')` → not found) |

The §2 before/after is a real before/after on the same instrument in the same rig, not a symbol-missing revert. The flat count carries its own positive control inside the spec: the same counter is asserted to RISE twice earlier in the same page's life (the healthy attach, and the companion switch), so a flat count at the end is a real absence rather than a blind one.

## Do not

- **Do not put `isCredentialSocketFailure` ahead of the remote arm again.** It is trivially true on a remote origin, so it raises the wrong banner and silently eats the arm the gateway probe lives in. `test/socket-close-wiring.mjs` check (13) pins the order for every client that makes the distinction.
- **Do not retry a token-LESS refused upgrade.** There is no credential to probe and nothing an episode could learn; the re-attach nonce is the recovery, and the ladder only spends the shared failed-auth budget. Check (12) pins it.
- **Do not collapse `no-token`, `token-refused` and `revoked`.** They differ in what was OBSERVED: nothing presented, presented-and-rejected by an HTTP probe, and a named status change the daemon itself authored. Only the last may use the "token revoked" copy.
- **Do not raise the gateway lock for a probe of a token this browser no longer holds, and do not let `"invalid"` and that raise come apart.** They are ONE decision: `"invalid"` is the only stopping outcome, so returning it without the raise ends a ladder with no banner to explain it. A replaced token is `"unknown"`. Do not reach for the episode's generation fence to cover any of this — that fence guards a different decision at a different layer.
- **Do not collapse the two credential locks into one boolean in `useCredentialReattach`.** A clearing edge is invisible behind the other lock still being up, so no nonce is emitted and every bounded ladder becomes a pane that is dead until reload. Per-lock edges, via `anyLockCleared`; `test/credential-reattach-edge.mjs` pins the algebra (including the negative control that the old OR form answered `false` for exactly the cases that matter).
- **Do not scope this ordering bug's consequence to the client that holds it.** §4 is the worked example: the Terminal copy was dismissed in round 1 as "a copy/attribution defect, not a traffic one" — locally correct about Terminal's own traffic, and a false clearance, because the loopback lock it wrongly raises is module state with no clearing path on a remote origin, which permanently disabled the COMPANION's and the fleet feed's recovery from a valid paste. When a defect writes app-wide module state, ask what else READS that state and whether anything can clear it on the origin where the raise happens.
- **Do not test a companion-pane credential behaviour on the shared `loomDaemon` fixture.** A loopback page's sockets are not token-authenticated, so the behaviour is unreachable and the test passes vacuously. Use `e2e/fixtures/gateway-proxy-rig.ts`.
