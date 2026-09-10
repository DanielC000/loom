# c148f118 — `composerDirtyLen` is the CONSERVATIVE reading only; read it together with `composerDirtyLenBelieved`

## Narrative

Card c148f118: `composerDirtyLen` never assumes a defensive clear-prefix actually landed, so ALONE it cannot tell "a clear was attempted and failed" from "a clear worked but the write after it just hasn't confirmed yet" — those read as the SAME number. `composerDirtyLenBelieved` (same row) is the OPTIMISTIC counterpart — read the two TOGETHER: equal means nothing to doubt; `composerDirtyLenBelieved` lower than `composerDirtyLen` means a clear is unresolved and the gap is exactly how many characters are in doubt.

## Do not

- Do not read `composerDirtyLen` alone as proof a clear-prefix failed — it cannot distinguish that from an unresolved-but-successful clear. Always pair it with `composerDirtyLenBelieved`.

## Source

Inline comment in `packages/daemon/src/mcp/orchestration.ts` (the fleet-view builder, `composerDirtyLen`): lines 2655-2661, as of commit `f81f9c1108773e559efe78b7166cbf78b6201480`. Relocated by card `a2278b09` (tranche 2). See `getComposerDirtyLen`/`getComposerDirtyLenBelieved`'s own docs in `pty/host.ts` for the full mechanics.
