# 0ab96d24 — a wrong claim about the reader's OWN capabilities suppresses verification; reword conditional

## Narrative

Card 0ab96d24: the `[loom:redelivery-parked]` notice's negative branch used to assert, as a flat
universal, "there is no cross-session transcript/state read available to a sender in your
position." FALSE for the `platform` role — the Lead's `session_transcript` (mcp/platform.ts)
reads ANY session's transcript by id alone, cross-project, unconditionally, and in two live
incidents that exact read is what resolved the situation in a single call.

A wrong claim about the WORLD invites verification; a wrong claim about the READER'S OWN
CAPABILITIES suppresses it — nobody goes looking for a tool they were just told doesn't exist.

Reworded to a conditional ("if you have one, use it") rather than hard-coding a `sender`-role
check here: that phrasing stays true for the platform Lead today, and for whatever future
role/read this file doesn't yet know about — the old absolute claim already rotted once without
this file changing at all (the Lead's `session_transcript` predates this fix).

## Do not

- Do not phrase a notice as a flat universal about what the reader CAN do ("there is no read
  available to you") — phrase it conditionally ("if you have one, use it") so a future role/read
  this text doesn't yet know about doesn't silently make the claim false again.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`handleGiveUpExhausted`'s
`[loom:redelivery-parked]` notice-building block), as of main `c461821e`. Relocated by card
`1341fcde` (tranche 20 on `sessions/service.ts`).
