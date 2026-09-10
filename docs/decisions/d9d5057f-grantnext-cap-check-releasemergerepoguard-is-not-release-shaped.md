# d9d5057f — `grantNext` needs its own cap check because `releaseMergeRepoGuard` isn't release-shaped

## Narrative

Card d9d5057f: `grantNext` is now gated on `this.lastKnownCap` before scanning any waiter tier. Both of `grantNext`'s callers were previously assumed "release-shaped" — called only when a slot had JUST freed, so `active` was already `< cap` by construction. That holds for `release()` (its own `this.active--` runs immediately before the call, in the same synchronous turn) but NOT for `releaseMergeRepoGuard()`: it frees a REPO guard, not a cap slot — the cap slot for that same op was already freed earlier, at its own `release()` call, and an unrelated op can have consumed that freed slot in the gap between the two. A cap-blind grant there would then over-admit past `cap`.

`lastKnownCap` was chosen over threading a fresh `cap` param through every call site because `releaseMergeRepoGuard`/`endSquash` — invoked standalone from `confirmWorkerMerge`, outside `runExclusive` entirely — has no `cap` in scope at all and is a PUBLIC method other code already calls by this exact signature; adding a `cap` param there would be a breaking API change for a value this class already tracks. `lastKnownCap` is the same RESOLVE-LIVE value `runExclusive` already refreshes on every call, so reading it here extends that existing liveness instead of freezing a cap captured at construction time. `undefined` (no `runExclusive` call has ever happened yet) never blocks — unreachable in practice, since `grantNext()` is only ever reached from `release()`/`releaseMergeRepoGuard()`, both of which presuppose at least one prior admission that already set it.

**Side effect on a separate investigation:** fixing this gap INVALIDATES a premise card `96d5f76b`'s investigation relied on — reasoning about whether a decline at `release()`/`endSquash()` was cap-caused or repo-caused held ONLY because `grantNext()` had no cap check before this card. Any conclusion from that investigation resting on that premise needs re-deriving now, not assumed to still hold.

## Do not

- Do not assume every caller of `grantNext` is release-shaped (i.e. calls it the instant a slot frees, so `active < cap` already holds) — `releaseMergeRepoGuard`/`endSquash` frees a REPO guard, not a cap slot, and can be called well after the cap slot for that same op was freed and possibly re-consumed by an unrelated op.
- Do not thread a fresh `cap` param through `releaseMergeRepoGuard`/`endSquash` to fix this — it's a public method with an existing signature other code already calls; use `this.lastKnownCap` instead, the same RESOLVE-LIVE value `runExclusive` already refreshes.
- Do not trust any conclusion from card `96d5f76b`'s investigation about whether a decline was cap-caused or repo-caused without re-deriving it — that investigation's premise (no cap check in `grantNext`) no longer holds as of this card.

## Source

Inline comment in `packages/daemon/src/orchestration/gate-semaphore.ts` (`grantNext`'s own doc, lines 850-871), commit `e81a0e75b`, as of `beeeb7c2`. Relocated by card `772735d2` (tranche 2); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
