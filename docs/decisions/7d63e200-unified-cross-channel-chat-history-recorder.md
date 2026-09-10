# 7d63e200 / 0f01f234 — the chat-history recorder generalizes an earlier in-app-only history fix to every channel

## Narrative

Card 7d63e200 — `CompanionMessageRecorder` is the injected CHAT HISTORY recorder for the unified
cross-channel chat feature: it generalizes the original in-app-only "reload loses history" fix
(bug 0f01f234) to every channel the gateway routes, rather than leaving that fix scoped to the in-app
channel alone.

`record` is called for BOTH an accepted inbound turn (`author:"user"`) and a delivered/voiced outbound
reply (`author:"companion"`). The daemon's real implementation (`companion/factory.ts`) deliberately SKIPS
the in-app channel here — it already records via its own dedicated hooks (`companion/controller.ts`'s
inbound record, `companion/in-app.ts`'s outbound record) — so recording it again through this generic hook
would double-write the same turn.

## Do not

- Do not wire `companion/factory.ts`'s `CompanionMessageRecorder` implementation to also record the in-app
  channel — it already records via its own dedicated hooks, and recording through both paths would
  double-write the same turn.

## Source

Inline comment in `packages/daemon/src/companion/types.ts` (the `CompanionMessageRecorder` interface's
top-of-block doc): lines 252-266, as of this tranche's HEAD. Relocated by card `d8bd1cde` (tranche on
`companion/types.ts`); no wording changed beyond joining wrapped source lines into a flowing paragraph and
stripping `*` comment markers.
