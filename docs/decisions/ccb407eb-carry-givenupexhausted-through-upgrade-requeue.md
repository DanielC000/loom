# ccb407eb — Carry `msg.onGiveUpExhausted` through the companion-upgrade requeue paths (finding [6])

## Narrative

CR follow-up (card ccb407eb, finding [6]): carry msg.onGiveUpExhausted too.

Card ccb407eb, finding [6]: a durable (onDeliver-bearing) entry is skipped above, so this loop only ever carries plain (non-durable) entries — msg.onGiveUpExhausted is always undefined here in practice, but pass it through anyway.

## Do not

- Do not drop `msg.onGiveUpExhausted` when requeuing a drained message back onto the pty in either `upgradeCompanionCapabilities` path (same-pty abort, or post-`resume()`) — carry it through even when it's undefined in practice.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`upgradeCompanionCapabilities`): lines 4136-4137 (abort path) and 4175-4176 (post-resume path), as of commit `7a20d971f1c5d3d098b36030b5cc5feebd8be930`. Relocated by card `6065685c`; no wording changed, wrapped source lines joined into a flowing paragraph and the `//` comment markers stripped. Narrowly scoped to this method's two requeue sites — `finding [6]`'s broader `ccb407eb` feature has other sites elsewhere in this file, out of this record's scope.
