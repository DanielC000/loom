# 6439c51f — the `"system"` sentinel to `null` coalescing-identity map moved into `enqueueStdin` itself

## Narrative

The `"system"` sentinel to `null` coalescing-identity map (`coalesceSenderId`, card e01687ea) used to
live in `enqueueDurableMessage` itself; card 6439c51f moves it INSIDE `enqueueStdin`
(`coalesceSenderIdentity`, `pty/host.ts`, beside `routeKeyOf`) — the unit that actually consumes
`senderId` as a coalescing/reorder identity — so no caller (this one included) can forget to apply it.

Both `enqueueStdin` call sites in `enqueueDurableMessage` now pass the RAW `sender`/`ctx.sender`
straight through, un-mapped. The durable record (`resolveQueuedMessage`'s `sender: ctx.sender`, and
`db.appendEvent`'s `managerSessionId: ctx.sender`) still keeps the raw string for attribution — only the
value that reaches `enqueueStdin`'s `senderId` parameter (the coalescing/reorder identity) is mapped,
and that mapping now happens inside `enqueueStdin`, not at this call site.

## Do not

- Do not re-apply the `"system"` to `null` coalescing-identity map at a caller of `enqueueStdin` — it is
  now applied once, inside `enqueueStdin` itself (`coalesceSenderIdentity`), so a caller doing it again
  would double-map or drift from that single source of truth.
- Do not map the RAW `sender`/`ctx.sender` before it reaches the durable record — attribution
  (`resolveQueuedMessage`, `db.appendEvent`) must keep the unmapped string; only the `enqueueStdin`
  `senderId` argument is mapped.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`enqueueDurableMessage`, above and inside
its body): lines 7005-7009 and 7072-7077, as of main `a1c91ab66ab74e401387ad5f6336eae21175ec45`.
Relocated by card `34cbd17a` (tranche 18).
