# 438973ce — `submit()` attributes owner text from EVERY origin member, not just the head

## Narrative

Card 438973ce: when `submit()` receives an `origin` array (the FULL set of `QueuedMessage` this
turn was built from — `drainPending`'s `drained` array, or a single-element synthetic origin for
the immediate/kickoff-guarantee callers), in FIFO order, it
attributes owner text from EVERY member that carries its own `ownerText` — not just the single
`ownerText` parameter, which is only ever `drained[0]!.ownerText` (the head). A coalesced drain
(card eac3464d) can fold several same-sender owner turns into ONE `submit()`; iterating `origin`
itself — the same array whose arity already tracks the drain's own coalescing — means a future
change to that arity can't silently re-break attribution the way eac3464d once did, since there is
no separate "just the head" value left to fall out of sync. FIFO order plus `attributeOwnerText`'s
own `unshift` leaves `recentOwnerTurns` newest-first, byte-identical to the pre-existing
single-entry ordering. Falls back to the plain `ownerText` parameter only when no `origin` was
supplied at all (rate-limit replay, `resumeAfterRateLimit`'s "rate-limit-replay" caller) —
unchanged from before this card.

## Do not

- Do not read back `ownerText` from only `origin[0]` (the head) once `submit()` receives a
  coalesced `origin` array — every member that carries its own `ownerText` must be attributed, or a
  future coalescing-arity change can silently re-break attribution the way eac3464d once did.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (`submit()`'s body, the owner-text attribution
loop), commit `341d6b20985a1092a485e25c0b1b94ba6629247f` (2026-09-01). Relocated by card `fc865948`
(tranche 34 on `pty/host.ts`).
