# b7158b99 — a recognized replay does NOT establish a loss, and never did reliably

## Narrative

Card `b7158b99` — CORRECTION to `Live.lastMismatchReplay`: this field does NOT establish a loss, and never did reliably. A replay at a given generation is compatible with the composer still holding that generation's own intended text, which a LATER generation's own submission can fuse back in whole (see `lastMismatchFusion`, which would then name this generation in its own `spanGens`); whether that happens is unknowable until that later generation, if any, actually occurs (see `detectComposerAccumulation`'s own coverage-limit doc).

Read a replay as "detected, possibly recoverable by a later fusion", never as "an established loss" — the session-facing `[loom:prompt-mismatch]` notice's own wording carries the same correction.

## Do not

- Do not word a replay-detection notice or field doc as an established loss — a later generation can still fuse the content back in whole, which is unknowable at detection time.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (the `Live.lastMismatchReplay` field doc, correction clause), as of `main` `d8b3076b`. Extracted by card `b19e70d3` (tranche 10 on `pty/host.ts`); wording unchanged beyond joining wrapped lines and stripping `//` markers.
