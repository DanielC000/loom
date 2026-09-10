# f286919e — SubmitTurn nulls senderId (and ownerText) together on a multi-sender coalesced batch

## Narrative

Card f286919e: `SubmitTurn`'s `senderId` argument (Companion Trust Window) is the AUTHENTICATED sender id
for a GROUP-scope route only (mirrors `VoicePrefRoute`'s own group-only senderId rule — null/omitted for a
DM route), read back via `pty.getActiveTurnSenderId` to key a group route's trust window per-sender.

This is this SUBMIT's own senderId, not necessarily what a later read-back reflects — the pty host can
coalesce several queued submits into one turn (`drainPending`), and when that batch spans MORE THAN ONE
sender (only reachable via the legacy `coalesceAgentMessages:true` full-coalesce; the default per-sender
coalescing never mixes senders), `submit()` nulls BOTH `activeTurnSenderId` and the owner-text primitive
together rather than reading back one member's id under another member's words — never a single "whichever
member drained first" id.

## Do not

- Do not read back `activeTurnSenderId` (or the owner-text primitive) as belonging to a specific queued
  member once a batch has coalesced across more than one sender — both are nulled together in that case,
  never partially attributed to whichever member happened to drain first.

## Source

Inline comment in `packages/daemon/src/companion/types.ts` (the `SubmitTurn` type's doc, above
`export type SubmitTurn = ...`): lines 169-175, as of this tranche's HEAD. Relocated by card `d8bd1cde`
(tranche on `companion/types.ts`); no wording changed beyond joining wrapped source lines into a flowing
paragraph and stripping `*` comment markers.
