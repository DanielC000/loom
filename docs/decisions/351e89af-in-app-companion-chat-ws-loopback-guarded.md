# 351e89af — `/ws/companion/:sessionId` gated by the loopback human-only-write guard, not "loopback = human"

## Narrative

`GET /ws/companion/:sessionId` is the DEFAULT companion transport: live in-app chat (JSON chat + audio frames only), deliberately SEPARATE from `/ws/term` (which streams raw pty bytes) — a distinct route + a distinct JSON message channel, so the in-app chat multiplexes cleanly alongside terminal-attach on the same session with no collision.

This route's doc comment used to claim "the loopback cockpit IS the authenticated local user — NO bot token, NO pairing, NO external authz." That conflated "safe for an authenticated REMOTE human" (`trust-tier.ts`'s predicate) with "safe from an unauthenticated CO-RESIDENT agent" (the loopback human-only-write guard's own predicate) — on the default loopback-only daemon ANY co-resident process that can open a TCP connection, including an agent session's own Bash tool, could open this socket and inject a `{type:"chat"}` frame straight into the owner-role Companion slot, with no manager involved at all (unlike the alert-text path card `018ce1db` fixes). Closing the gap card `9ccedbee` deliberately left open: the loopback human-only-write guard now gates THIS upgrade exactly like `/ws/term`'s (same mechanism, same secret, reused verbatim — not a second scheme) — reaching this handler at all already means the caller held the loopback secret, or the connection arrived on a non-loopback bind and already passed the remote tier's own token check.

INBOUND (a message typed in the cockpit) routes through the SAME bindings-authoritative gateway (`companion.handleInAppInbound` → `gateway.handleInbound`); a session with no in-app binding is rejected there (this carries traffic only for an already-provisioned in-app companion — it creates nothing). OUTBOUND companion replies arrive via the in-app hub (`deps.inApp`) pushing a `{ type:"chat" }` frame here. ADDITIVE: with no in-app companion, attach is a no-op and inbound is rejected — every session unaffected.

## Do not

- Do not read this fix as closing the same-OS-user co-residency ceiling — an agent that specifically goes looking for and reads the loopback secret file still gets a valid credential. This closes the casual/incidental bypass (a co-resident process opening the socket with no credential at all), not that stronger threat.
- Do not conflate "safe for an authenticated remote human" (`trust-tier.ts`) with "safe from an unauthenticated co-resident agent" (this guard) — they are different predicates; the route's own doc comment made exactly this mistake before this card.

## Source

Inline comment in `packages/daemon/src/gateway/server.ts` (`GET /ws/companion/:sessionId`, lines 5677-5699 as of commit `a9b55042`). Relocated by card `2bf0b41d`; wording condensed, no substantive detail dropped.
