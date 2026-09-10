# 134368ac — re-arm a suppressed same-home heartbeat survivor when the winner exits

## The bug

`suppressDuplicateHomeHeartbeats` (`packages/daemon/src/companion/store.ts`) keeps only ONE heartbeat armed per shared home destination: among live members sharing a home, the winner (highest `ctxTurns`, ties broken by oldest `createdAt`) stays armed and every other live sibling on that home has its heartbeat zeroed. RESIDUAL LATENCY ON A WINNER'S EXIT: if the winning LIVE session later exits, a bare pty exit alone does not re-run this guard — `controller.ts`'s `onSessionExit` deliberately bypasses `reconcile()` (the config row's `enabled` stays true across a pty death, so an unscoped reconcile would try to re-START the now-dead session's gateway), and even a REST-scoped `reconcile(sessionId)` for an unrelated write only diffs that ONE session (see [[b2ff5b8c-cross-companion-rearm-scoped-to-one-session]]), never a sibling. Left alone, a suppressed survivor would stay silently disarmed until the next boot or an unrelated config write.

## The fix

`onSessionExit` now closes this itself via `teardownOneAndRearmSameHomeSiblings` (`packages/daemon/src/companion/controller.ts`): it captures the exited session's home before tearing it down, then re-resolves + reconciles (via `applyDesired`, scoped per sibling — never through `reconcile()`, which would recurse into the same serialization chain this runs inside of) every still-LIVE sibling sharing that home — so a suppressed survivor re-arms promptly on the exit itself.

`teardownOneAndRearmSameHomeSiblings` is `teardownOne` PLUS the same-home rearm: if the exited session shared its home with a still-LIVE sibling, that sibling may currently be SUPPRESSED (its heartbeat zeroed by `suppressDuplicateHomeHeartbeats` because the exited session was the group's winner) — re-resolving + reconciling just that sibling re-arms it promptly instead of leaving it disarmed until the next boot or an unrelated config write.

## ONE SOURCE OF TRUTH for the same-home match (CR fix)

Both the exited session's home AND the candidate-sibling homes are read from the freshly-`resolve`d set — the SAME authoritative source `suppressDuplicateHomeHeartbeats`'s own winner-pick uses (`db.getCompanionHome` via `buildConfigFromRow`) — never from the `this.cfgs` CACHE. A home REST write (`PUT /api/companion/home`) mutates app_meta WITHOUT calling `reconcile()`, so a live sibling's cached `cfgs` entry can go stale on a home change; matching against the cache could then MISS a survivor whose home just changed — exactly the latency class this card exists to close, in a home-changed sub-case. `desired` already includes the exited session's own (still-enabled) row — resolving liveness has no bearing on `buildConfigFromRow`, only on the suppression step — so its home is read off `desired` too, before `teardownOne` clears its `cfgs` entry (order doesn't matter functionally here, since `resolve` is a pure DB read, but reading it up front keeps the "one resolve, one source" property obvious).

## No-op cases and convergence

A non-companion session (absent from `desired` — no enabled row at all) or one with no same-home LIVE sibling is a no-op — `siblingIds` is simply empty (still-live is checked against `this.cfgs`, the controller's own liveness truth, which `desired` alone can't tell — an enabled-but-long-dead row would otherwise wrongly count as a "sibling"). Each sibling is reconciled via `applyDesired` DIRECTLY (not `reconcile()`/`enqueue()`, which would recursively await this very op's own place in the serialization chain and deadlock) — this method already runs serialized inside that chain via `onSessionExit`'s `enqueue`, so a plain sequential `applyDesired` call preserves the same ordering guarantee for free. The exited session's id is NEVER passed to `applyDesired` here — only its still-live siblings — so its now-dead gateway is never re-started. With ≥2 surviving same-home siblings, `desired`'s own suppression pass has already picked the NEW winner among them (the exited session is excluded from that competition via `isLiveSession`, since its `processState`/`archivedAt` are set BEFORE `onSessionExit` is ever called — see `index.ts`'s `onExit`) — so re-arming every sibling here converges on exactly one winner armed, the rest still suppressed.

## Do not

- Do not match same-home siblings against the `this.cfgs` cache — a home REST write doesn't call `reconcile()`, so the cache can be stale exactly when this match needs to be fresh.
- Do not route a sibling rearm through `reconcile()`/`enqueue()` from inside `onSessionExit` — it already runs serialized inside that same chain and would deadlock recursing into it.

## Source

`packages/daemon/src/companion/controller.ts`: `onSessionExit`'s doc (was lines 134-142) and `teardownOneAndRearmSameHomeSiblings`'s full top-of-function doc (was lines 823-855), as of tranche 1 on this file (card `488cedea`). No wording changed beyond joining wrapped source lines into flowing paragraphs and stripping `*` comment markers. `packages/daemon/src/companion/store.ts`'s own `suppressDuplicateHomeHeartbeats` doc (lines ~154-163, untouched — out of this tranche's scope) documents the same card from the suppression side.
