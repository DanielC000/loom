# fb5e39c3 — a `live` message target that already has a recycle successor discloses, never redirects

## Narrative

`deliverSessionMessage` (`sessions/service.ts`) is the shared cross-project message-delivery mechanic
behind `messageSessionAsPlatform` and `messageSessionAsCompanion`. Its NOT-LIVE branch already handles a
target superseded by recycle (card `5519559c`): it routes to the live successor via the same durable
channel. This card is the THIRD variant of the same underlying failure (`e79e2956`/`8457d0ed`) but a
different mechanism: here the caller supplies the `sessionId` explicitly, so there is no candidate SCAN
to filter a stale entry out of — the caller already named the target.

**The producers, corrected (Code Review finding, card fb5e39c3):** `recycleManager` never touches the
predecessor's `processState` at all — it stays `"live"` until the pty is eventually torn down by
`settleRecycleHandoff`. `recycleWorker` hard-stops the predecessor, but its `processState` flips to
`"exited"` only via the async `onExit` callback, decoupled from the synchronous `insertRecycleSuccessor`
+ `setProcessState(fresh.id, "live")` that follows — and `recycleWorker` is the HIGHEST-VOLUME producer of
this race. `recyclePlatformLead` is NOT a producer at all: it sets `setProcessState(old.id, "exited")`
SYNCHRONOUSLY, before the successor row is even inserted (the "no-await atomic lineage handoff" — see its
own inline comment), so predecessor and successor are never both `"live"` in that path. In whichever
producing path, `session.processState === "live"` can read true for a session `hasSuccessor()` already
reports as superseded, for a window that is ORDINARILY seconds (until the successor settles) but can run
INDEFINITELY if the successor never reaches ready and never dies (`settleRecycleHandoff`'s own unresolved-
outcome path keeps polling past its settle timeout rather than giving up) — not a bounded "few seconds".

The fix does NOT deliver into the addressed predecessor (it may be torn down before ever draining the
message) and does NOT silently redirect to the successor (the caller named this id explicitly and may
have had a reason to; redirecting changes who receives a message without saying so — its own surprise).
Instead it discloses: `deliveryStatus: "dropped"` — per the canonical `DeliveryStatus` definition
(`shared/src/types.ts`), "a genuine failure to route: nothing durable will surface it. The ONLY value that
warrants alarm" — reusing that existing classification rather than minting a new enum value, plus a
`replacedBy` field naming the successor (which may itself be dead — `recoverFleetAfterFailedRecycleSuccessor`'s
NEVER-RESURRECT branch deliberately leaves a confirmed-dead successor's `recycled_from` link intact — so
re-addressing `replacedBy` is not guaranteed to be live; a dead one simply falls through to the NOT-LIVE/
boarding path, at the cost of one extra hop).

## Do not

- Do not deliver a `session_message`/companion message into an addressed target whose `processState`
  reads `"live"` but that already `hasSuccessor()` — check this BEFORE calling `deliverLive`, not after.
- Do not silently redirect such a message to the successor — return `replacedBy` and let the caller
  decide; only the NOT-LIVE branch (`@decision 5519559c`) auto-routes, and only because it has no
  explicitly-named live alternative to defer to.
- Do not invent a new `DeliveryStatus` value for this case — reuse `"dropped"` (the canonical definition's
  "genuine failure to route" applies here) so `@decision fc9a27d5`'s existing classification doesn't need
  re-deriving.
- Do not CACHE a `"dropped"` result in `messageSessionAsPlatform`'s retry-dedupe map
  (`platformMessageDedupe`) — that map exists to prevent double-DELIVERY, so replaying a cached
  non-delivery for its full TTL would defeat a retry that, by the time it's re-tried, may legitimately
  take the NOT-LIVE/successor-routing branch instead (Code Review finding, card fb5e39c3).

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`deliverSessionMessage`'s own live branch).
Filed by Loom lead `gen 359`, card `fb5e39c3`, worker-implemented 2026-09-22.
