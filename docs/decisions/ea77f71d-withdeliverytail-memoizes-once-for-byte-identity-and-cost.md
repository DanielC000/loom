# ea77f71d — `withDeliveryTail` memoizes its resolver once, for byte-identity AND cost

## Narrative

Card ea77f71d (Code Reviewer Major ②, follow-up on card 8e0d09e8): `m.resolveTailAtDelivery` (if present) is resolved HERE, but only ONCE ever, on the first evaluation that TOUCHES this entry — the result is memoized onto the entry itself (`m.resolvedTailReady`/`m.resolvedTail`) and every later call, for the SAME `m`, returns the cached value without re-invoking the resolver. This is load-bearing for TWO things at once:

1. BYTE-IDENTITY: `requeueGiveUpOrigin` reconstructs the exact text a failed attempt actually wrote, by calling this SAME function again on the SAME `QueuedMessage` object (`origin`'s members are the identical references `drainPending` drained — see `submit`'s `live.giveUpOrigin = origin`). Before this memoization, a resolver that reads live external state (e.g. a task's current board column) could return a DIFFERENT value on that later reconstruction than it did at the real write, silently breaking the late-confirmation content-match/purge mechanism `annotatedMessageText`'s own card 78e4b3f2 doc already declares load-bearing.
2. COST: `projectedWrittenLength` can invoke this up to 3x per drain candidate (a byte-bound probe, then the accumulate, then the real write) — including, before this fix, for a candidate that fails the byte bound and is therefore never drained at all. Memoizing collapses that back to at most one real resolver invocation, ever, per entry.

KNOWN CAVEAT (accepted, not closed by this fix): memoization happens on the FIRST touch, which is not always the real delivery write — a coalescing-budget probe that ends up REJECTING this candidate (it stays in `live.pending` for a later drain) still counts as a touch. Today's one production resolver (`SessionService.platformEscalate`) can never hit this, because it always enqueues with no `senderId`, which keeps it out of the same-sender coalescing-candidate scan entirely (see that scan's own `senderKey !== null` guard) — so it is always resolved exactly at its own head-of-batch, i.e. genuinely at drain time. A FUTURE resolver-bearing caller that DOES supply a `senderId` and gets rejected as a coalescing candidate would see its tail frozen at that earlier, rejected probe rather than at its actual later delivery — this is named explicitly here so a future caller (via `resolveTailAtDelivery`'s own doc) can judge whether that's acceptable for what it reads.

## Do not

- Do not remove the memoization (`m.resolvedTailReady`/`m.resolvedTail`) — a resolver that reads live external state could then return a different value between `drainPending`'s real write and `requeueGiveUpOrigin`'s later reconstruction, silently breaking the late-confirmation content-match/purge mechanism.
- Do not assume today's known caveat (first-touch may be a rejected coalescing probe, not the real delivery write) is closed — it's accepted as harmless only because the one production resolver never hits it; a future `senderId`-supplying resolver caller must judge this explicitly.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (`withDeliveryTail`'s function doc), as of commit `1974444dc94618d380f474192e22edff20215ec5`. Relocated by card `de94a415` (tranche 2 on `pty/host.ts`); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
