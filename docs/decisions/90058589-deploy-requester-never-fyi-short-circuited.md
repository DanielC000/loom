# 90058589 — the deploy requester is never FYI-short-circuited on resume

## Narrative

Card 90058589 fixed a wrongly-stalled nudge for the session that itself requested a `daemon_restart`.
Initiating a deploy is active work, so the requester always gets the full "code is live — continue/
verify" nudge on resume — even at 0 live workers with a stale done/waiting idle-policy, the exact case
the old converged-FYI branch used to wrongly stall on (that branch is correct for a non-causal
bystander, per `b5664b5b`, but the requester is never a bystander with respect to its own restart).

## Do not

- Do not route the deploy requester's own resume nudge through the same converged-FYI short-circuit
  used for a non-causal bystander — the requester always gets the full "code is live" nudge,
  regardless of its worker count or idle policy.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts`, above `resumeFleetOnBoot`'s requester
resume handling: line 4713, as of this tranche's HEAD (tranche 13).
