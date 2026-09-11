# c148f118 — `composerDirtyLen` is the CONSERVATIVE reading only; read it together with `composerDirtyLenBelieved`

## Narrative

Card c148f118: `composerDirtyLen` never assumes a defensive clear-prefix actually landed, so ALONE it cannot tell "a clear was attempted and failed" from "a clear worked but the write after it just hasn't confirmed yet" — those read as the SAME number. `composerDirtyLenBelieved` (same row) is the OPTIMISTIC counterpart — read the two TOGETHER: equal means nothing to doubt; `composerDirtyLenBelieved` lower than `composerDirtyLen` means a clear is unresolved and the gap is exactly how many characters are in doubt.

## Mechanics — write-side bookkeeping, not a terminal readback

`composerDirtyLenBelieved` mirrors every `composerDirtyLen` add (same sites, same amounts) EXCEPT the defensive clear-prefix branch in `submit()` (the `composerDirtyLen > 0 && composerLen === 0` case), which zeroes `composerDirtyLenBelieved` the moment it issues the backspace burst — optimistically ASSUMING that burst actually empties the composer, rather than letting the total keep compounding the way `composerDirtyLen` deliberately does. Before this pair existed, both possibilities ("the clear worked" and "the clear did nothing") collapsed onto one identical number — see the specimen recorded in `submit()`'s own comment, card `2960c3bf`. Both fields reset to 0 together only via the SAME three decisive-confirm sites (the `composerDirtyLenClearedByGen`-gated UserPromptSubmit/Stop hooks, and `clearComposerDirtyOnConfirm`'s `composerDirtyMarkedGens` gate) — a genuine confirmation proves the whole ordered byte stream landed, so both readings collapse back to true zero together. Like `composerDirtyLen`, this is pure write-side bookkeeping, never a readback of real terminal content — "optimistic" describes the ASSUMPTION, not a verification.

## `getComposerDirtyLenBelieved`'s own site — bounding the truth, not just flagging doubt

`getComposerDirtyLenBelieved` (`pty/host.ts`) frames the pairing as BOUNDING the truth between "the clear
worked" (this getter) and "the clear did nothing" (`getComposerDirtyLen`) — instead of the single,
ambiguity-collapsing number either field gave alone before this card existed. Both getters are surfaced on
`worker_list`/`worker_status`/`my_context` (`mcp/orchestration.ts`) side by side — that's the reader this
pairing exists for.

## Do not

- Do not read `composerDirtyLen` alone as proof a clear-prefix failed — it cannot distinguish that from an unresolved-but-successful clear. Always pair it with `composerDirtyLenBelieved`.
- Do not reset `composerDirtyLenBelieved` anywhere except the three decisive-confirm sites named above — resetting it elsewhere breaks its "collapses back to true zero only on genuine confirmation" guarantee.

## Source

Inline comment in `packages/daemon/src/mcp/orchestration.ts` (the fleet-view builder, `composerDirtyLen`): lines 2655-2661, as of commit `f81f9c1108773e559efe78b7166cbf78b6201480`. Relocated by card `a2278b09` (tranche 2). See `getComposerDirtyLen`/`getComposerDirtyLenBelieved`'s own docs in `pty/host.ts` for the full mechanics.

The Mechanics section above is a second site for the same card, extracted from the `composerDirtyLenBelieved` field doc in `packages/daemon/src/pty/host.ts` (the `Live` interface), as of commit `ca1117e261e56fcff271d6a0f2e5dce4579500b6` (tranche 7's HEAD). Extracted by card `0f3c76a4` (tranche 8 on `pty/host.ts`); no wording changed, wrapped source lines joined into a flowing paragraph and the `//` comment markers stripped.
