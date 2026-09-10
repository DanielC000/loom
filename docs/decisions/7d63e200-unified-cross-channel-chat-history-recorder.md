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
- Do not have `pushCrossChannel` (or any other in-app live-push method) write to the database — recording
  must already be complete before a live push runs; these pushes are display-only and dedup by the
  ALREADY-persisted row id.

## Live-push to an already-open web panel (added by card `e04aa826`)

The live-push half of the same unified cross-channel chat feature: once a non-in-app turn (e.g. Telegram) is
persisted by chat-gateway.ts's generic recorder path, `InAppChannel.pushCrossChannel` (`companion/in-app.ts`)
immediately pushes a `{type:"cross-channel"}` frame to every web client already attached to that session, so
an already-OPEN CompanionChat panel shows the turn without waiting for a reload/history-fetch. The frame
carries the SAME `id` the row was persisted under (`companion_messages.id`) so an attached client can dedup
it against that same row surfacing again on its next history-reload. This is purely a live push — it never
writes to the db itself; recording already happened before this runs.

## Source

Inline comment in `packages/daemon/src/companion/types.ts` (the `CompanionMessageRecorder` interface's
top-of-block doc): lines 252-266, as of this tranche's HEAD. Relocated by card `d8bd1cde` (tranche on
`companion/types.ts`); no wording changed beyond joining wrapped source lines into a flowing paragraph and
stripping `*` comment markers.

Additional source: `packages/daemon/src/companion/in-app.ts` (the `InAppServerFrame` `type:"cross-channel"`
doc, "closing a gap in the unified cross-channel chat" paragraph), lines 86-90 as of main `8a99dba9`. Added
by card `e04aa826` (tranche on `companion/in-app.ts`); no wording changed beyond compressing wrapped lines.
