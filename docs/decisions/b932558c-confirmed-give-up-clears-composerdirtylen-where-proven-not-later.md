# b932558c — a CONFIRMED give-up clears `composerDirtyLen` right where it's proven, not at some later unrelated submit()

## Narrative

Card `b932558c`: a CONFIRMED give-up — this generation's turn genuinely started, proven either by `purgeConfirmedGiveUpRequeue`'s content-match branch or its FIFO-position fallback — is decisive proof THIS generation's own composer content was submitted, not stranded. The daemon already acts on that proof (purging the requeued duplicate right where this is called from); `composerDirtyLen` contradicting it until some LATER, unrelated `submit()`'s own defensive clear-prefix happens to confirm it is the bug this closes.

Previously the ONLY clear path (`composerDirtyLenClearedByGen`, gated on a fresh `submit()`'s own confirmation) never fired for a give-up resolved this way, since no new `submit()` is involved — the ORIGINAL generation's own late-arriving hook is what confirms it, and nothing else was watching for that.

The fix: `clearComposerDirtyOnConfirm` is called directly from both resolution paths — the content-match branch (`purgeConfirmedGiveUpRequeueCore`, `decisive: true`) and the FIFO-position fallback (same method, `decisive: false`) — the instant either one proves a generation's turn actually started, instead of waiting on the unrelated later clear-prefix path. See card `a6c1d413`'s own record for how `decisive` gates how much of `composerDirtyMarkedGens` a given confirmation may resolve.

## Do not

- Do not leave `composerDirtyLen` dirty after a CONFIRMED give-up on the theory that some later submit()'s clear-prefix will eventually catch it up — that is exactly the stale-until-unrelated-confirm bug this card closes.

## Source

Inline JSDoc in `packages/daemon/src/pty/host.ts` (`clearComposerDirtyOnConfirm`'s own method doc), as of commit `e17a8c2af20b2da570967744ef4e5f7f5f020fa0` (this tranche's starting HEAD). Extracted by card `8ebdd7d3` (tranche 45 on `pty/host.ts`); condensed and reworded, not verbatim. Two further call sites (`purgeConfirmedGiveUpRequeueCore`'s content-match branch and its FIFO-position fallback) cite this same card as short inline pointers back to this method's own doc; not separately recorded.
