# 2960c3bf — composerDirtyLen at a large number is write-side accounting, never composer evidence

## Narrative

Card 2960c3bf (2026-08-05, worker `a9b67b0d`): a SECOND occurrence of exactly the residue `3ce3fa39`'s own comment predicted ("first-hand confirmed: two specimens' abandoned text survived a backspace-clear... only to resurface — once doubled") — this time via the DEFERRED clear (`submit()`'s own branch), not the immediate clear `3ce3fa39` moved away from. A re-minted give-up retry (44283 stranded + a fresh 44323-char repaste, the 40-char excess being the `[loom:possible-duplicate root:…]` tag `framePossibleDuplicate` adds) landed at `composerDirtyLen === 88606` (`= 44283 + 44323`, exact) after ITS OWN Enter also never confirmed.

⚠️ **That number is not composer evidence.** `composerDirtyLen` is pure write-side bookkeeping (verified: every mutation site is either `+= lastPrompt.length` — the length of what Loom wrote — or a full reset to 0 gated on `composerDirtyLenClearedByGen` trusting a CONFIRMED hook — never a read-back of real terminal/composer content). `88606` is therefore what this accounting produces whenever a clear-then-repaste generation's OWN Enter also fails to confirm, REGARDLESS of whether the backspace burst actually cleared anything — it says nothing about what the engine's real composer held.

Two open candidates, not established either way from static logs alone: (a) the un-bracketed `BACKSPACE.repeat(dirty)` burst gets misinterpreted as literal paste content once/if the engine processes it; (b) the engine simply stopped consuming stdin after rendering the specimen's first large paste (its raw per-session output log recorded ~0 bytes of further output for the rest of that session's life — consistent with nothing sent afterward, backspaces included, ever being read at all).

A live experiment was later run to try to discriminate (a)/(b): card `17c98df7`'s own repaint probe (merged `a648239`, see `packages/daemon/test/_probe-repaint-wedge.mjs`) did NOT reproduce the strand in 9 attempts — a small-n null, not a clearance. Card `c148f118` fixed a DIFFERENT, narrower thing: `88606` above being unable to tell "the clear worked, the repaste alone didn't confirm" from "the clear did nothing" is closed by `composerDirtyLenBelieved` (see `c148f118`'s own record) — for this exact specimen it would have read `44323` (just the repaste, assuming the clear landed) alongside `composerDirtyLen`'s unchanged `88606` (assuming it didn't) — an honest range instead of one number silently picking neither story. This does NOT resolve which of (a)/(b) actually happened; it only stops the number from claiming to.

## Do not

- Do not read a large `composerDirtyLen` value as proof of what's actually sitting in the composer — it is an upper-bound accounting figure only, never a readback. Pair it with `composerDirtyLenBelieved` (card `c148f118`) for an honest range, not a false single number.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (`submit()`, the composer clear-prefix / give-up-redelivery block), lines 9862-9890, as of commit `dc53c7111807e103baf99544d3890df80e9a1c92` (this tranche's starting HEAD). Extracted by card `dfde8c66` (tranche 9).
