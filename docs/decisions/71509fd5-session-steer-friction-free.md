# 71509fd5 — session-steer is fully friction-free, an accepted residual risk

## Narrative

Decision `71509fd5` made `session-steer`'s four actions (message/steer/stop/resume) FULLY FRICTION-FREE: all four commit IMMEDIATELY on the first call, with NO Primitive C propose/confirm round-trip — unlike `decision_resolve`/`board_create`/`board_update`, which all require a second, owner-confirmed call before committing.

This is deliberate, owner-accepted residual risk on Loom's most injection-exposed surface. The safety model here is NOT structural prevention of a bad action; it rests entirely on Primitive A (mandatory owner-authored turn) plus scope re-checked on every call — see the lever's own inline guard list for that enforcement, which stays inline because its physical presence and ordering is the guarantee.

The same decision also set `session-steer`'s per-project `config_json.roleFilter` default to NO restriction (an absent/empty roleFilter admits every role) — the OPPOSITE of `decisionClasses`' conservative admit-nothing default — because the owner explicitly wants "whatever I want" here once scope + Primitive A already hold.

## Do not

- Do not add a Primitive C confirm round-trip to `session-steer`'s four actions as a "safety improvement" without a fresh owner decision — friction-free operation here was a deliberate, accepted trade-off, not an oversight.
- Do not flip `roleFilter`'s default to admit-nothing (mirroring `decisionClasses`) without a fresh owner decision — the permissive default was chosen deliberately, opposite of the rest of the catalog.

## Source

Inline comment in `packages/daemon/src/companion/capabilities.ts` (`session-steer`'s top-of-block doc): lines 1984-2002, as of this tranche's HEAD. Relocated by card `d091d3fa` (tranche on `companion/capabilities.ts`); no wording changed beyond joining wrapped source lines into flowing paragraphs and stripping `*` comment markers.
