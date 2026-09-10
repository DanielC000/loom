# 2b57b5a9 — a stray form feed at the write-chunk seam is reconciled, never signature-matched

## Narrative

Card 2b57b5a9 — measured n=13, 10 distinct positions, zero exceptions: a stray U+000C (form feed) lands in the engine-reported echo at an EXACT MULTIPLE of `PTY_WRITE_CHUNK_UNITS`, mid-token.

Root cause (DoD-4): `repaint()` writes a raw Ctrl-L directly to the pty, unsynchronized with `writeChunked`. When a viewer's repaint (`Terminal.tsx`'s post-attach "geometry" handler) lands in `writeChunked`'s inter-chunk pacing gap while a bracketed-paste run is still open, the engine treats the stray byte as literal pasted content instead of a repaint trigger, landing exactly at the chunk seam.

RECONCILIATION, not signature, is the suppression bar (binding per this card, from a dissolved counter-specimen `f1a8dce1`): stripping the ONE form feed at that exact seam must make the remainder byte-IDENTICAL to `intended` — a genuinely lost/truncated payload cannot satisfy that, so this can never mask a real loss. Mirrors `isStalePlaceholderPrefix`'s own exact-strip-and-compare discipline; only the position (a seam, not a fixed prefix) differs.

The code's own guard clause — `i > 0` — excludes a divergence AT the very start (before any chunk was ever written), which is not a chunk seam and must not be treated as one.

## Do not

- Do not suppress on a positional/signature match alone (e.g. "a form feed sitting at a chunk-multiple offset") — require the strip-and-compare reconciliation, per the dissolved counter-specimen `f1a8dce1`. A signature-only check cannot rule out a genuine loss that happens to land at the same offset.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (the `isChunkSeamFormFeed` computation, inside `deliverHook`'s `UserPromptSubmit` case). Relocated by card `6a9dba1a` (tranche 21). No wording changed in the narrative moved here beyond joining wrapped lines and stripping `//` markers; the `i > 0` guard clause and its rationale stayed inline (compressed into the anchor) per `CLAUDE.md`'s class-A rule.
