# e01687ea — `leapfrogCount` bounds how much a chatty sender's burst can delay a quiet different-sender entry

## Narrative

Card e01687ea (correction to an earlier framing of the same-sender reorder-on-enqueue): `enqueueStdin`
reorders a same-sender agent-kind arrival to land right after that sender's own last queued entry (rather
than the FIFO tail), so same-sender coalescing has something adjacent to work with even when another
sender's message interleaved the arrivals. That reorder shifts every OTHER entry still queued behind that
insertion point one position further from the front — including a quiet entry from a different sender that
never itself matches the reorder.

This is a STATED fairness trade: a chatty sender CAN delay a quiet one, but only by `AGENT_COALESCE_MAX_COUNT`
arrivals, never unboundedly. The correction this card made: the CAP on that delay comes from a per-entry
`leapfrogCount` on `QueuedMessage` that freezes an entry once it's been displaced that many times — NOT
from the lookback window the reorder's scan uses to bound how far back it searches. The window alone does
NOT age a quiet entry out of eligibility, since the reorder always inserts immediately in front of it and
its index grows in lockstep with the window; only the per-entry counter, incremented once per displacement,
actually bounds the total delay.

## Do not

- Do not reason about the same-sender reorder's fairness bound from the lookback window alone — the window
  does not age a displaced entry out; the actual cap is the per-entry `leapfrogCount` counter reaching
  `AGENT_COALESCE_MAX_COUNT`.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (the `leapfrogCount` field doc on `QueuedMessage`), as
of commit `9ec4728543118ddeea8569bf7c9de4878719fb62` (`fix(pty): thread the sender id through to the
queued-message drain so same-sender coalescing reaches production`). Relocated by card `3f45b7d8` (tranche
6 on `pty/host.ts`). A second site citing this same card exists at `pty/host.ts` lines 2687-2706 (the
reorder scan's own "FAIRNESS BOUND" comment) — out of this tranche's scope; a future tranche extracting
that site should extend this record, not create a second file.
