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

## Decision B — `Live.activeTurnSenderId` no longer proves a companion GROUP turn (unrelated decision, same card id, `pty/host.ts`)

**Source (this section only):** not the same decision as the section above — that section is about the same-sender queued-message reorder's fairness bound; this is a correction to what a non-null `activeTurnSenderId` read is allowed to prove.

### Narrative

`Live.activeTurnSenderId` (Companion Trust Window, Companion Capability & Permission-Lever Framework card 0) was originally the authenticated sender id of the in-flight turn's inbound message, set ONLY for a GROUP-scope companion route — null for a DM route (the chatId alone already identifies the single owner) and null for every non-companion-inbound turn.

CORRECTION (card `e01687ea`): the field is NO LONGER null for "every non-companion-inbound turn" in general. Since that card, `enqueueDurableMessage`'s single funnel threads a REAL sender id into this same `senderId` param for `worker_message`/redirect/`session_message`/peer-letters/settle-nudges too (the coalescing/reorder identity DoD-1 the section above wires up), so a non-companion turn (e.g. a `session_message` landing on a session that also happens to be a companion) can now carry a non-null value here as well. A non-null read alone therefore no longer PROVES "this was a GROUP-scope companion-route turn" — it only means SOME real sender was attributed to this turn.

It is STILL true, unconditionally, for the companion-INBOUND path itself (a group route sets it, a DM route never does). Any consumer that needs the narrower "authenticated GROUP-companion turn" fact (e.g. `transcript_read`'s DM-only co-gate, `companion/capabilities.ts`) must keep pairing this with `activeTurnOwnerText`/Primitive A, which IS still exclusive to companion-inbound turns — the pairing, not this field alone, is what still holds.

Lifecycle mirrors `activeTurnOwnerText` exactly: set alongside it in `submit()`, CLEARED at the Stop/StopFailure hook (a stale prior turn's sender must never be attributed to a later turn), with `lastPromptSenderId` mirroring `lastPromptOwnerText` so a rate-limit-killed companion turn's replay keeps the same sender identity.

### Do not (this section)

- Do not treat a non-null `activeTurnSenderId`/`lastPromptSenderId` alone as proof of a GROUP-scope companion turn — since card `e01687ea`, other agent-message producers thread a real senderId too. Pair with `activeTurnOwnerText`/Primitive A for that narrower fact.

### Source (this section only)

Inline comment in `packages/daemon/src/pty/host.ts` (the `Live.activeTurnSenderId` field doc), as of `main`
`d8b3076b`. Extracted by card `b19e70d3` (tranche 10 on `pty/host.ts`); wording unchanged beyond joining
wrapped lines and stripping `//` markers.
