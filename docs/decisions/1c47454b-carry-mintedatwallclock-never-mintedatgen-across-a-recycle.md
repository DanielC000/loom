# 1c47454b — A recycle carry keeps `m.mintedAtWallClock`, never `m.mintedAtGen`

## Narrative

`carryPendingToSuccessor`'s non-durable carry loop (`packages/daemon/src/sessions/service.ts`)
re-enqueues a still-pending nudge/raw-turn (`QueuedMessage`) onto a recycle successor. It carries
`m.mintedAtWallClock` — a still-pending paste-recovery notice's absolute mint time — but deliberately
never `m.mintedAtGen`.

The successor is a FRESH `Live`, whose `submitGeneration` restarts at 0. A predecessor's generation
count carried verbatim would be compared against this unrelated counter — a unit error, not evidence —
and `annotatePasteRecoveryAge` (`pty/host.ts`) would silently disclose nothing, which is the exact
defect this card exists to close.

## Do not

- Do not carry `m.mintedAtGen` across a recycle. It is only meaningful relative to the PREDECESSOR's
  own `submitGeneration` counter; a fresh successor's counter restarts at 0, so comparing against it is
  a unit error that fails silently rather than throwing.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`carryPendingToSuccessor`'s non-durable
carry loop), as of main `b89cafa49ad4490fc9081790fbcf8961b82a6457`. See
`QueuedMessage.mintedAtGen`/`mintedAtWallClock`'s own field docs in `pty/host.ts` for the fuller
reasoning behind the two fields themselves.
