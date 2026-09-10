# db2179f6 — the "your merged code is now LIVE" claim is caveated when the deploy touched the supervisor

## Narrative

Card db2179f6 fixed a false unconditional claim in `resumeFleetOnBoot`'s post-`daemon_restart` nudge
to the requester. "Your merged daemon code is now LIVE" is true in the common case, but false for the
one case this restart path already detects and returns from `requestDaemonRestart`:
`intent.supervisorChanged` — a deploy that touches the supervisor script itself leaves those lines
inert until a human runs `pnpm daemon:stable` (see `RestartIntent.supervisorChanged`'s own doc). The
wording is now conditional on that flag: absent/false keeps the unconditional claim unchanged (the
common case), true swaps in a caveated claim naming the manual step still required.

The skill-store adopt half of the same finding — a merged `assets/skills/**` change also isn't live
for a user-edited (`customized:true`) skill until an explicit adopt — was judged out of scope here:
plumbing `skillStoreStaleness` through to this notice-building site was judged not worth its cost. See
the card for that scoping call; this record covers only the supervisor-script half that was fixed.

## Do not

- Do not assert "your merged code is now LIVE" unconditionally when `intent.supervisorChanged` is
  true — the supervisor script's own lines are inert until a human re-runs `pnpm daemon:stable`.
- Do not extend this caveat to skill-store staleness without re-opening the cost/benefit call the card
  made — that half was deliberately left unplumbed here.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts`, above `resumeFleetOnBoot`'s `liveClaim`
construction: line 4765, as of this tranche's HEAD (tranche 13).
