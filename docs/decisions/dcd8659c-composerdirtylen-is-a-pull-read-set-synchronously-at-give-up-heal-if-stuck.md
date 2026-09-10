# dcd8659c — `composerDirtyLen` is a PULL read of possibly-unsubmitted composer text, set synchronously at give-up/heal-if-stuck

## Narrative

Card dcd8659c: a PULL read of `Live.composerDirtyLen` (`pty/host.ts`, card `3ce3fa39`) — a count of characters possibly still sitting UNSUBMITTED in this worker's composer from an earlier delivery whose confirmation never arrived. Same getter shape as `lastEngineOutputAt` (`pty?.getComposerDirtyLen(id) ?? null`) — read-only, never touches `submit()`/`enqueueStdin`/`drainPending`/the pty. SET synchronously the moment a give-up/heal-if-stuck fires (no dependency on any later write), so it stays non-zero and readable indefinitely when nothing further ever arrives — exactly the stuck case this exists to catch, not just the case where a later write happens to surface it. `0` means the composer is genuinely clean; `null` means this session isn't live in this process — never conflate the two (an absent signal read as a measured zero is the bug this card closes).

## Do not

- Do not conflate `composerDirtyLen: 0` (measured clean) with `composerDirtyLen: null` (session not live in this process) — treating an absent signal as a measured zero is the exact bug this card closes.

## Source

Inline comment in `packages/daemon/src/mcp/orchestration.ts` (the fleet-view builder, `composerDirtyLen`): lines 2646-2654, as of commit `f81f9c1108773e559efe78b7166cbf78b6201480`. Relocated by card `a2278b09` (tranche 2). See `getComposerDirtyLen`'s own doc in `pty/host.ts` for the full mechanics.
